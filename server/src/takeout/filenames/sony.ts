import { NameInfo, typeFromExt } from 'src/takeout/filenames/name-info';
import { parseCompactTime } from 'src/takeout/filenames/names-date';

const SONY_XPERIA_RE = /^DSC_(\d+)_BURST(\d+)(\D+)?(\..+)$/;

export function sonyXperia(name: string, zone: string): NameInfo | null {
  const m = SONY_XPERIA_RE.exec(name);
  if (!m) {
    return null;
  }
  const extension = m[4];
  const ts = m[2];
  return {
    radical: 'BURST' + ts,
    base: name,
    isCover: (m[3] ?? '').includes('COVER'),
    ext: extension.toLowerCase(),
    type: typeFromExt(extension),
    kind: 'burst',
    index: Number(m[1]),
    taken: ts.length === 17 ? parseCompactTime(ts.slice(0, 14) + '.' + ts.slice(14), zone) : null,
  };
}
