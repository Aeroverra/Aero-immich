import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, Updateable } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { DummyValue, GenerateSql } from 'src/decorators';
import { WorkflowGetLogsDto, WorkflowSearchDto } from 'src/dtos/workflow.dto';
import { AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';
import { WorkflowLogTable } from 'src/schema/tables/workflow-log.table';
import { WorkflowStepTable } from 'src/schema/tables/workflow-step.table';
import { WorkflowTable } from 'src/schema/tables/workflow.table';
import { withTags } from 'src/utils/database';

export type WorkflowStepUpsert = Omit<Insertable<WorkflowStepTable>, 'workflowId' | 'order'>;

@Injectable()
export class WorkflowRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private queryBuilder(db?: Kysely<DB>) {
    return (db ?? this.db)
      .selectFrom('workflow')
      .select([
        'workflow.id',
        'workflow.name',
        'workflow.description',
        'workflow.trigger',
        'workflow.enabled',
        'workflow.createdAt',
        'workflow.updatedAt',
        'workflow.logging',
      ])
      .select((eb) => [
        jsonArrayFrom(
          eb
            .selectFrom('workflow_step')
            .innerJoin('plugin_method', 'plugin_method.id', 'workflow_step.pluginMethodId')
            .innerJoin('plugin', 'plugin.id', 'plugin_method.pluginId')
            .whereRef('workflow.id', '=', 'workflow_step.workflowId')
            .select([
              'plugin.name as pluginName',
              'plugin_method.name as methodName',
              'workflow_step.config',
              'workflow_step.enabled',
            ])
            .orderBy('workflow_step.order', 'asc'),
        ).as('steps'),
      ]);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  search(dto: WorkflowSearchDto & { userId?: string }) {
    return this.queryBuilder()
      .$if(!!dto.id, (qb) => qb.where('id', '=', dto.id!))
      .$if(!!dto.userId, (qb) => qb.where('ownerId', '=', dto.userId!))
      .$if(!!dto.trigger, (qb) => qb.where('trigger', '=', dto.trigger!))
      .$if(dto.enabled !== undefined, (qb) => qb.where('enabled', '=', dto.enabled!))
      .orderBy('createdAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.queryBuilder().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForWorkflowRun(id: string, options?: { includeDisabled?: boolean }) {
    return this.db
      .selectFrom('workflow')
      .select(['workflow.id', 'workflow.ownerId', 'workflow.name', 'workflow.trigger', 'workflow.logging'])
      .select((eb) => [
        jsonArrayFrom(
          eb
            .selectFrom('workflow_step')
            .innerJoin('plugin_method', 'plugin_method.id', 'workflow_step.pluginMethodId')
            .whereRef('workflow_step.workflowId', '=', 'workflow.id')
            .where('workflow_step.enabled', '=', true)
            .select([
              'workflow_step.id',
              'workflow_step.config',
              'plugin_method.pluginId as pluginId',
              'plugin_method.name as methodName',
              'plugin_method.types as types',
              'plugin_method.hostFunctions',
              'plugin_method.allowedHosts',
              'plugin_method.uiHints',
            ])
            .orderBy('workflow_step.order', 'asc'),
        ).as('steps'),
      ])
      .where('id', '=', id)
      .$if(!options?.includeDisabled, (qb) => qb.where('enabled', '=', true))
      .executeTakeFirst();
  }

  create(dto: Insertable<WorkflowTable>, steps?: WorkflowStepUpsert[]) {
    return this.db.transaction().execute(async (tx) => {
      const { id } = await tx.insertInto('workflow').values(dto).returning(['id']).executeTakeFirstOrThrow();
      return this.replaceAndReturn(tx, id, steps);
    });
  }

  update(id: string, dto: Updateable<WorkflowTable>, steps?: WorkflowStepUpsert[]) {
    return this.db.transaction().execute(async (tx) => {
      if (dto.logging === false) {
        await tx.deleteFrom('workflow_log').where('workflowId', '=', id).execute();
      }
      if (Object.values(dto).some((prop) => prop !== undefined)) {
        await tx.updateTable('workflow').set(dto).where('id', '=', id).executeTakeFirstOrThrow();
      }
      return this.replaceAndReturn(tx, id, steps);
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, { result: undefined }] })
  getLogs(id: string, dto: WorkflowGetLogsDto) {
    return this.db
      .selectFrom('workflow_log')
      .select([
        'workflow_log.id',
        'workflow_log.createdAt',
        'workflow_log.result',
        'workflow_log.workflowId',
        'workflow_log.workflowStepId',
        'workflow_log.triggerDataId',
        'workflow_log.runId',
        'workflow_log.isManual',
      ])
      .where('workflow_log.workflowId', '=', id)
      .select((eb) => [
        jsonObjectFrom(
          eb
            .selectFrom('workflow_step')
            .whereRef('workflow_step.id', '=', 'workflow_log.workflowStepId')
            .innerJoin('plugin_method', 'plugin_method.id', 'workflow_step.pluginMethodId')
            .select(['plugin_method.pluginId', 'plugin_method.name as methodName', 'workflow_step.order']),
        ).as('step'),
      ])
      .$if(dto.result !== undefined, (qb) => qb.where('workflow_log.result', '=', dto.result!))
      .$if(dto.before !== undefined, (qb) => qb.where('workflow_log.createdAt', '<', dto.before!))
      .orderBy('workflow_log.createdAt', 'desc')
      .limit(dto.limit)
      .execute();
  }

  log(dto: Insertable<WorkflowLogTable>) {
    return this.db.insertInto('workflow_log').values(dto).execute();
  }

  async updateStep(id: string, dto: Updateable<WorkflowStepTable>) {
    await this.db.updateTable('workflow_step').where('workflow_step.id', '=', id).set(dto).execute();
  }

  private async replaceAndReturn(tx: Kysely<DB>, workflowId: string, steps?: WorkflowStepUpsert[]) {
    if (steps) {
      await tx.deleteFrom('workflow_step').where('workflowId', '=', workflowId).execute();
      if (steps.length > 0) {
        await tx
          .insertInto('workflow_step')
          .values(
            steps.map((step, i) => ({
              workflowId,
              enabled: step.enabled ?? true,
              pluginMethodId: step.pluginMethodId,
              config: step.config,
              order: i,
            })),
          )
          .returningAll()
          .execute();
      }
    }

    return this.queryBuilder(tx).where('id', '=', workflowId).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('workflow').where('id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForAssetV1(assetId: string) {
    return this.assetV1QueryBuilder().where('asset.id', '=', assetId).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getForAssetsV1(assetIds: string[]) {
    if (assetIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.assetV1QueryBuilder().where('asset.id', 'in', assetIds).execute();
  }

  /** the assets of a user that a manual run goes through, newest first */
  @GenerateSql({ params: [DummyValue.UUID], stream: true })
  streamForRun(ownerId: string) {
    return this.runAssetsQueryBuilder(ownerId)
      .select(['asset.id'])
      .orderBy('asset.fileCreatedAt', 'desc')
      .orderBy('asset.id', 'desc')
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getRunAssetCount(ownerId: string) {
    const { count } = await this.runAssetsQueryBuilder(ownerId)
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  private runAssetsQueryBuilder(ownerId: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden);
  }

  private assetV1QueryBuilder() {
    return this.db
      .selectFrom('asset')
      .select((eb) => [
        ...columns.workflowAssetV1,
        withTags,
        this.withOcrLines(eb),
        jsonObjectFrom(
          eb
            .selectFrom('asset_exif')
            .select([
              'asset_exif.make',
              'asset_exif.model',
              'asset_exif.orientation',
              'asset_exif.dateTimeOriginal',
              'asset_exif.modifyDate',
              'asset_exif.exifImageWidth',
              'asset_exif.exifImageHeight',
              'asset_exif.fileSizeInByte',
              'asset_exif.lensModel',
              'asset_exif.fNumber',
              'asset_exif.focalLength',
              'asset_exif.iso',
              'asset_exif.latitude',
              'asset_exif.longitude',
              'asset_exif.city',
              'asset_exif.state',
              'asset_exif.country',
              'asset_exif.description',
              'asset_exif.fps',
              'asset_exif.exposureTime',
              'asset_exif.livePhotoCID',
              'asset_exif.timeZone',
              'asset_exif.projectionType',
              'asset_exif.profileDescription',
              'asset_exif.colorspace',
              'asset_exif.bitsPerSample',
              'asset_exif.autoStackId',
              'asset_exif.rating',
              'asset_exif.tags',
              'asset_exif.updatedAt',
            ])
            .whereRef('asset_exif.assetId', '=', 'asset.id'),
        ).as('exifInfo'),
      ]);
  }

  private withOcrLines(eb: ExpressionBuilder<DB, 'asset'>) {
    return jsonArrayFrom(
      eb
        .selectFrom('asset_ocr')
        .select([
          'asset_ocr.text',
          'asset_ocr.textScore',
          'asset_ocr.x1',
          'asset_ocr.y1',
          'asset_ocr.x2',
          'asset_ocr.y2',
          'asset_ocr.x3',
          'asset_ocr.y3',
          'asset_ocr.x4',
          'asset_ocr.y4',
        ])
        .whereRef('asset_ocr.assetId', '=', 'asset.id')
        .where('asset_ocr.isVisible', '=', true)
        .orderBy('asset_ocr.y1', 'asc')
        .orderBy('asset_ocr.x1', 'asc'),
    ).as('ocr');
  }
}
