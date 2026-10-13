import { base, ext } from 'src/takeout/paths';
import { EntryKind } from 'src/takeout/types';
import { mimeTypes } from 'src/utils/mime-types';

export type MediaType = 'image' | 'video';

// Go filetypes.rawExtensions, used unchanged by grouping and filters [DEV 7]
const RAW_EXTENSIONS = new Set([
  '.3fr',
  '.ari',
  '.arw',
  '.cap',
  '.cin',
  '.cr2',
  '.cr3',
  '.crw',
  '.dcr',
  '.dng',
  '.erf',
  '.fff',
  '.iiq',
  '.k25',
  '.kdc',
  '.mrw',
  '.nef',
  '.nrw',
  '.orf',
  '.ori',
  '.pef',
  '.psd',
  '.raf',
  '.raw',
  '.rw2',
  '.rwl',
  '.sr2',
  '.srf',
  '.srw',
  '.x3f',
]);

const DECODABLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp']);

export function isRawExt(extension: string): boolean {
  return RAW_EXTENSIONS.has(extension.toLowerCase());
}

// Media type of an extension (with its dot) from the server's supported list [DEV 7]
export function mediaTypeOfExt(extension: string): MediaType | null {
  const lower = extension.toLowerCase();
  if (lower === '') {
    return null;
  }
  if (Object.hasOwn(mimeTypes.image, lower)) {
    return 'image';
  }
  if (Object.hasOwn(mimeTypes.video, lower)) {
    return 'video';
  }
  return null;
}

export function mediaTypeOf(name: string): MediaType | null {
  return mediaTypeOfExt(ext(name));
}

export function isMediaExt(extension: string): boolean {
  return mediaTypeOfExt(extension) !== null;
}

export function isUselessExt(extension: string): boolean {
  const lower = extension.toLowerCase();
  return lower === '.mp' || lower.startsWith('.mp~');
}

// The Google motion photo movie part: Go tests the whole path, which never fires inside a Takeout;
// here it is tested on the base name [DEV 7].
function isMotionMoviePart(name: string, extension: string): boolean {
  const lower = extension.toLowerCase();
  return (lower === '' || mediaTypeOfExt(lower) === 'video') && base(name).toUpperCase().startsWith('MVIMG');
}

export function classifyEntry(path: string): EntryKind {
  const name = base(path);
  const extension = ext(name).toLowerCase();
  if (extension === '.json') {
    return 'json';
  }
  if (extension === '.xmp') {
    return 'sidecar';
  }
  if (isUselessExt(extension) || isMotionMoviePart(name, extension)) {
    return 'useless';
  }
  if (mediaTypeOfExt(extension) !== null) {
    return 'media';
  }
  return 'unsupported';
}

export function isDecodable(path: string): boolean {
  return DECODABLE_EXTENSIONS.has(ext(base(path)).toLowerCase());
}
