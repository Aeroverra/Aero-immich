import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, sql, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetFileType, AssetVisibility, PersonSuggestionSource, PersonSuggestionStatus, VectorIndex } from 'src/enum';
import { probes } from 'src/repositories/database.repository';
import { DB } from 'src/schema';
import { PersonSuggestionTable } from 'src/schema/tables/person-suggestion.table';
import {
  anyUuid,
  dummyViewFilter,
  isViewUnrestricted,
  PrivateScope,
  viewAssetPredicate,
  withFilePath,
  withVideoStream,
} from 'src/utils/database';
import { AnswerOutcome } from 'src/utils/person-suggestion';

export type FaceQualityOptions = {
  /** faces with a shorter embedding are left out: backs of heads, upside-down faces and other weak detections */
  minNorm: number;
};

export type CandidateFaceOptions = FaceQualityOptions & {
  /** the shorter side of a face box as a share of the longer side of its picture; smaller faces are hard to judge */
  minFaceSize: number;
};

export type SimilarityOptions = FaceQualityOptions & { minSimilarity: number };

/** One side of a pair: a person, or a face without a person */
export type SuggestionCandidate = { personGroupId: string; faceId?: never } | { faceId: string; personGroupId?: never };

export type SuggestionPair = SuggestionCandidate & { targetPersonGroupId: string };

/** the faces the person suggestions job works with: the owner's own, on assets in the timeline or the archive */
const isUsableFace = (eb: ExpressionBuilder<DB, any>, ownerId: string) =>
  eb.and([
    eb('asset.ownerId', '=', ownerId),
    eb('asset.deletedAt', 'is', null),
    eb('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive]),
    eb('asset_face.deletedAt', 'is', null),
    eb('asset_face.isVisible', '=', true),
    eb('asset_face.isWholeAsset', '=', false),
  ]);

const hasStrongEmbedding = (eb: ExpressionBuilder<DB, any>, minNorm: number) =>
  eb(sql<number>`vector_norm(face_search.embedding)`, '>=', minNorm);

const isBigEnough = (eb: ExpressionBuilder<DB, any>, minFaceSize: number) =>
  eb(
    sql<number>`least(asset_face."boundingBoxX2" - asset_face."boundingBoxX1", asset_face."boundingBoxY2" - asset_face."boundingBoxY1")`,
    '>=',
    sql<number>`${minFaceSize}::float8 * greatest(asset_face."imageWidth", asset_face."imageHeight")`,
  );

/** assets the caller may see right now: private assets only in private mode, and only what the active view shows */
const isInScope = (eb: ExpressionBuilder<DB, any>, scope: PrivateScope) =>
  eb.and([
    scope.privateMode
      ? eb.or([eb('asset.isPrivate', '=', false), eb('asset.ownerId', '=', scope.userId)])
      : eb('asset.isPrivate', '=', false),
    ...(isViewUnrestricted(scope.view) ? [] : [viewAssetPredicate(eb, scope.view!)]),
  ]);

/** a face that is shown in a question: a usable face on an asset the caller may see */
const isShownFace = (eb: ExpressionBuilder<DB, any>, scope: PrivateScope) =>
  eb.and([
    eb('asset.ownerId', '=', scope.userId),
    eb('asset.deletedAt', 'is', null),
    eb('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive]),
    eb('asset_face.deletedAt', 'is', null),
    eb('asset_face.isVisible', '=', true),
    eb('asset_face.isWholeAsset', '=', false),
    isInScope(eb, scope),
  ]);

/** a list of uuids as a postgres array literal */
const asArray = (values: string[]) => `{${values}}`;

const dummyScope: PrivateScope = { privateMode: false, userId: DummyValue.UUID, view: dummyViewFilter };

@Injectable()
export class PersonSuggestionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** The median length of the owner's face embeddings, which depends on the model */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getTypicalFaceNorm(ownerId: string): Promise<number | null> {
    const row = await this.db
      .selectFrom('asset_face')
      .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .select(
        sql<number | null>`percentile_cont(0.5) within group (order by vector_norm(face_search.embedding))`.as('norm'),
      )
      .where((eb) => isUsableFace(eb, ownerId))
      .executeTakeFirst();

    return row?.norm ?? null;
  }

  /**
   * How alike each unnamed person of the owner is to each other person of the owner (hidden people left out): the cosine
   * similarity of the averages of their normalized face embeddings. Pairs of two unnamed people are listed once.
   */
  @GenerateSql({ params: [DummyValue.UUID, { minNorm: 15, minSimilarity: 0.2 }] })
  getPersonSimilarities(ownerId: string, { minNorm, minSimilarity }: SimilarityOptions) {
    const similarity = sql<number>`1 - (candidate.embedding <=> target.embedding)`;
    return this.db
      .with(
        (cte) => cte('centroid').materialized(),
        (db) =>
          db
            .selectFrom('asset_face')
            .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
            .innerJoin('asset', 'asset.id', 'asset_face.assetId')
            .innerJoin('person', (join) =>
              join.onRef('person.personGroupId', '=', 'asset_face.personGroupId').on('person.ownerId', '=', ownerId),
            )
            .select(['person.personGroupId', 'person.name'])
            .select(sql<string>`avg(l2_normalize(face_search.embedding))`.as('embedding'))
            .select((eb) => eb.fn.countAll<number>().as('faces'))
            .where('person.isHidden', '=', false)
            .where((eb) => isUsableFace(eb, ownerId))
            .where((eb) => hasStrongEmbedding(eb, minNorm))
            .groupBy(['person.personGroupId', 'person.name']),
      )
      .selectFrom('centroid as candidate')
      .innerJoin('centroid as target', (join) => join.onRef('target.personGroupId', '!=', 'candidate.personGroupId'))
      .select(['candidate.personGroupId as personGroupId', 'target.personGroupId as targetPersonGroupId'])
      .select((eb) => eb('target.name', '!=', '').as('isNamed'))
      .select(['candidate.faces as faces', 'target.faces as targetFaces'])
      .select(similarity.as('similarity'))
      .where('candidate.name', '=', '')
      .where((eb) =>
        eb.or([eb('target.name', '!=', ''), eb('candidate.personGroupId', '<', eb.ref('target.personGroupId'))]),
      )
      .where(similarity, '>=', minSimilarity)
      .execute();
  }

  /**
   * How alike each face without a person is to each named person of the owner (hidden people left out): the cosine
   * similarity of the face to the average of the person's normalized face embeddings. Faces too small or too weak to
   * judge are left out.
   */
  @GenerateSql({ params: [DummyValue.UUID, { minNorm: 15, minSimilarity: 0.2, minFaceSize: 0.025 }] })
  getFaceSimilarities(
    ownerId: string,
    { minNorm, minSimilarity, minFaceSize }: SimilarityOptions & CandidateFaceOptions,
  ) {
    const similarity = sql<number>`1 - (face_search.embedding <=> centroid.embedding)`;
    return this.db
      .with(
        (cte) => cte('centroid').materialized(),
        (db) =>
          db
            .selectFrom('asset_face')
            .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
            .innerJoin('asset', 'asset.id', 'asset_face.assetId')
            .innerJoin('person', (join) =>
              join.onRef('person.personGroupId', '=', 'asset_face.personGroupId').on('person.ownerId', '=', ownerId),
            )
            .select('person.personGroupId')
            .select(sql<string>`avg(l2_normalize(face_search.embedding))`.as('embedding'))
            .select((eb) => eb.fn.countAll<number>().as('faces'))
            .where('person.isHidden', '=', false)
            .where('person.name', '!=', '')
            .where((eb) => isUsableFace(eb, ownerId))
            .where((eb) => hasStrongEmbedding(eb, minNorm))
            .groupBy('person.personGroupId'),
      )
      .selectFrom('asset_face')
      .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .innerJoin('centroid', (join) => join.onTrue())
      .select([
        'asset_face.id as faceId',
        'centroid.personGroupId as targetPersonGroupId',
        'centroid.faces as targetFaces',
      ])
      .select(similarity.as('similarity'))
      .where('asset_face.personGroupId', 'is', null)
      .where((eb) => isUsableFace(eb, ownerId))
      .where((eb) => hasStrongEmbedding(eb, minNorm))
      .where((eb) => isBigEnough(eb, minFaceSize))
      .where(similarity, '>=', minSimilarity)
      .execute();
  }

  /**
   * Up to `limit` faces of each person to compare, spread evenly over the time the photos were taken. Faces too small or
   * too weak to judge are left out.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], { minNorm: 15, minFaceSize: 0.025 }, 12] })
  async getSpreadFaceIds(
    ownerId: string,
    personGroupIds: string[],
    { minNorm, minFaceSize }: CandidateFaceOptions,
    limit: number,
  ) {
    if (personGroupIds.length === 0) {
      return [];
    }

    return this.db
      .selectFrom((db) =>
        db
          .selectFrom('asset_face')
          .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
          .innerJoin('asset', 'asset.id', 'asset_face.assetId')
          .select(['asset_face.id', 'asset_face.personGroupId'])
          .select(
            sql<number>`row_number() over (partition by asset_face."personGroupId" order by asset."fileCreatedAt", asset_face.id)`.as(
              'position',
            ),
          )
          .select(sql<number>`count(*) over (partition by asset_face."personGroupId")`.as('total'))
          .where('asset_face.personGroupId', '=', anyUuid(personGroupIds))
          .where((eb) => isUsableFace(eb, ownerId))
          .where((eb) => hasStrongEmbedding(eb, minNorm))
          .where((eb) => isBigEnough(eb, minFaceSize))
          .as('face'),
      )
      .select(['face.id', 'face.personGroupId'])
      .where(sql<boolean>`(face.position - 1) % ceil(face.total::float8 / ${limit})::int = 0`)
      .execute()
      .then((rows) => rows.map(({ id, personGroupId }) => ({ id, personGroupId: personGroupId! })));
  }

  /**
   * For each face, the `limit` most similar faces of the owner that belong to a person (the vector index does the
   * search), with how similar they are
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], { minNorm: 15 }, 32] })
  async getNearestPersonFaces(ownerId: string, faceIds: string[], { minNorm }: FaceQualityOptions, limit: number) {
    if (faceIds.length === 0) {
      return [];
    }

    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Face])}`.execute(trx);
      return trx
        .selectFrom('face_search as query')
        .innerJoinLateral(
          (eb) =>
            eb
              .selectFrom('face_search')
              .innerJoin('asset_face', 'asset_face.id', 'face_search.faceId')
              .innerJoin('asset', 'asset.id', 'asset_face.assetId')
              .select(['asset_face.personGroupId', 'asset_face.assetId'])
              .select(sql<number>`1 - (face_search.embedding <=> query.embedding)`.as('similarity'))
              .where('asset_face.personGroupId', 'is not', null)
              .whereRef('asset_face.id', '!=', 'query.faceId')
              .where((eb) => isUsableFace(eb, ownerId))
              .where((eb) => hasStrongEmbedding(eb, minNorm))
              .orderBy(sql`face_search.embedding <=> query.embedding`)
              .limit(limit)
              .as('neighbor'),
          (join) => join.onTrue(),
        )
        .select(['query.faceId', 'neighbor.personGroupId', 'neighbor.assetId', 'neighbor.similarity'])
        .where('query.faceId', '=', anyUuid(faceIds))
        .execute()
        .then((rows) => rows.map((row) => ({ ...row, personGroupId: row.personGroupId! })));
    });
  }

  /** For each person or face without a person: on how many assets it is, on how many days, and the latest date */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], [DummyValue.UUID]] })
  async getCandidateStatistics(ownerId: string, personGroupIds: string[], faceIds: string[]) {
    if (personGroupIds.length === 0 && faceIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('asset_face')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .select((eb) => eb.fn.coalesce('asset_face.personGroupId', 'asset_face.id').as('id'))
      .select((eb) => eb.fn.count(eb.fn('distinct', ['asset.id'])).as('assets'))
      .select(sql<number>`count(distinct (asset."localDateTime" at time zone 'UTC')::date)`.as('days'))
      .select((eb) => eb.fn.max('asset.fileCreatedAt').as('latest'))
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .where((eb) =>
        eb.or([
          ...(personGroupIds.length > 0 ? [eb('asset_face.personGroupId', '=', anyUuid(personGroupIds))] : []),
          ...(faceIds.length > 0 ? [eb('asset_face.id', '=', anyUuid(faceIds))] : []),
        ]),
      )
      .groupBy((eb) => eb.fn.coalesce('asset_face.personGroupId', 'asset_face.id'))
      .execute();

    return rows.map(({ id, assets, days, latest }) => ({
      id: id!,
      assets: Number(assets),
      days: Number(days),
      latest: latest ? new Date(latest) : null,
    }));
  }

  /**
   * For each pair: the share of the candidate's assets on which the target is already located (a face in the picture,
   * not a whole-asset mark). One person is rarely twice in one picture, so the candidate is likely someone else there.
   */
  @GenerateSql({
    params: [DummyValue.UUID, [{ personGroupId: DummyValue.UUID, targetPersonGroupId: DummyValue.UUID }]],
  })
  async getSharedAssetShares(ownerId: string, pairs: SuggestionPair[]) {
    if (pairs.length === 0) {
      return [];
    }

    const personPairs = pairs.filter((pair) => pair.personGroupId);
    const facePairs = pairs.filter((pair) => pair.faceId);
    const sharedCount = sql`count(distinct asset.id) filter (where exists (
      select 1 from asset_face as other
      where other."assetId" = asset.id
        and other."personGroupId" = pair."targetId"
        and other."deletedAt" is null
        and other."isVisible" is true
        and other."isWholeAsset" is false))`;

    const { rows } = await sql<{ candidateId: string; targetId: string; total: string; shared: string }>`
      select pair."candidateId", pair."targetId", count(distinct asset.id) as total, ${sharedCount} as shared
      from (
        select
          unnest(${asArray(personPairs.map((pair) => pair.personGroupId!))}::uuid[]) as "candidateId",
          unnest(${asArray(personPairs.map((pair) => pair.targetPersonGroupId))}::uuid[]) as "targetId"
      ) as pair
      inner join asset_face on asset_face."personGroupId" = pair."candidateId"
      inner join asset on asset.id = asset_face."assetId"
      where asset."ownerId" = ${ownerId}
        and asset."deletedAt" is null
        and asset_face."deletedAt" is null
        and asset_face."isVisible" is true
      group by pair."candidateId", pair."targetId"
      union all
      select pair."candidateId", pair."targetId", count(distinct asset.id) as total, ${sharedCount} as shared
      from (
        select
          unnest(${asArray(facePairs.map((pair) => pair.faceId!))}::uuid[]) as "candidateId",
          unnest(${asArray(facePairs.map((pair) => pair.targetPersonGroupId))}::uuid[]) as "targetId"
      ) as pair
      inner join asset_face on asset_face.id = pair."candidateId"
      inner join asset on asset.id = asset_face."assetId"
      where asset."ownerId" = ${ownerId}
        and asset."deletedAt" is null
      group by pair."candidateId", pair."targetId"
    `.execute(this.db);

    return rows.map(({ candidateId, targetId, total, shared }) => ({
      candidateId,
      targetId,
      share: Number(total) > 0 ? Number(shared) / Number(total) : 0,
    }));
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getAll(ownerId: string) {
    return this.db.selectFrom('person_suggestion').selectAll().where('ownerId', '=', ownerId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db.selectFrom('person_suggestion').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** The suggestion about a pair, whichever way round two people were asked about */
  @GenerateSql({ params: [DummyValue.UUID, { personGroupId: DummyValue.UUID, targetPersonGroupId: DummyValue.UUID }] })
  getByPair(ownerId: string, pair: SuggestionPair) {
    return this.db
      .selectFrom('person_suggestion')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where((eb) =>
        pair.faceId
          ? eb.and([eb('faceId', '=', pair.faceId), eb('targetPersonGroupId', '=', pair.targetPersonGroupId)])
          : eb.or([
              eb.and([
                eb('personGroupId', '=', pair.personGroupId!),
                eb('targetPersonGroupId', '=', pair.targetPersonGroupId),
              ]),
              eb.and([
                eb('personGroupId', '=', pair.targetPersonGroupId),
                eb('targetPersonGroupId', '=', pair.personGroupId!),
              ]),
            ]),
      )
      .executeTakeFirst();
  }

  @GenerateSql({
    params: [
      {
        ownerId: DummyValue.UUID,
        kind: 'named',
        personGroupId: DummyValue.UUID,
        targetPersonGroupId: DummyValue.UUID,
        score: 0.4,
      },
    ],
  })
  create(suggestion: Insertable<PersonSuggestionTable>) {
    return this.db.insertInto('person_suggestion').values(suggestion).returningAll().executeTakeFirstOrThrow();
  }

  async createAll(suggestions: Insertable<PersonSuggestionTable>[]) {
    if (suggestions.length === 0) {
      return;
    }

    for (let index = 0; index < suggestions.length; index += 1000) {
      await this.db
        .insertInto('person_suggestion')
        .values(suggestions.slice(index, index + 1000))
        .execute();
    }
  }

  @GenerateSql({ params: [DummyValue.UUID, { status: PersonSuggestionStatus.Different }] })
  update(id: string, suggestion: Updateable<PersonSuggestionTable>) {
    return this.db
      .updateTable('person_suggestion')
      .set(suggestion)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** New scores for pending suggestions that the job found again */
  async updateScores(updates: { id: string; score: number; priority: number }[]) {
    for (let index = 0; index < updates.length; index += 1000) {
      const chunk = updates.slice(index, index + 1000);
      const ids = `{${chunk.map(({ id }) => id)}}`;
      const scores = `{${chunk.map(({ score }) => score)}}`;
      const priorities = `{${chunk.map(({ priority }) => priority)}}`;
      await sql`
        update person_suggestion
        set score = updated.score, priority = updated.priority
        from (
          select unnest(${ids}::uuid[]) as id, unnest(${scores}::real[]) as score, unnest(${priorities}::real[]) as priority
        ) as updated
        where person_suggestion.id = updated.id
      `.execute(this.db);
    }
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async deleteAll(ids: string[]) {
    if (ids.length === 0) {
      return;
    }

    await this.db.deleteFrom('person_suggestion').where('id', '=', anyUuid(ids)).execute();
  }

  /** "Not sure" answers older than `before` are asked again */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.DATE] })
  async reopenSkipped(ownerId: string, before: Date) {
    await this.db
      .updateTable('person_suggestion')
      .set({ status: PersonSuggestionStatus.Pending, answeredAt: null })
      .where('ownerId', '=', ownerId)
      .where('status', '=', PersonSuggestionStatus.Skipped)
      .where('answeredAt', '<', before)
      .execute();
  }

  /**
   * The pending questions the caller can be asked right now, most valuable first: both sides still exist and have a
   * face the caller may see, the candidate is still unnamed or without a person, and nobody involved is hidden
   */
  @GenerateSql({ params: [dummyScope, { take: 10, skip: 0, personGroupId: DummyValue.UUID }] })
  getPending(
    scope: PrivateScope,
    { take, skip, personGroupId }: { take: number; skip: number; personGroupId?: string },
  ) {
    return this.pendingQuery(scope, personGroupId)
      .selectAll('person_suggestion')
      .orderBy('person_suggestion.priority', 'desc')
      .orderBy('person_suggestion.id')
      .limit(take)
      .offset(skip)
      .execute();
  }

  @GenerateSql({ params: [dummyScope, DummyValue.UUID] })
  async getPendingCount(scope: PrivateScope, personGroupId?: string): Promise<number> {
    const row = await this.pendingQuery(scope, personGroupId)
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }

  private pendingQuery(scope: PrivateScope, personGroupId?: string) {
    const ownerId = scope.userId;
    return (
      this.db
        .selectFrom('person_suggestion')
        // only the questions about one person: asked about, or the one asked about may be them
        .$if(!!personGroupId, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb('person_suggestion.personGroupId', '=', personGroupId!),
              eb('person_suggestion.targetPersonGroupId', '=', personGroupId!),
            ]),
          ),
        )
        .innerJoin('person as target', (join) =>
          join
            .onRef('target.personGroupId', '=', 'person_suggestion.targetPersonGroupId')
            .on('target.ownerId', '=', ownerId),
        )
        .leftJoin('person as candidate', (join) =>
          join
            .onRef('candidate.personGroupId', '=', 'person_suggestion.personGroupId')
            .on('candidate.ownerId', '=', ownerId),
        )
        .leftJoin('asset_face as face', 'face.id', 'person_suggestion.faceId')
        .leftJoin('person as facePerson', (join) =>
          join.onRef('facePerson.personGroupId', '=', 'face.personGroupId').on('facePerson.ownerId', '=', ownerId),
        )
        .where('person_suggestion.ownerId', '=', ownerId)
        .where('person_suggestion.status', '=', PersonSuggestionStatus.Pending)
        .where('target.isHidden', '=', false)
        .where((eb) =>
          eb.or([
            eb.and([eb('candidate.isHidden', '=', false), eb('candidate.name', '=', '')]),
            // a face without a person, or with an unnamed one (questions created through the API); a face that went to
            // a named person in the meantime has its answer
            eb.and([
              eb('face.id', 'is not', null),
              eb.or([eb('face.personGroupId', 'is', null), eb('facePerson.name', '=', '')]),
              eb.or([
                eb('face.personGroupId', 'is', null),
                eb('face.personGroupId', '!=', eb.ref('person_suggestion.targetPersonGroupId')),
              ]),
            ]),
          ]),
        )
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('asset_face')
              .innerJoin('asset', 'asset.id', 'asset_face.assetId')
              .select('asset_face.id')
              .where((eb) =>
                eb.or([
                  eb('asset_face.personGroupId', '=', eb.ref('person_suggestion.personGroupId')),
                  eb('asset_face.id', '=', eb.ref('person_suggestion.faceId')),
                ]),
              )
              .where((eb) => isShownFace(eb, scope)),
          ),
        )
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('asset_face')
              .innerJoin('asset', 'asset.id', 'asset_face.assetId')
              .select('asset_face.id')
              .whereRef('asset_face.personGroupId', '=', 'person_suggestion.targetPersonGroupId')
              .where((eb) => isShownFace(eb, scope)),
          ),
        )
    );
  }

  /** The latest answers, newest first */
  @GenerateSql({ params: [DummyValue.UUID, 10] })
  getAnswered(ownerId: string, limit: number) {
    return this.db
      .selectFrom('person_suggestion')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('status', '!=', PersonSuggestionStatus.Pending)
      .where('answeredAt', 'is not', null)
      .orderBy('answeredAt', 'desc')
      .limit(limit)
      .execute();
  }

  /** How the owner answered each kind of question: how often "same", and how often the scores promised it */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getAnswerOutcomes(ownerId: string): Promise<AnswerOutcome[]> {
    const rows = await this.db
      .selectFrom('person_suggestion')
      .select((eb) => [
        'kind',
        eb('faceId', 'is not', null).as('isFace'),
        eb.fn.countAll<number>().filterWhere('status', '=', PersonSuggestionStatus.Same).as('same'),
        sql<number>`sum(person_suggestion.score::float8 * person_suggestion.score)`.as('expected'),
      ])
      .where('ownerId', '=', ownerId)
      .where('status', '!=', PersonSuggestionStatus.Pending)
      .groupBy(['kind', 'isFace'])
      .execute();

    return rows.map(({ kind, isFace, same, expected }) => ({
      kind,
      isFace: !!isFace,
      same: Number(same),
      expected: Number(expected),
    }));
  }

  /**
   * Up to `limit` faces of a person (or the one face) to show, spread over the time the photos were taken; the larger
   * faces of each stretch of time first
   */
  @GenerateSql({ params: [dummyScope, { personGroupId: DummyValue.UUID }, 8] })
  getShownFaces(scope: PrivateScope, candidate: SuggestionCandidate, limit: number) {
    return this.db
      .selectFrom((db) =>
        db
          .selectFrom('asset_face')
          .innerJoin('asset', 'asset.id', 'asset_face.assetId')
          .select(['asset_face.id', 'asset_face.assetId', 'asset_face.updatedAt', 'asset.fileCreatedAt'])
          .select(sql<number>`ntile(${limit}) over (order by asset."fileCreatedAt", asset_face.id)`.as('tile'))
          .select(
            sql<number>`(asset_face."boundingBoxX2" - asset_face."boundingBoxX1")::float8 * (asset_face."boundingBoxY2" - asset_face."boundingBoxY1") / greatest(asset_face."imageWidth" * asset_face."imageHeight", 1)`.as(
              'size',
            ),
          )
          .where((eb) =>
            candidate.faceId
              ? eb('asset_face.id', '=', candidate.faceId)
              : eb('asset_face.personGroupId', '=', candidate.personGroupId!),
          )
          .where((eb) => isShownFace(eb, scope))
          .as('face'),
      )
      .distinctOn('face.tile')
      .select(['face.id', 'face.assetId', 'face.updatedAt', 'face.fileCreatedAt'])
      .orderBy('face.tile')
      .orderBy('face.size', 'desc')
      .orderBy('face.id')
      .execute();
  }

  /** The `limit` faces of a person that look most like the candidate, to show next to it */
  @GenerateSql({
    params: [dummyScope, DummyValue.UUID, { personGroupId: DummyValue.UUID }, 4],
  })
  getMostSimilarFaces(scope: PrivateScope, personGroupId: string, candidate: SuggestionCandidate, limit: number) {
    return this.db
      .with('query', (db) =>
        db
          .selectFrom('asset_face')
          .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
          .select(sql<string>`avg(l2_normalize(face_search.embedding))`.as('embedding'))
          .where((eb) =>
            candidate.faceId
              ? eb('asset_face.id', '=', candidate.faceId)
              : eb('asset_face.personGroupId', '=', candidate.personGroupId!),
          )
          .where('asset_face.deletedAt', 'is', null),
      )
      .selectFrom('asset_face')
      .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .innerJoin('query', (join) => join.onTrue())
      .select(['asset_face.id', 'asset_face.assetId', 'asset_face.updatedAt', 'asset.fileCreatedAt'])
      .where('asset_face.personGroupId', '=', personGroupId)
      .where((eb) => isShownFace(eb, scope))
      .orderBy(sql`face_search.embedding <=> query.embedding`)
      .limit(limit)
      .execute();
  }

  /** On how many assets the caller may see right now a person (or the one face) is */
  @GenerateSql({ params: [dummyScope, { personGroupId: DummyValue.UUID }] })
  async getShownAssetCount(scope: PrivateScope, candidate: SuggestionCandidate): Promise<number> {
    const row = await this.db
      .selectFrom('asset_face')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .select((eb) => eb.fn.count(eb.fn('distinct', ['asset.id'])).as('count'))
      .where((eb) =>
        candidate.faceId
          ? eb('asset_face.id', '=', candidate.faceId)
          : eb('asset_face.personGroupId', '=', candidate.personGroupId!),
      )
      .where('asset.ownerId', '=', scope.userId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .where((eb) => isInScope(eb, scope))
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }

  /** The people a face was answered to be different from, which facial recognition must never assign it to */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getDifferentPersonGroupIds(faceId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('person_suggestion')
      .select('targetPersonGroupId')
      .where('faceId', '=', faceId)
      .where('status', '=', PersonSuggestionStatus.Different)
      .execute();

    return rows.map(({ targetPersonGroupId }) => targetPersonGroupId);
  }

  /** Of the faces, those that were answered to be a different person than `personGroupId` */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID] })
  async getFacesDifferentFrom(faceIds: string[], personGroupId: string): Promise<string[]> {
    if (faceIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('person_suggestion')
      .select('faceId')
      .where('faceId', '=', anyUuid(faceIds))
      .where('targetPersonGroupId', '=', personGroupId)
      .where('status', '=', PersonSuggestionStatus.Different)
      .execute();

    return rows.map(({ faceId }) => faceId!);
  }

  /** Of the people, those that were answered to be a different person than `personGroupId`, either way round */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, [DummyValue.UUID]] })
  async getPeopleDifferentFrom(ownerId: string, personGroupId: string, personGroupIds: string[]): Promise<string[]> {
    if (personGroupIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('person_suggestion')
      .select(['personGroupId', 'targetPersonGroupId'])
      .where('ownerId', '=', ownerId)
      .where('status', '=', PersonSuggestionStatus.Different)
      .where((eb) =>
        eb.or([
          eb.and([eb('personGroupId', '=', personGroupId), eb('targetPersonGroupId', '=', anyUuid(personGroupIds))]),
          eb.and([eb('targetPersonGroupId', '=', personGroupId), eb('personGroupId', '=', anyUuid(personGroupIds))]),
        ]),
      )
      .execute();

    return rows.map((row) => (row.personGroupId === personGroupId ? row.targetPersonGroupId : row.personGroupId!));
  }

  /**
   * A person was merged into another: what was answered about it now applies to the person it became part of. Open
   * questions about it go, since they were about a person that no longer exists. Answers that would compare the
   * person with itself, or that duplicate one the other person already has, go as well.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.UUID] })
  async moveToPerson(ownerId: string, fromPersonGroupId: string, toPersonGroupId: string) {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('person_suggestion')
        .where('ownerId', '=', ownerId)
        .where((eb) =>
          eb.or([
            eb('status', 'in', [PersonSuggestionStatus.Pending, PersonSuggestionStatus.Skipped]),
            // about the two people that are now one
            eb.and([eb('personGroupId', '=', fromPersonGroupId), eb('targetPersonGroupId', '=', toPersonGroupId)]),
            eb.and([eb('personGroupId', '=', toPersonGroupId), eb('targetPersonGroupId', '=', fromPersonGroupId)]),
          ]),
        )
        .where((eb) =>
          eb.or([eb('personGroupId', '=', fromPersonGroupId), eb('targetPersonGroupId', '=', fromPersonGroupId)]),
        )
        .execute();

      // a different answer the other person already has makes this one redundant
      await trx
        .deleteFrom('person_suggestion as moved')
        .where('moved.ownerId', '=', ownerId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('person_suggestion as kept')
              .select('kept.id')
              .whereRef('kept.ownerId', '=', 'moved.ownerId')
              .where((eb) =>
                eb.or([
                  // moved = (from, X) and kept = (to, X) or (X, to)
                  eb.and([
                    eb('moved.personGroupId', '=', fromPersonGroupId),
                    eb.or([
                      eb.and([
                        eb('kept.personGroupId', '=', toPersonGroupId),
                        eb('kept.targetPersonGroupId', '=', eb.ref('moved.targetPersonGroupId')),
                      ]),
                      eb.and([
                        eb('kept.targetPersonGroupId', '=', toPersonGroupId),
                        eb('kept.personGroupId', '=', eb.ref('moved.targetPersonGroupId')),
                      ]),
                    ]),
                  ]),
                  // moved = (X, from) and kept = (X, to) or (to, X); a face X can only be the candidate
                  eb.and([
                    eb('moved.targetPersonGroupId', '=', fromPersonGroupId),
                    eb.or([
                      eb.and([
                        eb('kept.targetPersonGroupId', '=', toPersonGroupId),
                        eb.or([
                          eb('kept.personGroupId', '=', eb.ref('moved.personGroupId')),
                          eb('kept.faceId', '=', eb.ref('moved.faceId')),
                        ]),
                      ]),
                      eb.and([
                        eb('kept.personGroupId', '=', toPersonGroupId),
                        eb('kept.targetPersonGroupId', '=', eb.ref('moved.personGroupId')),
                      ]),
                    ]),
                  ]),
                ]),
              ),
          ),
        )
        .execute();

      await trx
        .updateTable('person_suggestion')
        .set({ personGroupId: toPersonGroupId })
        .where('ownerId', '=', ownerId)
        .where('personGroupId', '=', fromPersonGroupId)
        .execute();

      await trx
        .updateTable('person_suggestion')
        .set({ targetPersonGroupId: toPersonGroupId })
        .where('ownerId', '=', ownerId)
        .where('targetPersonGroupId', '=', fromPersonGroupId)
        .execute();
    });
  }

  /** A face as it is needed to cut it out of its picture */
  @GenerateSql({ params: [DummyValue.UUID] })
  getFaceForCrop(faceId: string) {
    return this.db
      .selectFrom('asset_face')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('asset_video', 'asset_video.assetId', 'asset.id')
      .select([
        'asset_face.id',
        'asset_face.boundingBoxX1 as x1',
        'asset_face.boundingBoxY1 as y1',
        'asset_face.boundingBoxX2 as x2',
        'asset_face.boundingBoxY2 as y2',
        'asset_face.imageWidth as oldWidth',
        'asset_face.imageHeight as oldHeight',
        'asset_face.frameTimestamp',
        'asset_face.isWholeAsset',
        'asset.id as assetId',
        'asset.ownerId',
        'asset.type',
        'asset.originalPath',
        'asset.isPrivate',
        'asset_exif.orientation as exifOrientation',
      ])
      .select((eb) => withFilePath(eb, AssetFileType.Preview).as('previewPath'))
      .select((eb) => withVideoStream(eb).as('videoStream'))
      .where('asset_face.id', '=', faceId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  /** Whether the asset may be shown to the caller right now (private mode and the active view) */
  @GenerateSql({ params: [dummyScope, DummyValue.UUID] })
  async isAssetInScope(scope: PrivateScope, assetId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.id', '=', assetId)
      .where((eb) => isInScope(eb, scope))
      .executeTakeFirst();

    return !!row;
  }

  /** The other open questions about a face: once it is answered to be someone, they are moot */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async deleteOpenForFace(faceId: string, exceptId: string) {
    await this.db
      .deleteFrom('person_suggestion')
      .where('faceId', '=', faceId)
      .where('id', '!=', exceptId)
      .where('status', 'in', [PersonSuggestionStatus.Pending, PersonSuggestionStatus.Skipped])
      .execute();
  }

  /** Every face of a person on the owner's assets, whatever its state: what a merge of the person moves */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async getFaceIdsOfPerson(ownerId: string, personGroupId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset_face')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .select('asset_face.id')
      .where('asset_face.personGroupId', '=', personGroupId)
      .where('asset.ownerId', '=', ownerId)
      .execute();

    return rows.map(({ id }) => id);
  }

  /** Moves those of the faces that are still with `fromPersonGroupId`; null leaves them without a person */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID, DummyValue.UUID] })
  async moveFaces(faceIds: string[], fromPersonGroupId: string, toPersonGroupId: string | null): Promise<string[]> {
    if (faceIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .updateTable('asset_face')
      .set({ personGroupId: toPersonGroupId })
      .where('asset_face.id', '=', anyUuid(faceIds))
      .where('asset_face.personGroupId', '=', fromPersonGroupId)
      .returning('asset_face.id')
      .execute();

    return rows.map(({ id }) => id);
  }

  /** Of the faces, those that are still with the person */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID] })
  async getFacesStillWith(faceIds: string[], personGroupId: string): Promise<string[]> {
    if (faceIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('asset_face')
      .select('asset_face.id')
      .where('asset_face.id', '=', anyUuid(faceIds))
      .where('asset_face.personGroupId', '=', personGroupId)
      .execute();

    return rows.map(({ id }) => id);
  }

  /** Brings back a person group that a merge removed, with its old id, in the owner's cluster group */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async restoreGroup(ownerId: string, personGroupId: string): Promise<void> {
    await this.db
      .insertInto('person_group')
      .columns(['id', 'clusterGroupId'])
      .expression((eb) =>
        eb
          .selectFrom('user')
          .select([sql<string>`${personGroupId}::uuid`.as('id'), 'user.clusterGroupId'])
          .where('user.id', '=', ownerId),
      )
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  /** Those of the faces the caller may see right now, newest first */
  @GenerateSql({ params: [dummyScope, [DummyValue.UUID], 4] })
  getShownFacesByIds(scope: PrivateScope, faceIds: string[], limit: number) {
    if (faceIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('asset_face')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .select(['asset_face.id', 'asset_face.assetId', 'asset_face.updatedAt', 'asset.fileCreatedAt'])
      .where('asset_face.id', '=', anyUuid(faceIds))
      .where((eb) => isShownFace(eb, scope))
      .orderBy('asset.fileCreatedAt', 'desc')
      .limit(limit)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, PersonSuggestionSource.Automatic] })
  async deleteBySource(ownerId: string, source: PersonSuggestionSource) {
    await this.db
      .deleteFrom('person_suggestion')
      .where('ownerId', '=', ownerId)
      .where('source', '=', source)
      .where('status', '=', PersonSuggestionStatus.Pending)
      .execute();
  }
}
