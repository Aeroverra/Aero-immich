import {
  Check,
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
import { PersonSuggestionKind, PersonSuggestionSource, PersonSuggestionStatus } from 'src/enum';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table';
import { PersonGroupTable } from 'src/schema/tables/person-group.table';
import { UserTable } from 'src/schema/tables/user.table';

/** What it takes to take back a "same" answer */
export type PersonSuggestionUndo = {
  /** the person the candidate's faces belonged to before the answer, null for a face without a person */
  personGroupId: string | null;
  /** the faces the answer moved to the target */
  faceIds: string[];
  /** the candidate person the answer merged away, to bring it back */
  person?: {
    name: string;
    birthDate: string | null;
    isHidden: boolean;
    isFavorite: boolean;
    color: string | null;
  };
  /** the target's name before the answer named it */
  targetName?: string;
};

/**
 * A question for the owner: is the candidate (an unnamed person, or a face without a person) the same person as the
 * target? Answers are kept: "different" is a lasting rule that the pair is never asked about again, never merged and
 * never matched automatically.
 */
@Table('person_suggestion')
@UpdatedAtTrigger('person_suggestion_updatedAt')
@Index({ columns: ['ownerId', 'status'] })
@Index({
  name: 'person_suggestion_ownerId_personGroupId_target_uq',
  columns: ['ownerId', 'personGroupId', 'targetPersonGroupId'],
  unique: true,
  where: '"personGroupId" IS NOT NULL',
})
@Index({
  name: 'person_suggestion_ownerId_faceId_target_uq',
  columns: ['ownerId', 'faceId', 'targetPersonGroupId'],
  unique: true,
  where: '"faceId" IS NOT NULL',
})
@Check({
  name: 'person_suggestion_candidate_chk',
  expression: `"personGroupId" IS NULL OR "faceId" IS NULL`,
})
export class PersonSuggestionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;

  @Column()
  kind!: PersonSuggestionKind;

  @Column({ default: PersonSuggestionSource.Automatic })
  source!: Generated<PersonSuggestionSource>;

  /** the candidate when it is a person; null once a "same" answer merged it away */
  @ForeignKeyColumn(() => PersonGroupTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  personGroupId!: string | null;

  /** the candidate when it is a face without a person */
  @ForeignKeyColumn(() => AssetFaceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  faceId!: string | null;

  @ForeignKeyColumn(() => PersonGroupTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  targetPersonGroupId!: string;

  /** how alike the two look, 0 to 1 */
  @Column({ type: 'real' })
  score!: number;

  /** questions with a higher priority are asked first */
  @Column({ type: 'real', default: 0 })
  priority!: Generated<number>;

  @Column({ default: PersonSuggestionStatus.Pending })
  status!: Generated<PersonSuggestionStatus>;

  @Column({ type: 'jsonb', nullable: true })
  undo!: PersonSuggestionUndo | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  answeredAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}
