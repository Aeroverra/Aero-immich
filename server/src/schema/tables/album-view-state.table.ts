import { Column, ForeignKeyColumn, Generated, Table } from '@immich/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table';
import { AssetTable } from 'src/schema/tables/asset.table';
import { UserTable } from 'src/schema/tables/user.table';

/**
 * How an album looks under the default view of one of its users, for sync clients that only receive the default view.
 * A row exists only when the album differs from what everyone else sees: the default view hides every asset of the
 * non-empty album, or the album cover is hidden and another asset stands in for it. Maintained by the sync service,
 * so an album is sent again only when this state really changes.
 */
@Table('album_view_state')
export class AlbumViewStateTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  albumId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: true })
  userId!: string;

  @Column({ type: 'boolean', default: false })
  isHidden!: Generated<boolean>;

  /** the cover these clients receive instead of the album cover, when the default view hides the album cover */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  thumbnailAssetId!: string | null;
}
