import { Column, ForeignKeyColumn, Generated, Index, Int8, PrimaryColumn, Table, Timestamp } from '@immich/sql-tools';
import { TakeoutEntryKind, TakeoutSampleSkipped } from 'src/enum';
import { TakeoutExportTable } from 'src/schema/tables/takeout-export.table';
import { TakeoutPartTable } from 'src/schema/tables/takeout-part.table';

/** The pass 1 catalog: one row per file entry of a scanned part */
@Table('takeout_entry')
@Index({ columns: ['partId', 'seq'] })
export class TakeoutEntryTable {
  @PrimaryColumn({ type: 'bigint', identity: true })
  id!: Generated<Int8>;

  @ForeignKeyColumn(() => TakeoutExportTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  exportId!: string;

  @ForeignKeyColumn(() => TakeoutPartTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', index: false })
  partId!: string;

  /** Order inside the part (zip: central directory index) */
  @Column({ type: 'integer' })
  seq!: number;

  /** Full archive path, exact */
  @Column({ type: 'text' })
  path!: string;

  @Column({ type: 'bigint' })
  size!: Int8;

  @Column({ type: 'timestamp with time zone', nullable: true })
  mtime!: Timestamp | null;

  @Column({ type: 'character varying' })
  kind!: TakeoutEntryKind;

  /** SHA-1 of media entries */
  @Column({ type: 'bytea', nullable: true })
  checksum!: Buffer | null;

  /** Compact Google JSON of json entries */
  @Column({ type: 'jsonb', nullable: true })
  json!: object | null;

  @Column({ type: 'text', nullable: true })
  jsonError!: string | null;

  @Column({ type: 'integer', nullable: true })
  width!: number | null;

  @Column({ type: 'integer', nullable: true })
  height!: number | null;

  /** 32x32 grey pixels used to detect rotate-only edited copies */
  @Column({ type: 'bytea', nullable: true })
  sample!: Buffer | null;

  @Column({ type: 'character varying', nullable: true })
  sampleSkipped!: TakeoutSampleSkipped | null;
}
