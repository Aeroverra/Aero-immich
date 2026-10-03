import {
  Column,
  ForeignKeyColumn,
  Generated,
  Index,
  Int8,
  PrimaryColumn,
  Table,
  Timestamp,
  Unique,
  UpdateDateColumn,
} from '@immich/sql-tools';
import {
  TakeoutFileKind,
  TakeoutGroupKind,
  TakeoutMatcher,
  TakeoutRotationState,
  TakeoutRunFileAction,
  TakeoutRunFileStatus,
  TakeoutZoneSource,
} from 'src/enum';
import { AssetTable } from 'src/schema/tables/asset.table';
import { TakeoutRunTable } from 'src/schema/tables/takeout-run.table';

/** The plan of a takeout run and its per-file report */
@Table('takeout_run_file')
@Unique({ columns: ['runId', 'seq'] })
@Index({ columns: ['runId', 'groupIndex'] })
export class TakeoutRunFileTable {
  @PrimaryColumn({ type: 'bigint', identity: true })
  id!: Generated<Int8>;

  @ForeignKeyColumn(() => TakeoutRunTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', index: false })
  runId!: string;

  /** Report order (plan order) */
  @Column({ type: 'integer' })
  seq!: number;

  @Column({ type: 'text' })
  takeoutPath!: string;

  @Column({ type: 'character varying', nullable: true })
  partName!: string | null;

  /** seq of the entry inside partName, for targeted re-reads; null for report-only rows and rows planned by the old code */
  @Column({ type: 'integer', nullable: true })
  entrySeq!: number | null;

  @Column({ type: 'bigint' })
  size!: Int8;

  @Column({ type: 'timestamp with time zone', nullable: true })
  mtime!: Timestamp | null;

  @Column({ type: 'bytea', nullable: true })
  checksum!: Buffer | null;

  @Column({ type: 'character varying' })
  fileKind!: TakeoutFileKind;

  @Column({ type: 'text', nullable: true })
  jsonPath!: string | null;

  @Column({ type: 'character varying', nullable: true })
  matcher!: TakeoutMatcher | null;

  @Column({ type: 'text', nullable: true })
  originalFileName!: string | null;

  @Column({ type: 'integer', nullable: true })
  groupIndex!: number | null;

  /** Position inside the group, 0 is the cover */
  @Column({ type: 'integer', nullable: true })
  groupOrder!: number | null;

  @Column({ type: 'character varying', nullable: true })
  groupKind!: TakeoutGroupKind | null;

  @Column({ type: 'boolean', default: false })
  isCover!: Generated<boolean>;

  @Column({ type: 'character varying' })
  action!: TakeoutRunFileAction;

  @Column({ type: 'character varying' })
  status!: TakeoutRunFileStatus;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /** Planned asset data while work remains, reduced to albums and tags when done */
  @Column({ type: 'jsonb', nullable: true })
  plan!: object | null;

  /** alreadyProcessed: seq of the first row with the same checksum */
  @Column({ type: 'integer', nullable: true })
  dependsOnSeq!: number | null;

  // no foreign key: the id is chosen before the asset exists
  @Column({ type: 'uuid', nullable: true })
  newAssetId!: string | null;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'SET NULL', nullable: true })
  assetId!: string | null;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'SET NULL', nullable: true })
  smallerAssetId!: string | null;

  @Column({ type: 'text', nullable: true })
  targetPath!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  captureDate!: Timestamp | null;

  @Column({ type: 'character varying', nullable: true })
  zone!: string | null;

  @Column({ type: 'character varying', nullable: true })
  zoneSource!: TakeoutZoneSource | null;

  @Column({ type: 'text', array: true, default: [] })
  fallbacks!: Generated<string[]>;

  @Column({ type: 'smallint', default: 0 })
  rotation!: Generated<number>;

  @Column({ type: 'character varying', nullable: true })
  rotationState!: TakeoutRotationState | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
