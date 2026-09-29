import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { DB } from 'src/schema';
import { VideoBookmarkTable } from 'src/schema/tables/video-bookmark.table';

@Injectable()
export class VideoBookmarkRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getByAssetId(assetId: string, userId: string) {
    return this.db
      .selectFrom('video_bookmark')
      .selectAll()
      .where('assetId', '=', assetId)
      .where('userId', '=', userId)
      .orderBy('time', 'asc')
      .orderBy('createdAt', 'asc')
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
