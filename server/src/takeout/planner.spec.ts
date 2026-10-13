import { buildCatalog } from 'src/takeout/catalog';
import { planImport } from 'src/takeout/planner';
import { DEFAULT_TAKEOUT_SETTINGS } from 'src/takeout/settings';
import { CatalogInput, ImportPlan, PlanContext, Rotation, TakeoutSettings } from 'src/takeout/types';
import { describe, expect, it } from 'vitest';

const PART = 'takeout-20260914T211500Z-1-001.tgz';

function media(path: string, size = 100): CatalogInput {
  return {
    partName: PART,
    path,
    size,
    mtime: new Date(1_700_000_000_000),
    kind: 'media',
    json: null,
    checksum: Buffer.from(path),
    sample: null,
  };
}
function assetJson(path: string, title: string, ts = '1700000000'): CatalogInput {
  return {
    partName: PART,
    path,
    size: 500,
    mtime: new Date(0),
    kind: 'json',
    json: { title, photoTakenTime: { timestamp: ts } },
    checksum: null,
    sample: null,
  };
}
function albumJson(path: string, title: string): CatalogInput {
  return {
    partName: PART,
    path,
    size: 500,
    mtime: new Date(0),
    kind: 'json',
    json: { title },
    checksum: null,
    sample: null,
  };
}

async function plan(
  inputs: CatalogInput[],
  probeAngle: Rotation,
  settings: TakeoutSettings = DEFAULT_TAKEOUT_SETTINGS,
): Promise<ImportPlan> {
  const catalog = await buildCatalog(inputs);
  const context: PlanContext = { rotationProbe: () => Promise.resolve(probeAngle) };
  return planImport(catalog, settings, context);
}

const byPath = (p: ImportPlan, path: string) => p.files.find((f) => f.takeoutPath === path)!;
const actions = (p: ImportPlan, action: string) => p.files.filter((f) => f.action === action).map((f) => f.takeoutPath);

// A stable, timezone-independent projection of a plan: matching and grouping decisions only, no capture
// dates or checksums. Sorted so the golden snapshot never depends on catalog iteration order.
function planShape(p: ImportPlan) {
  return {
    files: p.files
      .map((f) => ({
        takeoutPath: f.takeoutPath,
        action: f.action,
        matcher: f.matcher,
        fileKind: f.fileKind,
        isEditedCopy: f.isEditedCopy,
        jsonPath: f.jsonPath,
        albums: (f.data?.albums ?? []).map((a) => a.title).sort(),
        tags: [...(f.data?.tags ?? [])].sort(),
        fallbacks: [...(f.data?.fallbacks ?? [])].sort(),
      }))
      .sort((a, b) => a.takeoutPath.localeCompare(b.takeoutPath)),
    groups: p.groups
      .map((g) => ({
        kind: g.kind,
        cover: p.files[g.coverIndex]?.takeoutPath ?? null,
        members: g.members.map((m) => p.files[m]?.takeoutPath ?? null).sort(),
      }))
      .sort((a, b) => (a.cover ?? '').localeCompare(b.cover ?? '')),
  };
}

describe('planner golden snapshot', () => {
  it('plans a representative mixed catalog', async () => {
    const Y = 'Takeout/Google Photos/Photos from 2021';
    const T = 'Takeout/Google Photos/Trip';
    const inputs = [
      // matched original with an edited copy in a year folder
      media(`${Y}/PXL_20210102_221126.jpg`),
      media(`${Y}/PXL_20210102_221126-edited.jpg`, 90),
      assetJson(`${Y}/PXL_20210102_221126.jpg.json`, 'PXL_20210102_221126.jpg'),
      // the same original again inside an album folder
      media(`${T}/PXL_20210102_221126.jpg`),
      albumJson(`${T}/metadata.json`, 'Trip'),
      // a cut-short supplemental-metadata sidecar
      media(`${Y}/Screenshot_20200301-161151.png`),
      assetJson(`${Y}/Screenshot_20200301-161151.png.supplemental-me.json`, 'Screenshot_20200301-161151.png'),
      // an orphan media with no sidecar
      media(`${Y}/orphan.jpg`),
    ];
    const result = await plan(inputs, 0);
    expect(planShape(result)).toMatchSnapshot();
  });
});

describe('[DEV 3] rotate-only edited copies', () => {
  const A = 'Takeout/Google Photos/Album A';
  const Y = 'Takeout/Google Photos/Photos from 2020';
  const base = () => [
    media(`${A}/X.jpg`),
    media(`${A}/X-edited.jpg`, 90),
    assetJson(`${A}/X.jpg.json`, 'X.jpg'),
    albumJson(`${A}/metadata.json`, 'Album A'),
    media(`${Y}/X.jpg`),
    media(`${Y}/X-edited.jpg`, 90),
    assetJson(`${Y}/X.jpg.json`, 'X.jpg'),
  ];

  it('drops both edited copies, rotates the Album A original, keeps only its album', async () => {
    const p = await plan(base(), 90);
    expect(actions(p, 'upload')).toEqual([`${A}/X.jpg`]);
    expect(byPath(p, `${A}/X.jpg`).rotation).toBe(90);
    expect(byPath(p, `${A}/X.jpg`).data?.albums.map((a) => a.title)).toEqual(['Album A']);
    expect(actions(p, 'rotateOnlyDropped').sort()).toEqual([`${A}/X-edited.jpg`, `${Y}/X-edited.jpg`].sort());
    expect(actions(p, 'localDuplicate')).toEqual([`${Y}/X.jpg`]);
  });

  // section 11 D1: every dropped rotate-only copy is exposed as (original, copy, angle) so B can rotate the
  // original, re-detect faces, reconcile people, then drop the copy. Both dropped copies (Album A and the year
  // folder, which shares the Album A original after the local-duplicate merge) point at the one imported original.
  it('exposes a rotatePairs entry per dropped copy pointing at the rotated original', async () => {
    const p = await plan(base(), 90);
    const original = byPath(p, `${A}/X.jpg`);
    const editedA = byPath(p, `${A}/X-edited.jpg`);
    const editedY = byPath(p, `${Y}/X-edited.jpg`);
    expect(p.rotatePairs.every((r) => r.originalKey === original.key && r.angle === 90)).toBe(true);
    expect(p.rotatePairs.map((r) => r.copyKey).sort((a, b) => a - b)).toEqual(
      [editedA.key, editedY.key].sort((a, b) => a - b),
    );
  });

  it('with a zero-angle probe keeps the edited copy and stacks it as cover [DEV 4]', async () => {
    const p = await plan(base(), 0);
    const uploads = actions(p, 'upload');
    expect(uploads).toContain(`${A}/X.jpg`);
    expect(uploads).toContain(`${A}/X-edited.jpg`);
    const group = p.groups.find((g) => g.members.length === 2)!;
    expect(group.kind).toBe('other');
    expect(byPath(p, `${A}/X-edited.jpg`).key).toBe(group.members[0]);
  });
});

describe('[DEV 4] edited copies stacked as other', () => {
  it('RAW + JPG + JPG-edited become one other group covered by the edit', async () => {
    const D = 'Takeout/Google Photos/Album';
    const p = await plan(
      [
        media(`${D}/IMG_1.dng`),
        media(`${D}/IMG_1.jpg`),
        media(`${D}/IMG_1-edited.jpg`, 110),
        assetJson(`${D}/IMG_1.dng.json`, 'IMG_1.dng'),
        assetJson(`${D}/IMG_1.jpg.json`, 'IMG_1.jpg'),
      ],
      0,
    );
    const group = p.groups.find((g) => g.members.length === 3)!;
    expect(group.kind).toBe('other');
    expect(byPath(p, `${D}/IMG_1-edited.jpg`).key).toBe(group.members[0]);
    expect(actions(p, 'upload').sort()).toEqual([`${D}/IMG_1-edited.jpg`, `${D}/IMG_1.dng`, `${D}/IMG_1.jpg`].sort());
  });

  it('HEIC + edited stays grouped as other even with heicJpg NoStack', async () => {
    const D = 'Takeout/Google Photos/Album';
    const p = await plan(
      [media(`${D}/IMG_2.heic`), media(`${D}/IMG_2-edited.jpg`, 110), assetJson(`${D}/IMG_2.heic.json`, 'IMG_2.heic')],
      0,
      { ...DEFAULT_TAKEOUT_SETTINGS, heicJpg: 'NoStack' },
    );
    const group = p.groups.find((g) => g.members.length === 2)!;
    expect(group.kind).toBe('other');
    expect(byPath(p, `${D}/IMG_2-edited.jpg`).key).toBe(group.members[0]);
  });

  it('DNG + edited with StackCoverRaw stays other, edited on top', async () => {
    const D = 'Takeout/Google Photos/Album';
    const p = await plan(
      [media(`${D}/IMG_3.dng`), media(`${D}/IMG_3-edited.jpg`, 110), assetJson(`${D}/IMG_3.dng.json`, 'IMG_3.dng')],
      0,
      { ...DEFAULT_TAKEOUT_SETTINGS, rawJpg: 'StackCoverRaw' },
    );
    const group = p.groups.find((g) => g.members.length === 2)!;
    expect(group.kind).toBe('other');
    expect(byPath(p, `${D}/IMG_3-edited.jpg`).key).toBe(group.members[0]);
  });
});

// section 11 D2: Google exports two distinct items that share one original name as "X.jpg" and "X(1).jpg" (same
// photoTakenTime, different bytes). immich-go's local-duplicate key is (on-disk base name, size), so the two on-disk
// names never collide there and both survive; the JSON title of both is the same original name, so the series/other
// grouper stacks them by shared radical. Both must become assets in one stack, never dropped as a local duplicate.
describe('[D2] same-name different-bytes X and X(1) are stacked', () => {
  const D = 'Takeout/Google Photos/Photos from 2021';

  // Both files carry the same JSON title 'X.jpg' (the shared original name) and the same capture time; only the
  // on-disk name and content differ. One stack of two assets, both uploaded.
  const stacksBoth = (p: ImportPlan) => {
    expect(actions(p, 'upload').sort()).toEqual([`${D}/X(1).jpg`, `${D}/X.jpg`].sort());
    expect(actions(p, 'localDuplicate')).toEqual([]);
    expect(actions(p, 'duplicatedInDirectory')).toEqual([]);
    const group = p.groups.find((g) => g.members.length === 2)!;
    expect(group).toBeDefined();
    expect(group.kind).toBe('other');
    expect(group.members).toContain(byPath(p, `${D}/X.jpg`).key);
    expect(group.members).toContain(byPath(p, `${D}/X(1).jpg`).key);
    // exactly one two-member stack, no leftover singleton group for either file
    expect(p.groups.filter((g) => g.members.length === 2)).toHaveLength(1);
  };

  it('stacks two same-name different-size items as one two-member stack', async () => {
    const p = await plan(
      [
        media(`${D}/X.jpg`, 100),
        media(`${D}/X(1).jpg`, 250),
        assetJson(`${D}/X.jpg.json`, 'X.jpg'),
        assetJson(`${D}/X(1).jpg.json`, 'X.jpg'),
      ],
      0,
    );
    stacksBoth(p);
  });

  it('stacks two same-size different-content items (distinguished by checksum) as one stack', async () => {
    // Same size (100) for both; media() derives a distinct checksum from the path, so the two are separate Google
    // items with different bytes. (base, size) still differs by on-disk base name, so neither is a local duplicate.
    const p = await plan(
      [
        media(`${D}/X.jpg`, 100),
        media(`${D}/X(1).jpg`, 100),
        assetJson(`${D}/X.jpg.json`, 'X.jpg'),
        assetJson(`${D}/X(1).jpg.json`, 'X.jpg'),
      ],
      0,
    );
    expect(byPath(p, `${D}/X.jpg`).checksum).not.toEqual(byPath(p, `${D}/X(1).jpg`).checksum);
    stacksBoth(p);
  });
});
