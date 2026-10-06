import { NameInfo, typeFromExt } from 'src/takeout/filenames/name-info';
import { parseCompactTime } from 'src/takeout/filenames/names-date';

const HUAWEI_RE = /^(IMG_\d{8}_\d{6})_BURST(\d{3})(?:_(\w+))?(\..+)$/;

export function huawei(name: string, zone: string): NameInfo | null {
  const m = HUAWEI_RE.exec(name);
  if (!m) {
    return null;
  }
  const extension = m[4];
  return {
    radical: m[1],
    base: name,
    isCover: (m[3] ?? '').endsWith('COVER'),
    ext: extension.toLowerCase(),
    type: typeFromExt(extension),
    kind: 'burst',
    index: Number(m[2]),
    taken: parseCompactTime(m[1].slice(4, 19), zone),
  };
}
