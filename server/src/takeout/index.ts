// Public API of the pure takeout library (spec section 5.4). B consumes only these exports.

export type {
  ArchiveKind,
  PartName,
  FolderFile,
  DetectedPart,
  DetectedExport,
  ArchiveBrowserIndex,
  Completeness,
  ExportAnalysisInput,
  ExportAnalysis,
  ExportAnalysisPart,
  AnalysisReason,
  ArchiveEntryInfo,
  EntryHandler,
  WalkOptions,
  EntryKind,
  ImageSample,
  ImageSampleResult,
  Rotation,
  GoogleMetadata,
  CompactGoogleJson,
  AssetMetadataFromJson,
  AlbumFromJson,
  CatalogInput,
  MatcherName,
  CatalogSummary,
  RawJpgMode,
  BurstMode,
  HeicJpgMode,
  VideoBoostMode,
  TakeoutSettings,
  TemplateVars,
  DateRange,
  GroupKind,
  PlanAction,
  PlannedAssetData,
  PlannedFile,
  PlannedGroup,
  ImportPlan,
  RotatePair,
  PlanContext,
  ZoneSource,
  DeviceClass,
  CaptureExifInput,
  CaptureTimeInput,
  CaptureTimeResult,
  TakeoutCounters,
  CounterRow,
} from 'src/takeout/types';

export { compareBytes, sortBytes } from 'src/takeout/byte-order';
export { nfc } from 'src/takeout/paths';

export { parsePartName, groupExports, takeoutTagName } from 'src/takeout/part-names';
export { parseArchiveBrowser } from 'src/takeout/archive-browser';
export { analyzeExport } from 'src/takeout/export-analysis';

export { walkArchive, listZipNames, readArchiveEntry } from 'src/takeout/archive-reader';
export { hashTap } from 'src/takeout/hashing';

export { classifyEntry, isDecodable } from 'src/takeout/media-types';
export { computeImageSample, detectRotationFromSamples, rotateSample } from 'src/takeout/image-sample';
export { EDITED_NAME_RE, originalNameOfEdited, isEditedCopy, samplePairsToKeep } from 'src/takeout/edited';

export {
  compactGoogleJson,
  parseGoogleJson,
  isAsset,
  isAlbum,
  asMetadata,
  googlePhotosExtra,
  albumFromJson,
  sanitizedTitle,
} from 'src/takeout/google-json';

export { buildCatalog } from 'src/takeout/catalog';
export type { TakeoutCatalog, CatalogAsset } from 'src/takeout/catalog';
export { DEFAULT_BANNED_PATTERNS } from 'src/takeout/banned';

export {
  DEFAULT_TAKEOUT_SETTINGS,
  mergeSettings,
  validateSettings,
  renderTemplate,
  runTags,
} from 'src/takeout/settings';

export { parseDateRange, inRange } from 'src/takeout/date-range';

export { planImport, sampleRotationProbe } from 'src/takeout/planner';
export { resolveCaptureTime, classifyDevice, sidecarDateString, wallTimeAsUtc, toLuxonZone } from 'src/takeout/timezone';
export { emptyCounters, countersFromRows } from 'src/takeout/counters';
