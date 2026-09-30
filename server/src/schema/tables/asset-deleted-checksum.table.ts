import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  PrimaryColumn,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import { DeletedReimportMode } from 'src/enum';
import { UserTable } from 'src/schema/tables/user.table';

/**
 * The checksum of every asset a user permanently deleted, so that an upload of the same file can be
 * recognised and handled according to the user's `deletedReimport` preference.
 */
@Table('asset_deleted_checksum')
export class AssetDeletedChecksumTable {
  @ForeignKeyColumn(() => UserTable, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    primary: true,
    // [ownerId, checksum] is the PK constraint
    index: false,
  })
  ownerId!: string;

  @PrimaryColumn({ type: 'bytea' })
  checksum!: Buffer;

  /** The id the deleted asset had. Returned as the duplicate id when an upload is skipped. */
  @Column({ type: 'uuid' })
  assetId!: string;

  @Column()
  originalFileName!: string;

  @CreateDateColumn()
  deletedAt!: Generated<Timestamp>;

  /** When the file was last uploaded again, null until it happens. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  reimportedAt!: Timestamp | null;

  /** How the last re-upload was handled. */
  @Column({ type: 'character varying', nullable: true })
  reimportMode!: DeletedReimportMode | null;

  /** When the user was told about the last re-upload, null while a notification is still pending. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  notifiedAt!: Timestamp | null;
}
