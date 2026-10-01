import { pathKey } from 'src/takeout/path-key';
import { describe, expect, it } from 'vitest';

describe('pathKey', () => {
  it('normalizes NFD to NFC', () => {
    const nfd = 'Takeout/Google Photos/Café/é.jpg';
    const nfc = 'Takeout/Google Photos/Café/é.jpg';
    expect(pathKey(nfd)).toBe(nfc);
    expect(pathKey(nfc)).toBe(nfc);
  });

  it('trims trailing spaces of every segment', () => {
    expect(pathKey('Takeout/Google Photos/Trip  /photo.jpg ')).toBe('Takeout/Google Photos/Trip/photo.jpg');
  });

  it('keeps leading spaces', () => {
    expect(pathKey('Takeout/Google Photos/ a.jpg')).toBe('Takeout/Google Photos/ a.jpg');
  });

  it('gives identical keys for the index spelling and the archive spelling', () => {
    const archive = 'Takeout/Google Photos/Photos from 2020 /Café.jpg';
    const index = 'Takeout/Google Photos/Photos from 2020/Café.jpg';
    expect(pathKey(archive)).toBe(pathKey(index));
  });
});
