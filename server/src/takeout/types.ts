// ---------- part names and exports ----------
export type ArchiveKind = 'zip' | 'tgz';

export interface PartName {
  fileName: string;
  timestamp: string;
  exportedAt: Date;
  segment: number | null;
  partNumber: number;
  kind: ArchiveKind;
}

export interface FolderFile {
  fileName: string;
  size: number;
  mtime: Date;
  ctime: Date;
}

export interface DetectedPart extends PartName {
  size: number;
  mtime: Date;
  ctime: Date;
  isIndex: boolean;
  indexConfirmed: boolean;
}

export interface DetectedExport {
  exportKey: string;
  exportedAt: Date;
  parts: DetectedPart[];
}

// ---------- archive_browser.html ----------
export interface ArchiveBrowserIndex {
  googleJobId: string | null;
  accountEmail: string | null;
  createdText: string | null;
  totalSizeText: string | null;
  services: Array<{ englishName: string; folderName: string; fileCount: number; sizeText: string }>;
  files: string[];
}

// ---------- analysis ----------
export type Completeness = 'unknown' | 'complete' | 'uncertain' | 'incomplete';
export type PartScanStatus = 'pending' | 'scanning' | 'scanned' | 'error' | 'missing';

export interface ExportAnalysisPart {
  fileName: string;
  segment: number | null;
  partNumber: number;
  timestamp: string;
  size: number;
  kind: ArchiveKind;
  isIndex: boolean;
  scanStatus: PartScanStatus;
  scanError: string | null;
}

export interface ExportAnalysisInput {
  parts: ExportAnalysisPart[];
  index: ArchiveBrowserIndex | null;
  catalogPaths: Set<string> | null;
  catalogSummary: CatalogSummary | null;
  previous: ExportAnalysis | null;
}

export type AnalysisReason =
  | 'missing_part'
  | 'corrupt_part'
  | 'last_part_may_be_missing'
  | 'index_missing_files'
  | 'orphan_json'
  | 'not_scanned'
  | 'part_missing_on_disk';

export interface PathSample {
  count: number;
  sample: string[];
}

export interface ExportAnalysis {
  completeness: Completeness;
  splitSize: number | null;
  missingParts: Array<{ segment: number | null; partNumber: number; expectedName: string }>;
  smallParts: string[];
  corruptParts: string[];
  lastPartMayBeMissing: boolean;
  indexMissingFiles: PathSample;
  notInIndex: number;
  // true once the index cross-check ran against scanned catalogs (now or in `previous`)
  indexChecked: boolean;
  jsonWithoutMedia: PathSample;
  mediaWithoutJson: PathSample;
  catalogSummary: CatalogSummary | null;
  reasons: AnalysisReason[];
}

// ---------- archive reading ----------
export interface ArchiveEntryInfo {
  path: string;
  size: number;
  mtime: Date | null;
  seq: number;
  error: string | null;
}

export type EntryHandler = (entry: ArchiveEntryInfo, open: () => Promise<NodeJS.ReadableStream>) => Promise<void>;

export interface WalkOptions {
  signal?: AbortSignal;
  // cumulative compressed bytes read from disk by this walk (monotonic)
  onBytes?: (bytesRead: number) => void;
  only?: Set<string>;
  startSeq?: number;
}

// ---------- classification and samples ----------
export type EntryKind = 'media' | 'json' | 'sidecar' | 'useless' | 'unsupported' | 'other';

export interface ImageSample {
  width: number;
  height: number;
  sample: Buffer;
}

export type ImageSampleResult = ImageSample | { skipped: 'tooLarge' | 'decodeError' };

export type Rotation = 0 | 90 | 180 | 270;

// ---------- google json ----------
export interface GoogleTime {
  timestamp?: string | null;
}

export interface GoogleGeoData {
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
}

export interface GoogleEnrichment {
  narrativeEnrichment?: { text?: string | null } | null;
  locationEnrichment?: {
    location?: Array<{
      name?: string | null;
      description?: string | null;
      latitudeE7?: number | null;
      longitudeE7?: number | null;
    } | null> | null;
  } | null;
}

export interface GoogleMetadata {
  title?: string | null;
  description?: string | null;
  category?: string | null;
  date?: GoogleTime | null;
  photoTakenTime?: GoogleTime | null;
  geoDataExif?: GoogleGeoData | null;
  geoData?: GoogleGeoData | null;
  trashed?: boolean | null;
  archived?: boolean | null;
  url?: string | null;
  favorited?: boolean | null;
  enrichments?: Array<GoogleEnrichment | null> | null;
  people?: Array<{ name?: string | null } | null> | null;
  googlePhotosOrigin?: {
    fromPartnerSharing?: unknown;
    fromSharedAlbum?: unknown;
    mobileUpload?: {
      deviceType?: string | null;
      deviceFolder?: { localFolderName?: string | null } | null;
    } | null;
    webUpload?: { computerUpload?: unknown } | null;
  } | null;
  creationTime?: GoogleTime | null;
  imageViews?: string | null;
  appSource?: { androidPackageName?: string | null } | null;
  composition?: { type?: string | null } | null;
  removeResultReason?: Array<{ reason?: Array<string | null> | null } | null> | null;
  sharedAlbumComments?: Array<{
    text?: string | null;
    liked?: boolean | null;
    contentOwnerName?: string | null;
    creationTime?: GoogleTime | null;
  } | null> | null;
  albumData?: unknown;
}

export type CompactGoogleJson = GoogleMetadata | { immichGo: true };

export interface AssetMetadataFromJson {
  fileName: string;
  description: string;
  latitude: number;
  longitude: number;
  captureDate: Date | null;
  trashed: boolean;
  archived: boolean;
  favorited: boolean;
  fromPartner: boolean;
  people: string[];
}

export interface AlbumFromJson {
  title: string;
  description: string;
  latitude: number;
  longitude: number;
}

// ---------- catalog ----------
export interface CatalogInput {
  partName: string;
  path: string;
  size: number;
  mtime: Date | null;
  kind: EntryKind;
  json: CompactGoogleJson | null;
  checksum: Buffer | null;
  sample: ImageSample | null;
}

export type MatcherName = 'fastTrack' | 'normal' | 'forgottenDuplicates' | 'edited';

export interface CatalogSummary {
  assetJsons: number;
  albumJsons: number;
  unknownJsons: number;
  matched: Record<MatcherName, number>;
  jsonWithoutMedia: string[];
  mediaWithoutJson: string[];
}

// ---------- settings ----------
export type RawJpgMode = 'NoStack' | 'KeepRaw' | 'KeepJPG' | 'StackCoverRaw' | 'StackCoverJPG';
export type BurstMode = 'NoStack' | 'Stack' | 'StackKeepRaw' | 'StackKeepJPEG';
export type HeicJpgMode = 'NoStack' | 'KeepHeic' | 'KeepJPG' | 'StackCoverHeic' | 'StackCoverJPG';
export type VideoBoostMode = 'NoStack' | 'Stack' | 'KeepMain';
export type OnErrorsMode = 'continue' | 'stop';

export interface TakeoutSettings {
  rawJpg: RawJpgMode;
  burst: BurstMode;
  heicJpg: HeicJpgMode;
  videoBoost: VideoBoostMode;
  customTags: string[];
  sessionTag: boolean;
  sessionTagTemplate: string;
  takeoutTag: boolean;
  peopleTags: boolean;
  onErrors: OnErrorsMode;
  stopAfterErrors: number;
  dateRange: string | null;
  syncAlbums: boolean;
  includePartner: boolean;
  includeArchived: boolean;
  includeTrashed: boolean;
  includeUnmatched: boolean;
  googlePhotosFields: boolean;
  applyRotation: boolean;
  tagServerDuplicates: boolean;
  burstByTime: boolean;
  homeTimeZone: string;
}

export interface TemplateVars {
  date: string;
  user: string;
  start: string;
}

// ---------- date range ----------
export interface DateRange {
  after: Date;
  before: Date;
  text: string;
}

// ---------- planning ----------
export type GroupKind = 'none' | 'burst' | 'rawJpg' | 'heicJpg' | 'other' | 'videoBoost';

export const PLAN_ACTIONS = [
  'upload',
  'localDuplicate',
  'duplicatedInDirectory',
  'rotateOnlyDropped',
  'notSelected',
  'filteredPartner',
  'filteredTrashed',
  'filteredArchived',
  'filteredDateRange',
  'missingMetadata',
  'failedVideo',
  'useless',
  'unsupported',
  'banned',
  'sidecarXmp',
  'albumJson',
  'assetJson',
  'assetJsonUnused',
  'unknownJson',
  'immichGoJson',
] as const;

// 'assetJson' is an asset JSON that supplied metadata to at least one file: every catalog file gets exactly one action
export type PlanAction = (typeof PLAN_ACTIONS)[number];

export type PlannedFileKind = 'image' | 'video' | 'json' | 'sidecar' | 'useless' | 'unsupported' | 'banned' | 'other';

export interface PlannedAlbum {
  title: string;
  description: string;
}

export interface PlannedAssetData {
  captureDate: string | null;
  description: string;
  latitude: number;
  longitude: number;
  favorited: boolean;
  archived: boolean;
  trashed: boolean;
  fromPartner: boolean;
  albums: PlannedAlbum[];
  tags: string[];
  extra: Record<string, unknown> | null;
  fallbacks: string[];
}

export interface PlannedFile {
  key: number;
  catalogIndex: number;
  partName: string | null;
  takeoutPath: string;
  onDiskName: string;
  size: number;
  mtime: Date | null;
  checksum: Buffer | null;
  fileKind: PlannedFileKind;
  jsonPath: string | null;
  matcher: MatcherName | null;
  originalFileName: string | null;
  action: PlanAction;
  reason: string | null;
  rotation: Rotation;
  isEditedCopy: boolean;
  data: PlannedAssetData | null;
}

export interface PlannedGroup {
  index: number;
  kind: GroupKind;
  members: number[];
  coverIndex: number;
  links: number[];
}

// [DEV 3] / section 11 D1: one entry per dropped rotate-only edited copy. The library applies the rotation to the
// original's PlannedFile (`files[originalKey].rotation === angle`) and drops the copy (`rotateOnlyDropped`). Package B
// consumes this list to run the D1 sequence on the ORIGINAL asset, in this order, before the copy is discarded server
// side: (1) apply the rotation edit to the original, (2) re-run face detection on the now-upright original, (3)
// reconcile the named people that belonged to the copy, (4) only then drop the copy. `originalKey` and `copyKey` are
// `PlannedFile.key` values (resolve with `plan.files.find((f) => f.key === ...)`, or by array index since key === the
// index). The copy's Google people/metadata are the copy row's own (same JSON as the original by construction, so
// `files[copyKey].jsonPath` and the original's `data.tags` People/* entries carry them). `angle` is the clockwise
// rotation in degrees to make the original upright, matching `files[originalKey].rotation`.
export interface RotatePair {
  originalKey: number;
  copyKey: number;
  angle: Rotation;
}

export interface ImportPlan {
  files: PlannedFile[];
  groups: PlannedGroup[];
  counters: TakeoutCounters;
  // section 11 D1 hook contract; empty when no rotate-only copy was dropped.
  rotatePairs: RotatePair[];
}

export interface PlanContext {
  rotationProbe: (original: PlannedFile, edited: PlannedFile) => Promise<Rotation>;
}

// ---------- time zone (section 13: "Google unless 100% sure" capture-time rule) ----------
// Where the resolved zone came from. Only the first four are produced by section 13; 'device', 'gps', 'home',
// 'exif' and 'filename' are kept for backward compatibility with older run rows.
//   fileOffset    rule 1: the file's own explicit offset (OffsetTimeOriginal / QuickTime CreationDate offset)
//   derivedOffset rule 2: PHONE clock minus Google is a whole 15-min offset within 2s
//   screenshot    rule 3: Screenshot_YYYYMMDD-HHMMSS name minus Google is a whole 15-min offset within 2s
//   google        Google's photoTakenTime kept with NO zone (camera, or no zone evidence; flagged zoneAssumed)
export type ZoneSource = 'fileOffset' | 'device' | 'derivedOffset' | 'google' | 'screenshot' | 'gps' | 'home' | 'exif' | 'filename';

// The device class the EXIF Make/Model classify into (section 12).
export type DeviceClass = 'phone' | 'camera' | 'unknown';

// The per-asset EXIF facts the capture-time algorithm needs. The server derives these from a single
// `metadataRepository.readTags(file)` read; the pure library never touches exiftool.
export interface CaptureExifInput {
  // EXIF Make (or Android/ICC fallbacks), null when the file carries none (screenshots/downloads).
  make: string | null;
  // EXIF Model (or Android/ICC fallbacks), null when absent.
  model: string | null;
  // The file's own explicit offset zone (from OffsetTimeOriginal, TimeZone tags, or a QuickTime CreationDate
  // offset). Null when the file records no explicit offset. GPS-derived and inferred zones do NOT go here.
  fileOffsetZone: string | null;
  // True when the file already carries GPS coordinates (so we must not write Google GPS to the sidecar).
  fileHasGps: boolean;
  // The file's own wall clock (DateTimeOriginal / QuickTime CreateDate) as UTC calendar components: a Date
  // whose UTC Y-M-D H:M:S equal the clock the device wrote. Null when the file has no date.
  fileClock: Date | null;
  // The file's GPSDateTime (a UTC instant), when present: an independent clock that can prove a rule-1 file
  // moment that disagrees with Google (section 13.1). Null otherwise.
  gpsDateTime: Date | null;
}

export interface CaptureTimeInput {
  // Google's photoTakenTime as an instant (epoch), or null when Google has no usable time.
  googleInstant: Date | null;
  exif: CaptureExifInput;
  // On-disk and title names: tested against Screenshot_YYYYMMDD-HHMMSS (rule 3) and, as an independent UTC
  // clock only, PXL_YYYYMMDD_HHMMSSmmm (section 13.1 proof).
  names: string[];
}

// Everything the caller needs to store the asset and drive the Immich sidecar/API mechanics (section 13).
export interface CaptureTimeResult {
  device: DeviceClass;
  // The chosen capture moment: Google's photoTakenTime unless a file moment was proven (section 13.1). Null
  // only when Google has no usable time and the file carries no zoned moment.
  instant: Date | null;
  // The zone a rule supplied (luxon name / UTC offset), or null when there is no zone evidence (no invented
  // zone; leave Immich's default display).
  zone: string | null;
  zoneSource: ZoneSource | null;
  // Whether to PUT dateTimeOriginal through the API. False when the file natively carries the chosen moment
  // and zone (rule 1) or when there is no moment to set.
  putDate: boolean;
  // The offset/zone to PUT alongside dateTimeOriginal, only when a rule supplies one. Null with putDate true
  // means PUT the moment with no zone.
  putOffsetZone: string | null;
  // Write Google GPS into the sidecar only when the file lacks GPS (section 13 mechanics).
  writeGpsToSidecar: boolean;
  // Report flags: 'zoneAssumed' (no zone evidence), 'fileMomentDisagrees', 'fileMomentProvenByPxl',
  // 'fileMomentProvenByGpsDateTime', 'google-instant-with-differing-clock', '1-hour-ambiguous', 'noDate'.
  flags: string[];
}

// ---------- counters ----------
export interface TakeoutCounters {
  scanned: {
    files: number;
    images: number;
    videos: number;
    assetJsons: number;
    albumJsons: number;
    unknownJsons: number;
    useless: number;
    unsupported: number;
    banned: number;
    sidecars: number;
  };
  matched: { fastTrack: number; normal: number; forgottenDuplicates: number; edited: number; missingMetadata: number };
  discarded: {
    localDuplicates: number;
    duplicatedInDirectory: number;
    filteredPartner: number;
    filteredTrashed: number;
    filteredArchived: number;
    filteredDateRange: number;
    notSelected: number;
    rotateOnlyDropped: number;
    failedVideos: number;
    previouslyDeleted: number;
  };
  result: {
    toUpload: number;
    uploaded: number;
    serverDuplicates: number;
    betterOnServer: number;
    alreadyProcessed: number;
    largerUploaded: number;
    stacked: number;
    albumsCreated: number;
    albumAdds: number;
    tagged: number;
    metadataSaved: number;
    rotationsQueued: number;
    rotationsApplied: number;
    zoneAssumed: number;
    errors: number;
  };
  bytes: { total: number; done: number };
}

export interface CounterRow {
  action: string;
  status: string;
  fileKind: string;
  matcher: string | null;
  fallbacks: string[];
  rotationState: string | null;
  isCover: boolean;
  groupKind: string | null;
  reason: string | null;
  count: number;
}
