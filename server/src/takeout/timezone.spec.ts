import { classifyDevice, resolveCaptureTime, sidecarDateString, wallTimeAsUtc } from 'src/takeout/timezone';
import { CaptureExifInput, CaptureTimeResult } from 'src/takeout/types';
import { describe, expect, it } from 'vitest';

// A wall clock as UTC calendar components (what deriveCaptureExif hands the library).
function wall(iso: string): Date {
  return new Date(`${iso}Z`);
}

const NO_EXIF: CaptureExifInput = {
  make: null,
  model: null,
  fileOffsetZone: null,
  fileHasGps: false,
  fileClock: null,
  fileClockIsUtc: false,
  gpsDateTime: null,
};

const PHONE = { make: 'Google', model: 'Pixel 7' };
const IPHONE = { make: 'Apple', model: 'iPhone 14' };
const CAMERA = { make: 'Sony', model: 'ILCE-6400' };

describe('classifyDevice', () => {
  const cases: Array<[string | null, string | null, string]> = [
    ['Apple', 'iPhone 14 Pro', 'phone'],
    ['Google', 'Pixel 7', 'phone'],
    ['LG Electronics', 'LM-G710', 'phone'],
    ['motorola', 'moto g', 'phone'],
    ['OnePlus', 'GM1913', 'phone'],
    ['HTC', 'HTC6535LVW', 'phone'],
    ['HUAWEI', 'VOG-L29', 'phone'],
    ['Xiaomi', 'Mi 9', 'phone'],
    ['samsung', 'SM-G991B', 'phone'],
    ['samsung', 'GT-I9300', 'phone'],
    ['samsung', 'NX3000', 'camera'],
    ['samsung', null, 'camera'],
    ['Sony', 'G8341', 'camera'],
    ['Sony', 'Xperia 1 III', 'phone'],
    ['Sony', 'ILCE-6400', 'camera'],
    ['Sony', 'DSC-RX100M3', 'camera'],
    ['Canon', 'Canon EOS 5D', 'camera'],
    ['NIKON CORPORATION', 'NIKON D750', 'camera'],
    ['GoPro', 'HERO8 Black', 'camera'],
    ['DJI', 'FC3411', 'camera'],
    ['FUJIFILM', 'X-T4', 'camera'],
    ['Panasonic', 'DMC-GX85', 'camera'],
    ['', null, 'unknown'],
    [null, null, 'unknown'],
    ['Nokia', 'Lumia', 'unknown'],
  ];
  it.each(cases)('classifies make=%s model=%s as %s', (make, model, expected) => {
    expect(classifyDevice(make, model)).toBe(expected);
  });
});

interface Case {
  name: string;
  google: string | null;
  exif?: Partial<CaptureExifInput>;
  names?: string[];
  expected: {
    instant: string | null;
    zone: string | null;
    zoneSource: CaptureTimeResult['zoneSource'];
    putDate: boolean;
    putOffsetZone: string | null;
    flags: string[];
    device?: CaptureTimeResult['device'];
  };
}

// Google moment used by most rows: 2023-07-05T01:30:00Z (= 2023-07-04 21:30 at UTC-4).
const G = '2023-07-05T01:30:00Z';
const G_ISO = '2023-07-05T01:30:00.000Z';
const GOOGLE_NO_ZONE = {
  instant: G_ISO,
  zone: null,
  zoneSource: 'google' as const,
  putDate: true,
  putOffsetZone: null,
};

const cases: Case[] = [
  // ---------- rule 1: file records time AND zone ----------
  {
    name: 'rule 1: file moment equals Google exactly: Google moment, file zone, PUT nothing',
    google: G,
    exif: { ...IPHONE, fileOffsetZone: 'UTC-4', fileClock: wall('2023-07-04T21:30:00') },
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'fileOffset',
      putDate: false,
      putOffsetZone: null,
      flags: [],
      device: 'phone',
    },
  },
  {
    name: 'rule 1: file moment within 2 s of Google: moment stays Google, zone from the file',
    google: G,
    exif: { ...IPHONE, fileOffsetZone: 'UTC-4', fileClock: wall('2023-07-04T21:30:02') },
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'fileOffset',
      putDate: false,
      putOffsetZone: null,
      flags: [],
    },
  },
  {
    name: 'rule 1: GPS never overrides a recorded zone',
    google: G,
    exif: { ...IPHONE, fileOffsetZone: 'UTC-4', fileClock: wall('2023-07-04T21:30:00'), fileHasGps: true },
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'fileOffset',
      putDate: false,
      putOffsetZone: null,
      flags: [],
    },
  },
  {
    name: 'rule 1: IANA file zone matching Google',
    google: G,
    exif: { ...IPHONE, fileOffsetZone: 'America/New_York', fileClock: wall('2023-07-04T21:30:00') },
    expected: {
      instant: G_ISO,
      zone: 'America/New_York',
      zoneSource: 'fileOffset',
      putDate: false,
      putOffsetZone: null,
      flags: [],
    },
  },
  {
    name: 'rule 1: unknown make (not a camera) with a zoned file moment still qualifies',
    google: G,
    exif: { fileOffsetZone: 'UTC-4', fileClock: wall('2023-07-04T21:30:00') },
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'fileOffset',
      putDate: false,
      putOffsetZone: null,
      flags: [],
      device: 'unknown',
    },
  },
  {
    name: 'rule 1: 3 s off is a disagreement: keep Google, zone-less, flagged',
    google: G,
    exif: { ...IPHONE, fileOffsetZone: 'UTC-4', fileClock: wall('2023-07-04T21:30:03') },
    expected: { ...GOOGLE_NO_ZONE, flags: ['fileMomentDisagrees', 'zoneAssumed'] },
  },
  {
    name: 'rule 1: 49-day manual edit in Google Photos: keep Google, zone-less, flagged',
    google: G,
    exif: { ...IPHONE, fileOffsetZone: 'UTC-4', fileClock: wall('2023-05-17T21:30:00') },
    expected: { ...GOOGLE_NO_ZONE, flags: ['fileMomentDisagrees', 'zoneAssumed'] },
  },
  {
    name: 'rule 1: PXL name (UTC) proves the file: file moment and zone',
    // Google stored local time as UTC (01:30Z); the file says 01:30 at UTC+4 = 21:30Z; the PXL name (UTC) agrees.
    google: '2023-07-05T01:30:00Z',
    exif: { ...PHONE, fileOffsetZone: 'UTC+4', fileClock: wall('2023-07-05T01:30:00') },
    names: ['PXL_20230704_213000123.jpg'],
    expected: {
      instant: '2023-07-04T21:30:00.000Z',
      zone: 'UTC+4',
      zoneSource: 'fileOffset',
      putDate: false,
      putOffsetZone: null,
      flags: ['fileMomentDisagrees', 'fileMomentProvenByPxl'],
    },
  },
  {
    name: 'rule 1: PXL name within 2 s of the file moment still proves it',
    google: '2023-07-05T01:30:00Z',
    exif: { ...PHONE, fileOffsetZone: 'UTC+4', fileClock: wall('2023-07-05T01:30:00') },
    names: ['PXL_20230704_213001900.jpg'],
    expected: {
      instant: '2023-07-04T21:30:00.000Z',
      zone: 'UTC+4',
      zoneSource: 'fileOffset',
      putDate: false,
      putOffsetZone: null,
      flags: ['fileMomentDisagrees', 'fileMomentProvenByPxl'],
    },
  },
  {
    name: 'rule 1: PXL name more than 2 s from the file moment proves nothing: keep Google',
    google: '2023-07-05T01:30:00Z',
    exif: { ...PHONE, fileOffsetZone: 'UTC+4', fileClock: wall('2023-07-05T01:30:00') },
    names: ['PXL_20230704_213003000.jpg'],
    expected: { ...GOOGLE_NO_ZONE, flags: ['fileMomentDisagrees', 'zoneAssumed'] },
  },
  {
    name: 'rule 1: GPSDateTime proves the file: file moment and zone',
    google: G,
    exif: {
      ...IPHONE,
      fileOffsetZone: 'UTC-4',
      fileClock: wall('2023-07-04T23:30:00'),
      gpsDateTime: wall('2023-07-05T03:30:01'),
    },
    expected: {
      instant: '2023-07-05T03:30:00.000Z',
      zone: 'UTC-4',
      zoneSource: 'fileOffset',
      putDate: false,
      putOffsetZone: null,
      flags: ['fileMomentDisagrees', 'fileMomentProvenByGpsDateTime'],
    },
  },
  {
    name: 'rule 1: GPSDateTime that does not match the file moment proves nothing: keep Google',
    google: G,
    exif: {
      ...IPHONE,
      fileOffsetZone: 'UTC-4',
      fileClock: wall('2023-07-04T23:30:00'),
      gpsDateTime: wall('2023-07-05T01:30:00'),
    },
    expected: { ...GOOGLE_NO_ZONE, flags: ['fileMomentDisagrees', 'zoneAssumed'] },
  },
  {
    name: 'rule 1: a Screenshot name is not an independent clock',
    google: G,
    exif: { ...IPHONE, fileOffsetZone: 'UTC-4', fileClock: wall('2023-07-04T23:30:00') },
    names: ['Screenshot_20230705-033000.png'],
    expected: { ...GOOGLE_NO_ZONE, flags: ['fileMomentDisagrees', 'zoneAssumed'] },
  },
  {
    name: 'rule 1: file zone but no clock: no file moment, falls through to the default',
    google: G,
    exif: { ...IPHONE, fileOffsetZone: 'UTC-4' },
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'] },
  },

  // ---------- rule 4: cameras ----------
  {
    name: 'rule 4: camera with a recorded zone matching Google: zone NOT used',
    google: G,
    exif: { ...CAMERA, fileOffsetZone: 'UTC-4', fileClock: wall('2023-07-04T21:30:00') },
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'], device: 'camera' },
  },
  {
    name: 'rule 4: camera clock on a whole 15-min offset: no derived zone',
    google: G,
    exif: { make: 'Canon', model: 'EOS 5D', fileClock: wall('2023-07-04T21:30:00') },
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'], device: 'camera' },
  },
  {
    name: 'rule 4: camera never uses a Screenshot name',
    google: G,
    exif: CAMERA,
    names: ['Screenshot_20230704-213000.png'],
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'] },
  },

  // ---------- rule 2: phone clock, whole 15-min offset within 2 s ----------
  {
    name: 'rule 2: phone clock minus Google = -4 h exactly',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:30:00') },
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'derivedOffset',
      putDate: true,
      putOffsetZone: 'UTC-4',
      flags: [],
    },
  },
  {
    name: 'rule 2: +5:30 offset (15-min grid)',
    google: '2023-07-04T16:00:00Z',
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:30:00') },
    expected: {
      instant: '2023-07-04T16:00:00.000Z',
      zone: 'UTC+5:30',
      zoneSource: 'derivedOffset',
      putDate: true,
      putOffsetZone: 'UTC+5:30',
      flags: [],
    },
  },
  {
    name: 'rule 2: +5:45 offset (Nepal) on the 15-min grid',
    google: '2023-07-04T15:45:00Z',
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:30:00') },
    expected: {
      instant: '2023-07-04T15:45:00.000Z',
      zone: 'UTC+5:45',
      zoneSource: 'derivedOffset',
      putDate: true,
      putOffsetZone: 'UTC+5:45',
      flags: [],
    },
  },
  {
    name: 'rule 2: 2 s residual tolerated, moment stays exactly Google',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:30:02') },
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'derivedOffset',
      putDate: true,
      putOffsetZone: 'UTC-4',
      flags: [],
    },
  },
  {
    name: 'rule 2: -2 s residual tolerated',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:29:58') },
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'derivedOffset',
      putDate: true,
      putOffsetZone: 'UTC-4',
      flags: [],
    },
  },
  {
    name: 'rule 2: clock equals Google (offset 0)',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-05T01:30:00') },
    expected: {
      instant: G_ISO,
      zone: 'UTC+0',
      zoneSource: 'derivedOffset',
      putDate: true,
      putOffsetZone: 'UTC+0',
      flags: [],
    },
  },
  {
    name: 'rule 2 skips a UTC video clock (QuickTime CreateDate) equal to Google: no zone, flagged',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-05T01:30:00'), fileClockIsUtc: true },
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'] },
  },
  {
    name: 'rule 2 skips a UTC video clock on a whole-hour offset from Google: no zone, flagged, no DST note',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-05T02:30:00'), fileClockIsUtc: true },
    expected: { ...GOOGLE_NO_ZONE, flags: ['google-instant-with-differing-clock', 'zoneAssumed'] },
  },
  {
    name: 'rule 2: 3 s residual rejected: Google, no zone, flagged',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:30:03') },
    expected: { ...GOOGLE_NO_ZONE, flags: ['google-instant-with-differing-clock', 'zoneAssumed'] },
  },
  {
    name: 'rule 2: non-15-min offset (-4:07) rejected',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:23:00') },
    expected: { ...GOOGLE_NO_ZONE, flags: ['google-instant-with-differing-clock', 'zoneAssumed'] },
  },
  {
    name: 'rule 2: ~1 h off the grid flagged as 1-hour ambiguous',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-05T00:32:00') },
    expected: { ...GOOGLE_NO_ZONE, flags: ['google-instant-with-differing-clock', '1-hour-ambiguous', 'zoneAssumed'] },
  },
  {
    name: 'rule 2: offset beyond 14 h rejected',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-05T16:30:00') },
    expected: { ...GOOGLE_NO_ZONE, flags: ['google-instant-with-differing-clock', 'zoneAssumed'] },
  },
  {
    name: 'rule 2 is PHONE only: unknown make with a 15-min clock gets no zone',
    google: G,
    exif: { make: 'Nokia', model: 'Lumia', fileClock: wall('2023-07-04T21:30:00') },
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'], device: 'unknown' },
  },
  {
    name: 'removed: GPSDateTime no longer vetoes rule 2',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:30:00'), gpsDateTime: wall('2023-07-05T00:30:00') },
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'derivedOffset',
      putDate: true,
      putOffsetZone: 'UTC-4',
      flags: [],
    },
  },

  // ---------- rule 3: Screenshot_YYYYMMDD-HHMMSS ----------
  {
    name: 'rule 3: exact Screenshot name matching Google on the 15-min grid',
    google: G,
    names: ['Screenshot_20230704-213000.png'],
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'screenshot',
      putDate: true,
      putOffsetZone: 'UTC-4',
      flags: [],
      device: 'unknown',
    },
  },
  {
    name: 'rule 3: Screenshot name with a suffix, 2 s residual',
    google: G,
    names: ['Screenshot_20230704-213002_Chrome.jpg'],
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'screenshot',
      putDate: true,
      putOffsetZone: 'UTC-4',
      flags: [],
    },
  },
  {
    name: 'rule 3: the second name (title) can match',
    google: G,
    names: ['image.png', 'Screenshot_20230704-213000.png'],
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'screenshot',
      putDate: true,
      putOffsetZone: 'UTC-4',
      flags: [],
    },
  },
  {
    name: 'rule 3: Screenshot name off the 15-min grid rejected',
    google: G,
    names: ['Screenshot_20230704-212300.png'],
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'] },
  },
  {
    name: 'rule 3: Screenshot name with 3 s residual rejected',
    google: G,
    names: ['Screenshot_20230704-213003.png'],
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'] },
  },
  {
    name: 'rule 3: applies to a phone whose clock gave no offset',
    google: G,
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:23:00') },
    names: ['Screenshot_20230704-213000.png'],
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'screenshot',
      putDate: true,
      putOffsetZone: 'UTC-4',
      flags: [],
    },
  },
  ...[
    'Screenshot_20230704_213000.png',
    'Screenshot 2023-07-04 at 21.30.00.png',
    'IMG_20230704_213000.jpg',
    'VID_20230704_213000.mp4',
    'PXL_20230704_213000000.jpg',
    '20230704_213000.jpg',
  ].map((fileName): Case => ({
    name: `rule 3: other name style ignored (${fileName})`,
    google: G,
    names: [fileName],
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'] },
  })),

  // ---------- everything else ----------
  {
    name: 'default: no file facts at all: Google moment, no zone',
    google: G,
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'], device: 'unknown' },
  },
  {
    name: 'default: phone with no clock and no zone: Google, no zone (no same-device inference)',
    google: G,
    exif: IPHONE,
    expected: { ...GOOGLE_NO_ZONE, flags: ['zoneAssumed'], device: 'phone' },
  },
  {
    name: 'no Google time, no zoned file moment: noDate',
    google: null,
    exif: { ...PHONE, fileClock: wall('2023-07-04T21:30:00') },
    names: ['Screenshot_20230704-213000.png'],
    expected: { instant: null, zone: null, zoneSource: null, putDate: false, putOffsetZone: null, flags: ['noDate'] },
  },
  {
    name: 'no Google time, zoned file moment: the file is read natively',
    google: null,
    exif: { ...IPHONE, fileOffsetZone: 'UTC-4', fileClock: wall('2023-07-04T21:30:00') },
    expected: {
      instant: G_ISO,
      zone: 'UTC-4',
      zoneSource: 'fileOffset',
      putDate: false,
      putOffsetZone: null,
      flags: [],
    },
  },
  {
    name: 'no Google time, camera with a zoned moment: noDate',
    google: null,
    exif: { ...CAMERA, fileOffsetZone: 'UTC-4', fileClock: wall('2023-07-04T21:30:00') },
    expected: { instant: null, zone: null, zoneSource: null, putDate: false, putOffsetZone: null, flags: ['noDate'] },
  },
];

describe('resolveCaptureTime (section 13 / 13.1)', () => {
  it.each(cases)('$name', ({ google, exif, names, expected }) => {
    const r = resolveCaptureTime({
      googleInstant: google ? new Date(google) : null,
      exif: { ...NO_EXIF, ...exif },
      names: names ?? [],
    });
    const { instant, device, ...rest } = expected;
    expect(r.instant?.toISOString() ?? null).toBe(instant);
    expect(r).toMatchObject(rest);
    expect(r.flags).toEqual(expected.flags);
    if (device) {
      expect(r.device).toBe(device);
    }
  });
});

describe('writeGpsToSidecar', () => {
  it.each([
    ['file has GPS', true, false],
    ['file lacks GPS', false, true],
  ])('%s', (_label, fileHasGps, expected) => {
    for (const exif of [
      NO_EXIF,
      { ...NO_EXIF, ...PHONE, fileClock: wall('2023-07-04T21:30:00') },
      { ...NO_EXIF, ...CAMERA },
    ]) {
      const r = resolveCaptureTime({ googleInstant: new Date(G), exif: { ...exif, fileHasGps }, names: [] });
      expect(r.writeGpsToSidecar).toBe(expected);
    }
  });
});

describe('sidecarDateString / wallTimeAsUtc across DST', () => {
  const HOME = 'America/New_York';
  it('summer (EDT, -04:00)', () => {
    const instant = new Date('2023-07-05T01:30:00Z');
    expect(sidecarDateString(instant, HOME)).toBe('2023-07-04T21:30:00.000-04:00');
    expect(wallTimeAsUtc(instant, HOME).toISOString()).toBe('2023-07-04T21:30:00.000Z');
  });
  it('winter (EST, -05:00)', () => {
    const instant = new Date('2023-01-05T01:30:00Z');
    expect(sidecarDateString(instant, HOME)).toBe('2023-01-04T20:30:00.000-05:00');
    expect(wallTimeAsUtc(instant, HOME).toISOString()).toBe('2023-01-04T20:30:00.000Z');
  });
  it('fixed-offset zone string', () => {
    expect(sidecarDateString(new Date('2023-07-05T01:30:00Z'), 'UTC-4')).toBe('2023-07-04T21:30:00.000-04:00');
    expect(sidecarDateString(new Date('2023-07-04T16:00:00Z'), 'UTC+5:30')).toBe('2023-07-04T21:30:00.000+05:30');
  });
});
