import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Int8,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  Unique,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UserTable } from 'src/schema/tables/user.table';

/** A resumable upload of a takeout archive into the user's takeout folder */
@Table('takeout_upload')
@Unique({ columns: ['userId', 'fileName'] })
export class TakeoutUploadTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', index: false })
  userId!: string;

  @Column()
  fileName!: string;

  /** Declared total size in bytes */
  @Column({ type: 'bigint' })
  size!: Int8;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  /** Time of the last chunk; a session is stale 7 days after it */
  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
