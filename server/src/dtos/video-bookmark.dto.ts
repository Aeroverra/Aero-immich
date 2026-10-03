import { Selectable } from 'kysely';
import { createZodDto } from 'nestjs-zod';
import { VideoBookmarkTable } from 'src/schema/tables/video-bookmark.table';
import { asDateTimeString } from 'src/utils/date';
import z from 'zod';

const VideoBookmarkTimeSchema = z.int().min(0).describe('Position in the video in milliseconds');
const VideoBookmarkLabelSchema = z.string().trim().max(200).describe('Label, empty for none');

const VideoBookmarkSearchSchema = z
  .object({
    assetId: z.uuidv4().describe('Video asset ID'),
  })
  .meta({ id: 'VideoBookmarkSearchDto' });

const VideoBookmarkCreateSchema = z
  .object({
    assetId: z.uuidv4().describe('Video asset ID'),
    time: VideoBookmarkTimeSchema,
    label: VideoBookmarkLabelSchema.optional(),
  })
  .meta({ id: 'VideoBookmarkCreateDto' });

const VideoBookmarkUpdateSchema = z
  .object({
    time: VideoBookmarkTimeSchema.optional(),
    label: VideoBookmarkLabelSchema.optional(),
  })
  .meta({ id: 'VideoBookmarkUpdateDto' });

const VideoBookmarkResponseSchema = z
  .object({
    id: z.uuidv4().describe('Bookmark ID'),
    assetId: z.uuidv4().describe('Video asset ID'),
    time: VideoBookmarkTimeSchema,
    label: z.string().describe('Label, empty for none'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
  })
  .describe('A moment in a video that the current user bookmarked')
  .meta({ id: 'VideoBookmarkResponseDto' });

export class VideoBookmarkSearchDto extends createZodDto(VideoBookmarkSearchSchema) {}
export class VideoBookmarkCreateDto extends createZodDto(VideoBookmarkCreateSchema) {}
export class VideoBookmarkUpdateDto extends createZodDto(VideoBookmarkUpdateSchema) {}
export class VideoBookmarkResponseDto extends createZodDto(VideoBookmarkResponseSchema) {}

export const mapVideoBookmark = (bookmark: Selectable<VideoBookmarkTable>): VideoBookmarkResponseDto => ({
  id: bookmark.id,
  assetId: bookmark.assetId,
  time: bookmark.time,
  label: bookmark.label,
  createdAt: asDateTimeString(bookmark.createdAt),
  updatedAt: asDateTimeString(bookmark.updatedAt),
});
