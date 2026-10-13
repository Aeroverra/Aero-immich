import { Column, CreateDateColumn, Generated, PrimaryColumn, Table, Timestamp } from '@immich/sql-tools';

/** The folder under `<mediaLocation>/takeouts/` that belongs to a user, named once and never moved */
@Table('takeout_folder')
export class TakeoutFolderTable {
  // no foreign key: the folder must outlive the user row until UserDelete removes it from disk
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @Column({ unique: true })
  folderName!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
