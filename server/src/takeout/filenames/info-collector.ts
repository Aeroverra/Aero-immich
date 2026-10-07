import { huawei } from 'src/takeout/filenames/huawei';
import { NameInfo, typeFromExt } from 'src/takeout/filenames/name-info';
import { takeTimeFromPath } from 'src/takeout/filenames/names-date';
import { nexus } from 'src/takeout/filenames/nexus';
import { pixel } from 'src/takeout/filenames/pixel';
import { samsung } from 'src/takeout/filenames/samsung';
import { sonyXperia } from 'src/takeout/filenames/sony';
import { base, ext } from 'src/takeout/paths';

// Go filenames.InfoCollector.GetInfo: the first brand parser that recognizes the base name wins
export function getInfo(name: string, zone = 'UTC'): NameInfo {
  const baseName = base(name);
  const info =
    pixel(baseName) ??
    samsung(baseName, zone) ??
    nexus(baseName, zone) ??
    huawei(baseName, zone) ??
    sonyXperia(baseName, zone);
  if (info) {
    return info;
  }
  const extension = ext(baseName);
  return {
    base: baseName,
    radical: baseName.slice(0, baseName.length - extension.length),
    ext: extension.toLowerCase(),
    taken: takeTimeFromPath(name, zone),
    type: typeFromExt(extension),
    kind: 'none',
    index: 0,
    isCover: false,
  };
}
