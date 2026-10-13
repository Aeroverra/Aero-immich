import { AlbumFromJson, AssetMetadataFromJson, CompactGoogleJson, GoogleMetadata, GoogleTime } from 'src/takeout/types';

// Shape of Go's GoogleMetadata (adapters/googlePhotos/json.go). A value of the wrong JSON type makes Go's
// json.Unmarshal fail for the whole file, which turns it into an "unknown JSONfile"; the checks below mirror that.
type Schema = 'string' | 'bool' | 'number' | 'int' | 'any' | { object: Record<string, Schema> } | { array: Schema };

const TIME: Schema = { object: { timestamp: 'string' } };
const GEO: Schema = { object: { latitude: 'number', longitude: 'number', altitude: 'number' } };

const METADATA: { object: Record<string, Schema> } = {
  object: {
    title: 'string',
    description: 'string',
    category: 'string',
    date: TIME,
    photoTakenTime: TIME,
    geoDataExif: GEO,
    geoData: GEO,
    trashed: 'bool',
    archived: 'bool',
    url: 'string',
    favorited: 'bool',
    enrichments: {
      array: {
        object: {
          narrativeEnrichment: { object: { text: 'string' } },
          locationEnrichment: {
            object: {
              location: {
                array: {
                  object: { name: 'string', description: 'string', latitudeE7: 'int', longitudeE7: 'int' },
                },
              },
            },
          },
        },
      },
    },
    people: { array: { object: { name: 'string' } } },
    googlePhotosOrigin: {
      object: {
        fromPartnerSharing: 'any',
        fromSharedAlbum: 'any',
        mobileUpload: {
          object: { deviceType: 'string', deviceFolder: { object: { localFolderName: 'string' } } },
        },
        webUpload: { object: { computerUpload: 'any' } },
      },
    },
    creationTime: TIME,
    imageViews: 'string',
    appSource: { object: { androidPackageName: 'string' } },
    composition: { object: { type: 'string' } },
    removeResultReason: { array: { object: { reason: { array: 'string' } } } },
    sharedAlbumComments: {
      array: { object: { text: 'string', liked: 'bool', contentOwnerName: 'string', creationTime: TIME } },
    },
  },
};

const INT64_MAX = 9_223_372_036_854_775_807n;
const INT64_MIN = -9_223_372_036_854_775_808n;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validate(value: unknown, schema: Schema): boolean {
  if (value === null || value === undefined || schema === 'any') {
    return true;
  }
  switch (schema) {
    case 'string': {
      return typeof value === 'string';
    }
    case 'bool': {
      return typeof value === 'boolean';
    }
    case 'number': {
      return typeof value === 'number';
    }
    case 'int': {
      return typeof value === 'number' && Number.isSafeInteger(value);
    }
  }
  if ('array' in schema) {
    return Array.isArray(value) && value.every((item) => validate(item, schema.array));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  for (const [key, child] of Object.entries(schema.object)) {
    if (Object.hasOwn(value, key) && !validate(value[key], child)) {
      return false;
    }
  }
  return true;
}

function prune(value: unknown, schema: Schema): unknown {
  if (typeof schema === 'string' || value === null || value === undefined) {
    return value;
  }
  if ('array' in schema) {
    return Array.isArray(value) ? value.map((item) => prune(item, schema.array)) : value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema.object)) {
    if (Object.hasOwn(value, key)) {
      result[key] = prune(value[key], child);
    }
  }
  return result;
}

// Keeps only the fields read by parseGoogleJson, isAsset, isAlbum, asMetadata, googlePhotosExtra and albumFromJson.
// Values of the wrong type are kept as they are, so parsing the compact form fails exactly like the original.
export function compactGoogleJson(value: unknown): CompactGoogleJson {
  if (!isPlainObject(value)) {
    return value as CompactGoogleJson;
  }
  const result = prune(value, METADATA) as Record<string, unknown>;
  if (Object.hasOwn(value, 'albumData')) {
    result.albumData = prune(value.albumData, METADATA);
  }
  return result as CompactGoogleJson;
}

export function isImmichGoJson(value: unknown): value is { immichGo: true } {
  return isPlainObject(value) && value.immichGo === true && Object.keys(value).length === 1;
}

// Pass 1 reading of a .json entry (2.4 step 4)
export function compactJsonEntry(data: Buffer): { json: CompactGoogleJson | null; error: string | null } {
  if (data.includes('immich-go version:')) {
    return { json: { immichGo: true }, error: null };
  }
  try {
    return { json: compactGoogleJson(JSON.parse(data.toString('utf8'))), error: null };
  } catch (error) {
    return { json: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// Go's GoogleMetadata.UnmarshalJSON, including the old {"albumData": {...}} album format. null means Go fails.
export function parseGoogleJson(value: unknown): GoogleMetadata | null {
  if (value === null) {
    return {};
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const albumData = value.albumData;
  if (albumData !== null && albumData !== undefined && validate(albumData, METADATA)) {
    return albumData as GoogleMetadata;
  }
  if (!validate(value, METADATA)) {
    return null;
  }
  return value as GoogleMetadata;
}

export function isAsset(md: GoogleMetadata): boolean {
  return md.photoTakenTime !== null && md.photoTakenTime !== undefined && (md.photoTakenTime.timestamp ?? '') !== '';
}

export function isAlbum(md: GoogleMetadata): boolean {
  return !isAsset(md) && (md.title ?? '') !== '';
}

// googIsPresent: true when the key is present with anything but a JSON bool (or null)
export function googIsPresent(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== 'boolean';
}

function parseInt64(value: string): bigint | null {
  if (!/^[+-]?\d+$/.test(value)) {
    return null;
  }
  const n = BigInt(value);
  if (n > INT64_MAX || n < INT64_MIN) {
    return null;
  }
  return n;
}

// googTimeObject.Time(): null stands for Go's zero time (unparsable or "0")
export function googleTimeToDate(time: GoogleTime | null | undefined): Date | null {
  const timestamp = time?.timestamp ?? '';
  const seconds = parseInt64(timestamp);
  if (seconds === null || seconds === 0n) {
    return null;
  }
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

// time.Time.UTC().Format(time.RFC3339)
export function formatRfc3339(date: Date | null): string {
  if (date === null) {
    return '0001-01-01T00:00:00Z';
  }
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}Z`
  );
}

function hasTimestamp(time: GoogleTime | null | undefined, allowZero: boolean): boolean {
  if (time === null || time === undefined) {
    return false;
  }
  const timestamp = time.timestamp ?? '';
  return timestamp !== '' && (allowZero || timestamp !== '0');
}

export function sanitizedTitle(title: string): string {
  return title.replaceAll(/[\r\n\\/:*?"<>|]/g, '_');
}

export function captureDateOf(md: GoogleMetadata): Date | null {
  return hasTimestamp(md.photoTakenTime, false) ? googleTimeToDate(md.photoTakenTime) : null;
}

export function isPartner(md: GoogleMetadata): boolean {
  return googIsPresent(md.googlePhotosOrigin?.fromPartnerSharing);
}

export function asMetadata(md: GoogleMetadata): AssetMetadataFromJson {
  let latitude = 0;
  let longitude = 0;
  if (md.geoDataExif !== null && md.geoDataExif !== undefined) {
    latitude = md.geoDataExif.latitude ?? 0;
    longitude = md.geoDataExif.longitude ?? 0;
    if (latitude === 0 && longitude === 0 && md.geoData !== null && md.geoData !== undefined) {
      latitude = md.geoData.latitude ?? 0;
      longitude = md.geoData.longitude ?? 0;
    }
  } else if (md.geoData !== null && md.geoData !== undefined) {
    latitude = md.geoData.latitude ?? 0;
    longitude = md.geoData.longitude ?? 0;
  }
  return {
    fileName: sanitizedTitle(md.title ?? ''),
    description: md.description ?? '',
    latitude,
    longitude,
    captureDate: captureDateOf(md),
    trashed: md.trashed ?? false,
    archived: md.archived ?? false,
    favorited: md.favorited ?? false,
    fromPartner: isPartner(md),
    people: (md.people ?? []).map((person) => person?.name ?? ''),
  };
}

// Go GoogleMetadata.Extra(): the "google-photos" asset metadata, only present values
export function googlePhotosExtra(md: GoogleMetadata): Record<string, unknown> {
  const e: Record<string, unknown> = {};
  if ((md.url ?? '') !== '') {
    e.url = md.url;
  }
  if (hasTimestamp(md.creationTime, false)) {
    e.uploadedAt = formatRfc3339(googleTimeToDate(md.creationTime));
  }
  if (hasTimestamp(md.photoTakenTime, false)) {
    e.takenAt = formatRfc3339(googleTimeToDate(md.photoTakenTime));
  }
  const views = parseInt64(md.imageViews ?? '');
  if (views !== null) {
    e.views = Number(views);
  }
  const exifAltitude = md.geoDataExif?.altitude ?? 0;
  const altitude = md.geoData?.altitude ?? 0;
  if (md.geoDataExif !== null && md.geoDataExif !== undefined && exifAltitude !== 0) {
    e.altitude = exifAltitude;
  } else if (md.geoData !== null && md.geoData !== undefined && altitude !== 0) {
    e.altitude = altitude;
  }

  const origin = md.googlePhotosOrigin;
  const mobileUpload = origin?.mobileUpload ?? null;
  if (googIsPresent(origin?.fromPartnerSharing)) {
    e.origin = 'partnerSharing';
  } else if (googIsPresent(origin?.fromSharedAlbum)) {
    e.origin = 'sharedAlbum';
    e.addedByOtherUser = true;
  } else if (origin?.webUpload !== null && origin?.webUpload !== undefined) {
    e.origin = 'webUpload';
  } else if (mobileUpload !== null) {
    e.origin = 'mobileUpload';
  }
  if (mobileUpload !== null) {
    if ((mobileUpload.deviceType ?? '') !== '') {
      e.deviceType = mobileUpload.deviceType;
    }
    const folder = mobileUpload.deviceFolder?.localFolderName ?? '';
    if (folder !== '') {
      e.deviceFolder = folder;
    }
  }
  if ((md.appSource?.androidPackageName ?? '') !== '') {
    e.appPackage = md.appSource?.androidPackageName;
  }
  if ((md.composition?.type ?? '') !== '') {
    e.composition = md.composition?.type;
  }

  const people = (md.people ?? []).map((person) => person?.name ?? '').filter((name) => name !== '');
  if (people.length > 0) {
    e.people = people;
  }

  const removed = (md.removeResultReason ?? []).flatMap((r) => (r?.reason ?? []).map((reason) => reason ?? ''));
  if (removed.length > 0) {
    e.peopleRemovedReasons = removed;
  }

  const comments = md.sharedAlbumComments ?? [];
  if (comments.length > 0) {
    e.comments = comments.map((comment) => {
      const m: Record<string, unknown> = {};
      if ((comment?.contentOwnerName ?? '') !== '') {
        m.author = comment?.contentOwnerName;
      }
      if ((comment?.text ?? '') !== '') {
        m.text = comment?.text;
      }
      if (comment?.liked) {
        m.liked = true;
      }
      if (hasTimestamp(comment?.creationTime, true)) {
        m.at = formatRfc3339(googleTimeToDate(comment?.creationTime));
      }
      return m;
    });
  }
  return e;
}

function addString(s: string, separator: string, t: string): string {
  return s === '' ? t : s + separator + t;
}

export function enrichmentsOf(md: GoogleMetadata): { text: string; latitude: number; longitude: number } | null {
  if (md.enrichments === null || md.enrichments === undefined) {
    return null;
  }
  let text = '';
  let latitude = 0;
  let longitude = 0;
  for (const enrichment of md.enrichments) {
    const narrative = enrichment?.narrativeEnrichment?.text ?? '';
    if (narrative !== '') {
      text = addString(text, '\n', narrative);
    }
    const locations = enrichment?.locationEnrichment?.location;
    if (locations !== null && locations !== undefined) {
      for (const location of locations) {
        const name = location?.name ?? '';
        const description = location?.description ?? '';
        if (name !== '') {
          text = addString(text, '\n', name);
        }
        if (description !== '') {
          text = addString(text, ' - ', description);
        }
        latitude = (location?.latitudeE7 ?? 0) / 10e6;
        longitude = (location?.longitudeE7 ?? 0) / 10e6;
      }
    }
  }
  return { text, latitude, longitude };
}

export function albumFromJson(md: GoogleMetadata): AlbumFromJson {
  const enrichments = enrichmentsOf(md);
  return {
    title: md.title ?? '',
    description: enrichments?.text ?? '',
    latitude: enrichments?.latitude ?? 0,
    longitude: enrichments?.longitude ?? 0,
  };
}
