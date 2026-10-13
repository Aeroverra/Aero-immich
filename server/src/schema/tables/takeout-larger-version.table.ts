import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  Unique,
} from '@immich/sql-tools';
import { TakeoutLargerVersionStatus } from 'src/enum';
import { AssetTable } from 'src/schema/tables/asset.table';
import { TakeoutRunTable } from 'src/schema/tables/takeout-run.table';
import { UserTable } from 'src/schema/tables/user.table';

/** A takeout file imported next to a smaller version already on the server, kept for review */
@Table('takeout_larger_version')
@Unique({ columns: ['largerAssetId', 'smallerAssetId'] })
@Index({ columns: ['userId', 'status'] })
export class TakeoutLargerVersionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', index: false })
  userId!: string;

  @ForeignKeyColumn(() => TakeoutRunTable, { onUpdate: 'CASCADE', onDelete: 'SET NULL', nullable: true })
  runId!: string | null;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', index: false })
  largerAssetId!: string;

  // nullable so the review history survives emptying the trash
  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'SET NULL', nullable: true })
  smallerAssetId!: string | null;

  @Column({ type: 'character varying', default: TakeoutLargerVersionStatus.Pending })
  status!: Generated<TakeoutLargerVersionStatus>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  resolvedAt!: Timestamp | null;
}
