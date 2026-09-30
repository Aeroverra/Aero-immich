import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetStatus, DeletedReimportMode } from 'src/enum';
import { DB } from 'src/schema';
import { AssetDeletedChecksumTable } from 'src/schema/tables/asset-deleted-checksum.table';

@Injectable()
export class AssetDeletedChecksumRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({
    params: [
      {
        ownerId: DummyValue.UUID,
        checksum: DummyValue.BUFFER,
        assetId: DummyValue.UUID,
        originalFileName: DummyValue.STRING,
      },
    ],
  })
  async upsert(item: Insertable<AssetDeletedChecksumTable>) {
    await this.db
      .insertInto('asset_deleted_checksum')
      .values(item)
      .onConflict((oc) =>
        oc.columns(['ownerId', 'checksum']).doUpdateSet((eb) => ({
          assetId: eb.ref('excluded.assetId'),
          originalFileName: eb.ref('excluded.originalFileName'),
          deletedAt: sql`now()`,
          reimportedAt: null,
          reimportMode: null,
          notifiedAt: null,
        })),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BUFFER] })
  get(ownerId: string, checksum: Buffer) {
    return this.db
      .selectFrom('asset_deleted_checksum')
      .select(['assetId', 'originalFileName', 'deletedAt'])
      .where('ownerId', '=', ownerId)
      .where('checksum', '=', checksum)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.BUFFER]] })
  getByChecksums(ownerId: string, checksums: Buffer[]) {
    if (checksums.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('asset_deleted_checksum')
      .select(['checksum', 'assetId'])
      .where('ownerId', '=', ownerId)
      .where('checksum', 'in', checksums)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BUFFER, DeletedReimportMode.Trash] })
  async markReimported(ownerId: string, checksum: Buffer, mode: DeletedReimportMode) {
    await this.db
      .updateTable('asset_deleted_checksum')
      .set({ reimportedAt: sql`now()`, reimportMode: mode, notifiedAt: null })
      .where('ownerId', '=', ownerId)
      .where('checksum', '=', checksum)
      .execute();
  }

  /** Re-uploads the owner has not been told about yet, counted per mode */
  @GenerateSql({ params: [DummyValue.UUID] })
  getPendingNotification(ownerId: string) {
    return this.db
      .selectFrom('asset_deleted_checksum')
      .select((eb) => ['reimportMode', eb.fn.countAll<number>().as('count')])
      .where('ownerId', '=', ownerId)
      .where('reimportedAt', 'is not', null)
      .where('notifiedAt', 'is', null)
      .groupBy('reimportMode')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async markNotified(ownerId: string) {
    await this.db
      .updateTable('asset_deleted_checksum')
      .set({ notifiedAt: sql`now()` })
      .where('ownerId', '=', ownerId)
      .where('reimportedAt', 'is not', null)
      .where('notifiedAt', 'is', null)
      .execute();
  }

  /** Forget the checksums of the given assets for their owners, e.g. after a restore from the trash */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async forgetAssets(assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('asset_deleted_checksum')
      .using('asset')
      .whereRef('asset.ownerId', '=', 'asset_deleted_checksum.ownerId')
      .whereRef('asset.checksum', '=', 'asset_deleted_checksum.checksum')
      .where('asset.id', 'in', assetIds)
      .execute();
  }

  /** Forget the checksums of every trashed asset of the owner, before the whole trash is restored */
  @GenerateSql({ params: [DummyValue.UUID] })
  async forgetTrashed(ownerId: string) {
    await this.db
      .deleteFrom('asset_deleted_checksum')
      .using('asset')
      .whereRef('asset.checksum', '=', 'asset_deleted_checksum.checksum')
      .where('asset.ownerId', '=', ownerId)
      .where('asset.status', '=', AssetStatus.Trashed)
      .where('asset_deleted_checksum.ownerId', '=', ownerId)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getCount(ownerId: string) {
    const { count } = await this.db
      .selectFrom('asset_deleted_checksum')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('ownerId', '=', ownerId)
      .executeTakeFirstOrThrow();

    return Number(count);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAll(ownerId: string) {
    await this.db.deleteFrom('asset_deleted_checksum').where('ownerId', '=', ownerId).execute();
  }
}
