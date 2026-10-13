import { Column, ForeignKeyColumn, Index, Table } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table';

@Table({ name: 'smart_search_frame' })
@Index({
  name: 'clip_frame_index',
  using: 'hnsw',
  expression: `embedding vector_cosine_ops`,
  with: `ef_construction = 300, m = 16`,
  synchronize: false,
})
export class SmartSearchFrameTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', primary: true, index: false })
  assetId!: string;

  @Column({ type: 'integer', primary: true })
  frameTimestamp!: number;

  @Column({ type: 'vector', length: 512, storage: 'external', synchronize: false })
  embedding!: string;
}
