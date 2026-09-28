import { createZodDto } from 'nestjs-zod';
import { HistoryBuilder } from 'src/decorators';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto';
import {
  TakeoutArchiveKindSchema,
  TakeoutBurstModeSchema,
  TakeoutCompletenessSchema,
  TakeoutExportReadStatusSchema,
  TakeoutFileKindSchema,
  TakeoutGroupKindSchema,
  TakeoutHeicJpgModeSchema,
  TakeoutLargerVersionStatusSchema,
  TakeoutMatcherSchema,
  TakeoutOnErrorsSchema,
  TakeoutPartReadStatusSchema,
  TakeoutRawJpgModeSchema,
  TakeoutRotationStateSchema,
  TakeoutRunFileActionSchema,
  TakeoutRunFileStatusSchema,
  TakeoutRunPartStatusSchema,
  TakeoutRunStatusSchema,
  TakeoutScanStatusSchema,
  TakeoutSizeCheckSchema,
  TakeoutVideoBoostModeSchema,
  TakeoutZoneSourceSchema,
} from 'src/enum';
import z from 'zod';

const dateTime = () => z.string().meta({ format: 'date-time' });
/** single-pass reading replaced the scan: the old fields stay one release, derived from the read state */
const deprecated = () => new HistoryBuilder().added('v3.2.2').deprecated('v3.2.2').getExtensions();

const TakeoutFolderSchema = z
  .object({
    name: z.string().describe('Folder name, chosen once when the folder was created'),
    hostPath: z.string().describe('Folder path relative to UPLOAD_LOCATION, for example "takeouts/<name>"'),
  })
  .meta({ id: 'TakeoutFolderDto' });

const TakeoutOtherFileSchema = z
  .object({
    name: z.string().describe('File name'),
    size: z.int().min(0).describe('File size in bytes'),
  })
  .meta({ id: 'TakeoutOtherFileDto' });

const TakeoutPartSchema = z
  .object({
    id: z.uuidv4().describe('Part ID'),
    fileName: z.string().describe('Archive file name'),
    segment: z.int().nullable().describe('Segment number N of "-N-NNN" names, null for "-NNN" names'),
    partNumber: z.int().describe('Part number NNN'),
    kind: TakeoutArchiveKindSchema,
    isIndex: z.boolean().describe('Whether this is the index archive (archive_browser.html)'),
    size: z.int().min(0).describe('File size in bytes'),
    mtime: dateTime().describe('File modification time'),
    readStatus: TakeoutPartReadStatusSchema,
    bytesRead: z.int().min(0).describe('Bytes read from the file by the last run that read it, all passes included'),
    entryCount: z.int().min(0).nullable().describe('Number of files in the part, once it was read completely'),
    readError: z.string().nullable().describe('Why the part could not be read'),
    readErrorOffset: z
      .int()
      .min(0)
      .nullable()
      .describe('Compressed byte offset where reading failed, comparable with the file size'),
    lastReadRunId: z.uuidv4().nullable().describe('The run that read the part last'),
    scanStatus: TakeoutScanStatusSchema.meta(deprecated()),
    bytesScanned: z.int().min(0).describe('Deprecated: same as bytesRead').meta(deprecated()),
    scanError: z.string().nullable().describe('Deprecated: same as readError').meta(deprecated()),
  })
  .meta({ id: 'TakeoutPartDto' });

const TakeoutMissingPartSchema = z
  .object({
    segment: z.int().nullable().describe('Segment number, null for exports without segments'),
    partNumber: z.int().describe('Missing part number'),
    expectedName: z
      .string()
      .describe('Expected file name; the real file may carry a different timestamp than its neighbours'),
  })
  .meta({ id: 'TakeoutMissingPartDto' });

const TakeoutPathSampleSchema = z
  .object({
    count: z.int().min(0).describe('Number of paths'),
    sample: z.array(z.string()).describe('The first paths (at most 200)'),
  })
  .meta({ id: 'TakeoutPathSampleDto' });

const TakeoutUnreadablePartSchema = z
  .object({
    fileName: z.string().describe('Archive file name'),
    error: z.string().describe('Why the part could not be read'),
    offset: z.int().min(0).nullable().describe('Compressed byte offset of the failure'),
    size: z.int().min(0).describe('File size in bytes'),
  })
  .meta({ id: 'TakeoutUnreadablePartDto' });

const TakeoutAnalysisSchema = z
  .object({
    splitSize: z.int().nullable().describe('Detected archive split size in bytes'),
    missingParts: z.array(TakeoutMissingPartSchema).describe('Gaps in the part numbering'),
    smallParts: z.array(z.string()).describe('Parts smaller than the split size (informational)'),
    corruptParts: z.array(z.string()).describe('Parts that could not be read, with the error'),
    lastPartMayBeMissing: z.boolean().describe('Whether parts after the last one may exist (no index)'),
    indexMissingFiles: TakeoutPathSampleSchema.describe('Files listed in the index but missing from the parts'),
    notInIndex: z.int().min(0).describe('Files in the parts that the index does not list (informational)'),
    jsonWithoutMedia: TakeoutPathSampleSchema.describe('Google JSON files that belong to no media file'),
    mediaWithoutJson: TakeoutPathSampleSchema.describe('Media files without Google JSON'),
    indexTotalBytes: z.int().min(0).nullable().describe('Total size the index announces, in bytes'),
    partsTotalBytes: z.int().min(0).describe('Sum of the sizes of the media parts'),
    sizeCheck: TakeoutSizeCheckSchema,
    listingChecked: z.boolean().describe('Zip listings were cross-checked against the index before any read'),
    lastReadAt: dateTime().nullable().describe('When the checks that need a read ran (the last run)'),
    lastReadRunId: z.uuidv4().nullable().describe('The run whose read produced those checks'),
    unreadableParts: z.array(TakeoutUnreadablePartSchema).describe('Parts the last run could not read'),
    unreadableEntries: z.int().min(0).describe('Zip entries the last run could not read'),
    reasons: z.array(z.string()).describe('Why the export is not complete, as stable keys'),
  })
  .meta({ id: 'TakeoutAnalysisDto' });

const TakeoutSettingsSchema = z
  .object({
    rawJpg: TakeoutRawJpgModeSchema,
    burst: TakeoutBurstModeSchema,
    heicJpg: TakeoutHeicJpgModeSchema,
    videoBoost: TakeoutVideoBoostModeSchema,
    customTags: z
      .array(z.string())
      .describe('Tags added to every imported asset; {date}, {user} and {start} are replaced'),
    sessionTag: z.boolean().describe('Add a tag for the run'),
    sessionTagTemplate: z.string().describe('Template of the run tag'),
    takeoutTag: z.boolean().describe('Tag each asset with the name of its archive'),
    peopleTags: z.boolean().describe('Tag people named by Google as People/<name>'),
    onErrors: TakeoutOnErrorsSchema,
    stopAfterErrors: z.int().min(0).describe('With onErrors continue: stop after this many errors, 0 never stops'),
    dateRange: z
      .string()
      .nullable()
      .describe('Only import files taken in this range: YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DD,YYYY-MM-DD'),
    syncAlbums: z.boolean().describe('Add assets to the albums of the export'),
    includePartner: z.boolean().describe('Import photos shared by a partner'),
    includeArchived: z.boolean().describe('Import archived photos'),
    includeTrashed: z.boolean().describe('Import photos that were in the Google Photos trash'),
    includeUnmatched: z.boolean().describe('Import files without Google metadata'),
    googlePhotosFields: z.boolean().describe('Save Google Photos fields as asset metadata'),
    applyRotation: z.boolean().describe('Apply rotations from rotate-only edited copies'),
    tagServerDuplicates: z.boolean().describe('Tag photos that are already on the server'),
    burstByTime: z.boolean().describe('Stack bursts by time (500 ms grouper)'),
    homeTimeZone: z.string().describe('IANA time zone used when a file has no time zone of its own'),
  })
  .meta({ id: 'TakeoutSettingsDto' });

const TakeoutSettingsUpdateSchema = TakeoutSettingsSchema.partial().meta({ id: 'TakeoutSettingsUpdateDto' });

const TakeoutScannedCountersSchema = z
  .object({
    files: z.int(),
    images: z.int(),
    videos: z.int(),
    assetJsons: z.int(),
    albumJsons: z.int(),
    unknownJsons: z.int(),
    useless: z.int(),
    unsupported: z.int(),
    banned: z.int(),
    sidecars: z.int(),
  })
  .meta({ id: 'TakeoutScannedCountersDto' });

const TakeoutMatchedCountersSchema = z
  .object({
    fastTrack: z.int(),
    normal: z.int(),
    forgottenDuplicates: z.int(),
    edited: z.int(),
    missingMetadata: z.int(),
  })
  .meta({ id: 'TakeoutMatchedCountersDto' });

const TakeoutDiscardedCountersSchema = z
  .object({
    localDuplicates: z.int(),
    duplicatedInDirectory: z.int(),
    filteredPartner: z.int(),
    filteredTrashed: z.int(),
    filteredArchived: z.int(),
    filteredDateRange: z.int(),
    notSelected: z.int(),
    rotateOnlyDropped: z.int(),
    failedVideos: z.int(),
    previouslyDeleted: z.int(),
    unreadable: z.int().describe('Parts and zip entries that could not be read'),
    missingFromArchive: z.int().describe('Files the index lists but no readable part contains'),
  })
  .meta({ id: 'TakeoutDiscardedCountersDto' });

const TakeoutResultCountersSchema = z
  .object({
    toUpload: z.int(),
    uploaded: z.int(),
    serverDuplicates: z.int(),
    betterOnServer: z.int(),
    alreadyProcessed: z.int(),
    largerUploaded: z.int(),
    stacked: z.int(),
    albumsCreated: z.int(),
    albumAdds: z.int(),
    tagged: z.int(),
    metadataSaved: z.int(),
    rotationsQueued: z.int(),
    rotationsApplied: z.int(),
    zoneAssumed: z.int(),
    errors: z.int(),
  })
  .meta({ id: 'TakeoutResultCountersDto' });

const TakeoutBytesCountersSchema = z
  .object({
    total: z.int(),
    done: z.int(),
  })
  .meta({ id: 'TakeoutBytesCountersDto' });

const TakeoutCountersSchema = z
  .object({
    scanned: TakeoutScannedCountersSchema,
    matched: TakeoutMatchedCountersSchema,
    discarded: TakeoutDiscardedCountersSchema,
    result: TakeoutResultCountersSchema,
    bytes: TakeoutBytesCountersSchema,
  })
  .meta({ id: 'TakeoutCountersDto' });

const TakeoutRunPartStatsSchema = z
  .object({
    partId: z.uuidv4().describe('Part ID'),
    fileName: z.string().describe('Archive file name'),
    size: z.int().min(0).describe('File size in bytes'),
    status: TakeoutRunPartStatusSchema,
    passes: z.int().min(0).describe('How many times this run started reading the part (1 when nothing went wrong)'),
    bytesRead: z.int().min(0).describe('Bytes read from the file by this run, all passes included'),
    bytesSkipped: z.int().min(0).describe('Bytes jumped over (zip gaps)'),
    position: z.int().min(0).describe('Covered file offset of the current pass'),
    fetchBytesRead: z.int().min(0).describe('Bytes read again to fetch entries the plan needed'),
    entries: z.int().min(0).describe('Files found in the part'),
    media: z.int().min(0).describe('Photos and videos found in the part'),
    entryErrors: z.int().min(0).describe('Zip entries that could not be read'),
    staged: z.int().min(0).describe('Files written to staging'),
    stagedBytes: z.int().min(0).describe('Bytes written to staging'),
    duplicates: z.int().min(0).describe('Files already on the server or already staged'),
    deferred: z.int().min(0).describe('Files hashed only, fetched later if the plan needs them'),
    transportRetries: z.int().min(0).describe('Reads retried in place after a transport error'),
    error: z.string().nullable().describe('Why the part could not be read'),
    errorOffset: z.int().min(0).nullable().describe('Compressed byte offset of the failure'),
    startedAt: dateTime().nullable().describe('When this run started reading the part'),
    finishedAt: dateTime().nullable().describe('When this run finished the part'),
  })
  .meta({ id: 'TakeoutRunPartStatsDto' });

const TakeoutRunReadStatsSchema = z
  .object({
    readers: z.int().min(0).describe('Parts read in parallel'),
    readahead: z.int().min(0).describe('Reads in flight per part'),
    crossDevice: z.boolean().describe('Staging is on another disk than the library, so finishing copies files'),
    filesFound: z.int().min(0).describe('Files found in the parts read by this run'),
    mediaFound: z.int().min(0).describe('Photos and videos found'),
    jsonFound: z.int().min(0).describe('Google JSON files found'),
    serverDuplicatesSkipped: z.int().min(0).describe('Files already on the server, not written'),
    localDuplicatesSkipped: z.int().min(0).describe('Files whose content was already staged, not written again'),
    stagedFiles: z.int().min(0).describe('Files written to staging'),
    stagedBytes: z.int().min(0).describe('Bytes written to staging'),
    deferredFiles: z.int().min(0).describe('Files hashed only, fetched later if the plan needs them'),
    deferredBytes: z.int().min(0).describe('Bytes of the deferred files'),
    wastedWriteFiles: z.int().min(0).describe('Files written and then discarded because their content was present'),
    wastedWriteBytes: z.int().min(0).describe('Bytes written and then discarded'),
    fetchFiles: z.int().min(0).describe('Files read again because the plan needed them'),
    fetchBytesTotal: z.int().min(0).describe('Archive bytes the fetch step expects to read'),
    fetchBytesRead: z.int().min(0).describe('Archive bytes the fetch step read'),
    sampleBackfillFiles: z.int().min(0).describe('Images sampled after the read for the rotation check'),
    directoryBytesRead: z.int().min(0).describe('Zip central directory bytes read for the sampling set'),
    transportRetries: z.int().min(0).describe('Reads retried in place after a transport error'),
    etaSeconds: z.int().min(0).nullable().describe('Estimated seconds until reading or fetching is done'),
    discardedStagedFiles: z.int().min(0).describe('Staged files the plan did not use'),
    discardedStagedBytes: z.int().min(0).describe('Bytes of the staged files the plan did not use'),
    stagingBytes: z.int().min(0).describe('Bytes held in staging by a failed or cancelled run'),
    stagingExpiresAt: dateTime().nullable().describe('When the staging of a failed or cancelled run is removed'),
    parts: z.array(TakeoutRunPartStatsSchema).describe('Per part, in part order'),
  })
  .meta({ id: 'TakeoutRunReadStatsDto' });

const TakeoutRunSchema = z
  .object({
    id: z.uuidv4().describe('Run ID'),
    exportId: z.uuidv4().describe('Export ID'),
    status: TakeoutRunStatusSchema,
    importAnyway: z.boolean().describe('Whether the run was started although the export is not complete'),
    settings: TakeoutSettingsSchema,
    counters: TakeoutCountersSchema,
    bytesTotal: z.int().min(0).describe('Bytes of media to import'),
    bytesDone: z.int().min(0).describe('Bytes of media imported'),
    archiveBytesTotal: z.int().min(0).describe('Bytes of archives the reading phase covers'),
    archiveBytesRead: z.int().min(0).describe('Bytes of archives the reading phase covered so far (never goes back)'),
    readStats: TakeoutRunReadStatsSchema,
    hasStaging: z.boolean().describe('Staged files are held for this run (a failed or cancelled run can be discarded)'),
    supersededBy: z.uuidv4().nullable().describe('The newer run that took over the staged files of this run'),
    currentFile: z.string().nullable().describe('Archive path of the file being processed'),
    error: z.string().nullable().describe('Why the run failed'),
    startedAt: dateTime().nullable().describe('When the run started'),
    finishedAt: dateTime().nullable().describe('When the run finished'),
    createdAt: dateTime().describe('When the run was created'),
  })
  .meta({ id: 'TakeoutRunDto' });

const TakeoutExportSchema = z
  .object({
    id: z.uuidv4().describe('Export ID'),
    exportKey: z.string().describe('Timestamp of the first part, plus "-<segment>" when segmented'),
    exportedAt: dateTime().describe('Timestamp of the first part'),
    completeness: TakeoutCompletenessSchema,
    readStatus: TakeoutExportReadStatusSchema,
    partsRead: z.int().min(0).describe('Media parts that were read completely'),
    scanStatus: TakeoutScanStatusSchema.meta(deprecated()),
    partCount: z.int().min(0).describe('Number of parts found'),
    totalSize: z.int().min(0).describe('Total size of the parts in bytes'),
    bytesScanned: z
      .int()
      .min(0)
      .describe('Deprecated: bytes read from the parts by their last reads')
      .meta(deprecated()),
    accountEmail: z.string().nullable().describe('Google account of the export, from the index'),
    indexFileCount: z.int().nullable().describe('Number of files the index lists'),
    indexTotalSize: z.string().nullable().describe('Total size as the index prints it'),
    archivesDeletedAt: dateTime().nullable().describe('When the archives were deleted'),
    lastRun: TakeoutRunSchema.nullable().describe('The most recent run of the export'),
  })
  .meta({ id: 'TakeoutExportDto' });

const TakeoutExportDetailSchema = TakeoutExportSchema.extend({
  parts: z.array(TakeoutPartSchema).describe('Parts of the export, the index part last'),
  analysis: TakeoutAnalysisSchema,
  runs: z.array(TakeoutRunSchema).describe('Runs of the export, newest first'),
}).meta({ id: 'TakeoutExportDetailDto' });

const TakeoutUploadSchema = z
  .object({
    id: z.uuidv4().describe('Upload ID'),
    fileName: z.string().describe('Archive file name'),
    size: z.int().min(0).describe('Total size in bytes'),
    offset: z.int().min(0).describe('Bytes received so far; the next chunk starts here'),
    chunkSize: z.int().min(1).describe('Preferred chunk size in bytes'),
    stale: z.boolean().describe('Whether no chunk arrived for 7 days'),
  })
  .meta({ id: 'TakeoutUploadDto' });

const TakeoutUploadCreateSchema = z
  .object({
    fileName: z.string().min(1).describe('Archive file name, for example takeout-20260914T211500Z-1-001.tgz'),
    size: z.int().min(1).describe('Total size in bytes'),
  })
  .meta({ id: 'TakeoutUploadCreateDto' });

const TakeoutOverviewSchema = z
  .object({
    folder: TakeoutFolderSchema,
    exports: z.array(TakeoutExportSchema).describe('Exports found in the folder, newest first'),
    orphanIndexFiles: z.array(TakeoutOtherFileSchema).describe('Index archives that belong to no export'),
    uploads: z.array(TakeoutUploadSchema).describe('Uploads in progress'),
    otherFiles: z.array(TakeoutOtherFileSchema).describe('Files in the folder that are not takeout archives'),
    activeRun: TakeoutRunSchema.nullable().describe('The run that is not finished yet'),
    pendingLargerVersions: z.int().min(0).describe('Number of larger versions waiting for review'),
  })
  .meta({ id: 'TakeoutOverviewDto' });

const TakeoutRunCreateSchema = z
  .object({
    importAnyway: z.boolean().default(false).describe('Start although the export is not complete'),
  })
  .meta({ id: 'TakeoutRunCreateDto' });

const TakeoutRunFileQuerySchema = z
  .object({
    action: TakeoutRunFileActionSchema.optional(),
    status: TakeoutRunFileStatusSchema.optional(),
    search: z.string().optional().describe('Only files whose archive path contains this text'),
    page: z.coerce.number().int().min(1).default(1).describe('Page number, starting at 1'),
    size: z.coerce.number().int().min(1).max(500).default(100).describe('Number of files per page'),
  })
  .meta({ id: 'TakeoutRunFileQueryDto' });

const TakeoutRunFileSchema = z
  .object({
    id: z.int().describe('File ID'),
    takeoutPath: z.string().describe('Full archive path'),
    partName: z.string().nullable().describe('Archive file name'),
    size: z.int().min(0).describe('File size in bytes'),
    fileKind: TakeoutFileKindSchema,
    jsonPath: z.string().nullable().describe('Archive path of the matched Google JSON'),
    matcher: TakeoutMatcherSchema.nullable(),
    originalFileName: z.string().nullable().describe('File name used for the asset'),
    groupIndex: z.int().nullable().describe('Stack group of the file'),
    groupKind: TakeoutGroupKindSchema.nullable(),
    isCover: z.boolean().describe('Whether the file is the cover of its stack'),
    action: TakeoutRunFileActionSchema,
    status: TakeoutRunFileStatusSchema,
    reason: z.string().nullable().describe('Why the file got its action'),
    assetId: z.uuidv4().nullable().describe('Asset created for the file or found on the server'),
    captureDate: dateTime().nullable().describe('Capture time from Google'),
    zone: z.string().nullable().describe('Time zone of the capture time'),
    zoneSource: TakeoutZoneSourceSchema.nullable(),
    fallbacks: z.array(z.string()).describe('Fallbacks applied to the file, such as zoneAssumed'),
    albums: z.array(z.string()).describe('Albums the asset was added to'),
    tags: z.array(z.string()).describe('Tags of the asset'),
    rotation: z.int().describe('Rotation in degrees taken from a rotate-only edited copy'),
    rotationState: TakeoutRotationStateSchema.nullable(),
    error: z.string().nullable().describe('Error message'),
  })
  .meta({ id: 'TakeoutRunFileDto' });

const TakeoutRunFilePageSchema = z
  .object({
    items: z.array(TakeoutRunFileSchema).describe('Files of this page'),
    total: z.int().min(0).describe('Number of files matching the query'),
    hasNextPage: z.boolean().describe('Whether there are more pages'),
  })
  .meta({ id: 'TakeoutRunFilePageDto' });

const TakeoutLargerVersionSchema = z
  .object({
    id: z.uuidv4().describe('Larger version ID'),
    runId: z.uuidv4().nullable().describe('Run that imported the larger version'),
    status: TakeoutLargerVersionStatusSchema,
    createdAt: dateTime().describe('When the larger version was imported'),
    resolvedAt: dateTime().nullable().describe('When the review was resolved'),
    larger: AssetResponseSchema.describe('The imported larger version, on top of the stack'),
    smaller: AssetResponseSchema.nullable().describe('The version that was already on the server; null once deleted'),
  })
  .meta({ id: 'TakeoutLargerVersionDto' });

export enum TakeoutLargerVersionFilter {
  Pending = 'pending',
  Resolved = 'resolved',
}

const TakeoutLargerVersionSearchSchema = z
  .object({
    status: z
      .enum(TakeoutLargerVersionFilter)
      .optional()
      .describe('Only pending or only resolved reviews')
      .meta({ id: 'TakeoutLargerVersionFilter' }),
  })
  .meta({ id: 'TakeoutLargerVersionSearchDto' });

export enum TakeoutLargerVersionAction {
  DeleteSmaller = 'deleteSmaller',
  KeepBoth = 'keepBoth',
}

const TakeoutLargerVersionResolveSchema = z
  .object({
    action: z
      .enum(TakeoutLargerVersionAction)
      .describe('Move the smaller version to the trash, or keep both')
      .meta({ id: 'TakeoutLargerVersionAction' }),
  })
  .meta({ id: 'TakeoutLargerVersionResolveDto' });

export class TakeoutFolderDto extends createZodDto(TakeoutFolderSchema) {}
export class TakeoutOtherFileDto extends createZodDto(TakeoutOtherFileSchema) {}
export class TakeoutPartDto extends createZodDto(TakeoutPartSchema) {}
export class TakeoutMissingPartDto extends createZodDto(TakeoutMissingPartSchema) {}
export class TakeoutPathSampleDto extends createZodDto(TakeoutPathSampleSchema) {}
export class TakeoutUnreadablePartDto extends createZodDto(TakeoutUnreadablePartSchema) {}
export class TakeoutRunPartStatsDto extends createZodDto(TakeoutRunPartStatsSchema) {}
export class TakeoutRunReadStatsDto extends createZodDto(TakeoutRunReadStatsSchema) {}
export class TakeoutAnalysisDto extends createZodDto(TakeoutAnalysisSchema) {}
export class TakeoutSettingsDto extends createZodDto(TakeoutSettingsSchema) {}
export class TakeoutSettingsUpdateDto extends createZodDto(TakeoutSettingsUpdateSchema) {}
export class TakeoutCountersDto extends createZodDto(TakeoutCountersSchema) {}
export class TakeoutRunDto extends createZodDto(TakeoutRunSchema) {}
export class TakeoutExportDto extends createZodDto(TakeoutExportSchema) {}
export class TakeoutExportDetailDto extends createZodDto(TakeoutExportDetailSchema) {}
export class TakeoutUploadDto extends createZodDto(TakeoutUploadSchema) {}
export class TakeoutUploadCreateDto extends createZodDto(TakeoutUploadCreateSchema) {}
export class TakeoutOverviewDto extends createZodDto(TakeoutOverviewSchema) {}
export class TakeoutRunCreateDto extends createZodDto(TakeoutRunCreateSchema) {}
export class TakeoutRunFileQueryDto extends createZodDto(TakeoutRunFileQuerySchema) {}
export class TakeoutRunFileDto extends createZodDto(TakeoutRunFileSchema) {}
export class TakeoutRunFilePageDto extends createZodDto(TakeoutRunFilePageSchema) {}
export class TakeoutLargerVersionDto extends createZodDto(TakeoutLargerVersionSchema) {}
export class TakeoutLargerVersionSearchDto extends createZodDto(TakeoutLargerVersionSearchSchema) {}
export class TakeoutLargerVersionResolveDto extends createZodDto(TakeoutLargerVersionResolveSchema) {}
