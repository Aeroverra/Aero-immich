import { Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import { UserTable } from 'src/schema/tables/user.table';

/** Up to where the album view state of a user was brought up to date, as an updateId */
@Table('album_view_state_checkpoint')
export class AlbumViewStateCheckpointTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  userId!: string;

  @Column({ type: 'uuid' })
  updateId!: string;
}
