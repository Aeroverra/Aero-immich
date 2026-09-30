import { createZodDto } from 'nestjs-zod';
import { pinCodeRegex } from 'src/dtos/auth.dto';
import { ViewAccess, ViewAccessSchema, ViewPrivateAssets, ViewPrivateAssetsSchema } from 'src/enum';
import { asDateTimeString } from 'src/utils/date';
import z from 'zod';

const CustomViewSearchSchema = z
  .object({
    tagId: z
      .uuidv4()
      .optional()
      .describe('Only views with a rule on this tag or on one of its descendants (the views a tag deletion affects)'),
  })
  .meta({ id: 'CustomViewSearchDto' });

const CustomViewRulesSchema = {
  name: z.string().trim().min(1).describe('View name'),
  order: z.int().min(0).optional().describe('Position in the view list'),
  isDefault: z
    .boolean()
    .optional()
    .describe('Make this the default view, which applies whenever no other view is active (at most one per user)'),
  access: ViewAccessSchema.optional(),
  includeAll: z.boolean().optional().describe('Include every asset'),
  includeUntagged: z.boolean().optional().describe('Include assets without any of your tags'),
  includeTagIds: z.array(z.uuidv4()).optional().describe('Include assets with any of these tags or their descendants'),
  excludeTagIds: z
    .array(z.uuidv4())
    .optional()
    .describe('Exclude assets with any of these tags or their descendants; exclude wins over include'),
  privateAssets: ViewPrivateAssetsSchema.optional(),
};

const CustomViewCreateSchema = z.object(CustomViewRulesSchema).meta({ id: 'CustomViewCreateDto' });

const CustomViewUpdateSchema = z
  .object({ ...CustomViewRulesSchema, name: CustomViewRulesSchema.name.optional() })
  .meta({ id: 'CustomViewUpdateDto' });

export const CustomViewResponseSchema = z
  .object({
    id: z.uuidv4().describe('View ID'),
    name: z.string().describe('View name'),
    order: z.int().describe('Position in the view list'),
    isDefault: z.boolean().describe('Whether this is the default view'),
    access: ViewAccessSchema,
    includeAll: z.boolean().describe('Include every asset'),
    includeUntagged: z.boolean().describe('Include assets without any of the owner tags'),
    includeTagIds: z.array(z.string()).describe('Include assets with any of these tags or their descendants'),
    excludeTagIds: z.array(z.string()).describe('Exclude assets with any of these tags or their descendants'),
    privateAssets: ViewPrivateAssetsSchema,
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
  })
  .meta({ id: 'CustomViewResponseDto' });

const CustomViewActiveUpdateSchema = z
  .object({
    viewId: z.uuidv4().nullable().describe('View to switch to; null returns to the default view'),
    pinCode: z
      .string()
      .regex(pinCodeRegex)
      .optional()
      .describe('PIN code, required on every switch to a view with locked access')
      .meta({ example: '123456' }),
  })
  .meta({ id: 'CustomViewActiveUpdateDto' });

const CustomViewActiveResponseSchema = z
  .object({
    viewId: z.string().nullable().describe('The view this session switched to; null when the default view applies'),
    view: CustomViewResponseSchema.nullable().describe(
      'The view that applies to this session (the switched view or the default one); null when nothing is filtered',
    ),
    expiresAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When a switched view falls back to the default view unless the session stays active'),
  })
  .meta({ id: 'CustomViewActiveResponseDto' });

export class CustomViewSearchDto extends createZodDto(CustomViewSearchSchema) {}
export class CustomViewCreateDto extends createZodDto(CustomViewCreateSchema) {}
export class CustomViewUpdateDto extends createZodDto(CustomViewUpdateSchema) {}
export class CustomViewResponseDto extends createZodDto(CustomViewResponseSchema) {}
export class CustomViewActiveUpdateDto extends createZodDto(CustomViewActiveUpdateSchema) {}
export class CustomViewActiveResponseDto extends createZodDto(CustomViewActiveResponseSchema) {}

export type CustomView = {
  id: string;
  ownerId: string;
  name: string;
  order: number;
  isDefault: boolean;
  access: ViewAccess;
  includeAll: boolean;
  includeUntagged: boolean;
  includeTagIds: string[];
  excludeTagIds: string[];
  privateAssets: ViewPrivateAssets;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export const mapCustomView = (view: CustomView): CustomViewResponseDto => ({
  id: view.id,
  name: view.name,
  order: view.order,
  isDefault: view.isDefault,
  access: view.access,
  includeAll: view.includeAll,
  includeUntagged: view.includeUntagged,
  includeTagIds: view.includeTagIds,
  excludeTagIds: view.excludeTagIds,
  privateAssets: view.privateAssets,
  createdAt: asDateTimeString(view.createdAt),
  updatedAt: asDateTimeString(view.updatedAt),
});
