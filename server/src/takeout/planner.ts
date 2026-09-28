import { compareBytes } from 'src/takeout/byte-order';
import { CatalogAsset, TakeoutCatalog } from 'src/takeout/catalog';
import { countersFromRows } from 'src/takeout/counters';
import { parseDateRange } from 'src/takeout/date-range';
import { isMotionName, originalNameOfEdited } from 'src/takeout/edited';
import { applyFilters } from 'src/takeout/filters';
import { Group, GroupItem } from 'src/takeout/groups/group';
import { runGroupers } from 'src/takeout/groups/pipeline';
import { detectRotationFromSamples } from 'src/takeout/image-sample';
import { isDecodable } from 'src/takeout/media-types';
import { takeoutTagName } from 'src/takeout/part-names';
import {
  CounterRow,
  DateRange,
  ImportPlan,
  PlanAction,
  PlanContext,
  PlannedAssetData,
  PlannedFile,
  PlannedGroup,
  RotatePair,
  Rotation,
  TakeoutSettings,
} from 'src/takeout/types';

const ROTATE_ONLY_REASON = 'edited copy only rotates the original, the rotation is applied to the original in Immich';

interface PlanItem extends GroupItem {
  catalogIndex: number;
  asset: CatalogAsset;
}

// Default probe B passes: compares the two files' 32x32 samples.
export function sampleRotationProbe(catalog: TakeoutCatalog): PlanContext['rotationProbe'] {
  // eslint-disable-next-line @typescript-eslint/require-await -- must satisfy the async rotationProbe signature
  return async (original, edited) => {
    const o = catalog.inputs[original.catalogIndex]?.sample;
    const e = catalog.inputs[edited.catalogIndex]?.sample;
    if (!o || !e) {
      return 0;
    }
    return detectRotationFromSamples(o, e);
  };
}

export async function planImport(
  catalog: TakeoutCatalog,
  settings: TakeoutSettings,
  context: PlanContext,
): Promise<ImportPlan> {
  const files: PlannedFile[] = catalog.inputs.map((input, index) => ({
    key: index,
    catalogIndex: index,
    partName: input.partName,
    takeoutPath: input.path,
    onDiskName: baseNameOf(input.path),
    size: input.size,
    mtime: input.mtime,
    checksum: input.checksum,
    fileKind: 'other',
    jsonPath: null,
    matcher: null,
    originalFileName: null,
    action: 'unsupported',
    reason: null,
    rotation: 0,
    isEditedCopy: false,
    data: null,
  }));

  // Report rows for every non-imported file.
  for (const entry of catalog.nonAssets) {
    const f = files[entry.catalogIndex];
    f.fileKind = entry.fileKind;
    f.action = entry.action;
  }
  for (const record of catalog.assetJsons) {
    const f = files[record.catalogIndex];
    f.fileKind = 'json';
    f.action = record.matched > 0 ? 'assetJson' : 'assetJsonUnused';
    f.jsonPath = record.path;
  }

  const range: DateRange | null =
    settings.dateRange === null ? null : parseDateRange(settings.dateRange, settings.homeTimeZone);

  const emittedWinner = new Map<string, CatalogAsset>();
  const droppedRotateOnly = new Map<string, { originalIndex: number; angle: Rotation }>();
  const rotatePairs: RotatePair[] = []; // section 11 D1: (original, copy, angle) for each dropped rotate-only copy
  const extraAlbumDirs = new Map<number, string[]>(); // catalogIndex -> extra album dirs merged from dropped copies
  const groups: PlannedGroup[] = [];
  let groupIndex = 0;
  let iter = 0;

  const dirs = catalog.assetsByDir.keys().toArray().sort(compareBytes);
  for (const dir of dirs) {
    const dirAssets = catalog.assetsByDir.get(dir)!;

    const active: CatalogAsset[] = [];
    for (const asset of dirAssets) {
      const f = files[asset.catalogIndex];
      f.fileKind = asset.fileKind;
      f.matcher = asset.matcher;
      f.jsonPath = asset.jsonPath;
      f.originalFileName = asset.originalFileName;
      f.isEditedCopy = asset.isEditedCopy;

      if (asset.matcher === null && !settings.includeUnmatched) {
        f.action = 'missingMetadata';
        continue;
      }

      const track = catalog.tracker.get(asset.trackerKey);
      if (track?.emitted) {
        f.action = 'localDuplicate';
        continue;
      }

      const filtered = filterAction(asset, settings, range);
      if (filtered) {
        f.action = filtered;
        continue;
      }
      active.push(asset);
    }

    // [DEV 3] rotate-only edited copies.
    if (settings.applyRotation) {
      const byName = new Map<string, CatalogAsset>();
      for (const asset of dirAssets) {
        byName.set(asset.base, asset);
      }
      const stillActive: CatalogAsset[] = [];
      for (const asset of active) {
        if (!asset.isEditedCopy) {
          stillActive.push(asset);
          continue;
        }
        const drop = droppedRotateOnly.get(asset.trackerKey);
        if (drop) {
          dropRotateOnly(files, asset, drop.originalIndex, drop.angle, catalog, extraAlbumDirs, rotatePairs);
          continue;
        }
        const originalName = originalNameOfEdited(asset.base);
        if (originalName === null) {
          stillActive.push(asset);
          continue;
        }
        const originalHere = byName.get(originalName);
        const original = originalHere ? (emittedWinner.get(originalHere.trackerKey) ?? originalHere) : undefined;
        if (
          original === undefined ||
          files[original.catalogIndex].rotation !== 0 ||
          !isDecodable(asset.base) ||
          !isDecodable(originalName) ||
          original.nameInfo.kind === 'motion' ||
          isMotionName(original.originalFileName) ||
          isMotionName(originalName)
        ) {
          stillActive.push(asset);
          continue;
        }
        const angle = await context.rotationProbe(files[original.catalogIndex], files[asset.catalogIndex]);
        if (angle === 0) {
          stillActive.push(asset);
          continue;
        }
        files[original.catalogIndex].rotation = angle;
        dropRotateOnly(files, asset, original.catalogIndex, angle, catalog, extraAlbumDirs, rotatePairs);
        droppedRotateOnly.set(asset.trackerKey, { originalIndex: original.catalogIndex, angle });
      }
      active.length = 0;
      active.push(...stillActive);
    }

    // Sort by radical, capture date, then on-disk name (stable).
    active.sort((a, b) => {
      if (a.nameInfo.radical !== b.nameInfo.radical) {
        return compareBytes(a.nameInfo.radical, b.nameInfo.radical);
      }
      const da = a.meta?.captureDate?.getTime() ?? 0;
      const db = b.meta?.captureDate?.getTime() ?? 0;
      if (da !== db) {
        return da - db;
      }
      return compareBytes(a.base, b.base);
    });

    // Albums, tags and PlannedAssetData for each active file.
    for (const asset of active) {
      files[asset.catalogIndex].action = 'upload';
      files[asset.catalogIndex].data = buildAssetData(
        asset,
        catalog,
        settings,
        extraAlbumDirs.get(asset.catalogIndex) ?? [],
      );
    }

    // Groupers over the active files.
    const items: PlanItem[] = active.map((asset) => ({
      catalogIndex: asset.catalogIndex,
      asset,
      radical: asset.nameInfo.radical,
      type: asset.nameInfo.type,
      kind: asset.nameInfo.kind,
      isCover: asset.nameInfo.isCover,
      ext: asset.nameInfo.ext,
      captureDate: asset.meta?.captureDate?.getTime() ?? null,
      fileDate: asset.mtime?.getTime() ?? null,
    }));

    const emitted = runGroupers(items, {
      burst: settings.burstByTime && settings.burst !== 'NoStack',
      isEditedPair,
    });

    for (const group of emitted) {
      applyFilters(group, settings);
      for (const removed of group.removed) {
        files[removed.item.catalogIndex].action = 'notSelected';
        files[removed.item.catalogIndex].reason = removed.reason;
        files[removed.item.catalogIndex].data = null;
      }
      if (group.members.length === 0) {
        continue;
      }
      const members = orderMembers(group);
      for (const member of members) {
        emittedWinner.set(member.asset.trackerKey, member.asset);
        const track = catalog.tracker.get(member.asset.trackerKey);
        if (track) {
          track.emitted = true;
        }
      }
      groups.push({
        index: groupIndex++,
        kind: group.members.length < 2 ? 'none' : group.kind,
        members: members.map((m) => m.catalogIndex),
        coverIndex: 0,
        links: [],
      });
    }

    if (++iter % 50 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  attachEditedCopies(files, groups, catalog, emittedWinner);

  const counters = countersFromRows(planRows(files), planBytes(files));
  return { files, groups, counters, rotatePairs };
}

function baseNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function filterAction(asset: CatalogAsset, settings: TakeoutSettings, range: DateRange | null): PlanAction | null {
  const meta = asset.meta;
  if (!settings.includeArchived && meta?.archived) {
    return 'filteredArchived';
  }
  if (!settings.includePartner && meta?.fromPartner) {
    return 'filteredPartner';
  }
  if (!settings.includeTrashed && meta?.trashed) {
    return 'filteredTrashed';
  }
  if (range !== null) {
    const date = meta?.captureDate ?? null;
    if (date === null || date.getTime() < range.after.getTime() || range.before.getTime() <= date.getTime()) {
      return 'filteredDateRange';
    }
  }
  return null;
}

function dropRotateOnly(
  files: PlannedFile[],
  asset: CatalogAsset,
  originalIndex: number,
  angle: Rotation,
  catalog: TakeoutCatalog,
  extraAlbumDirs: Map<number, string[]>,
  rotatePairs: RotatePair[],
): void {
  const f = files[asset.catalogIndex];
  f.action = 'rotateOnlyDropped';
  f.reason = ROTATE_ONLY_REASON;
  f.data = null;
  // section 11 D1: record (original, copy, angle) so B rotates + re-detects faces + reconciles people before the drop.
  rotatePairs.push({ originalKey: files[originalIndex].key, copyKey: f.key, angle });
  const track = catalog.tracker.get(asset.trackerKey);
  if (track) {
    const existing = extraAlbumDirs.get(originalIndex) ?? [];
    extraAlbumDirs.set(originalIndex, [...existing, ...track.paths]);
  }
}

function buildAssetData(
  asset: CatalogAsset,
  catalog: TakeoutCatalog,
  settings: TakeoutSettings,
  extraDirs: string[],
): PlannedAssetData {
  const meta = asset.meta;
  const fallbacks: string[] = [];
  const albums: Array<{ title: string; description: string }> = [];
  const seenTitles = new Set<string>();
  let albumHasGps = false;

  if (settings.syncAlbums) {
    const track = catalog.tracker.get(asset.trackerKey);
    const dirsToCheck = [...(track?.paths ?? []), ...extraDirs];
    for (const p of dirsToCheck) {
      const album = catalog.albums.get(p);
      if (album && album.title !== '' && !seenTitles.has(album.title)) {
        seenTitles.add(album.title);
        albums.push({ title: album.title, description: album.description });
        if (album.latitude !== 0 || album.longitude !== 0) {
          albumHasGps = true;
        }
      }
    }
  }

  const latitude = meta?.latitude ?? 0;
  const longitude = meta?.longitude ?? 0;
  if (albumHasGps && latitude === 0 && longitude === 0) {
    fallbacks.push('albumGpsIgnored');
  }

  const tags: string[] = [];
  if (settings.peopleTags && meta) {
    for (const person of meta.people) {
      tags.push(`People/${person}`);
    }
  }
  if (settings.takeoutTag) {
    tags.push(takeoutTagName(asset.partName));
  }

  if ((meta?.captureDate ?? null) === null) {
    fallbacks.push('noGoogleDate');
  }

  const extra = settings.googlePhotosFields && asset.extra && Object.keys(asset.extra).length > 0 ? asset.extra : null;

  return {
    captureDate: meta?.captureDate ? meta.captureDate.toISOString() : null,
    description: meta?.description ?? '',
    latitude,
    longitude,
    favorited: meta?.favorited ?? false,
    archived: meta?.archived ?? false,
    trashed: meta?.trashed ?? false,
    fromPartner: meta?.fromPartner ?? false,
    albums,
    tags,
    extra,
    fallbacks,
  };
}

// [DEV 4] a group counts as an edited pair when it holds an edited copy and at least one non-edited original.
// The link between an edited '.jpg' copy and a HEIC or DNG original is the shared JSON, so a name match is not
// required: any non-edited sibling in the same series group is treated as the original.
function isEditedPair(members: PlanItem[]): boolean {
  return members.some((m) => m.asset.isEditedCopy) && members.some((m) => !m.asset.isEditedCopy);
}

function orderMembers(group: Group<PlanItem>): PlanItem[] {
  const members = [...group.members];
  const cover = group.coverIndex;
  if (cover > 0 && cover < members.length) {
    const [item] = members.splice(cover, 1);
    members.unshift(item);
  }
  return members;
}

// [DEV 4] cover and attach pass over the whole plan (planning step 8, 2.6).
function attachEditedCopies(
  files: PlannedFile[],
  groups: PlannedGroup[],
  catalog: TakeoutCatalog,
  emittedWinner: Map<string, CatalogAsset>,
): void {
  const groupOf = new Map<number, PlannedGroup>();
  for (const group of groups) {
    for (const member of group.members) {
      groupOf.set(member, group);
    }
  }
  const assetByIndex = new Map<number, CatalogAsset>();
  const indexByDirBase = new Map<string, number>();
  for (const list of catalog.assetsByDir.values()) {
    for (const asset of list) {
      assetByIndex.set(asset.catalogIndex, asset);
      indexByDirBase.set(`${asset.dir}\0${asset.base}`, asset.catalogIndex);
    }
  }

  const removed = new Set<PlannedGroup>();
  const isSingleton = (g: PlannedGroup) => g.kind === 'none' && g.members.length === 1;

  for (const asset of assetByIndex.values()) {
    const f = files[asset.catalogIndex];
    if (f.action !== 'upload' || !asset.isEditedCopy) {
      continue;
    }
    const originalName = originalNameOfEdited(asset.base);
    if (originalName === null) {
      continue;
    }
    const originalHereIndex = indexByDirBase.get(`${asset.dir}\0${originalName}`);
    if (originalHereIndex === undefined) {
      continue;
    }
    const originalHere = assetByIndex.get(originalHereIndex)!;
    const originalIndex = (emittedWinner.get(originalHere.trackerKey) ?? originalHere).catalogIndex;
    if (files[originalIndex].action !== 'upload') {
      continue;
    }
    const gE = groupOf.get(asset.catalogIndex);
    const gO = groupOf.get(originalIndex);
    if (!gE || !gO || removed.has(gE) || removed.has(gO)) {
      continue;
    }

    if (gE === gO) {
      const pos = gE.members.indexOf(asset.catalogIndex);
      if (pos > 0) {
        gE.members.splice(pos, 1);
        gE.members.unshift(asset.catalogIndex);
      }
      gE.kind = 'other';
      continue;
    }

    const eSingle = isSingleton(gE);
    const oSingle = isSingleton(gO);
    if (eSingle && oSingle) {
      gE.members = [asset.catalogIndex, originalIndex];
      gE.kind = 'other';
      removed.add(gO);
      groupOf.set(originalIndex, gE);
    } else if (eSingle) {
      gO.members.unshift(asset.catalogIndex);
      gO.kind = 'other';
      removed.add(gE);
      groupOf.set(asset.catalogIndex, gO);
    } else if (oSingle) {
      const pos = gE.members.indexOf(asset.catalogIndex);
      gE.members.splice(pos + 1, 0, originalIndex);
      gE.kind = 'other';
      removed.add(gO);
      groupOf.set(originalIndex, gE);
    } else if (!gE.links.includes(originalIndex)) {
      gE.links.push(originalIndex);
    }
  }

  const kept = groups.filter((g) => !removed.has(g));
  groups.length = 0;
  for (const [index, group] of kept.entries()) {
    group.index = index;
    groups.push(group);
  }
}

function planRows(files: PlannedFile[]): CounterRow[] {
  const map = new Map<string, CounterRow>();
  for (const f of files) {
    const key = `${f.action}\0${f.fileKind}\0${f.matcher}\0${f.reason}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, {
        action: f.action,
        status: f.action === 'upload' ? 'planned' : 'skipped',
        fileKind: f.fileKind,
        matcher: f.matcher,
        fallbacks: [],
        rotationState: null,
        isCover: false,
        groupKind: null,
        reason: f.reason,
        count: 1,
      });
    }
  }
  return map.values().toArray();
}

function planBytes(files: PlannedFile[]): { total: number; done: number } {
  let total = 0;
  for (const f of files) {
    if (f.action === 'upload') {
      total += f.size;
    }
  }
  return { total, done: 0 };
}
