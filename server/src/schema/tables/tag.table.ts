import {
  AfterDeleteTrigger,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  Unique,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { tag_delete_audit } from 'src/schema/functions';
import { UserTable } from 'src/schema/tables/user.table';

@Table('tag')
@UpdatedAtTrigger('tag_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: tag_delete_audit,
  referencingOldTableAs: 'old',
})
@Unique({ columns: ['userId', 'value'] })
export class TagTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    // [userId, value] makes this redundant
    index: false,
  })
  userId!: string;

  @Column()
  value!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'character varying', nullable: true, default: null })
  color!: string | null;

  @ForeignKeyColumn(() => TagTable, { nullable: true, onDelete: 'CASCADE' })
  parentId!: string | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  /** hidden tags (and their descendants) are left out of every response unless private mode is unlocked */
  @Column({ type: 'boolean', default: false })
  isHidden!: Generated<boolean>;
}
