// Public API of the pure takeout library (spec section 5.4). B consumes only these exports.

export { ANALYSIS_REASONS } from 'src/takeout/types';
export type {
  AlbumFromJson,
  AnalysisReason,
  ArchiveBrowserIndex,
  ArchiveEntryInfo,
  ArchiveKind,
  AssetMetadataFromJson,
  BurstMode,
  CaptureExifInput,
  CaptureTimeInput,
  CaptureTimeResult,
  CatalogInput,
  CatalogStatus,
  CatalogSummary,
  CompactGoogleJson,
  Completeness,
  CounterRow,
  DateRange,
  DetectedExport,
  DetectedPart,
  DeviceClass,
  EntryHandler,
  EntryKind,
  EntryOpener,
  ExportAnalysis,
  ExportAnalysisInput,
  ExportAnalysisPart,
  FileFingerprint,
  FolderFile,
  GoogleMetadata,
  GroupKind,
  HeicJpgMode,
  ImageSample,
  ImageSampleResult,
  ImportPlan,
  LastReadAnalysis,
  MatcherName,
  PartName,
  PlanAction,
  PlanContext,
  PlannedAssetData,
  PlannedFile,
  PlannedGroup,
  RawJpgMode,
  ReadMeter,
  RotatePair,
  Rotation,
  RunPartStatus,
  SizeCheck,
  TakeoutCounters,
  TakeoutReadStats,
  TakeoutRunPartStats,
  TakeoutSettings,
  TemplateVars,
  UnreadablePart,
  VideoBoostMode,
  WalkOptions,
  WalkResult,
  WalkSourceOptions,
  ZoneSource,
} from 'src/takeout/types';

export { compareBytes, sortBytes } from 'src/takeout/byte-order';
export { nfc } from 'src/takeout/paths';

export { parseArchiveBrowser, parseSizeText } from 'src/takeout/archive-browser';
export { SIZE_RATIO_LOW, SIZE_RATIO_SHORT, analyzeExport } from 'src/takeout/export-analysis';
export { groupExports, parsePartName, takeoutTagName } from 'src/takeout/part-names';

export { readArchiveEntry, readZipDirectory, readZipEntriesAt, walkArchive } from 'src/takeout/archive-reader';
export type { ZipDirectory, ZipDirectoryEntry } from 'src/takeout/archive-reader';
export { ByteLease, ByteSemaphore } from 'src/takeout/byte-semaphore';
export { ChecksumSet } from 'src/takeout/checksum-set';
export {
  ArchiveChangedError,
  ArchiveDataError,
  EntryDataError,
  GzipIntegrityError,
  PartMissingError,
  isArchiveDataError,
  messageOf,
} from 'src/takeout/errors';
export {
  FileSource,
  fingerprintOf,
  isTransportError,
  newReadMeter,
  nodeFileSourceFs,
  realClock,
  sameFingerprint,
} from 'src/takeout/file-source';
export type { FileHandleLike, FileSourceClock, FileSourceFs, FileSourceOptions } from 'src/takeout/file-source';
export { Gate, ReadThrottle, allGates, realThrottleClock } from 'src/takeout/flow-control';
export type { GateChange, ReadGate, ThrottleClock } from 'src/takeout/flow-control';
export { groupEdges, orderGroups } from 'src/takeout/group-order';
export type { GroupOrderRow } from 'src/takeout/group-order';
export { hashTap, sha1 } from 'src/takeout/hashing';
export { pathKey } from 'src/takeout/path-key';
export { chooseReadMode, decideAfterHash, decideAfterProbe, hex } from 'src/takeout/staging-policy';
export type { ReadMode, StageDecision, StagingLimits, StagingView } from 'src/takeout/staging-policy';

export { EDITED_NAME_RE, isEditedCopy, originalNameOfEdited, samplePairsToKeep } from 'src/takeout/edited';
export { computeImageSample, detectRotationFromSamples, rotateSample } from 'src/takeout/image-sample';
export { classifyEntry, isDecodable } from 'src/takeout/media-types';

export {
  albumFromJson,
  asMetadata,
  compactGoogleJson,
  googlePhotosExtra,
  isAlbum,
  isAsset,
  parseGoogleJson,
  sanitizedTitle,
} from 'src/takeout/google-json';

export { DEFAULT_BANNED_PATTERNS } from 'src/takeout/banned';
export { buildCatalog } from 'src/takeout/catalog';
export type { CatalogAsset, TakeoutCatalog } from 'src/takeout/catalog';

export {
  DEFAULT_TAKEOUT_SETTINGS,
  mergeSettings,
  renderTemplate,
  runTags,
  validateSettings,
} from 'src/takeout/settings';

export { inRange, parseDateRange } from 'src/takeout/date-range';

export { countersFromRows, emptyCounters } from 'src/takeout/counters';
export { planImport, sampleRotationProbe } from 'src/takeout/planner';
export {
  classifyDevice,
  resolveCaptureTime,
  sidecarDateString,
  toLuxonZone,
  wallTimeAsUtc,
} from 'src/takeout/timezone';
