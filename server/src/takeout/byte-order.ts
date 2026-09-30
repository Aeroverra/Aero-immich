// Go compares strings byte by byte on their UTF-8 encoding. UTF-8 byte order is code point order, which differs
// from JavaScript's UTF-16 unit order only when a surrogate pair meets a code unit in U+E000..U+FFFF.
// The code-unit comparison below is deliberate: it detects that boundary before falling back to code points.
/* eslint-disable unicorn/prefer-code-point */
export function compareBytes(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) {
      continue;
    }
    const pa = a.codePointAt(i) ?? ca;
    const pb = b.codePointAt(i) ?? cb;
    return pa < pb ? -1 : 1;
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

export function sortBytes(list: Iterable<string>): string[] {
  return [...list].sort(compareBytes);
}
