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
import { TakeoutCompleteness, TakeoutScanStatus } from 'src/enum';
import { UserTable } from 'src/schema/tables/user.table';

/** One Google Takeout export: a chain of archive parts plus its optional index archive */
@Table('takeout_export')
@Unique({ columns: ['userId', 'exportKey'] })
export class TakeoutExportTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', index: false })
  userId!: string;

  /** The first part's timestamp, plus `-<segment>` when the export is segmented */
  @Column()
  exportKey!: string;

  @Column({ type: 'timestamp with time zone' })
  exportedAt!: Timestamp;

  @Column({ type: 'bigint', nullable: true })
  splitSize!: Int8 | null;

  @Column({ type: 'character varying', default: TakeoutCompleteness.Unknown })
  completeness!: Generated<TakeoutCompleteness>;

  @Column({ type: 'character varying', default: TakeoutScanStatus.Pending })
  scanStatus!: Generated<TakeoutScanStatus>;

  @Column({ type: 'character varying', nullable: true })
  indexFileName!: string | null;

  @Column({ type: 'character varying', nullable: true })
  accountEmail!: string | null;

  @Column({ type: 'character varying', nullable: true })
  googleJobId!: string | null;

  /** Total size as the index prints it, for example "730.64 GB" */
  @Column({ type: 'character varying', nullable: true })
  indexTotalSize!: string | null;

  @Column({ type: 'integer', nullable: true })
  indexFileCount!: number | null;

  @Column({ type: 'character varying', nullable: true })
  indexCreatedText!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  analysis!: Generated<object>;

  /** When the parts last changed; the analysis runs again when this is newer than analyzedAt */
  @Column({ type: 'timestamp with time zone', nullable: true })
  analysisInputsAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  analyzedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  archivesDeletedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
