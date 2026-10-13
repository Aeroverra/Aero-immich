import { AfterDeleteTrigger, Column, ForeignKeyColumn, Generated, Table } from '@immich/sql-tools';
import { UpdateIdColumn } from 'src/decorators';
import { ViewTagMode } from 'src/enum';
import { view_tag_mode_enum } from 'src/schema/enums';
import { view_tag_delete_audit } from 'src/schema/functions';
import { TagTable } from 'src/schema/tables/tag.table';
import { ViewTable } from 'src/schema/tables/view.table';

/** A tag rule of a view; rows are only inserted and deleted, never updated */
@Table('view_tag')
@AfterDeleteTrigger({
  scope: 'statement',
  function: view_tag_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() = 0',
})
export class ViewTagTable {
  @ForeignKeyColumn(() => ViewTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  viewId!: string;

  @ForeignKeyColumn(() => TagTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: true })
  tagId!: string;

  @Column({ enum: view_tag_mode_enum })
  mode!: ViewTagMode;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
