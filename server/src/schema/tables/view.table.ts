import {
  AfterDeleteTrigger,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { ViewAccess, ViewPrivateAssets } from 'src/enum';
import { view_access_enum, view_private_assets_enum } from 'src/schema/enums';
import { view_delete_audit } from 'src/schema/functions';
import { UserTable } from 'src/schema/tables/user.table';

/** A saved filter over the owner's tags that the owner can switch the whole library to */
@Table('view')
@UpdatedAtTrigger('view_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: view_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() = 0',
})
@Index({ name: 'view_ownerId_isDefault_uidx', columns: ['ownerId'], unique: true, where: '"isDefault" = true' })
export class ViewTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;

  @Column()
  name!: string;

  @Column({ type: 'integer', default: 0 })
  order!: Generated<number>;

  @Column({ type: 'boolean', default: false })
  isDefault!: Generated<boolean>;

  @Column({ enum: view_access_enum, default: ViewAccess.Open })
  access!: Generated<ViewAccess>;

  @Column({ type: 'boolean', default: false })
  includeAll!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  includeUntagged!: Generated<boolean>;

  @Column({ enum: view_private_assets_enum, default: ViewPrivateAssets.Unlocked })
  privateAssets!: Generated<ViewPrivateAssets>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
