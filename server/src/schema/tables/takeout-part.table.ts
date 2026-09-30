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
import { TakeoutArchiveKind, TakeoutCatalogStatus } from 'src/enum';
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

  /** The file is not in the folder any more (its entries are deleted) */
  @Column({ type: 'boolean', default: false })
  isMissing!: Generated<boolean>;

  /** none|reading|partial|complete|error: state of this part's rows in takeout_entry */
  @Column({ type: 'character varying', default: TakeoutCatalogStatus.None })
  catalogStatus!: Generated<TakeoutCatalogStatus>;

  /** CATALOG_VERSION of the reader that wrote the rows; any other value means "not catalogued" */
  @Column({ type: 'smallint', nullable: true })
  catalogVersion!: number | null;

  /** Size and mtime of the file when its rows were written (the persisted cache key) */
  @Column({ type: 'bigint', nullable: true })
  catalogSize!: Int8 | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  catalogMtime!: Timestamp | null;

  /** Why the read failed (truncated, bad header, bad gzip, gzip CRC); sticky until the file changes */
  @Column({ type: 'text', nullable: true })
  catalogError!: string | null;

  /** Compressed byte offset of the failure (tgz: gunzip input consumed; zip: file offset) */
  @Column({ type: 'bigint', nullable: true })
  catalogErrorOffset!: Int8 | null;

  // no foreign key: history only
  @Column({ type: 'uuid', nullable: true })
  lastReadRunId!: string | null;

  /** Bytes read from the file by the last run that read it, all passes included */
  @Column({ type: 'bigint', default: 0 })
  bytesRead!: Generated<Int8>;

  @Column({ type: 'integer', nullable: true })
  entryCount!: number | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
