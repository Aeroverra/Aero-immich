import { Column, ForeignKeyColumn, Generated, Table, Timestamp, UpdateDateColumn } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table';

/** Technical image quality of an asset preview, used to pick the best photo of a series. */
@Table('asset_quality')
export class AssetQualityTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  /** Variance of the Laplacian of the preview downscaled to 640px, higher is sharper. */
  @Column({ type: 'real' })
  sharpness!: number;

  /** Fraction of nearly black or nearly white pixels, from 0 to 1. */
  @Column({ type: 'real' })
  exposureClipped!: number;

  /** Mean brightness from 0 to 1. */
  @Column({ type: 'real' })
  brightness!: number;

  @Column({ type: 'text' })
  modelName!: string;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
