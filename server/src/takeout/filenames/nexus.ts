import { NameInfo, typeFromExt } from 'src/takeout/filenames/name-info';
import { parseCompactTime } from 'src/takeout/filenames/names-date';

const NEXUS_RE = /^(\d+)\D+_\d+_(BURST\d+)(\D+)?(\..+)$/;

export function nexus(name: string, zone: string): NameInfo | null {
  const m = NEXUS_RE.exec(name);
  if (!m) {
    return null;
  }
  const extension = m[4];
  const ts = m[2].slice('BURST'.length);
  let taken: Date | null = null;
  switch (ts.length) {
    case 14: {
      taken = parseCompactTime(ts, zone);
      break;
    }
    case 13: {
      taken = new Date(Number(ts));
      break;
    }
    case 17: {
      taken = parseCompactTime(ts.slice(0, 14) + '.' + ts.slice(14), zone);
      break;
    }
  }
  return {
    radical: m[2],
    base: name,
    isCover: (m[3] ?? '').includes('COVER'),
    ext: extension.toLowerCase(),
    type: typeFromExt(extension),
    kind: 'burst',
    index: Number(m[1]),
    taken,
  };
}
