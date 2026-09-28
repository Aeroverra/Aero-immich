import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Int8,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { TakeoutRunStatus } from 'src/enum';
import { TakeoutExportTable } from 'src/schema/tables/takeout-export.table';
import { UserTable } from 'src/schema/tables/user.table';

/** One import of a takeout export */
@Table('takeout_run')
export class TakeoutRunTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  userId!: string;

  @ForeignKeyColumn(() => TakeoutExportTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  exportId!: string;

  @Column({ type: 'character varying', default: TakeoutRunStatus.Queued })
  status!: Generated<TakeoutRunStatus>;

  @Column({ type: 'boolean', default: false })
  importAnyway!: Generated<boolean>;

  /** Full settings snapshot taken when the run was created */
  @Column({ type: 'jsonb' })
  settings!: object;

  /** Template variables fixed at the first start */
  @Column({ type: 'jsonb' })
  templateVars!: object;

  /** Written only by the run job */
  @Column({ type: 'jsonb', default: '{}' })
  counters!: Generated<object>;

  /** Bytes of the files that need a write */
  @Column({ type: 'bigint', default: 0 })
  bytesTotal!: Generated<Int8>;

  @Column({ type: 'bigint', default: 0 })
  bytesDone!: Generated<Int8>;

  /** Sum of the sizes of the parts pass 2 reads */
  @Column({ type: 'bigint', default: 0 })
  archiveBytesTotal!: Generated<Int8>;

  @Column({ type: 'bigint', default: 0 })
  archiveBytesRead!: Generated<Int8>;

  @Column({ type: 'text', nullable: true })
  currentFile!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  heartbeatAt!: Timestamp | null;

  /** Token of the worker holding the run */
  @Column({ type: 'uuid', nullable: true })
  leaseToken!: string | null;

  /** Part of the job id, incremented on every re-queue so a failed job never blocks a new one */
  @Column({ type: 'integer', default: 0 })
  attempt!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  startedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  finishedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
