import { buildCatalog, CatalogAsset } from 'src/takeout/catalog';
import {
  albumFromJson,
  asMetadata,
  compactGoogleJson,
  googlePhotosExtra,
  parseGoogleJson,
} from 'src/takeout/google-json';
import { matchEdited } from 'src/takeout/matchers';
import { planImport } from 'src/takeout/planner';
import { DEFAULT_TAKEOUT_SETTINGS } from 'src/takeout/settings';
import { CatalogInput, GoogleMetadata } from 'src/takeout/types';
import { describe, expect, it } from 'vitest';

const PART = 'takeout-20260914T211500Z-1-001.tgz';
const media = (path: string): CatalogInput => ({
  partName: PART,
  path,
  size: 10,
  mtime: null,
  kind: 'media',
  json: null,
  checksum: Buffer.from(path),
  sample: null,
});
const json = (path: string, title: string): CatalogInput => ({
  partName: PART,
  path,
  size: 20,
  mtime: null,
  kind: 'json',
  json: { title, photoTakenTime: { timestamp: '1700000000' } },
  checksum: null,
  sample: null,
});

async function matchedIn(inputs: CatalogInput[]): Promise<Map<string, CatalogAsset>> {
  const catalog = await buildCatalog(inputs);
  const map = new Map<string, CatalogAsset>();
  for (const list of catalog.assetsByDir.values()) {
    for (const asset of list) {
      map.set(asset.base, asset);
    }
  }
  return map;
}

// Spec 6.1 #2: [DEV 1] engine correctness on the Screenshot ambiguity.
describe('[DEV 1] matcher engine', () => {
  it('claims Screenshot_22-edited.png with its own JSON, never the Screenshot_2 JSON', async () => {
    const dir = 'Takeout/Google Photos/Album';
    const matched = await matchedIn([
      media(`${dir}/Screenshot_2.png`),
      json(`${dir}/Screenshot_2.png.supplemental-metadata.json`, 'Screenshot_2.png'),
      media(`${dir}/Screenshot_22.png`),
      media(`${dir}/Screenshot_22-edited.png`),
      json(`${dir}/Screenshot_22.png.supplemental-metadata.json`, 'Screenshot_22.png'),
    ]);
    expect(matched.get('Screenshot_2.png')?.jsonPath).toBe(`${dir}/Screenshot_2.png.supplemental-metadata.json`);
    expect(matched.get('Screenshot_22.png')?.jsonPath).toBe(`${dir}/Screenshot_22.png.supplemental-metadata.json`);
    expect(matched.get('Screenshot_22-edited.png')?.jsonPath).toBe(
      `${dir}/Screenshot_22.png.supplemental-metadata.json`,
    );
    expect(matched.get('Screenshot_22-edited.png')?.matcher).toBe('edited');
  });

  it('rejects the known Go-wrong edited claims', () => {
    expect(matchEdited('Screenshot_2.png.supplemental-metadata.json', 'Screenshot_22-edited.png')).toBe(false);
    expect(matchEdited('Screenshot_2.png.supplemental-metadata.json', 'Screenshot_20210528-084739-edited.png')).toBe(
      false,
    );
    expect(matchEdited('Screenshot_2.png.supplemental-metadata.json', 'Screenshot_20220514-092533-edited.png')).toBe(
      false,
    );
    expect(matchEdited('20250411_183451.jpg.supplemental-metadata.json', '20250411_183451~2-edited.jpg')).toBe(false);
  });

  it('claims a cut-short JSON of an edited name, an NFD edited copy and an uppercase EDITED', async () => {
    const dir = 'd';
    const matched = await matchedIn([
      media(`${dir}/IMG-20230325-WA0122~2-edited.jpg`),
      json(`${dir}/IMG-20230325-WA0122~2.jpg.supplemental-metadat.json`, 'IMG-20230325-WA0122~2.jpg'),
      media(`${dir}/PORTRAIT-modifié.jpg`),
      json(`${dir}/PORTRAIT.jpg.json`, 'PORTRAIT.jpg'),
      media(`${dir}/IMG_1-EDITED.jpg`),
      json(`${dir}/IMG_1.jpg.json`, 'IMG_1.jpg'),
    ]);
    expect(matched.get('IMG-20230325-WA0122~2-edited.jpg')?.matcher).toBe('edited');
    // The catalog stores the NFC form of the on-disk name as the key.
    expect(matched.get('PORTRAIT-modifié.jpg'.normalize('NFC'))?.matcher).toBe('edited');
    expect(matched.get('IMG_1-EDITED.jpg')?.matcher).toBe('edited');
  });

  it('claims X.COVER.jp/.j at the cut length but not below it', () => {
    const longStem = 'A'.repeat(40); // pushes the JSON stem past the cut length
    expect(matchEdited(`${longStem}.COVER.jp.json`, `${longStem}.COVER.jpg`)).toBe(true);
    expect(matchEdited(`${longStem}.COVER.j.json`, `${longStem}.COVER.jpg`)).toBe(true);
    expect(matchEdited('X.COVER.jp.json', 'X.COVER.jpg')).toBe(false);
  });

  it('gives every file of a real year folder its own JSON, with full and cut sidecar names side by side', async () => {
    // names of family assets from the 2026-09 Takeouts (full names), plus two with the older cut names
    const dir = 'Takeout/Google Photos/Photos from 2019';
    const full = [
      '[RWBY MMD] Apple Pie - Sisterly HD [JIC JIC] - Pornhub.com.mp4',
      'Rwby Nora Gang Bang - Pornhub.com.mp4',
      '[iRB] Toxic (pyrrha, Weiss, Blake) - Pornhub.com.mp4',
      '11024379_800533190002620_1254948441_n.jpg',
      '11024379_800533190002620_1254948441_n-fr3.jpg',
      'deadmoon114_1481316161512.jpg',
      'Screenshot_2016-08-08-21-24-25.png',
    ];
    const cut = new Map([
      [
        '20170608-120938-0074450 11024379_800533190002620_1254948441_n.jpg',
        '20170608-120938-0074450 11024379_8005331900026.json',
      ],
      ['20161210-001810-0082642 deadmoon114_1481316161512.jpg', '20161210-001810-0082642 deadmoon114_1481316161.json'],
    ]);
    const inputs: CatalogInput[] = [];
    for (const name of full) {
      inputs.push(media(`${dir}/${name}`), json(`${dir}/${name}.supplemental-metadata.json`, name));
    }
    for (const [name, jsonName] of cut) {
      inputs.push(media(`${dir}/${name}`), json(`${dir}/${jsonName}`, name));
    }

    const matched = await matchedIn(inputs);
    for (const name of full) {
      expect(matched.get(name)?.jsonPath, name).toBe(`${dir}/${name}.supplemental-metadata.json`);
    }
    for (const [name, jsonName] of cut) {
      expect(matched.get(name)?.jsonPath, name).toBe(`${dir}/${jsonName}`);
    }
  });
});

const skipped = (path: string, kind: CatalogInput['kind']): CatalogInput => ({ ...media(path), kind });

async function orphans(inputs: CatalogInput[]): Promise<string[]> {
  const catalog = await buildCatalog(inputs);
  return catalog.summary.jsonWithoutMedia;
}

describe('JSONs that no media file claims', () => {
  it('does not count the JSON of a failed video or of an unsupported file as an orphan', async () => {
    // family exports: the media files are in the Takeout and left out on purpose
    const failed = 'Takeout/Google Photos/Failed Videos/VID_20191220_162138.mp4';
    const jfif = 'Takeout/Google Photos/Photos from 2019/2f31d892e412448ef338315d4da62a80.jfif';
    const missing = 'Takeout/Google Photos/Photos from 2019/IMG_20190101_101010.jpg';
    const inputs = [
      media(failed),
      json(`${failed}.supplemental-metadata.json`, 'VID_20191220_162138.mp4'),
      skipped(jfif, 'unsupported'),
      json(`${jfif}.supplemental-metadata.json`, '2f31d892e412448ef338315d4da62a80.jfif'),
      json(`${missing}.supplemental-metadata.json`, 'IMG_20190101_101010.jpg'),
    ];
    expect(await orphans(inputs)).toEqual([`${missing}.supplemental-metadata.json`]);

    const plan = await planImport(await buildCatalog(inputs), DEFAULT_TAKEOUT_SETTINGS, {
      rotationProbe: () => Promise.resolve(0),
    });
    const row = (path: string) => plan.files.find((f) => f.takeoutPath === path)!;
    expect(row(failed)).toMatchObject({ action: 'failedVideo', jsonPath: `${failed}.supplemental-metadata.json` });
    expect(row(`${failed}.supplemental-metadata.json`)).toMatchObject({
      action: 'assetJsonUnused',
      reason: 'its media file is in the Takeout but not imported (failed video)',
    });
    expect(row(jfif)).toMatchObject({ action: 'unsupported', jsonPath: `${jfif}.supplemental-metadata.json` });
    expect(row(`${jfif}.supplemental-metadata.json`)).toMatchObject({
      action: 'assetJsonUnused',
      reason: 'its media file is in the Takeout but not imported (unsupported type)',
    });
    expect(row(`${missing}.supplemental-metadata.json`)).toMatchObject({ action: 'assetJsonUnused', reason: null });
  });

  it('still counts the JSON of a missing photo that only a loose matcher ties to a skipped file', async () => {
    const dir = 'Takeout/Google Photos/Photos from 2019';
    expect(
      await orphans([
        skipped(`${dir}/MVIMG_20190509_114254.mp4`, 'useless'),
        json(`${dir}/MVIMG_20190509_114254.jpg.supplemental-metadata.json`, 'MVIMG_20190509_114254.jpg'),
      ]),
    ).toEqual([`${dir}/MVIMG_20190509_114254.jpg.supplemental-metadata.json`]);
  });

  it('does not count a numbered spare of a JSON that has its media as an orphan', async () => {
    // family export: 'X.jpg.supplemental-metadata(1).json' next to the JSON of 'X.jpg', and no 'X(1).jpg'
    const dir = 'Takeout/Google Photos/Photos from 2019';
    const received = 'received_394369767875204';
    const inputs = [
      media(`${dir}/MVIMG_20190509_114254.jpg`),
      json(`${dir}/MVIMG_20190509_114254.jpg.supplemental-metadata.json`, 'MVIMG_20190509_114254.jpg'),
      json(`${dir}/MVIMG_20190509_114254.jpg.supplemental-metadata(1).json`, 'MVIMG_20190509_114254.jpg'),
      // Google's cut names, next to an edited copy (retro-fix listing of the family Takeouts)
      media(`${dir}/${received}.jpeg`),
      media(`${dir}/${received}-edited.jpeg`),
      json(`${dir}/${received}.jpeg.supplemental-met.json`, `${received}.jpeg`),
      json(`${dir}/${received}.jpeg.supplemental-met(1).json`, `${received}.jpeg`),
    ];
    expect(await orphans(inputs)).toEqual([]);

    const plan = await planImport(await buildCatalog(inputs), DEFAULT_TAKEOUT_SETTINGS, {
      rotationProbe: () => Promise.resolve(0),
    });
    const spare = 'a spare numbered copy of the JSON that has its media file';
    expect(
      plan.files.filter((f) => f.action === 'assetJsonUnused').map((f) => [f.takeoutPath.split('/').pop(), f.reason]),
    ).toEqual([
      ['MVIMG_20190509_114254.jpg.supplemental-metadata(1).json', spare],
      [`${received}.jpeg.supplemental-met(1).json`, spare],
    ]);
  });

  it('still gives X(1).jpg its numbered JSON, and counts a numbered JSON without a sibling or with a file as an orphan', async () => {
    const dir = 'd';
    const catalog = await buildCatalog([
      media(`${dir}/IMG_1.jpg`),
      media(`${dir}/IMG_1(1).jpg`),
      json(`${dir}/IMG_1.jpg.supplemental-metadata.json`, 'IMG_1.jpg'),
      json(`${dir}/IMG_1.jpg.supplemental-metadata(1).json`, 'IMG_1.jpg'),
      // no unnumbered sibling
      json(`${dir}/IMG_2.jpg.supplemental-metadata(1).json`, 'IMG_2.jpg'),
      // 'IMG_3(1).jpg' is there but its old-style JSON claims it first: the numbered JSON is no spare
      media(`${dir}/IMG_3.jpg`),
      media(`${dir}/IMG_3(1).jpg`),
      json(`${dir}/IMG_3(1).jpg.json`, 'IMG_3(1).jpg'),
      json(`${dir}/IMG_3.jpg.supplemental-metadata.json`, 'IMG_3.jpg'),
      json(`${dir}/IMG_3.jpg.supplemental-metadata(1).json`, 'IMG_3.jpg'),
      // the unnumbered sibling is an orphan itself
      json(`${dir}/IMG_4.jpg.supplemental-metadata.json`, 'IMG_4.jpg'),
      json(`${dir}/IMG_4.jpg.supplemental-metadata(1).json`, 'IMG_4.jpg'),
    ]);
    const assets = new Map(catalog.assetsByDir.get(dir)!.map((asset) => [asset.base, asset]));
    expect(assets.get('IMG_1(1).jpg')).toMatchObject({
      jsonPath: `${dir}/IMG_1.jpg.supplemental-metadata(1).json`,
      matcher: 'normal',
    });
    expect(assets.get('IMG_1.jpg')?.jsonPath).toBe(`${dir}/IMG_1.jpg.supplemental-metadata.json`);
    expect(catalog.summary.jsonWithoutMedia).toEqual([
      `${dir}/IMG_2.jpg.supplemental-metadata(1).json`,
      `${dir}/IMG_3.jpg.supplemental-metadata(1).json`,
      `${dir}/IMG_4.jpg.supplemental-metadata.json`,
      `${dir}/IMG_4.jpg.supplemental-metadata(1).json`,
    ]);
  });
});

// Spec 6.1 #11: compact JSON keeps every field the parsers read.
describe('compactGoogleJson round trip', () => {
  const fixtures: string[] = [
    `{"title":"a.jpg","imageViews":"12","creationTime":{"timestamp":"1704200000"},"photoTakenTime":{"timestamp":"1704110400"},"geoData":{"latitude":1.5,"longitude":2.5,"altitude":30.5},"geoDataExif":{"latitude":0,"longitude":0,"altitude":0},"people":[{"name":"Alice"}],"url":"https://x","googlePhotosOrigin":{"fromSharedAlbum":{}},"appSource":{"androidPackageName":"com.whatsapp"},"composition":{"type":"AUTO"},"sharedAlbumComments":[{"creationTime":{"timestamp":"1"},"contentOwnerName":"Carol","text":"nice"}]}`,
    `{"title":"Album","enrichments":[{"locationEnrichment":{"location":[{"name":"Here","description":"There","latitudeE7":488029439,"longitudeE7":24854290}]}}]}`,
    `{"albumData":{"title":"Trip","date":{"timestamp":"1502439626"}}}`,
  ];
  for (const [i, fixture] of fixtures.entries()) {
    it(`fixture ${i}`, () => {
      const raw = JSON.parse(fixture);
      const fromRaw = parseGoogleJson(raw) as GoogleMetadata;
      const fromCompact = parseGoogleJson(compactGoogleJson(raw)) as GoogleMetadata;
      expect(asMetadata(fromCompact)).toEqual(asMetadata(fromRaw));
      expect(googlePhotosExtra(fromCompact)).toEqual(googlePhotosExtra(fromRaw));
      expect(albumFromJson(fromCompact)).toEqual(albumFromJson(fromRaw));
    });
  }
});

// Spec 6.1 #12 (loose): a 100k-file catalog plans without stalling.
describe('scale', () => {
  it('builds and plans a 100k-file catalog', async () => {
    const inputs: CatalogInput[] = [];
    const dirs = 20;
    const perDir = 2500;
    for (let d = 0; d < dirs; d++) {
      const dir = `Takeout/Google Photos/Photos from ${2000 + d}`;
      for (let i = 0; i < perDir; i++) {
        const name = `IMG_${d}_${i}.jpg`;
        inputs.push(media(`${dir}/${name}`), json(`${dir}/${name}.json`, name));
      }
    }
    expect(inputs).toHaveLength(dirs * perDir * 2);
    const start = Date.now();
    const catalog = await buildCatalog(inputs);
    const plan = await planImport(catalog, DEFAULT_TAKEOUT_SETTINGS, { rotationProbe: () => Promise.resolve(0) });
    expect(plan.files.filter((f) => f.action === 'upload')).toHaveLength(dirs * perDir);
    expect(Date.now() - start).toBeLessThan(30_000);
  }, 30_000);
});
