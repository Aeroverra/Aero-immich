import { Column, CreateDateColumn, Generated, Table, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators';

@Table('view_tag_audit')
export class ViewTagAuditTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @Column({ type: 'uuid' })
  viewId!: string;

  @Column({ type: 'uuid' })
  tagId!: string;

  @Column({ type: 'uuid', index: true })
  userId!: string;

  @CreateDateColumn({ default: () => 'clock_timestamp()', index: true })
  deletedAt!: Generated<Timestamp>;
}
