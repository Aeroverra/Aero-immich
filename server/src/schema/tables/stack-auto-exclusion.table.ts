import { Column, CreateDateColumn, ForeignKeyColumn, Generated, Table, Timestamp } from '@immich/sql-tools';
import { StackAutoExclusionReason } from 'src/enum';
import { AssetTable } from 'src/schema/tables/asset.table';
import { UserTable } from 'src/schema/tables/user.table';

/**
 * Assets the user took out of an automatic stack, or that are in an automatic stack the user changed. The automatic
 * stack job never puts these assets into a stack again.
 */
@Table('stack_auto_exclusion')
export class StackAutoExclusionTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;

  @Column()
  reason!: StackAutoExclusionReason;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
