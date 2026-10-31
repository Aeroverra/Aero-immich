// The one key used to compare archive paths from different sources (index file list, zip listings, archive entries):
// NFC, and every path segment without trailing spaces (Google's index trims them, the archives keep them).
export function pathKey(path: string): string {
  return path
    .normalize('NFC')
    .split('/')
    .map((segment) => segment.trimEnd())
    .join('/');
}
