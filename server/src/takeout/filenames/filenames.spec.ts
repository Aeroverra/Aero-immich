import { getInfo } from 'src/takeout/filenames/info-collector';
import { NameInfo } from 'src/takeout/filenames/name-info';
import { takeTimeFromPath } from 'src/takeout/filenames/names-date';
import { describe, expect, it } from 'vitest';

const ZONE = 'UTC';
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms)).getTime();

function check(name: string, want: Partial<NameInfo> & { takenMs?: number | null }) {
  const info = getInfo(name, ZONE);
  for (const [key, value] of Object.entries(want)) {
    if (key === 'takenMs') {
      expect(info.taken === null ? null : info.taken.getTime()).toBe(value);
    } else {
      expect((info as unknown as Record<string, unknown>)[key]).toBe(value);
    }
  }
}

// Ported from internal/filenames pixel_test.go, samsung_test.go, nexus_test.go, huawei_test.go, sony_xperia_test.go, info_test.go.
describe('getInfo brand parsers', () => {
  it('Pixel', () => {
    check('PXL_20231026_210642603.dng', {
      radical: 'PXL_20231026_210642603',
      ext: '.dng',
      type: 'image',
      kind: 'none',
      index: 0,
      isCover: false,
      takenMs: utc(2023, 10, 26, 21, 6, 42),
    });
    check('PXL_20231207_032111247.RAW-02.ORIGINAL.dng', {
      radical: 'PXL_20231207_032111247',
      ext: '.dng',
      index: 2,
      isCover: false,
      kind: 'none',
    });
    check('PXL_20231207_032111247.RAW-01.COVER.jpg', {
      radical: 'PXL_20231207_032111247',
      ext: '.jpg',
      index: 1,
      isCover: true,
    });
    check('PXL_20230330_184138390.MOTION-01.COVER.jpg', { kind: 'motion', index: 1, isCover: true });
    check('PXL_20230809_203029471.LONG_EXPOSURE-01.COVER.jpg', { kind: 'longExposure', index: 1, isCover: true });
    check('PXL_20240615_204528165.NIGHT.RAW-02.ORIGINAL.dng', { kind: 'night', index: 2, isCover: false });
    check('PXL_20250705_134305548.VB-01.COVER.mp4', { kind: 'videoBoost', type: 'video', index: 1, isCover: true });
    check('PXL_20250705_134305548.VB-02.MAIN.mp4', { kind: 'videoBoost', type: 'video', index: 2, isCover: false });
    check('PXL_20250803_113209979.NS-01.COVER.mp4', { kind: 'nightSightVideo', index: 1, isCover: true });
    check('PXL_20250803_113209979.NS-02.MAIN.mp4', { kind: 'nightSightVideo', index: 2, isCover: false });
    check('PXL_20250726_093641990.VB-02.MAIN~2.mp4', { kind: 'none', index: 2, isCover: false, type: 'video' });
    check('PXL_20250726_093641990.LS.mp4', { kind: 'none', index: 0, type: 'video' });
  });

  it('Samsung', () => {
    check('20231207_101605_001.jpg', {
      radical: '20231207_101605',
      kind: 'burst',
      index: 1,
      isCover: true,
      takenMs: utc(2023, 12, 7, 10, 16, 5),
    });
    check('20231207_101605_031.jpg', { radical: '20231207_101605', kind: 'burst', index: 31, isCover: false });
  });

  it('Nexus', () => {
    check('00001IMG_00001_BURST20171111030039.jpg', {
      radical: 'BURST20171111030039',
      kind: 'burst',
      index: 1,
      isCover: false,
      takenMs: utc(2017, 11, 11, 3, 0, 39),
    });
    check('00015IMG_00015_BURST20171111030039_COVER.jpg', { index: 15, isCover: true });
    check('00100lPORTRAIT_00100_BURST20181229213517346_COVER.jpg', {
      radical: 'BURST20181229213517346',
      index: 100,
      isCover: true,
      takenMs: utc(2018, 12, 29, 21, 35, 17, 346),
    });
    check('00002IMG_00002_BURST1723801037429.jpg', {
      radical: 'BURST1723801037429',
      index: 2,
      takenMs: 1_723_801_037_429,
    });
  });

  it('Huawei', () => {
    check('IMG_20231014_183246_BURST001_COVER.jpg', {
      radical: 'IMG_20231014_183246',
      kind: 'burst',
      index: 1,
      isCover: true,
      takenMs: utc(2023, 10, 14, 18, 32, 46),
    });
    check('IMG_20231014_183246_BURST002.jpg', { index: 2, isCover: false });
  });

  it('Sony Xperia', () => {
    check('DSC_0001_BURST20230709220904977.JPG', {
      radical: 'BURST20230709220904977',
      ext: '.jpg',
      kind: 'burst',
      index: 1,
      isCover: false,
      takenMs: utc(2023, 7, 9, 22, 9, 4, 977),
    });
    check('DSC_0052_BURST20230709220904977_COVER.JPG', { index: 52, isCover: true });
  });

  it('Regular and invalid names', () => {
    check('IMG_20171111_030128.jpg', {
      radical: 'IMG_20171111_030128',
      ext: '.jpg',
      type: 'image',
      kind: 'none',
      takenMs: utc(2017, 11, 11, 3, 1, 28),
    });
    check('IMG_1123.jpg', { radical: 'IMG_1123', ext: '.jpg', type: 'image', kind: 'none', index: 0, takenMs: null });
  });
});

// Ported from internal/filenames namesdate_test.go TestTakeTimeFromPath (tz UTC).
describe('takeTimeFromPath', () => {
  const cases: Array<{ name: string; expected: number | null }> = [
    { name: '2024.png', expected: null },
    { name: '2024-05.png', expected: null },
    { name: 'A/B/2022/2022.11/2022.11.09/IMG_1234.HEIC', expected: utc(2022, 11, 9) },
    { name: 'A/B/2022/2022.11/IMG_1234.HEIC', expected: null },
    { name: 'A/B/2022.11.09/2022.11/2022/IMG_1234.HEIC', expected: utc(2022, 11, 9) },
    { name: '2024-05-05.png', expected: utc(2024, 5, 5) },
    { name: 'PXL_20220909_154515546.TS.mp4', expected: utc(2022, 9, 9, 15, 45, 15) },
    { name: 'Screenshot from 2022-12-17 19-45-43.png', expected: utc(2022, 12, 17, 19, 45, 43) },
    { name: 'Bebop2_20180719194940+0200.mp4', expected: utc(2018, 7, 19, 19, 49, 40) },
    { name: 'AR_EFFECT_20141126193511.mp4', expected: utc(2014, 11, 26, 19, 35, 11) },
    { name: '2023-07-20 14:15:30', expected: utc(2023, 7, 20, 14, 15, 30) },
    { name: '20001010120000', expected: utc(2000, 10, 10, 12, 0, 0) },
    { name: '2023_07_20_10_09_20.mp4', expected: utc(2023, 7, 20, 10, 9, 20) },
    { name: '19991231', expected: utc(1999, 12, 31) },
    { name: '991231-125200', expected: null },
    { name: '20223112-125200', expected: null },
    { name: '00015IMG_00015_BURST20171111030039_COVER.jpg', expected: utc(2017, 11, 11, 3, 0, 39) },
    { name: 'IMG_1234.HEIC', expected: null },
    { name: '20221109/IMG_1234.HEIC', expected: utc(2022, 11, 9) },
    { name: '20221109T2030/IMG_1234.HEIC', expected: utc(2022, 11, 9, 20, 30) },
    { name: '2022.11.09T20.30/IMG_1234.HEIC', expected: utc(2022, 11, 9, 20, 30) },
    { name: '2022/11/09/IMG_1234.HEIC', expected: utc(2022, 11, 9) },
    { name: 'something_2011-05-11 something/IMG_1234.JPG', expected: utc(2011, 5, 11) },
    { name: '2021-05-27_overlay~zip-9C801DD4-6F9C-4E7B-A2D1-08C136E43C0.webp', expected: utc(2021, 5, 27) },
    { name: '2020-06-25_js-EjQSFXMSRzqjMGZ4WTBjulPZ21MRG9KVxoAGgAyAQdIAIAEYAE.mp4', expected: utc(2020, 6, 25) },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const got = takeTimeFromPath(c.name, ZONE);
      expect(got === null ? null : got.getTime()).toBe(c.expected);
    });
  }
});
