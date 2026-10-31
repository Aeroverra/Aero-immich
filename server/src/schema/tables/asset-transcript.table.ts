import { Column, CreateDateColumn, ForeignKeyColumn, Generated, Index, Table, Timestamp } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table';

/** The speech to text result of a video. A video without speech or audio has a transcript without segments. */
@Table('asset_transcript')
export class AssetTranscriptTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  /** Language code of the speech, null when nothing was said */
  @Column({ nullable: true })
  language!: string | null;

  @Column()
  modelName!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/** One line of a transcript: what was said between two positions of the video */
@Table('asset_transcript_segment')
@Index({
  name: 'asset_transcript_segment_text_idx',
  using: 'gin',
  expression: 'f_unaccent("text") gin_trgm_ops',
})
export class AssetTranscriptSegmentTable {
  @ForeignKeyColumn(() => AssetTranscriptTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    primary: true,
    index: false,
  })
  assetId!: string;

  /** Position of the line in the transcript, from 0 */
  @Column({ type: 'integer', primary: true })
  index!: number;

  /** Position in the video in milliseconds */
  @Column({ type: 'integer' })
  startTime!: number;

  /** Position in the video in milliseconds */
  @Column({ type: 'integer' })
  endTime!: number;

  @Column({ type: 'text' })
  text!: string;
}
