import { Injectable } from '@nestjs/common';
import { Insertable, InsertQueryBuilder, Kysely, QueryCreator, Selectable, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { Chunked, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table';
import { TagTable } from 'src/schema/tables/tag.table';
import { isTagHidden } from 'src/utils/database';
@Injectable()
export class TagRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TagRepository.name);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db.selectFrom('tag').select(columns.tag).where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getByValue(userId: string, value: string) {
    return this.db
      .selectFrom('tag')
      .select(columns.tag)
      .where('userId', '=', userId)
      .where('value', '=', value)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, value: DummyValue.STRING, parentId: DummyValue.UUID }] })
  async upsertValue({ userId, value, parentId: _parentId }: { userId: string; value: string; parentId?: string }) {
    const parentId = _parentId ?? null;
    return this.insertTagWithClosures((db) =>
      db
        .insertInto('tag')
        .values({ userId, value, parentId })
        .onConflict((oc) => oc.columns(['userId', 'value']).doUpdateSet({ parentId }))
        .returningAll(),
    );
  }

  @GenerateSql({ params: [DummyValue.UUID, { withHidden: false }] })
  getAll(userId: string, { withHidden = true }: { withHidden?: boolean } = {}) {
    return (
      this.db
        .selectFrom('tag')
        .select(columns.tag)
        .where('userId', '=', userId)
        // hidden tags and their descendants do not exist while private mode is locked
        .$if(!withHidden, (qb) => qb.where((eb) => eb.not(isTagHidden(eb, 'tag.id'))))
        .orderBy('value')
        .execute()
    );
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, color: DummyValue.STRING, value: DummyValue.STRING }] })
  create(tag: Insertable<TagTable>) {
    return this.insertTagWithClosures((db) => db.insertInto('tag').values(tag).returningAll());
  }

  @GenerateSql({ params: [DummyValue.UUID, { value: DummyValue.STRING, color: DummyValue.STRING }] })
  async update(id: string, dto: Updateable<TagTable>) {
    return this.db.transaction().execute(async (tx) => {
      // Get previous tag value for reference if the current update contains a new value or parent
      const previousTag =
        dto.value === undefined && dto.parentId === undefined
          ? undefined
          : await tx.selectFrom('tag').select(['value', 'parentId']).where('id', '=', id).executeTakeFirst();

      // Perform main tag update
      const updated = await tx
        .updateTable('tag')
        .set(dto)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      // Check if value has changed, trigger value updates on all children if so
      if (previousTag && dto.value !== previousTag.value) {
        await tx
          // Use a recursive cte to get all levels of nested child tags that need to be updated
          .withRecursive('descendants(id, value)', (qb) => {
            const directChildren = qb
              .selectFrom('tag as child')
              .select((eb) => [
                'child.id as id',
                eb
                  .fn<string>('concat', [
                    eb.cast<string>(eb.val(updated.value), 'text'),
                    eb.cast<string>(eb.val('/'), 'text'),
                    eb.fn<string>('regexp_replace', ['child.value', eb.val('^.*/'), eb.val('')]),
                  ])
                  .as('value'),
              ])
              .where('child.parentId', '=', id);

            const nestedChildren = qb
              .selectFrom('tag as child')
              .innerJoin('descendants as parent', 'parent.id', 'child.parentId')
              .select((eb) => [
                'child.id as id',
                eb
                  .fn<string>('concat', [
                    'parent.value',
                    eb.cast<string>(eb.val('/'), 'text'),
                    eb.fn<string>('regexp_replace', ['child.value', eb.val('^.*/'), eb.val('')]),
                  ])
                  .as('value'),
              ]);

            return directChildren.unionAll(nestedChildren);
          })
          .updateTable('tag')
          .from('descendants')
          .set((eb) => ({
            value: eb.ref('descendants.value'),
          }))
          .whereRef('tag.id', '=', 'descendants.id')
          .execute();
      }

      // A new parent: the tag and its descendants leave the ancestors above the tag and join the new parent's
      if (previousTag && dto.parentId !== undefined && dto.parentId !== previousTag.parentId) {
        const subtree = tx
          .selectFrom('tag_closure as own')
          .select('own.id_descendant')
          .where('own.id_ancestor', '=', id);
        await tx
          .deleteFrom('tag_closure')
          .where('id_descendant', 'in', subtree)
          .where('id_ancestor', 'not in', subtree)
          .execute();

        if (dto.parentId) {
          await tx
            .insertInto('tag_closure')
            .columns(['id_ancestor', 'id_descendant'])
            .expression((eb) =>
              eb
                .selectFrom('tag_closure as above')
                .crossJoin('tag_closure as below')
                .select(['above.id_ancestor', 'below.id_descendant'])
                .where('above.id_descendant', '=', dto.parentId!)
                .where('below.id_ancestor', '=', id),
            )
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
      }

      return updated;
    });
  }

  /** Whether [id] is [ancestorId] itself or one of its descendants */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async isInSubtree(ancestorId: string, id: string) {
    const row = await this.db
      .selectFrom('tag_closure')
      .select('id_descendant')
      .where('id_ancestor', '=', ancestorId)
      .where('id_descendant', '=', id)
      .executeTakeFirst();
    return !!row;
  }

  /** The assets tagged with [tagId] or one of its descendants */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getSubtreeAssetIds(tagId: string) {
    const rows = await this.db
      .selectFrom('tag_asset')
      .innerJoin('tag_closure', 'tag_closure.id_descendant', 'tag_asset.tagId')
      .select('tag_asset.assetId')
      .distinct()
      .where('tag_closure.id_ancestor', '=', tagId)
      .execute();
    return rows.map(({ assetId }) => assetId);
  }

  /** Rewrites the tag values stored with the assets' metadata (what the sidecar write puts in the file) */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async refreshAssetTagValues(assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        tags: eb
          .selectFrom('tag_asset')
          .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
          // every asset here still carries at least the renamed or moved tag, so the array is never empty
          .select((eb) => eb.fn.agg<string[]>('array_agg', ['tag.value']).as('tags'))
          .whereRef('tag_asset.assetId', '=', 'asset_exif.assetId'),
      }))
      .where('asset_exif.assetId', 'in', assetIds)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('tag').where('id', '=', id).execute();
  }

  @ChunkedSet({ paramIndex: 1 })
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async getAssetIds(tagId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const results = await this.db
      .selectFrom('tag_asset')
      .select(['assetId as assetId'])
      .where('tagId', '=', tagId)
      .where('assetId', 'in', assetIds)
      .execute();

    return new Set(results.map(({ assetId }) => assetId));
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1 })
  async addAssetIds(tagId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('tag_asset')
      .values(assetIds.map((assetId) => ({ tagId, assetId })))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1 })
  async removeAssetIds(tagId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db.deleteFrom('tag_asset').where('tagId', '=', tagId).where('assetId', 'in', assetIds).execute();
  }

  @GenerateSql({ params: [[{ assetId: DummyValue.UUID, tagIds: DummyValue.UUID }]] })
  @Chunked()
  upsertAssetIds(items: Insertable<TagAssetTable>[]) {
    if (items.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .insertInto('tag_asset')
      .values(items)
      .onConflict((oc) => oc.doNothing())
      .returningAll()
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1 })
  replaceAssetTags(assetId: string, tagIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('tag_asset').where('assetId', '=', assetId).execute();

      if (tagIds.length === 0) {
        return;
      }

      return tx
        .insertInto('tag_asset')
        .values(tagIds.map((tagId) => ({ tagId, assetId })))
        .onConflict((oc) => oc.doNothing())
        .returningAll()
        .execute();
    });
  }

  async deleteEmptyTags() {
    const result = await this.db
      .deleteFrom('tag')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('tag_closure')
              .whereRef('tag.id', '=', 'tag_closure.id_ancestor')
              .innerJoin('tag_asset', 'tag_closure.id_descendant', 'tag_asset.tagId'),
          ),
        ),
      )
      // a tag a view rule names (or the parent of one) stays, so a view never loses a rule while it is unused
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('tag_closure')
              .whereRef('tag.id', '=', 'tag_closure.id_ancestor')
              .innerJoin('view_tag', 'tag_closure.id_descendant', 'view_tag.tagId'),
          ),
        ),
      )
      .executeTakeFirst();

    const deletedRows = Number(result.numDeletedRows);
    if (deletedRows > 0) {
      this.logger.log(`Deleted ${deletedRows} empty tags`);
    }
  }

  insertTagWithClosures(insertTag: (db: QueryCreator<DB>) => InsertQueryBuilder<DB, 'tag', Selectable<TagTable>>) {
    return this.db
      .with('created_tag', insertTag)
      .with('created_tag_closures', (db) =>
        db
          .insertInto('tag_closure')
          .columns(['id_ancestor', 'id_descendant'])
          .expression((eb) =>
            eb
              .selectFrom('created_tag')
              .select(['created_tag.id as id_ancestor', 'created_tag.id as id_descendant'])
              .unionAll(
                eb
                  .selectFrom('created_tag')
                  .innerJoin('tag_closure', 'tag_closure.id_descendant', 'created_tag.parentId')
                  .select(['tag_closure.id_ancestor', 'created_tag.id as id_descendant']),
              ),
          )
          .onConflict((oc) => oc.doNothing()),
      )
      .selectFrom('created_tag')
      .selectAll()
      .executeTakeFirstOrThrow();
  }
}
