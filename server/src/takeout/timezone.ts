import { DateTime, FixedOffsetZone } from 'luxon';
import { base } from 'src/takeout/paths';
import { CaptureTimeInput, CaptureTimeResult, DeviceClass, ZoneSource } from 'src/takeout/types';

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const MAX_OFFSET_MS = 14 * 60 * 60 * 1000;
// Every "equal" comparison in section 13 / 13.1 uses a 2 s tolerance.
const TOLERANCE_MS = 2 * 1000;
// A clock-vs-Google gap this close to a whole hour is flagged as a possible 1-hour (DST) ambiguity.
const ONE_HOUR_LOW_MS = 50 * 60 * 1000;
const ONE_HOUR_HIGH_MS = 70 * 60 * 1000;

// Rule 3: Screenshot_YYYYMMDD-HHMMSS, only this style and only the hyphen separator. An optional suffix may follow.
const SCREENSHOT_RE = /^Screenshot_(\d{8})-(\d{6})/;
// Section 13.1 proof only: a Pixel PXL_YYYYMMDD_HHMMSSmmm name is a UTC clock. Never used as a date on its own.
const PXL_RE = /^PXL_(\d{8})_(\d{6})(\d{3})/;

// Device lists matched case-insensitively against the trimmed EXIF Make (and Model where noted).
const PHONE_MAKES = ['apple', 'google', 'lg', 'motorola', 'oneplus', 'htc', 'huawei', 'xiaomi'];
const SAMSUNG_PHONE_MODEL_RE = /^(SM-|GT-|SCH|SPH|SGH)/i;
const SONY_PHONE_MODEL_RE = /xperia/i;
const CAMERA_MAKES = ['canon', 'nikon', 'gopro', 'kodak', 'olympus', 'panasonic', 'fuji', 'fujifilm', 'dji'];

// Converts a luxon zone string (IANA name, or the Immich fixed-offset form UTC-4 / UTC+5:30) to a luxon zone.
export function toLuxonZone(zone: string): string | FixedOffsetZone {
  const m = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    const minutes = sign * (Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0));
    return FixedOffsetZone.instance(minutes);
  }
  return zone;
}

function fixedOffsetName(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return minutes === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(minutes).padStart(2, '0')}`;
}

// Interpret a wall clock (its UTC calendar components) as local time in `zone`, returning the resulting instant.
function wallClockToInstant(wallAsUtc: Date, zone: string): Date | null {
  const dt = DateTime.fromObject(
    {
      year: wallAsUtc.getUTCFullYear(),
      month: wallAsUtc.getUTCMonth() + 1,
      day: wallAsUtc.getUTCDate(),
      hour: wallAsUtc.getUTCHours(),
      minute: wallAsUtc.getUTCMinutes(),
      second: wallAsUtc.getUTCSeconds(),
      millisecond: wallAsUtc.getUTCMilliseconds(),
    },
    { zone: toLuxonZone(zone) },
  );
  return dt.isValid ? dt.toJSDate() : null;
}

function normalize(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

// Classify an asset by EXIF Make/Model into PHONE / CAMERA / UNKNOWN.
export function classifyDevice(make: string | null, model: string | null): DeviceClass {
  const m = normalize(make);
  if (m === '') {
    return 'unknown';
  }
  if (m.startsWith('samsung')) {
    return SAMSUNG_PHONE_MODEL_RE.test((model ?? '').trim()) ? 'phone' : 'camera';
  }
  if (m.startsWith('sony')) {
    // Xperia is a phone; ILCE/DSC/NEX and anything else from Sony is treated as a camera.
    return SONY_PHONE_MODEL_RE.test(model ?? '') ? 'phone' : 'camera';
  }
  if (PHONE_MAKES.some((p) => m.startsWith(p))) {
    return 'phone';
  }
  if (CAMERA_MAKES.some((c) => m.startsWith(c))) {
    return 'camera';
  }
  // A make is present but recognised in neither list: UNKNOWN (not a dedicated camera, not a phone).
  return 'unknown';
}

function within(a: Date, b: Date, toleranceMs = TOLERANCE_MS): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= toleranceMs;
}

// The whole-15-min offset (in minutes) that maps `wallAsUtc` onto `instant` within the 2 s tolerance, or null.
function fifteenMinuteOffset(wallAsUtc: Date, instant: Date): number | null {
  const raw = wallAsUtc.getTime() - instant.getTime();
  if (Math.abs(raw) > MAX_OFFSET_MS) {
    return null;
  }
  const rounded = Math.round(raw / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
  if (Math.abs(raw - rounded) > TOLERANCE_MS) {
    return null;
  }
  // `|| 0` folds -0 into 0.
  return rounded / 60_000 || 0;
}

function isAboutOneHour(ms: number): boolean {
  const abs = Math.abs(ms);
  return abs >= ONE_HOUR_LOW_MS && abs <= ONE_HOUR_HIGH_MS;
}

// Rule 3: the wall clock of an exact Screenshot_YYYYMMDD-HHMMSS name (as UTC calendar components), or null.
function screenshotClock(name: string): Date | null {
  const m = SCREENSHOT_RE.exec(base(name));
  if (!m) {
    return null;
  }
  const wall = DateTime.fromFormat(m[1] + m[2], 'yyyyMMddHHmmss', { zone: 'UTC' });
  return wall.isValid ? wall.toJSDate() : null;
}

// Section 13.1 proof: the UTC instant of a Pixel PXL_YYYYMMDD_HHMMSSmmm name, or null.
function pxlInstant(name: string): Date | null {
  const m = PXL_RE.exec(base(name));
  if (!m) {
    return null;
  }
  const dt = DateTime.fromFormat(m[1] + m[2] + m[3], 'yyyyMMddHHmmssSSS', { zone: 'UTC' });
  return dt.isValid ? dt.toJSDate() : null;
}

// Section 13 / 13.1 capture-time rule: "Google unless 100% sure". Pure and synchronous.
//
// Default: Google's photoTakenTime moment, with no invented zone (flag zoneAssumed). Changed only when:
//   1. the file records time AND zone, the device is not a dedicated camera, and the file moment equals Google's
//      within 2 s: moment stays Google's, zone from the file. If the moments disagree, keep Google (zone-less,
//      flagged) unless an independent clock (PXL_ name or GPSDateTime, within 2 s) proves the file: then the
//      file's moment and zone. GPS never overrides a recorded zone.
//   2. PHONE with a zone-less wall clock whose clock minus Google is a whole 15-min offset within 2 s: that offset.
//      A video's UTC QuickTime date is not a wall clock and never takes this rule.
//   3. exact Screenshot_YYYYMMDD-HHMMSS name: as rule 2 with the name as the clock.
//   4. CAMERA: Google's moment, no zone change.
export function resolveCaptureTime(input: CaptureTimeInput): CaptureTimeResult {
  const { googleInstant, exif, names } = input;
  const device = classifyDevice(exif.make, exif.model);
  const flags: string[] = [];
  const writeGpsToSidecar = !exif.fileHasGps;

  const result = (r: {
    instant: Date | null;
    zone: string | null;
    zoneSource: ZoneSource | null;
    putDate: boolean;
  }): CaptureTimeResult => ({
    device,
    instant: r.instant,
    zone: r.zone,
    zoneSource: r.zoneSource,
    putDate: r.putDate,
    putOffsetZone: r.putDate ? r.zone : null,
    writeGpsToSidecar,
    flags,
  });

  // Rule 1 input: the file's own zoned moment. Cameras never qualify (their zone labels are stale).
  const fileMoment =
    device !== 'camera' && exif.fileOffsetZone && exif.fileClock
      ? wallClockToInstant(exif.fileClock, exif.fileOffsetZone)
      : null;
  const fileZone = fileMoment ? exif.fileOffsetZone : null;

  if (!googleInstant) {
    // No Google time. A zoned file moment is read natively by Immich's extraction; otherwise leave it to Immich.
    if (fileMoment && fileZone) {
      return result({ instant: fileMoment, zone: fileZone, zoneSource: 'fileOffset', putDate: false });
    }
    flags.push('noDate');
    return result({ instant: null, zone: null, zoneSource: null, putDate: false });
  }

  // Google's moment with no zone evidence: PUT the moment with no zone (flagged).
  const googleNoZone = (): CaptureTimeResult => {
    flags.push('zoneAssumed');
    return result({ instant: googleInstant, zone: null, zoneSource: 'google', putDate: true });
  };

  // ---------- rule 1 ----------
  if (fileMoment && fileZone) {
    if (within(fileMoment, googleInstant)) {
      // The file natively carries this moment (within 2 s) and its zone: PUT nothing, let extraction read it.
      return result({ instant: googleInstant, zone: fileZone, zoneSource: 'fileOffset', putDate: false });
    }
    flags.push('fileMomentDisagrees');
    const pxlProof = names.some((name) => {
      const pxl = pxlInstant(name);
      return pxl !== null && within(pxl, fileMoment);
    });
    const gpsProof = !pxlProof && exif.gpsDateTime !== null && within(exif.gpsDateTime, fileMoment);
    if (pxlProof || gpsProof) {
      flags.push(pxlProof ? 'fileMomentProvenByPxl' : 'fileMomentProvenByGpsDateTime');
      return result({ instant: fileMoment, zone: fileZone, zoneSource: 'fileOffset', putDate: false });
    }
    // Google's date may be a manual edit in Google Photos: keep Google's moment, zone-less.
    return googleNoZone();
  }

  // ---------- rule 4 ----------
  if (device === 'camera') {
    return googleNoZone();
  }

  // ---------- rule 2 ----------
  // A UTC clock (QuickTime video date) minus Google is always ~0: that is no evidence of a +0 zone.
  if (device === 'phone' && exif.fileClock && !exif.fileOffsetZone && !exif.fileClockIsUtc) {
    const offsetMinutes = fifteenMinuteOffset(exif.fileClock, googleInstant);
    if (offsetMinutes !== null) {
      return result({
        instant: googleInstant,
        zone: fixedOffsetName(offsetMinutes),
        zoneSource: 'derivedOffset',
        putDate: true,
      });
    }
  }

  // ---------- rule 3 ----------
  for (const name of names) {
    const clock = screenshotClock(name);
    const offsetMinutes = clock ? fifteenMinuteOffset(clock, googleInstant) : null;
    if (offsetMinutes !== null) {
      return result({
        instant: googleInstant,
        zone: fixedOffsetName(offsetMinutes),
        zoneSource: 'screenshot',
        putDate: true,
      });
    }
  }

  // Everything else: Google's moment, no zone. Note a phone clock that disagrees with Google.
  if (device === 'phone' && exif.fileClock) {
    const diff = exif.fileClock.getTime() - googleInstant.getTime();
    if (Math.abs(diff) > TOLERANCE_MS) {
      flags.push('google-instant-with-differing-clock');
      if (isAboutOneHour(diff) && !exif.fileClockIsUtc) {
        flags.push('1-hour-ambiguous');
      }
    }
  }
  return googleNoZone();
}

// Sidecar DateTimeOriginal string with the resolved zone offset ('yyyy-MM-ddTHH:mm:ss.SSSZZ').
export function sidecarDateString(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone: toLuxonZone(zone) }).toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ");
}

// Immich localDateTime convention: the wall clock in `zone`, stored with the same components as a UTC instant.
export function wallTimeAsUtc(instant: Date, zone: string): Date {
  const dt = DateTime.fromJSDate(instant, { zone: toLuxonZone(zone) });
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond));
}
