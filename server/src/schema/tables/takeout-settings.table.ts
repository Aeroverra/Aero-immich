import { Column, ForeignKeyColumn, Generated, Table, Timestamp, UpdateDateColumn } from '@immich/sql-tools';
import { UserTable } from 'src/schema/tables/user.table';

/** Saved takeout import settings of a user, merged over the defaults on read */
@Table('takeout_settings')
export class TakeoutSettingsTable {
  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: false })
  userId!: string;

  @Column({ type: 'jsonb' })
  settings!: object;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
