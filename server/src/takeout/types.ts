import type { ByteSemaphore } from 'src/takeout/byte-semaphore';
import type { FileSourceClock, FileSourceFs } from 'src/takeout/file-source';
import type { ReadGate, ReadThrottle } from 'src/takeout/flow-control';

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
/** state of a part's rows in takeout_entry */
export type CatalogStatus = 'none' | 'reading' | 'partial' | 'complete' | 'error';
export type SizeCheck = 'ok' | 'low' | 'short' | 'unknown';

export interface ExportAnalysisPart {
  fileName: string;
  segment: number | null;
  partNumber: number;
  timestamp: string;
  size: number;
  kind: ArchiveKind;
  isIndex: boolean;
  /** stable-file rule: not being copied any more */
  stable: boolean;
  /** the file is not in the folder any more */
  isMissing: boolean;
  catalogStatus: CatalogStatus;
  catalogError: string | null;
}

export interface UnreadablePart {
  fileName: string;
  error: string;
  /** compressed byte offset of the failure, null when unknown */
  offset: number | null;
  size: number;
}

/** Post-read checks, written by the planning step of a run (single-pass design 7.1) */
export interface LastReadAnalysis {
  at: string;
  runId: string;
  catalogSummary: CatalogSummary | null;
  indexMissingFiles: PathSample | null;
  notInIndex: number;
  unreadableParts: UnreadablePart[];
  unreadableEntries: number;
}

export interface ExportAnalysisInput {
  parts: ExportAnalysisPart[];
  index: ArchiveBrowserIndex | null;
  /** the index's total size in bytes (parseSizeText of its header), null without an index */
  indexTotalBytes: number | null;
  /** zip central-directory names of every present media part (pathKey values); null unless every part is zip */
  listingPaths: Set<string> | null;
  /** zip parts whose central directory could not be read before the run */
  corruptListings: Array<{ fileName: string; error: string }>;
  lastRead: LastReadAnalysis | null;
}

export type AnalysisReason =
  | 'missing_part'
  | 'corrupt_part'
  | 'last_part_may_be_missing'
  | 'index_missing_files'
  | 'orphan_json'
  | 'part_missing_on_disk'
  | 'size_shortfall'
  | 'part_unreadable'
  | 'part_unstable';

export const ANALYSIS_REASONS: AnalysisReason[] = [
  'missing_part',
  'corrupt_part',
  'last_part_may_be_missing',
  'index_missing_files',
  'orphan_json',
  'part_missing_on_disk',
  'size_shortfall',
  'part_unreadable',
  'part_unstable',
];

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
  // true when the index file list was cross-checked (zip listings before the run, or the catalog of the last run)
  indexChecked: boolean;
  jsonWithoutMedia: PathSample;
  mediaWithoutJson: PathSample;
  catalogSummary: CatalogSummary | null;
  indexTotalBytes: number | null;
  partsTotalBytes: number;
  sizeCheck: SizeCheck;
  /** zip listings were cross-checked against the index before any read */
  listingChecked: boolean;
  lastReadAt: string | null;
  lastReadRunId: string | null;
  unreadableParts: UnreadablePart[];
  unreadableEntries: number;
  reasons: AnalysisReason[];
}

// ---------- archive reading ----------
export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

/** Live counters of one read of a part (single-pass design 6.7, 13.2) */
export interface ReadMeter {
  /** covered file offset (tgz: compressed bytes passed to gunzip; zip: end of the last entry visited) */
  position: number;
  /** bytes returned by read(2) */
  bytesRead: number;
  /** bytes jumped over by seeks (zip gaps) */
  bytesSkipped: number;
  /** reads retried in place after a transport error */
  transportRetries: number;
  /** start time (ms) of the oldest read in flight, null when none */
  pendingSince: number | null;
}

export interface ArchiveEntryInfo {
  path: string;
  size: number;
  mtime: Date | null;
  /** position in the part: tgz counts regular files, zip is the index in local-offset order (directories included) */
  seq: number;
  /** encrypted, unsupported method, or a local header that does not match the central directory (zip) */
  error: string | null;
  /** compressed position after the entry; zip: known up front, tgz: known after the entry (afterEntry) */
  endOffset: number | null;
}

export type EntryOpener = () => Promise<NodeJS.ReadableStream>;
export type EntryHandler = (entry: ArchiveEntryInfo, open: EntryOpener) => Promise<void>;

export interface WalkSourceOptions {
  chunk?: number;
  depth?: number;
  retryBudgetMs?: number;
  backoffMs?: number[];
  memory?: ByteSemaphore | null;
  fs?: FileSourceFs;
  clock?: FileSourceClock;
  /** the read rate limit shared by the process (FileSourceOptions.throttle) */
  throttle?: ReadThrottle | null;
  /** passed before every positional read (FileSourceOptions.gate) */
  gate?: ReadGate | null;
  /** the readahead depth wanted now (FileSourceOptions.liveDepth) */
  liveDepth?: () => number;
}

export interface WalkOptions {
  signal?: AbortSignal;
  /** visit only these paths (seq numbering is not affected) */
  only?: Set<string>;
  /** zip: visit only these seqs (random access, gaps skipped) */
  seqs?: Set<number>;
  /** zip: resume at this seq */
  startSeq?: number;
  /** stop after this seq (fetch); no trailer check then */
  untilSeq?: number;
  /** checked after every entry; true stops the walk (fetch: every request found) */
  shouldStop?: () => boolean;
  /** called after each visited entry once its data passed, with the compressed end offset */
  afterEntry?: (entry: ArchiveEntryInfo, endOffset: number) => Promise<void> | void;
  /** expected in-run fingerprint of the file */
  fingerprint?: FileFingerprint | null;
  source?: WalkSourceOptions;
  /** live counters of this walk */
  meter?: ReadMeter;
  /** zip: gaps between visited entries larger than this are skipped with a seek */
  zipSeekGap?: number;
  /** test only: limit the read rate */
  throttleMBps?: number | null;
}

export interface WalkResult {
  /** visited entries */
  entries: number;
  /** tgz: the gzip trailer (CRC-32, ISIZE) of every member was checked */
  trailerVerified: boolean;
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
  /** the Google account name (before the @), else the Immich user name */
  user: string;
  /** the Google account email, lowercased, else the Immich user name; absent on runs created before it existed */
  email: string;
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
export type ZoneSource =
  'fileOffset' | 'device' | 'derivedOffset' | 'google' | 'screenshot' | 'gps' | 'home' | 'exif' | 'filename';

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
  // True when fileClock is a video's QuickTime CreateDate / CreationDate left in UTC (the format stores it in UTC
  // and exiftool had no non-UTC zone to shift it into). A zero rule-2 offset from it is no zone evidence.
  fileClockIsUtc: boolean;
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
    /** partUnreadable rows: parts and zip entries that could not be read */
    unreadable: number;
    /** missingFromArchive rows: index paths found in no readable part */
    missingFromArchive: number;
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

// ---------- read statistics (single-pass design 13.2) ----------
export type RunPartStatus = 'pending' | 'cached' | 'reading' | 'paused' | 'read' | 'error' | 'missing';

export interface TakeoutRunPartStats {
  partId: string;
  fileName: string;
  size: number;
  segment: number | null;
  partNumber: number;
  status: RunPartStatus;
  passes: number;
  /** covered bytes of earlier passes of this run (a tgz part restarted from byte 0) */
  passBase: number;
  bytesRead: number;
  bytesSkipped: number;
  position: number;
  fetchBytesRead: number;
  entries: number;
  media: number;
  entryErrors: number;
  staged: number;
  stagedBytes: number;
  duplicates: number;
  deferred: number;
  transportRetries: number;
  error: string | null;
  errorOffset: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** time the part spent paused (a paused run, or its reader held back by a lowered reader count) */
  pausedMs: number;
}

export interface TakeoutReadStats {
  version: 1;
  readers: number;
  readahead: number;
  crossDevice: boolean;
  filesFound: number;
  mediaFound: number;
  jsonFound: number;
  serverDuplicatesSkipped: number;
  localDuplicatesSkipped: number;
  stagedFiles: number;
  stagedBytes: number;
  deferredFiles: number;
  deferredBytes: number;
  wastedWriteFiles: number;
  wastedWriteBytes: number;
  fetchFiles: number;
  fetchBytesTotal: number;
  fetchBytesRead: number;
  sampleBackfillFiles: number;
  directoryBytesRead: number;
  transportRetries: number;
  etaSeconds: number | null;
  discardedStagedFiles: number;
  discardedStagedBytes: number;
  stagingBytes: number;
  stagingExpiresAt: string | null;
  /** time the run spent paused, pauses that ended (the current one counts from the run's pausedAt) */
  pausedMs: number;
  parts: Record<string, TakeoutRunPartStats>;
}
