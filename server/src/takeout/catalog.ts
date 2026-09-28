import { NameList } from 'src/takeout/banned';
import { compareBytes } from 'src/takeout/byte-order';
import { isEditedCopy } from 'src/takeout/edited';
import { getInfo } from 'src/takeout/filenames/info-collector';
import { NameInfo } from 'src/takeout/filenames/name-info';
import {
  albumFromJson,
  asMetadata,
  googlePhotosExtra,
  isAlbum,
  isAsset,
  isImmichGoJson,
  parseGoogleJson,
} from 'src/takeout/google-json';
import { getFileIndex, MATCHERS } from 'src/takeout/matchers';
import { mediaTypeOf } from 'src/takeout/media-types';
import { base as pathBase, dir as pathDir, ext, nfc, trimExt } from 'src/takeout/paths';
import {
  AlbumFromJson,
  AssetMetadataFromJson,
  CatalogInput,
  CatalogSummary,
  GoogleMetadata,
  MatcherName,
  PlanAction,
  PlannedFileKind,
} from 'src/takeout/types';

// A media file that carries (or may carry) Google metadata.
export interface CatalogAsset {
  catalogIndex: number;
  dir: string;
  base: string; // NFC on-disk base name
  path: string; // exact archive path
  partName: string;
  size: number;
  mtime: Date | null;
  checksum: Buffer | null;
  fileKind: 'image' | 'video';
  md: GoogleMetadata | null;
  meta: AssetMetadataFromJson | null;
  extra: Record<string, unknown> | null;
  originalFileName: string;
  nameInfo: NameInfo;
  isEditedCopy: boolean;
  jsonPath: string | null;
  matcher: MatcherName | null;
  sampleAvailable: boolean;
  trackerKey: string;
}

// Any catalog file that is not an imported media asset (report-only rows).
export interface NonAssetEntry {
  catalogIndex: number;
  path: string;
  partName: string;
  size: number;
  mtime: Date | null;
  base: string;
  action: PlanAction;
  fileKind: PlannedFileKind;
  checksum: Buffer | null;
}

export interface TrackerInfo {
  base: string;
  size: number;
  paths: string[]; // dirs where this (base, size) appears, in discovery order
  emitted: boolean;
}

export interface AssetJsonRecord {
  catalogIndex: number;
  path: string;
  partName: string;
  size: number;
  mtime: Date | null;
  base: string;
  md: GoogleMetadata;
  meta: AssetMetadataFromJson;
  extra: Record<string, unknown> | null;
  matched: number;
}

export interface TakeoutCatalog {
  summary: CatalogSummary;
  assetsByDir: Map<string, CatalogAsset[]>;
  albums: Map<string, AlbumFromJson>;
  tracker: Map<string, TrackerInfo>;
  nonAssets: NonAssetEntry[];
  assetJsons: AssetJsonRecord[];
  inputs: CatalogInput[];
}

interface DirCatalog {
  jsons: Map<string, AssetJsonRecord>; // by NFC base
  unMatched: Map<string, CatalogAsset>; // by NFC base
  matched: Map<string, CatalogAsset>;
}

function trackerKey(base: string, size: number): string {
  return `${base}\0${size}`;
}

// The stem the normal matcher compares against, after the (k) index and a supplemental-metadata trailer are removed.
function normalStem(jsonName: string): { stem: string; index: string } {
  const { name, index } = getFileIndex(jsonName);
  let s = name;
  const p2 = s.lastIndexOf('.');
  if (p2 > 1) {
    const p1 = s.slice(0, p2).lastIndexOf('.');
    if (p1 > 1 && 'supplemental-metadata'.startsWith(s.slice(p1 + 1, p2))) {
      s = s.slice(0, p1) + s.slice(p2);
    }
  }
  return { stem: trimExt(s), index };
}

// Go makeAsset title rule (inventory 2.4): trim the superfluous title extensions against the on-disk extension.
function resolveTitle(onDiskPath: string, base: string, md: GoogleMetadata | null): string {
  if (md === null) {
    return base;
  }
  const meta = asMetadata(md);
  if (meta.fileName === '') {
    return base;
  }
  let title = meta.fileName;
  let titleExt = ext(title);
  const fileExt = ext(onDiskPath);
  if (titleExt !== fileExt) {
    title = trimExt(title);
    titleExt = ext(title);
    if (titleExt !== fileExt) {
      title = trimExt(title) + fileExt;
    }
  }
  return title;
}

function makeAsset(entry: CatalogAsset, md: GoogleMetadata | null): CatalogAsset {
  const title = resolveTitle(entry.path, entry.base, md);
  entry.md = md;
  entry.meta = md === null ? null : asMetadata(md);
  entry.extra = md === null ? null : googlePhotosExtra(md);
  entry.originalFileName = title;
  entry.nameInfo = getInfo(title, 'UTC');
  return entry;
}

// Builds the archive catalog and solves the JSON <-> file puzzle, exactly like Go passOne + solvePuzzle.
export async function buildCatalog(
  input: Iterable<CatalogInput> | AsyncIterable<CatalogInput>,
  options?: { banned?: string[] },
): Promise<TakeoutCatalog> {
  const banned = new NameList(options?.banned ?? []);
  const catalogs = new Map<string, DirCatalog>();
  const albums = new Map<string, AlbumFromJson>();
  const tracker = new Map<string, TrackerInfo>();
  const nonAssets: NonAssetEntry[] = [];
  const inputs: CatalogInput[] = [];
  const assetJsonRecords: AssetJsonRecord[] = [];
  const summary: CatalogSummary = {
    assetJsons: 0,
    albumJsons: 0,
    unknownJsons: 0,
    matched: { fastTrack: 0, normal: 0, forgottenDuplicates: 0, edited: 0 },
    jsonWithoutMedia: [],
    mediaWithoutJson: [],
  };

  const getDir = (dir: string): DirCatalog => {
    let cat = catalogs.get(dir);
    if (!cat) {
      cat = { jsons: new Map(), unMatched: new Map(), matched: new Map() };
      catalogs.set(dir, cat);
    }
    return cat;
  };

  let catalogIndex = 0;
  const pushNonAsset = (input: CatalogInput, action: PlanAction, fileKind: PlannedFileKind, index: number) => {
    nonAssets.push({
      catalogIndex: index,
      path: input.path,
      partName: input.partName,
      size: input.size,
      mtime: input.mtime,
      base: nfc(pathBase(input.path)),
      action,
      fileKind,
      checksum: input.checksum,
    });
  };

  let counter = 0;
  for await (const item of input as AsyncIterable<CatalogInput>) {
    inputs.push(item);
    const index = catalogIndex++;
    const nfcPath = nfc(item.path);
    const dir = pathDir(nfcPath);
    const baseName = nfc(pathBase(item.path));

    if (banned.match(nfcPath)) {
      pushNonAsset(item, 'banned', 'banned', index);
      continue;
    }

    if (item.kind === 'useless') {
      pushNonAsset(item, 'useless', 'useless', index);
      continue;
    }
    if (item.kind === 'sidecar') {
      pushNonAsset(item, 'sidecarXmp', 'sidecar', index);
      continue;
    }
    if (item.kind === 'unsupported') {
      pushNonAsset(item, 'unsupported', 'unsupported', index);
      continue;
    }
    if (item.kind === 'other') {
      pushNonAsset(item, 'unsupported', 'other', index);
      continue;
    }

    if (item.kind === 'json') {
      if (item.json === null || isImmichGoJson(item.json)) {
        pushNonAsset(item, item.json === null ? 'unknownJson' : 'immichGoJson', 'json', index);
        summary.unknownJsons++;
        continue;
      }
      const md = parseGoogleJson(item.json);
      if (md === null) {
        pushNonAsset(item, 'unknownJson', 'json', index);
        summary.unknownJsons++;
        continue;
      }
      if (isAsset(md)) {
        const record: AssetJsonRecord = {
          catalogIndex: index,
          path: item.path,
          partName: item.partName,
          size: item.size,
          mtime: item.mtime,
          base: baseName,
          md,
          meta: asMetadata(md),
          extra: googlePhotosExtra(md),
          matched: 0,
        };
        getDir(dir).jsons.set(baseName, record);
        assetJsonRecords.push(record);
        summary.assetJsons++;
      } else if (isAlbum(md)) {
        albums.set(dir, albumFromJson(md));
        pushNonAsset(item, 'albumJson', 'json', index);
        summary.albumJsons++;
      } else {
        pushNonAsset(item, 'unknownJson', 'json', index);
        summary.unknownJsons++;
      }
      continue;
    }

    // media
    const mediaType = mediaTypeOf(baseName);
    if (mediaType === null) {
      pushNonAsset(item, 'unsupported', 'unsupported', index);
      continue;
    }
    if (mediaType === 'video' && item.path.includes('Failed Videos')) {
      pushNonAsset(item, 'failedVideo', 'video', index);
      continue;
    }

    const key = trackerKey(baseName, item.size);
    let track = tracker.get(key);
    if (!track) {
      track = { base: baseName, size: item.size, paths: [], emitted: false };
      tracker.set(key, track);
    }
    track.paths.push(dir);

    const cat = getDir(dir);
    if (cat.unMatched.has(baseName)) {
      pushNonAsset(item, 'duplicatedInDirectory', mediaType, index);
      continue;
    }

    const asset: CatalogAsset = {
      catalogIndex: index,
      dir,
      base: baseName,
      path: item.path,
      partName: item.partName,
      size: item.size,
      mtime: item.mtime,
      checksum: item.checksum,
      fileKind: mediaType,
      md: null,
      meta: null,
      extra: null,
      originalFileName: baseName,
      nameInfo: getInfo(baseName, 'UTC'),
      isEditedCopy: isEditedCopy(baseName),
      jsonPath: null,
      matcher: null,
      sampleAvailable: item.sample !== null,
      trackerKey: key,
    };
    cat.unMatched.set(baseName, asset);

    if (++counter % 1000 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // solvePuzzle: dirs byte-sorted, matcher-major, JSON names byte-sorted, files in insertion order.
  const dirs = catalogs.keys().toArray().sort(compareBytes);
  for (const dir of dirs) {
    const cat = catalogs.get(dir)!;
    const jsonNames = cat.jsons.keys().toArray().sort(compareBytes);

    const claim = (fileName: string, asset: CatalogAsset, matcher: MatcherName, record: AssetJsonRecord): void => {
      makeAsset(asset, record.md);
      asset.jsonPath = record.path;
      asset.matcher = matcher;
      record.matched++;
      summary.matched[matcher]++;
      cat.matched.set(fileName, asset);
      cat.unMatched.delete(fileName);
    };

    // Fast path: index the two exact matchers (fastTrack and the supplemental-metadata exact case of normal)
    // so a big year folder is not O(jsons x files). The naive loop below still handles every other case, and
    // the indexed claims reproduce exactly what fastTrack and the normal exact branch would claim in JSON order.
    const byName = new Map<string, CatalogAsset>();
    const byNormalKey = new Map<string, CatalogAsset>();
    for (const [fileName, asset] of cat.unMatched) {
      byName.set(fileName, asset);
      const fi = getFileIndex(fileName);
      byNormalKey.set(`${fi.index}\0${fi.name}`, asset);
    }
    for (const jsonName of jsonNames) {
      const key = trimExt(jsonName);
      const asset = byName.get(key);
      if (asset && cat.unMatched.has(key)) {
        claim(key, asset, 'fastTrack', cat.jsons.get(jsonName)!);
      }
    }
    for (const jsonName of jsonNames) {
      const { stem, index } = normalStem(jsonName);
      const asset = byNormalKey.get(`${index}\0${stem}`);
      if (asset && cat.unMatched.has(asset.base)) {
        claim(asset.base, asset, 'normal', cat.jsons.get(jsonName)!);
      }
    }

    // Naive loop for the remaining matchers and the rarer normal truncation cases, over what is left.
    for (const matcher of MATCHERS) {
      for (const jsonName of jsonNames) {
        const record = cat.jsons.get(jsonName)!;
        for (const [fileName, asset] of cat.unMatched) {
          if (matcher.fn(jsonName, fileName)) {
            claim(fileName, asset, matcher.name, record);
          }
        }
      }
    }

    // Leftovers: unmatched media (kept as missingMetadata by the planner when includeUnmatched).
    for (const [fileName, asset] of [...cat.unMatched].sort((a, b) => compareBytes(a[0], b[0]))) {
      makeAsset(asset, null);
      cat.matched.set(fileName, asset);
      cat.unMatched.delete(fileName);
      summary.mediaWithoutJson.push(asset.path);
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const assetsByDir = new Map<string, CatalogAsset[]>();
  for (const dir of dirs) {
    const cat = catalogs.get(dir)!;
    assetsByDir.set(dir, cat.matched.values().toArray());
  }

  for (const record of assetJsonRecords) {
    if (record.matched === 0) {
      summary.jsonWithoutMedia.push(record.path);
    }
  }

  return { summary, assetsByDir, albums, tracker, nonAssets, assetJsons: assetJsonRecords, inputs };
}
