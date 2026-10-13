import {
  AfterDeleteTrigger,
  AfterInsertTrigger,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import {
  album_asset_delete_audit,
  album_asset_private_after_delete,
  album_asset_private_after_insert,
} from 'src/schema/functions';
import { AlbumTable } from 'src/schema/tables/album.table';
import { AssetTable } from 'src/schema/tables/asset.table';

@Table({ name: 'album_asset' })
@UpdatedAtTrigger('album_asset_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: album_asset_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() <= 1',
})
@AfterInsertTrigger({
  name: 'album_asset_private_after_insert',
  scope: 'statement',
  referencingNewTableAs: 'new',
  function: album_asset_private_after_insert,
  when: 'pg_trigger_depth() <= 1',
})
@AfterDeleteTrigger({
  name: 'album_asset_private_after_delete',
  scope: 'statement',
  referencingOldTableAs: 'old',
  function: album_asset_private_after_delete,
  when: 'pg_trigger_depth() <= 1',
})
export class AlbumAssetTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  assetId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
