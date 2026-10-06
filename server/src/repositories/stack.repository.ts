import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, sql, Updateable } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetVisibility, StackAutoExclusionReason } from 'src/enum';
import { DB } from 'src/schema';
import { StackTable } from 'src/schema/tables/stack.table';
import {
  anyUuid,
  asUuid,
  PrivateScope,
  withDefaultVisibility,
  withEffectiveTagColumns,
  withPrivateScope,
} from 'src/utils/database';

export interface StackSearch {
  ownerId: string;
  primaryAssetId?: string;
}

const withAssets = (eb: ExpressionBuilder<DB, 'stack'>, scope: PrivateScope, withTags = false) => {
  return jsonArrayFrom(
    eb
      .selectFrom('asset')
      .selectAll('asset')
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset_exif')
            .select(columns.exif)
            .whereRef('asset_exif.assetId', '=', 'asset.id')
            .as('exifInfo'),
        (join) => join.onTrue(),
      )
      .$if(withTags, (eb) =>
        eb.select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('tag')
              .select(withEffectiveTagColumns)
              .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
              .whereRef('tag_asset.assetId', '=', 'asset.id'),
          ).as('tags'),
        ),
      )
      .select((eb) => eb.fn.toJson('exifInfo').as('exifInfo'))
      .where('asset.deletedAt', 'is', null)
      .whereRef('asset.stackId', '=', 'stack.id')
      .$call(withDefaultVisibility)
      .$call(withPrivateScope(scope))
      .orderBy('asset.fileCreatedAt', 'asc'),
  ).as('assets');
};

@Injectable()
export class StackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID }, { privateMode: false, userId: DummyValue.UUID }] })
  search(query: StackSearch, scope: PrivateScope) {
    return this.db
      .selectFrom('stack')
      .selectAll('stack')
      .select((eb) => withAssets(eb, scope))
      .where('stack.ownerId', '=', query.ownerId)
      .$if(!!query.primaryAssetId, (eb) => eb.where('stack.primaryAssetId', '=', query.primaryAssetId!))
      .execute();
  }

  async create(entity: Omit<Insertable<StackTable>, 'primaryAssetId'>, assetIds: string[], scope: PrivateScope) {
    return this.db.transaction().execute(async (tx) => {
      const stacks = await tx
        .selectFrom('stack')
        .where('stack.ownerId', '=', entity.ownerId)
        .where('stack.primaryAssetId', 'in', assetIds)
        .select('stack.id')
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.stackId', '=', 'stack.id')
              .where('asset.deletedAt', 'is', null),
          ).as('assets'),
        )
        .execute();

      const uniqueIds = new Set<string>(assetIds);

      // children
      for (const stack of stacks) {
        if (stack.assets && stack.assets.length > 0) {
          for (const asset of stack.assets) {
            uniqueIds.add(asset.id);
          }
        }
      }

      if (stacks.length > 0) {
        await tx
          .deleteFrom('stack')
          .where(
            'id',
            'in',
            stacks.map((stack) => stack.id),
          )
          .execute();
      }

      const newRecord = await tx
        .insertInto('stack')
        .values({ ...entity, primaryAssetId: assetIds[0] })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('asset')
        .set({
          stackId: newRecord.id,
          updatedAt: new Date(),
        })
        .where('id', 'in', [...uniqueIds])
        .execute();

      return tx
        .selectFrom('stack')
        .selectAll('stack')
        .select((eb) => withAssets(eb, scope))
        .where('id', '=', newRecord.id)
        .executeTakeFirstOrThrow();
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  /** The stacks of [ids] with the number of assets each holds, for showing stacks in lists such as search results */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  getSummaries(ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('stack')
      .select(['stack.id', 'stack.primaryAssetId', 'stack.ownerId', 'stack.source'])
      .select((eb) =>
        eb
          .selectFrom('asset')
          .select(sql<number>`count(*)::int`.as('count'))
          .whereRef('asset.stackId', '=', 'stack.id')
          .where('asset.deletedAt', 'is', null)
          .as('assetCount'),
      )
      .where('stack.id', '=', anyUuid(ids))
      .execute();
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('stack').where('id', '=', asUuid(id)).execute();
  }

  async deleteAll(ids: string[]): Promise<void> {
    await this.db.deleteFrom('stack').where('id', 'in', ids).execute();
  }

  update(id: string, entity: Updateable<StackTable>, scope: PrivateScope) {
    return this.db
      .updateTable('stack')
      .set(entity)
      .where('id', '=', asUuid(id))
      .returningAll('stack')
      .returning((eb) => withAssets(eb, scope, true))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, { privateMode: false, userId: DummyValue.UUID }] })
  getById(id: string, scope: PrivateScope) {
    return this.db
      .selectFrom('stack')
      .selectAll()
      .select((eb) => withAssets(eb, scope, true))
      .where('id', '=', asUuid(id))
      .executeTakeFirst();
  }

  /**
   * The stacks a user is about to change by hand, selected by stack id or by the ids of their members, with every
   * member (trashed and hidden ones included) so that the change can be reported in full
   */
  @GenerateSql({ params: [{ stackIds: [DummyValue.UUID] }] })
  getForUserEdit({ stackIds, assetIds }: { stackIds?: string[]; assetIds?: string[] }) {
    return this.db
      .selectFrom('stack')
      .select(['stack.id', 'stack.primaryAssetId', 'stack.source'])
      .select((eb) =>
        jsonArrayFrom(eb.selectFrom('asset').select('asset.id').whereRef('asset.stackId', '=', 'stack.id')).as(
          'assets',
        ),
      )
      .$if(!!stackIds, (qb) => qb.where('stack.id', 'in', stackIds!))
      .$if(!!assetIds, (qb) =>
        qb.where((eb) =>
          eb.exists(
            eb.selectFrom('asset').whereRef('asset.stackId', '=', 'stack.id').where('asset.id', 'in', assetIds!),
          ),
        ),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getForAssetRemoval(assetId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(['stackId as id', 'stack.primaryAssetId', 'stack.source'])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  /**
   * The owner's assets whose original file name matches [pattern] (a `LIKE` pattern), for finding the other files of a
   * camera shot wherever they are in the library. Trashed and hidden assets are left out; `isExcluded` is set for
   * assets the user took out of a stack or unstacked.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getCameraGroupCandidates(ownerId: string, pattern: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select([
        'asset.id',
        'asset.originalFileName',
        'asset.type',
        'asset.visibility',
        'asset.isPrivate',
        'asset.stackId',
        'stack.primaryAssetId as stackPrimaryAssetId',
        'stack.source as stackSource',
      ])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('stack_auto_exclusion')
              .whereRef('stack_auto_exclusion.assetId', '=', 'asset.id')
              .where('stack_auto_exclusion.reason', 'in', [
                StackAutoExclusionReason.Removed,
                StackAutoExclusionReason.Unstacked,
              ]),
          )
          .as('isExcluded'),
      )
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where(sql`f_unaccent(asset."originalFileName")`, 'like', sql<string>`f_unaccent(${pattern})`)
      .execute();
  }

  @GenerateSql({ params: [{ sourceId: DummyValue.UUID, targetId: DummyValue.UUID }] })
  merge({ sourceId, targetId }: { sourceId: string; targetId: string }) {
    return this.db.updateTable('asset').set({ stackId: targetId }).where('asset.stackId', '=', sourceId).execute();
  }
}
