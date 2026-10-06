import { createZodDto } from 'nestjs-zod';
import { PersonResponseSchema } from 'src/dtos/person.dto';
import {
  PersonSuggestionKindSchema,
  PersonSuggestionSourceSchema,
  PersonSuggestionStatus,
  PersonSuggestionStatusSchema,
} from 'src/enum';
import z from 'zod';

const PersonSuggestionSearchSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe('Page number for pagination'),
    size: z.coerce.number().int().min(1).max(50).default(10).describe('Number of questions per page'),
  })
  .meta({ id: 'PersonSuggestionSearchDto' });

const PersonSuggestionAnswersSearchSchema = z
  .object({
    size: z.coerce.number().int().min(1).max(50).default(10).describe('Number of answers'),
  })
  .meta({ id: 'PersonSuggestionAnswersSearchDto' });

const PersonSuggestionAnswerSchema = z
  .enum([PersonSuggestionStatus.Same, PersonSuggestionStatus.Different, PersonSuggestionStatus.Skipped])
  .describe(
    'Same: merge the candidate into the target. Different: never ask again or match them. Skipped: not sure, ask later',
  )
  .meta({ id: 'PersonSuggestionAnswer' });

const PersonSuggestionAnswerRequestSchema = z
  .object({
    answer: PersonSuggestionAnswerSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('A name for the person both turned out to be, when two unnamed people are answered to be the same'),
  })
  .meta({ id: 'PersonSuggestionAnswerDto' });

const PersonSuggestionCreateSchema = z
  .object({
    personId: z.uuidv4().optional().describe('The candidate when it is a person'),
    faceId: z.uuidv4().optional().describe('The candidate when it is a face without a person'),
    targetPersonId: z.uuidv4().describe('The person the candidate may be'),
    score: z.number().min(0).max(1).optional().describe('How alike the two look, 0 to 1').meta({ format: 'double' }),
  })
  .refine((dto) => !!dto.personId !== !!dto.faceId, { error: 'Either personId or faceId is required, not both' })
  .meta({ id: 'PersonSuggestionCreateDto' });

const PersonSuggestionFaceSchema = z
  .object({
    id: z.uuidv4().describe('Face ID'),
    assetId: z.uuidv4().describe('Asset ID'),
    takenAt: z.string().meta({ format: 'date-time' }).describe('When the photo or video was taken'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('When the face last changed'),
  })
  .meta({ id: 'PersonSuggestionFaceDto' });

const PersonSuggestionSideSchema = z
  .object({
    person: PersonResponseSchema.nullable().describe('The person, or null for a face without a person'),
    assetCount: z.int().min(0).describe('On how many photos and videos the caller may see this person is'),
    faces: z.array(PersonSuggestionFaceSchema).describe('Faces to compare, spread over time'),
  })
  .meta({ id: 'PersonSuggestionSideDto' });

export const PersonSuggestionResponseSchema = z
  .object({
    id: z.uuidv4().describe('Suggestion ID'),
    kind: PersonSuggestionKindSchema,
    source: PersonSuggestionSourceSchema,
    status: PersonSuggestionStatusSchema,
    score: z.number().describe('How alike the two look, 0 to 1').meta({ format: 'double' }),
    answeredAt: z.string().meta({ format: 'date-time' }).nullable().describe('When it was answered'),
    candidate: PersonSuggestionSideSchema.describe('The unnamed person or the face without a person'),
    target: PersonSuggestionSideSchema.describe('The person the candidate may be'),
  })
  .meta({ id: 'PersonSuggestionResponseDto' });

const PersonSuggestionsResponseSchema = z
  .object({
    total: z.int().min(0).describe('Number of questions there are to answer'),
    suggestions: z.array(PersonSuggestionResponseSchema),
    hasNextPage: z.boolean().describe('Whether there are more pages'),
  })
  .meta({ id: 'PersonSuggestionsResponseDto' });

const PersonSuggestionStatisticsResponseSchema = z
  .object({
    pending: z.int().min(0).describe('Number of questions there are to answer'),
  })
  .meta({ id: 'PersonSuggestionStatisticsResponseDto' });

export class PersonSuggestionSearchDto extends createZodDto(PersonSuggestionSearchSchema) {}
export class PersonSuggestionAnswersSearchDto extends createZodDto(PersonSuggestionAnswersSearchSchema) {}
export class PersonSuggestionAnswerDto extends createZodDto(PersonSuggestionAnswerRequestSchema) {}
export class PersonSuggestionCreateDto extends createZodDto(PersonSuggestionCreateSchema) {}
export class PersonSuggestionResponseDto extends createZodDto(PersonSuggestionResponseSchema) {}
export class PersonSuggestionsResponseDto extends createZodDto(PersonSuggestionsResponseSchema) {}
export class PersonSuggestionStatisticsResponseDto extends createZodDto(PersonSuggestionStatisticsResponseSchema) {}
export type PersonSuggestionFaceDto = z.infer<typeof PersonSuggestionFaceSchema>;
export type PersonSuggestionSideDto = z.infer<typeof PersonSuggestionSideSchema>;
