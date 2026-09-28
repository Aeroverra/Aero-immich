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
} from '@immich/sql-tools';
import { TakeoutArchiveKind, TakeoutScanStatus } from 'src/enum';
import { TakeoutExportTable } from 'src/schema/tables/takeout-export.table';
import { UserTable } from 'src/schema/tables/user.table';

/** One archive file of a takeout export */
@Table('takeout_part')
@Unique({ columns: ['exportId', 'fileName'] })
@Unique({ columns: ['userId', 'fileName'] })
export class TakeoutPartTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => TakeoutExportTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', index: false })
  exportId!: string;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', index: false })
  userId!: string;

  @Column()
  fileName!: string;

  /** This part's own timestamp (YYYYMMDDTHHMMSSZ) */
  @Column()
  timestamp!: string;

  @Column({ type: 'integer', nullable: true })
  segment!: number | null;

  @Column({ type: 'integer' })
  partNumber!: number;

  @Column({ type: 'character varying' })
  kind!: TakeoutArchiveKind;

  @Column({ type: 'boolean', default: false })
  isIndex!: Generated<boolean>;

  @Column({ type: 'bigint' })
  size!: Int8;

  @Column({ type: 'timestamp with time zone' })
  mtime!: Timestamp;

  @Column({ type: 'timestamp with time zone' })
  ctime!: Timestamp;

  /** Size seen by the previous folder sync, for the stable-file rule */
  @Column({ type: 'bigint', nullable: true })
  prevSyncSize!: Int8 | null;

  @Column({ type: 'character varying', default: TakeoutScanStatus.Pending })
  scanStatus!: Generated<TakeoutScanStatus>;

  @Column({ type: 'text', nullable: true })
  scanError!: string | null;

  /** Token of the scanner that claimed the part */
  @Column({ type: 'uuid', nullable: true })
  scanOwner!: string | null;

  @Column({ type: 'bigint', nullable: true })
  scanStartSize!: Int8 | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  scanStartMtime!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  scanStartCtime!: Timestamp | null;

  @Column({ type: 'bigint', nullable: true })
  scannedSize!: Int8 | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  scannedMtime!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  heartbeatAt!: Timestamp | null;

  /** Part of the job id, incremented on every re-queue so a failed job never blocks a new one */
  @Column({ type: 'integer', default: 0 })
  attempt!: Generated<number>;

  @Column({ type: 'bigint', default: 0 })
  bytesScanned!: Generated<Int8>;

  @Column({ type: 'integer', nullable: true })
  entryCount!: number | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
