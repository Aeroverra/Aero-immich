import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { UserTable } from 'src/schema/tables/user.table';
import { ViewTable } from 'src/schema/tables/view.table';

@Table({ name: 'session' })
@UpdatedAtTrigger('session_updatedAt')
export class SessionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'bytea', index: true })
  token!: Buffer;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  expiresAt!: Timestamp | null;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  userId!: string;

  @ForeignKeyColumn(() => SessionTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', nullable: true })
  parentId!: string | null;

  @Column({ default: '' })
  deviceType!: Generated<string>;

  @Column({ default: '' })
  deviceOS!: Generated<string>;

  @Column({ nullable: true })
  appVersion!: string | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @Column({ type: 'boolean', default: false })
  isPendingSyncReset!: Generated<boolean>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  pinExpiresAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  privateModeExpiresAt!: Timestamp | null;

  /** the view the session switched to; null means the owner's default view */
  @ForeignKeyColumn(() => ViewTable, { onUpdate: 'CASCADE', onDelete: 'SET NULL', nullable: true })
  viewId!: string | null;

  /** a switched view falls back to the default after the private mode timeout, like private mode itself */
  @Column({ type: 'timestamp with time zone', nullable: true })
  viewExpiresAt!: Timestamp | null;

  @Column({ nullable: true, index: true })
  oauthSid!: string | null;

  @Column({ nullable: true })
  oauthBearerToken!: string | null;
}
