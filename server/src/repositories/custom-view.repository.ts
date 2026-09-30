import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, sql, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { ViewFilter } from 'src/database';
import { Chunked, DummyValue, GenerateSql } from 'src/decorators';
import { CustomView } from 'src/dtos/custom-view.dto';
import { ViewTagMode } from 'src/enum';
import { DB } from 'src/schema';
import { ViewTable } from 'src/schema/tables/view.table';
import { anyUuid, asUuid, dummyViewFilter, viewAssetPredicate, viewFilterColumns } from 'src/utils/database';

export type CustomViewTags = { includeTagIds: string[]; excludeTagIds: string[] };

const withViewColumns = (eb: ExpressionBuilder<DB, 'view'>) =>
  [...viewFilterColumns(eb), 'view.name', 'view.order', 'view.isDefault', 'view.createdAt', 'view.updatedAt'] as const;

@Injectable()
export class CustomViewRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, { tagId: DummyValue.UUID }] })
  getAll(ownerId: string, { tagId }: { tagId?: string } = {}): Promise<CustomView[]> {
    return this.db
      .selectFrom('view')
      .select(withViewColumns)
      .where('view.ownerId', '=', asUuid(ownerId))
      .$if(!!tagId, (qb) =>
        qb.where((eb) =>
          eb.exists(
            eb
              .selectFrom('view_tag')
              .innerJoin('tag_closure', 'tag_closure.id_descendant', 'view_tag.tagId')
              .whereRef('view_tag.viewId', '=', 'view.id')
              .where('tag_closure.id_ancestor', '=', asUuid(tagId!)),
          ),
        ),
      )
      .orderBy('view.order', 'asc')
      .orderBy('view.createdAt', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string): Promise<CustomView | undefined> {
    return this.db.selectFrom('view').select(withViewColumns).where('view.id', '=', asUuid(id)).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getDefault(ownerId: string): Promise<ViewFilter | undefined> {
    return this.db
      .selectFrom('view')
      .select(viewFilterColumns)
      .where('view.ownerId', '=', asUuid(ownerId))
      .where('view.isDefault', '=', true)
      .executeTakeFirst();
  }

  create(view: Insertable<ViewTable>, tags: CustomViewTags) {
    return this.db.transaction().execute(async (tx) => {
      if (view.isDefault) {
        await tx
          .updateTable('view')
          .set({ isDefault: false })
          .where('ownerId', '=', view.ownerId)
          .where('isDefault', '=', true)
          .execute();
      }

      const { id } = await tx.insertInto('view').values(view).returning('id').executeTakeFirstOrThrow();
      await this.insertTags(tx, id, tags);
      return id;
    });
  }

  update(id: string, ownerId: string, view: Updateable<ViewTable>, tags?: CustomViewTags) {
    return this.db.transaction().execute(async (tx) => {
      if (view.isDefault) {
        await tx
          .updateTable('view')
          .set({ isDefault: false })
          .where('ownerId', '=', ownerId)
          .where('isDefault', '=', true)
          .where('id', '!=', id)
          .execute();
      }

      // always touch the row so its updateId changes, also when only the tag rules changed
      await tx
        .updateTable('view')
        .set({ ...view, updatedAt: new Date() })
        .where('id', '=', asUuid(id))
        .execute();

      if (tags) {
        const existing = await tx.selectFrom('view_tag').select(['tagId', 'mode']).where('viewId', '=', id).execute();
        const wanted = new Map<string, ViewTagMode>([
          ...tags.includeTagIds.map((tagId) => [tagId, ViewTagMode.Include] as const),
          ...tags.excludeTagIds.map((tagId) => [tagId, ViewTagMode.Exclude] as const),
        ]);
        // only rows that really change are deleted, so sync clients see the smallest possible delta
        const removed = existing.filter(({ tagId, mode }) => wanted.get(tagId) !== mode).map(({ tagId }) => tagId);
        if (removed.length > 0) {
          await tx.deleteFrom('view_tag').where('viewId', '=', id).where('tagId', '=', anyUuid(removed)).execute();
        }
        const kept = new Set(
          existing.filter(({ tagId, mode }) => wanted.get(tagId) === mode).map(({ tagId }) => tagId),
        );
        const added = [...wanted].filter(([tagId]) => !kept.has(tagId));
        if (added.length > 0) {
          await tx
            .insertInto('view_tag')
            .values(added.map(([tagId, mode]) => ({ viewId: id, tagId, mode })))
            .execute();
        }
      }
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('view').where('id', '=', asUuid(id)).execute();
  }

  /**
   * The assets a user receives (own, partner and shared album assets) whose visibility differs between two views.
   * A missing view shows everything.
   */
  @GenerateSql({ params: [DummyValue.UUID, dummyViewFilter, null] })
  async getChangedAssetIds(userId: string, before: ViewFilter | null, after: ViewFilter | null) {
    const passes = (eb: ExpressionBuilder<DB, 'asset'>, view: ViewFilter | null) =>
      view ? viewAssetPredicate(eb, view) : eb.lit(true);

    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where((eb) =>
        eb.or([
          eb('asset.ownerId', '=', asUuid(userId)),
          eb(
            'asset.ownerId',
            'in',
            eb.selectFrom('partner').select('partner.sharedById').where('partner.sharedWithId', '=', asUuid(userId)),
          ),
          eb.exists(
            eb
              .selectFrom('album_asset')
              .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
              .whereRef('album_asset.assetId', '=', 'asset.id')
              .where('album_user.userId', '=', asUuid(userId)),
          ),
        ]),
      )
      .where((eb) => sql<boolean>`(${passes(eb, before)}) is distinct from (${passes(eb, after)})`)
      .execute();

    return rows.map(({ id }) => id);
  }

  /**
   * Hands out fresh updateIds for assets that moved in or out of the default view, and for the rows sync sends with
   * them, so clients that only receive the default view re-evaluate them.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async touchAssets(assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    const now = sql<Date>`clock_timestamp()`;
    await this.db.updateTable('asset').set({ updatedAt: now }).where('id', '=', anyUuid(assetIds)).execute();
    await this.db.updateTable('asset_exif').set({ updatedAt: now }).where('assetId', '=', anyUuid(assetIds)).execute();
    await this.db.updateTable('album_asset').set({ updatedAt: now }).where('assetId', '=', anyUuid(assetIds)).execute();
    await this.db
      .updateTable('stack')
      .set({ updatedAt: now })
      .where('primaryAssetId', '=', anyUuid(assetIds))
      .execute();
    await this.db.updateTable('asset_face').set({ updatedAt: now }).where('assetId', '=', anyUuid(assetIds)).execute();
    await this.db
      .updateTable('memory_asset')
      .set({ updatedAt: now })
      .where('assetId', '=', anyUuid(assetIds))
      .execute();
  }

  private async insertTags(tx: Kysely<DB>, viewId: string, { includeTagIds, excludeTagIds }: CustomViewTags) {
    const values = [
      ...includeTagIds.map((tagId) => ({ viewId, tagId, mode: ViewTagMode.Include })),
      ...excludeTagIds.map((tagId) => ({ viewId, tagId, mode: ViewTagMode.Exclude })),
    ];
    if (values.length > 0) {
      await tx.insertInto('view_tag').values(values).execute();
    }
  }
}
