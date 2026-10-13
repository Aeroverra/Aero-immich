import { NameInfo, typeFromExt } from 'src/takeout/filenames/name-info';
import { parseCompactTime } from 'src/takeout/filenames/names-date';

const SAMSUNG_RE = /^(\d{8}_\d{6})_(\d{3})(\..+)$/;

export function samsung(name: string, zone: string): NameInfo | null {
  const m = SAMSUNG_RE.exec(name);
  if (!m) {
    return null;
  }
  const index = Number(m[2]);
  return {
    radical: m[1],
    base: name,
    ext: m[3].toLowerCase(),
    type: typeFromExt(m[3]),
    kind: 'burst',
    index,
    isCover: index === 1,
    taken: parseCompactTime(m[1], zone),
  };
}
