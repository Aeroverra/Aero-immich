import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetType } from 'src/enum';
import { DB } from 'src/schema';
import { VideoBookmarkTable } from 'src/schema/tables/video-bookmark.table';

@Injectable()
export class VideoBookmarkRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** The bookmarks of a user on any of the given videos */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID] })
  getByAssetIds(assetIds: string[], userId: string) {
    return this.db
      .selectFrom('video_bookmark')
      .selectAll()
      .where('assetId', 'in', assetIds)
      .where('userId', '=', userId)
      .orderBy('time', 'asc')
      .orderBy('createdAt', 'asc')
      .execute();
  }

  /**
   * The videos in the stack of a video with their lengths in milliseconds, the video itself included.
   * Empty when the video is not stacked. Trashed videos are left out, except the video itself.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getStackVideos(assetId: string) {
    return this.db
      .selectFrom('asset as current')
      .innerJoin('asset', 'asset.stackId', 'current.stackId')
      .select(['asset.id', 'asset.duration'])
      .where('current.id', '=', assetId)
      .where('asset.type', '=', AssetType.Video)
      .where((eb) => eb.or([eb('asset.deletedAt', 'is', null), eb('asset.id', '=', eb.ref('current.id'))]))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db.selectFrom('video_bookmark').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({
    params: [{ assetId: DummyValue.UUID, userId: DummyValue.UUID, time: 1000, label: DummyValue.STRING }],
  })
  create(bookmark: Insertable<VideoBookmarkTable>) {
    return this.db.insertInto('video_bookmark').values(bookmark).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, { time: 1000, label: DummyValue.STRING }] })
  update(id: string, bookmark: Updateable<VideoBookmarkTable>) {
    return this.db
      .updateTable('video_bookmark')
      .set(bookmark)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('video_bookmark').where('id', '=', id).execute();
  }
}
