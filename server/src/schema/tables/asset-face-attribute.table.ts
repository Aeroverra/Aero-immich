import { Column, ForeignKeyColumn, Generated, Table, Timestamp, UpdateDateColumn } from '@immich/sql-tools';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table';

/**
 * Attributes of a detected face computed by the face landmark model, used to pick the best photo of a series.
 * The numbers are null when the model could not find landmarks in the face box (`detected` is false).
 */
@Table('asset_face_attribute')
export class AssetFaceAttributeTable {
  @ForeignKeyColumn(() => AssetFaceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  faceId!: string;

  /** Eye blink score from 0 (open) to 1 (closed). */
  @Column({ type: 'real', nullable: true })
  eyeBlinkLeft!: number | null;

  @Column({ type: 'real', nullable: true })
  eyeBlinkRight!: number | null;

  /** Smile score from 0 to 1. */
  @Column({ type: 'real', nullable: true })
  smile!: number | null;

  /** Head rotation in degrees, 0 when looking straight at the camera. */
  @Column({ type: 'real', nullable: true })
  yaw!: number | null;

  @Column({ type: 'real', nullable: true })
  pitch!: number | null;

  @Column({ type: 'real', nullable: true })
  roll!: number | null;

  /** Variance of the Laplacian of the face box resized to 112x112, higher is sharper. */
  @Column({ type: 'real', nullable: true })
  sharpness!: number | null;

  @Column({ type: 'boolean' })
  detected!: boolean;

  @Column({ type: 'text' })
  modelName!: string;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
