import { AfterDeleteTrigger, AfterInsertTrigger, ForeignKeyColumn, Generated, Index, Table } from '@immich/sql-tools';
import { UpdateIdColumn } from 'src/decorators';
import { tag_asset_after_delete, tag_asset_after_insert, tag_asset_delete_audit } from 'src/schema/functions';
import { AssetTable } from 'src/schema/tables/asset.table';
import { TagTable } from 'src/schema/tables/tag.table';

@Index({ columns: ['assetId', 'tagId'] })
@Table('tag_asset')
@AfterDeleteTrigger({
  scope: 'statement',
  function: tag_asset_delete_audit,
  referencingOldTableAs: 'old',
})
@AfterInsertTrigger({
  name: 'tag_asset_after_insert',
  scope: 'statement',
  referencingNewTableAs: 'new',
  function: tag_asset_after_insert,
})
@AfterDeleteTrigger({
  name: 'tag_asset_after_delete',
  scope: 'statement',
  referencingOldTableAs: 'old',
  function: tag_asset_after_delete,
})
export class TagAssetTable {
  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  assetId!: string;

  @ForeignKeyColumn(() => TagTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  tagId!: string;

  /** rows are only inserted and deleted, so the insert id doubles as the sync update id */
  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
