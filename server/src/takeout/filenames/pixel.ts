import { NameInfo, NameKind, typeFromExt } from 'src/takeout/filenames/name-info';
import { parseCompactTime } from 'src/takeout/filenames/names-date';

const PIXEL_RE = /^(PXL_\d{8}_\d{9})((.*)?(\d{2}))?(.*)?(\..*)$/;

export function pixel(name: string): NameInfo | null {
  const m = PIXEL_RE.exec(name);
  if (!m) {
    return null;
  }
  const radical = m[1];
  const part3 = m[3] ?? '';
  const part4 = m[4] ?? '';
  const part5 = m[5] ?? '';
  const extension = m[6];
  const videoPair = part5 === '.COVER' || part5 === '.MAIN';
  let kind: NameKind = 'none';
  if (videoPair && part3.endsWith('VB-')) {
    kind = 'videoBoost';
  } else if (videoPair && part3.endsWith('NS-')) {
    kind = 'nightSightVideo';
  } else if (part3.includes('PORTRAIT')) {
    kind = 'portrait';
  } else if (part3.includes('NIGHT')) {
    kind = 'night';
  } else if (part3.includes('LONG_EXPOSURE')) {
    kind = 'longExposure';
  } else if (part3.includes('MOTION')) {
    kind = 'motion';
  }
  return {
    radical,
    base: name,
    isCover: part5.endsWith('COVER'),
    ext: extension.toLowerCase(),
    type: typeFromExt(extension),
    kind,
    index: part4 === '' ? 0 : Number(part4),
    taken: parseCompactTime(radical.slice(4, 19), 'UTC'),
  };
}
