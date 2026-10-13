import { CUT_LENGTH, MATCHERS } from 'src/takeout/matchers';
import { describe, expect, it } from 'vitest';

// Reproduces how Google Takeout shortens a supplemental-metadata sidecar name: "<media>.supplemental-metadata"
// is cut to CUT_LENGTH UTF-16 units, then ".json" is appended. Kept in the test so the generator that feeds
// the cut-short matcher cases stays pinned to the same truncation rule the matcher relies on.
function cutShortJsonName(mediaName: string): string {
  const full = `${mediaName}.supplemental-metadata`;
  const stem = full.length > CUT_LENGTH ? full.slice(0, CUT_LENGTH) : full;
  return `${stem}.json`;
}

// "X.jpg" -> "X(n).jpg", how Google names the n-th file with the same name in a folder
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return `${name.slice(0, dot)}(${n})${name.slice(dot)}`;
}

function firstMatcher(jsonName: string, fileName: string): string {
  for (const matcher of MATCHERS) {
    if (matcher.fn(jsonName, fileName)) {
      return matcher.name;
    }
  }
  return '';
}

// Ported from immich-go adapters/googlePhotos/matcher_test.go Test_matchers.
// Go 'matchEditedName' maps to the [DEV 1] 'edited' matcher.
const rows: Array<{ jsonName: string; fileName: string; want: string }> = [
  { jsonName: 'PXL_20211013_220651983.jpg.json', fileName: 'PXL_20211013_220651983.jpg', want: 'fastTrack' },
  { jsonName: 'PXL_20211013_220651983.jpg.json', fileName: 'PXL_20211013_220651958.jpg', want: '' },
  {
    jsonName: 'PXL_20220405_090123740.PORTRAIT.jpg.json',
    fileName: 'PXL_20220405_090123740.PORTRAIT-modifié.jpg',
    want: 'edited',
  },
  {
    jsonName: 'PXL_20220405_090123740.PORTRAIT.jpg.json',
    fileName: 'PXL_20220405_090123741.PORTRAIT-modifié.jpg',
    want: '',
  },
  { jsonName: 'DSC_0100.JPG.json', fileName: 'DSC_0100.JPG', want: 'fastTrack' },
  { jsonName: 'DSC_0101.JPG(1).json', fileName: 'DSC_0101(1).JPG', want: 'normal' },
  { jsonName: 'DSC_0102.JPG(2).json', fileName: 'DSC_0102(1).JPG', want: '' },
  { jsonName: 'DSC_0103.JPG(1).json', fileName: 'DSC_0103.JPG', want: '' },
  { jsonName: 'DSC_0104.JPG.json', fileName: 'DSC_0104(1).JPG', want: '' },
  { jsonName: 'IMG_2710.HEIC(1).json', fileName: 'IMG_2710(1).HEIC', want: 'normal' },
  { jsonName: 'PXL_20231118_035751175.MP.jpg.json', fileName: 'PXL_20231118_035751175.MP.jpg', want: 'fastTrack' },
  {
    jsonName: 'PXL_20230809_203449253.LONG_EXPOSURE-02.ORIGIN.json',
    fileName: 'PXL_20230809_203449253.LONG_EXPOSURE-02.ORIGINA.jpg',
    want: 'normal',
  },
  {
    jsonName: '05yqt21kruxwwlhhgrwrdyb6chhwszi9bqmzu16w0 2.jp.json',
    fileName: '05yqt21kruxwwlhhgrwrdyb6chhwszi9bqmzu16w0 2.jpg',
    want: 'normal',
  },
  {
    jsonName: '😀😃😄😁😆😅😂🤣🥲☺️😊😇🙂🙃😉😌😍🥰😘😗😙😚😋.json',
    fileName: '😀😃😄😁😆😅😂🤣🥲☺️😊😇🙂🙃😉😌😍🥰😘😗😙😚😋😛.jpg',
    want: 'normal',
  },
  {
    jsonName: 'Backyard_ceremony_wedding_photography_xxxxxxx_(494).json',
    fileName: 'Backyard_ceremony_wedding_photography_xxxxxxx_m(494).jpg',
    want: 'normal',
  },
  {
    jsonName: 'Backyard_ceremony_wedding_photography_xxxxxxx_(494).json',
    fileName: 'Backyard_ceremony_wedding_photography_xxxxxxx_m(185).jpg',
    want: '',
  },
  {
    jsonName: 'original_1d4caa6f-16c6-4c3d-901b-9387de10e528_.json',
    fileName: 'original_1d4caa6f-16c6-4c3d-901b-9387de10e528_P.jpg',
    want: 'normal',
  },
  {
    jsonName: 'original_1d4caa6f-16c6-4c3d-901b-9387de10e528_.json',
    fileName: 'original_1d4caa6f-16c6-4c3d-901b-9387de10e528_P(1).jpg',
    want: 'forgottenDuplicates',
  },
  { jsonName: 'PXL_20210102_221126856.MP~2.jpg.json', fileName: 'PXL_20210102_221126856.MP~2.jpg', want: 'fastTrack' },
  {
    jsonName: '13039_327707840323_537645323_9470255_27214_n.j(1).json',
    fileName: '13039_327707840323_537645323_9470255_27214_n(1).jpg',
    want: 'normal',
  },
  { jsonName: '20161105_170829.jpg.supplemental-metadata.json', fileName: '20161105_170829.jpg', want: 'normal' },
  {
    jsonName: 'Screenshot_20231027_123303_Facebook.jpg.supple.json',
    fileName: 'Screenshot_20231027_123303_Facebook.jpg',
    want: 'normal',
  },
  {
    jsonName: 'Screenshot_20231027_123303_Facebook.jpg.supple(1).json',
    fileName: 'Screenshot_20231027_123303_Facebook(1).jpg',
    want: 'normal',
  },
  {
    jsonName: 'MVIMG_20191230_232926.jpg.supplemental-metadat.json',
    fileName: 'MVIMG_20191230_232926.jpg',
    want: 'normal',
  },
  {
    jsonName: 'Screenshot_20200301-161151.png.supplemental-me.json',
    fileName: 'Screenshot_20200301-161151.png',
    want: 'normal',
  },
  {
    jsonName: 'MVIMG_20200207_134534~2.jpg.supplemental-metad.json',
    fileName: 'MVIMG_20200207_134534~2.jpg',
    want: 'normal',
  },
  { jsonName: 'Scan35.jpg.supplemental-metadata(1).json', fileName: 'Scan35(1).jpg', want: 'normal' },
  { jsonName: 'CLIP0001.AVI.supplemental-metadata(10).json', fileName: 'CLIP0001(10).AVI', want: 'normal' },
  { jsonName: 'IMAG0061.JPG.supplemental-metadata.json', fileName: 'IMAG0061-edited.JPG', want: 'edited' },
  {
    jsonName: 'IMG-20230325-WA0122~2.jpg.supplemental-metadat.json',
    fileName: 'IMG-20230325-WA0122~2-edited.jpg',
    want: 'edited',
  },
  {
    jsonName: '2234089303984509579.supplemental-metadata.json',
    fileName: '2234089303984509579-edited.jpg',
    want: 'edited',
  },
  {
    jsonName: 'Screenshot_20231027_123303_Facebook.jpg.supple.json',
    fileName: 'Screenshot_20231027_123303_Facebook-edited.jpg',
    want: 'edited',
  },
  {
    jsonName: 'Screenshot_20231027_123303_Facebook.jpg.supple(1).json',
    fileName: 'Screenshot_20231027_123303_Facebook(1).jpg',
    want: 'normal',
  },
  {
    jsonName: 'Screenshot_2024-08-31-00-53-48-647_com.snapcha.json',
    fileName: 'Screenshot_2024-08-31-00-53-48-647_com.snapchat.jpg',
    want: 'normal',
  },
];

describe('matchers (Test_matchers table)', () => {
  for (const row of rows) {
    it(`${row.fileName} -> ${row.want || 'none'}`, () => {
      expect(firstMatcher(row.jsonName, row.fileName)).toBe(row.want);
    });
  }
});

describe('cut-short sidecar generator', () => {
  // media names long enough that "<media>.supplemental-metadata" overflows CUT_LENGTH
  const media = [
    'MVIMG_20191230_232926.jpg',
    'Screenshot_20200301-161151.png',
    'MVIMG_20200207_134534~2.jpg',
    'Screenshot_2024-08-31-00-53-48-647_com.snapchat.jpg',
  ];

  it('CUT_LENGTH matches Google Takeout truncation length', () => {
    expect(CUT_LENGTH).toBe(46);
  });

  it('reproduces the exact truncated names immich-go observed', () => {
    expect(cutShortJsonName('MVIMG_20191230_232926.jpg')).toBe('MVIMG_20191230_232926.jpg.supplemental-metadat.json');
    expect(cutShortJsonName('Screenshot_20200301-161151.png')).toBe(
      'Screenshot_20200301-161151.png.supplemental-me.json',
    );
  });

  for (const name of media) {
    it(`cuts ${name} to a ${CUT_LENGTH}-unit stem the normal matcher still claims`, () => {
      const jsonName = cutShortJsonName(name);
      expect(jsonName.endsWith('.json')).toBe(true);
      expect(jsonName.slice(0, -'.json'.length).length).toBe(CUT_LENGTH);
      expect(firstMatcher(jsonName, name)).toBe('normal');
    });
  }

  it('leaves a short name untruncated with the full supplemental-metadata trailer', () => {
    expect(cutShortJsonName('a.jpg')).toBe('a.jpg.supplemental-metadata.json');
    expect(firstMatcher('a.jpg.supplemental-metadata.json', 'a.jpg')).toBe('normal');
  });
});

// The sidecar names Google Takeout has used for one media file, each with the file it belongs to
function variants(name: string): Array<{ label: string; json: string; file: string }> {
  const cut = cutShortJsonName(name);
  const legacy = name.length > CUT_LENGTH ? `${name.slice(0, CUT_LENGTH)}.json` : `${name}.json`;
  return [
    { label: 'full supplemental-metadata', json: `${name}.supplemental-metadata.json`, file: name },
    { label: 'cut supplemental-metadata', json: cut, file: name },
    { label: 'legacy .json', json: legacy, file: name },
    {
      label: 'numbered full',
      json: `${name}.supplemental-metadata(1).json`,
      file: numbered(name, 1),
    },
    { label: 'numbered cut', json: `${cut.slice(0, -'.json'.length)}(1).json`, file: numbered(name, 1) },
  ];
}

// Names of assets that ended up with a file-time date on immich-family (2026-09). Their Takeouts name every sidecar
// "<media>.supplemental-metadata.json" in full (no cut, up to 79 characters); older Takeouts cut the name to
// CUT_LENGTH or used "<media>.json", and add "(n)" after the cut for a same-name file. Every variant must claim its file
// and never a sibling.
describe('real Takeout names, every sidecar naming variant', () => {
  const names = [
    '[RWBY MMD] Apple Pie - Sisterly HD [JIC JIC] - Pornhub.com.mp4',
    'Rwby Nora Gang Bang - Pornhub.com.mp4',
    '[iRB] Toxic (pyrrha, Weiss, Blake) - Pornhub.com.mp4',
    '20170608-120938-0074450 11024379_800533190002620_1254948441_n.jpg',
    '20161106-010749-0081545 Screenshot_2016-08-08-21-24-25.png',
    '0074459_11267034_709562962489093_938898794_n.jpg',
    '20161210-001810-0082642 deadmoon114_1481316161512.jpg',
    'Snapchat-1615986030.jpg',
    'MVIMG_20190118_181717-ANIMATION.gif',
    'IMG_20190309_193741-ANIMATION.gif',
    'Screenshot_2016-07-25-12-58-11.png',
  ];

  for (const name of names) {
    for (const { label, json, file } of variants(name)) {
      it(`${label}: ${json} claims ${file}`, () => {
        expect(firstMatcher(json, file)).not.toBe('');
      });
    }
  }

  it('no variant of one name claims another of these names', () => {
    for (const name of names) {
      for (const { json } of variants(name)) {
        for (const other of names) {
          if (other !== name) {
            expect(firstMatcher(json, other), `${json} -> ${other}`).toBe('');
          }
        }
      }
    }
  });
});
