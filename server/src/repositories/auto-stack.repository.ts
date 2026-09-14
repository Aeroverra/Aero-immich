import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetVisibility, StackSource, UserMetadataKey } from 'src/enum';
import { DB } from 'src/schema';
import { StackAutoExclusionTable } from 'src/schema/tables/stack-auto-exclusion.table';
import { anyUuid, asUuid } from 'src/utils/database';

export type AutoStackCandidateSearch = {
  ownerId: string;
  make: string;
  model: string;
  from: Date;
  to: Date;
};

/** users who turned on automatic stacks in their preferences */
const withAutoStackEnabled = (eb: ExpressionBuilder<DB, 'asset'>) =>
  eb.exists(
    eb
      .selectFrom('user_metadata')
      .whereRef('user_metadata.userId', '=', 'asset.ownerId')
      .where('user_metadata.key', '=', sql.lit(UserMetadataKey.Preferences))
      .where(sql`user_metadata.value -> 'autoStack' ->> 'enabled'`, '=', 'true'),
  );

/** the user took the asset out of a stack or changed the automatic stack it is in */
const withIsExcluded = (eb: ExpressionBuilder<DB, 'asset'>) =>
  eb
    .exists(eb.selectFrom('stack_auto_exclusion').whereRef('stack_auto_exclusion.assetId', '=', 'asset.id'))
    .as('isExcluded');

/** the asset is in a stack the job does not own: a manual stack or an automatic stack the user changed */
const withIsInUserStack = (eb: ExpressionBuilder<DB, 'asset'>) =>
  eb
    .exists(
      eb
        .selectFrom('stack')
        .whereRef('stack.id', '=', 'asset.stackId')
        .where((eb) =>
          eb.or([
            eb('stack.source', '!=', sql.lit(StackSource.Auto)),
            eb.exists(
              eb
                .selectFrom('asset as member')
                .innerJoin('stack_auto_exclusion', 'stack_auto_exclusion.assetId', 'member.id')
                .whereRef('member.stackId', '=', 'stack.id'),
            ),
          ]),
        ),
    )
    .as('isInUserStack');

@Injectable()
export class AutoStackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getForAutoStackJob(id: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select([
        'asset.id',
        'asset.ownerId',
        'stack.source as stackSource',
        'asset.type',
        'asset.visibility',
        'asset.deletedAt',
        'asset.fileCreatedAt',
        'asset_exif.make',
        'asset_exif.model',
        'asset_job_status.autoStackedAt',
      ])
      .where('asset.id', '=', asUuid(id))
      .executeTakeFirst();
  }

  /**
   * Every visible asset of one owner and camera captured in a time window, with what the grouping needs. Images
   * without an embedding or face detection are returned too, so the job can tell that a neighbour is still being
   * processed.
   */
  @GenerateSql({
    params: [{ ownerId: DummyValue.UUID, make: 'Google', model: 'Pixel', from: DummyValue.DATE, to: DummyValue.DATE }],
  })
  getCandidates({ ownerId, make, model, from, to }: AutoStackCandidateSearch) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('smart_search', 'smart_search.assetId', 'asset.id')
      .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
      .leftJoin('asset_quality', 'asset_quality.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.type',
        'asset.visibility',
        'asset.isFavorite',
        'asset.isPrivate',
        'asset.stackId',
        'asset.originalFileName',
        'asset.fileCreatedAt',
        'asset.createdAt',
        'asset_exif.make',
        'asset_exif.model',
        'smart_search.embedding',
        'asset_job_status.facesRecognizedAt',
        'asset_job_status.autoStackedAt',
        'asset_quality.sharpness',
        'asset_quality.exposureClipped',
      ])
      .select((eb) => eb('asset_quality.assetId', 'is not', null).as('hasQuality'))
      .select(withIsExcluded)
      .select(withIsInUserStack)
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset_face')
            .leftJoin('asset_face_attribute', 'asset_face_attribute.faceId', 'asset_face.id')
            .select([
              'asset_face_attribute.detected',
              'asset_face_attribute.eyeBlinkLeft',
              'asset_face_attribute.eyeBlinkRight',
              'asset_face_attribute.smile',
              'asset_face_attribute.yaw',
              'asset_face_attribute.sharpness',
              'asset_face.personGroupId',
              'asset_face.imageWidth',
              'asset_face.imageHeight',
              'asset_face.boundingBoxX1',
              'asset_face.boundingBoxY1',
              'asset_face.boundingBoxX2',
              'asset_face.boundingBoxY2',
            ])
            .whereRef('asset_face.assetId', '=', 'asset.id')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true),
        ).as('faces'),
      )
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where('asset.fileCreatedAt', '>=', from)
      .where('asset.fileCreatedAt', '<=', to)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Timeline), sql.lit(AssetVisibility.Archive)])
      .where('asset_exif.make', '=', make)
      .where('asset_exif.model', '=', model)
      .orderBy('asset.fileCreatedAt', 'asc')
      .execute();
  }

  /** automatic stacks with their members that are not in the trash */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  getStacks(ids: string[]) {
    return this.db
      .selectFrom('stack')
      .select(['stack.id', 'stack.primaryAssetId'])
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset')
            .select('asset.id')
            .whereRef('asset.stackId', '=', 'stack.id')
            .where('asset.deletedAt', 'is', null),
        ).as('assets'),
      )
      .where('stack.id', '=', anyUuid(ids))
      .where('stack.source', '=', sql.lit(StackSource.Auto))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async updatePrimaryAsset(id: string, primaryAssetId: string) {
    await this.db
      .updateTable('stack')
      .set({ primaryAssetId })
      .where('id', '=', asUuid(id))
      .where('source', '=', sql.lit(StackSource.Auto))
      .execute();
  }

  /** ids of the assets of users with automatic stacks turned on that were not evaluated yet */
  @GenerateSql({ params: [], stream: true })
  streamForAutoStack() {
    return this.db
      .selectFrom('asset')
      .select('asset.id')
      .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
      .where('asset_job_status.autoStackedAt', 'is', null)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Timeline), sql.lit(AssetVisibility.Archive)])
      .where(withAutoStackEnabled)
      .orderBy('asset.fileCreatedAt', 'asc')
      .stream();
  }

  /** forget which assets were evaluated so the next run looks at every asset again; stacks are left as they are */
  @GenerateSql({ params: [] })
  async resetAutoStackedAt() {
    await this.db
      .updateTable('asset_job_status')
      .set({ autoStackedAt: null })
      .where('asset_job_status.autoStackedAt', 'is not', null)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.DATE] })
  async setAutoStackedAt(assetIds: string[], autoStackedAt: Date) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('asset_job_status')
      .values(assetIds.map((assetId) => ({ assetId, autoStackedAt })))
      .onConflict((oc) => oc.column('assetId').doUpdateSet({ autoStackedAt }))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getStackAssetIds(stackId: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .where('asset.stackId', '=', asUuid(stackId))
      .execute();
  }

  async upsertExclusions(exclusions: Insertable<StackAutoExclusionTable>[]) {
    if (exclusions.length === 0) {
      return;
    }

    await this.db
      .insertInto('stack_auto_exclusion')
      .values(exclusions)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) => ({ reason: eb.ref('excluded.reason'), createdAt: sql`now()` })),
      )
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getExclusions(assetIds: string[]) {
    return this.db
      .selectFrom('stack_auto_exclusion')
      .selectAll()
      .where('stack_auto_exclusion.assetId', '=', anyUuid(assetIds))
      .execute();
  }
}
