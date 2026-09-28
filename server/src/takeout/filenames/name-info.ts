import { mediaTypeOfExt } from 'src/takeout/media-types';

export type NameKind =
  | 'none'
  | 'burst'
  | 'edited'
  | 'portrait'
  | 'night'
  | 'motion'
  | 'longExposure'
  | 'videoBoost'
  | 'nightSightVideo';

export interface NameInfo {
  base: string;
  ext: string;
  radical: string;
  type: 'image' | 'video' | '';
  kind: NameKind;
  index: number;
  taken: Date | null;
  isCover: boolean;
}

export function typeFromExt(extension: string): NameInfo['type'] {
  return mediaTypeOfExt(extension) ?? '';
}
