import { DateTime } from 'luxon';

const TIME_RE = /(19[89]\d|20\d\d)\D?(0\d|1[0-2])\D?([0-3]\d)\D{0,1}([01]\d|2[0-4])?\D?([0-5]\d)?\D?([0-5]\d)?/;

// Go time.Date followed by the component check of TakeTimeFromName: null when the date does not exist.
export function exactDate(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date | null {
  const dt = DateTime.fromObject({ year, month, day, hour, minute, second, millisecond }, { zone });
  if (
    !dt.isValid ||
    dt.year !== year ||
    dt.month !== month ||
    dt.day !== day ||
    dt.hour !== hour ||
    dt.minute !== minute ||
    dt.second !== second
  ) {
    return null;
  }
  return dt.toJSDate();
}

export function takeTimeFromName(s: string, zone: string, now = Date.now()): Date | null {
  const m = TIME_RE.exec(s);
  if (!m) {
    return null;
  }
  const n = m.slice(1, 7).map((part) => (part ? Number(part) : 0));
  const t = exactDate(zone, n[0], n[1], n[2], n[3], n[4], n[5]);
  if (t === null) {
    return null;
  }
  if (now - t.getTime() < -24 * 3600 * 1000) {
    return null;
  }
  return t;
}

// Tries the file name, then each folder name from the end, then the whole path.
export function takeTimeFromPath(fullPath: string, zone: string): Date | null {
  const parts = fullPath.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = takeTimeFromName(parts[i], zone);
    if (t !== null) {
      return t;
    }
  }
  return takeTimeFromName(fullPath, zone);
}

// Go time.ParseInLocation for the digit layouts the name parsers use ("20060102_150405" and friends)
export function parseCompactTime(digits: string, zone: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?$/.exec(digits);
  if (!m) {
    return null;
  }
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const millisecond = m[7] ? Number(m[7]) : 0;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return exactDate(zone, year, month, day, hour, minute, second, millisecond);
}
