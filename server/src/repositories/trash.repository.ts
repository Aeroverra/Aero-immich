import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { ViewFilter } from 'src/database';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetStatus } from 'src/enum';
import { DB } from 'src/schema';
import { isViewUnrestricted, viewAssetPredicate } from 'src/utils/database';

export class TrashRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  getDeletedIds(): AsyncIterableIterator<{ id: string }> {
    return this.db.selectFrom('asset').select(['id']).where('status', '=', AssetStatus.Deleted).stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async restore(userId: string, view?: ViewFilter | null): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Trashed)
      // only what the active view shows in the trash
      .$if(!isViewUnrestricted(view), (qb) => qb.where((eb) => viewAssetPredicate(eb, view!)))
      .set({ status: AssetStatus.Active, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async empty(userId: string, view?: ViewFilter | null): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Trashed)
      // only what the active view shows in the trash, so hidden assets are never deleted unseen
      .$if(!isViewUnrestricted(view), (qb) => qb.where((eb) => viewAssetPredicate(eb, view!)))
      .set({ status: AssetStatus.Deleted })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async restoreAll(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('status', '=', AssetStatus.Trashed)
      .where('id', 'in', ids)
      .set({ status: AssetStatus.Active, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }
}
