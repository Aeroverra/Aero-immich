import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { DB } from 'src/schema';
import { AssetTranscriptSegmentTable } from 'src/schema/tables/asset-transcript.table';
import { tokenizeForSearch } from 'src/utils/database';

export type TranscriptSegment = Omit<Insertable<AssetTranscriptSegmentTable>, 'assetId' | 'index'>;

@Injectable()
export class TranscriptRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getByAssetId(assetId: string) {
    return this.db
      .selectFrom('asset_transcript')
      .select(['asset_transcript.assetId', 'asset_transcript.language', 'asset_transcript.modelName'])
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset_transcript_segment')
            .select([
              'asset_transcript_segment.startTime',
              'asset_transcript_segment.endTime',
              'asset_transcript_segment.text',
            ])
            .whereRef('asset_transcript_segment.assetId', '=', 'asset_transcript.assetId')
            .orderBy('asset_transcript_segment.index'),
        ).as('segments'),
      )
      .where('asset_transcript.assetId', '=', assetId)
      .executeTakeFirst();
  }

  @GenerateSql({
    params: [
      { assetId: DummyValue.UUID, language: DummyValue.STRING, modelName: DummyValue.STRING },
      [{ startTime: DummyValue.NUMBER, endTime: DummyValue.NUMBER, text: DummyValue.STRING }],
    ],
  })
  replace(transcript: { assetId: string; language: string | null; modelName: string }, segments: TranscriptSegment[]) {
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('asset_transcript').where('assetId', '=', transcript.assetId).execute();
      await trx.insertInto('asset_transcript').values(transcript).execute();
      if (segments.length > 0) {
        await trx
          .insertInto('asset_transcript_segment')
          .values(segments.map((segment, index) => ({ ...segment, assetId: transcript.assetId, index })))
          .execute();
      }
    });
  }

  /**
   * For each of the given videos whose speech matches the text, the line that matches best (the earliest one when
   * several match equally well). Matching is the same word similarity the transcript search filter uses.
   */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.STRING] })
  getBestMatches(assetIds: string[], text: string) {
    if (assetIds.length === 0) {
      return Promise.resolve([]);
    }

    const query = tokenizeForSearch(text).join(' ');
    return this.db
      .selectFrom('asset_transcript_segment')
      .distinctOn('asset_transcript_segment.assetId')
      .select([
        'asset_transcript_segment.assetId',
        'asset_transcript_segment.startTime',
        'asset_transcript_segment.endTime',
        'asset_transcript_segment.text',
      ])
      .where('asset_transcript_segment.assetId', 'in', assetIds)
      .where(() => sql<boolean>`f_unaccent(asset_transcript_segment.text) %>> f_unaccent(${query})`)
      .orderBy('asset_transcript_segment.assetId')
      .orderBy(sql`strict_word_similarity(f_unaccent(${query}), f_unaccent(asset_transcript_segment.text))`, 'desc')
      .orderBy('asset_transcript_segment.startTime')
      .execute();
  }

  deleteAll() {
    return this.db.deleteFrom('asset_transcript').execute();
  }
}
