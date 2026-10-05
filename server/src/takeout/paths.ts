// Go "path" package semantics: POSIX, "/" only, no volume names.
// The rune helpers below walk UTF-16 code units by hand to mirror Go's rune counting, so the
// explicit surrogate-range checks with charCodeAt are intentional.
/* eslint-disable unicorn/prefer-code-point */

export function nfc(name: string): string {
  return name.normalize('NFC');
}

export function ext(path: string): string {
  for (let i = path.length - 1; i >= 0 && path[i] !== '/'; i--) {
    if (path[i] === '.') {
      return path.slice(i);
    }
  }
  return '';
}

export function trimExt(name: string): string {
  return name.slice(0, name.length - ext(name).length);
}

export function base(path: string): string {
  if (path === '') {
    return '.';
  }
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') {
    end--;
  }
  if (end === 0) {
    return '/';
  }
  const start = path.lastIndexOf('/', end - 1) + 1;
  return path.slice(start, end);
}

// Directory part as immich-go keys its catalogs: path.Split then the trailing "/" removed ("" for a root file).
export function dir(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i === -1 ? { dir: '', base: path } : { dir: path.slice(0, i), base: path.slice(i + 1) };
}

export function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function runeCount(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd8_00 && c <= 0xdb_ff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc_00 && next <= 0xdf_ff) {
        i++;
      }
    }
    count++;
  }
  return count;
}

export function firstRunes(value: string, count: number): string {
  let taken = 0;
  let i = 0;
  while (i < value.length && taken < count) {
    const c = value.charCodeAt(i);
    i += c >= 0xd8_00 && c <= 0xdb_ff && i + 1 < value.length ? 2 : 1;
    taken++;
  }
  return value.slice(0, i);
}

export function dropLastRune(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const last = value.charCodeAt(value.length - 1);
  if (last >= 0xdc_00 && last <= 0xdf_ff && value.length >= 2) {
    const prev = value.charCodeAt(value.length - 2);
    if (prev >= 0xd8_00 && prev <= 0xdb_ff) {
      return value.slice(0, -2);
    }
  }
  return value.slice(0, -1);
}
