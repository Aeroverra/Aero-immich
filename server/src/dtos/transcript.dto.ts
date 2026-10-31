import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const AssetTranscriptSegmentResponseSchema = z
  .object({
    startTime: z.int().min(0).describe('Position in milliseconds where the line starts'),
    endTime: z.int().min(0).describe('Position in milliseconds where the line ends'),
    text: z.string().describe('What was said'),
  })
  .meta({ id: 'AssetTranscriptSegmentResponseDto' });

const AssetTranscriptResponseSchema = z
  .object({
    assetId: z.uuidv4().describe('Video asset ID'),
    language: z.string().nullable().describe('Language code of the speech, null when no speech was found'),
    segments: z
      .array(AssetTranscriptSegmentResponseSchema)
      .describe('Lines of speech in playback order, empty when the video was not transcribed or has no speech'),
  })
  .meta({ id: 'AssetTranscriptResponseDto' });

export class AssetTranscriptResponseDto extends createZodDto(AssetTranscriptResponseSchema) {}
