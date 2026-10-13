import { Injectable } from '@nestjs/common';
import { Kysely, OrderByDirection, Selectable, SelectQueryBuilder, ShallowDehydrateObject, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns, ViewFilter } from 'src/database';
import { DummyValue, GenerateSql } from 'src/decorators';
import { MapAsset } from 'src/dtos/asset-response.dto';
import { SearchFilter, SearchOrder } from 'src/dtos/search.dto';
import { AssetStatus, AssetType, AssetVisibility, VectorIndex } from 'src/enum';
import { probes } from 'src/repositories/database.repository';
import { DB } from 'src/schema';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import {
  anyUuid,
  isViewUnrestricted,
  type PrivateScope,
  searchAssetBuilder,
  searchAssetBuilderLegacy,
  searchMetadataV3Examples,
  searchRandomV3Examples,
  searchSmartV3Examples,
  searchStatisticsV3Examples,
  viewAssetPredicate,
  withExifInner,
  withSearchOrder,
} from 'src/utils/database';
import { paginationHelper, PaginationOptions } from 'src/utils/pagination';
import z from 'zod';

export interface SearchAssetIdOptions {
  checksum?: Buffer;
  id?: string;
}

export interface SearchUserIdOptions {
  libraryId?: string | null;
  userIds?: string[];
}

export type SearchIdOptions = SearchAssetIdOptions & SearchUserIdOptions;

export interface SearchStatusOptions {
  isEncoded?: boolean;
  isFavorite?: boolean;
  isPrivate?: boolean;
  isMotion?: boolean;
  isOffline?: boolean;
  isNotInAlbum?: boolean;
  type?: AssetType;
  status?: AssetStatus;
  withArchived?: boolean;
  withDeleted?: boolean;
  visibility?: AssetVisibility;
}

export interface SearchOneToOneRelationOptions {
  withExif?: boolean;
  withStacked?: boolean;
}

export interface SearchRelationOptions extends SearchOneToOneRelationOptions {
  withFaces?: boolean;
  withPeople?: boolean;
  /** whose version of the people to select, required when selecting faces or people */
  viewingUserId?: string;
}

export interface SearchDateOptions {
  createdBefore?: Date;
  createdAfter?: Date;
  takenBefore?: Date;
  takenAfter?: Date;
  trashedBefore?: Date;
  trashedAfter?: Date;
  updatedBefore?: Date;
  updatedAfter?: Date;
}

export interface SearchPathOptions {
  encodedVideoPath?: string;
  originalFileName?: string;
  originalPath?: string;
  previewPath?: string;
  thumbnailPath?: string;
}

export interface SearchExifOptions {
  city?: string | null;
  country?: string | null;
  lensModel?: string | null;
  make?: string | null;
  model?: string | null;
  state?: string | null;
  description?: string | null;
  rating?: number | null;
}

export interface SearchEmbeddingOptions {
  embedding: string;
  userIds: string[];
}

export interface SearchOcrOptions {
  ocr?: string;
}

export interface SearchPeopleOptions {
  personIds?: string[];
}

export interface SearchTagOptions {
  tagIds?: string[] | null;
}

export interface SearchAlbumOptions {
  albumIds?: string[];
}

export interface SearchPrivateScopeOptions {
  /** private-mode scope of the requesting session; missing means private mode off */
  privateScope?: PrivateScope;
}

export interface SearchOrderOptions {
  orderDirection?: 'asc' | 'desc';
}

export interface SearchPaginationOptions {
  page: number;
  size: number;
}

type BaseAssetSearchOptions = SearchDateOptions &
  SearchIdOptions &
  SearchExifOptions &
  SearchOrderOptions &
  SearchPathOptions &
  SearchStatusOptions &
  SearchUserIdOptions &
  SearchPeopleOptions &
  SearchTagOptions &
  SearchAlbumOptions &
  SearchOcrOptions &
  SearchPrivateScopeOptions;

export type AssetSearchOptions = Omit<BaseAssetSearchOptions, 'visibility'> &
  SearchRelationOptions & { visibility?: AssetVisibility | 'not-locked' };

export type AssetSearchBuilderOptions = Omit<AssetSearchOptions, 'orderDirection'>;

export interface AssetSearchScope {
  userIds: string[];
  lockedOwnerId: string;
  /** whose private assets may be returned: the requesting user while in private mode, otherwise nobody's */
  privateOwnerId: string | null;
  /** whose version of the people to select, required when selecting faces or people */
  viewingUserId?: string;
  /** the view of the requesting session; missing shows everything */
  view?: ViewFilter | null;
}

export interface AssetSearchBuilderV3Options {
  filter?: SearchFilter;
  withExif?: boolean;
  withFaces?: boolean;
  withPeople?: boolean;
  withStacked?: boolean;
  order?: SearchOrder;
}

export type SmartSearchOptions = SearchDateOptions &
  SearchEmbeddingOptions &
  SearchExifOptions &
  SearchOneToOneRelationOptions &
  Omit<SearchStatusOptions, 'visibility'> &
  SearchUserIdOptions &
  SearchPeopleOptions &
  SearchTagOptions &
  SearchOcrOptions &
  SearchPrivateScopeOptions & { visibility?: AssetVisibility | 'not-locked'; viewingUserId?: string };

export type LargeAssetSearchOptions = AssetSearchOptions & { minFileSize?: number };

export interface FaceEmbeddingSearch extends Omit<SearchEmbeddingOptions, 'userIds'> {
  clusterGroupId: string;
  hasPerson?: boolean;
  numResults: number;
  maxDistance: number;
  minBirthDate?: Date | null;
}

export interface FaceSearchResult {
  distance: number;
  id: string;
  personGroupId: string | null;
}

export interface AssetDuplicateResult {
  assetId: string;
  duplicateId: string | null;
  distance: number;
}

export interface GetStatesOptions {
  country?: string;
}

export interface GetCitiesOptions extends GetStatesOptions {
  state?: string;
}

export interface GetCameraModelsOptions {
  make?: string;
  lensModel?: string;
}

export interface GetCameraMakesOptions {
  model?: string;
  lensModel?: string;
}

export interface GetCameraLensModelsOptions {
  make?: string;
  model?: string;
}

@Injectable()
export class SearchRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  // TODO(v4): remove with the deprecated flat-field search API
  @GenerateSql({
    params: [
      { page: 1, size: 100 },
      {
        takenAfter: DummyValue.DATE,
        lensModel: DummyValue.STRING,
        withStacked: true,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  async searchMetadata(pagination: SearchPaginationOptions, options: AssetSearchOptions) {
    const orderDirection = (options.orderDirection?.toLowerCase() || 'desc') as OrderByDirection;
    const items = await searchAssetBuilderLegacy(this.db, options)
      .select(columns.searchAsset)
      .orderBy('asset.fileCreatedAt', orderDirection)
      .orderBy('asset.id', orderDirection)
      .limit(pagination.size + 1)
      .offset((pagination.page - 1) * pagination.size)
      .execute();

    return paginationHelper(items, pagination.size);
  }

  // TODO(v4): remove with the deprecated flat-field search API
  @GenerateSql({
    params: [
      {
        takenAfter: DummyValue.DATE,
        lensModel: DummyValue.STRING,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  searchStatistics(options: AssetSearchOptions) {
    return searchAssetBuilderLegacy(this.db, options)
      .select((qb) => qb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
  }

  // TODO(v4): remove with the deprecated flat-field search API
  @GenerateSql({
    params: [
      100,
      {
        takenAfter: DummyValue.DATE,
        lensModel: DummyValue.STRING,
        withStacked: true,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  async searchRandom(size: number, options: AssetSearchOptions) {
    return searchAssetBuilderLegacy(this.db, options)
      .select(columns.searchAsset)
      .orderBy(sql`random()`)
      .limit(size)
      .execute();
  }

  // TODO(v4): remove with the deprecated flat-field search API
  @GenerateSql({
    params: [
      100,
      {
        takenAfter: DummyValue.DATE,
        lensModel: DummyValue.STRING,
        withStacked: true,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  searchLargeAssets(size: number, options: LargeAssetSearchOptions) {
    const orderDirection = (options.orderDirection?.toLowerCase() || 'desc') as OrderByDirection;
    return searchAssetBuilderLegacy(this.db, options)
      .select(columns.searchAsset)
      .$call(withExifInner)
      .where('asset_exif.fileSizeInByte', '>', options.minFileSize || 0)
      .orderBy('asset_exif.fileSizeInByte', orderDirection)
      .limit(size)
      .execute();
  }

  // TODO(v4): remove with the deprecated flat-field search API
  @GenerateSql({
    params: [
      { page: 1, size: 200 },
      {
        takenAfter: DummyValue.DATE,
        embedding: DummyValue.VECTOR,
        lensModel: DummyValue.STRING,
        withStacked: true,
        isFavorite: true,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  searchSmart(pagination: SearchPaginationOptions, options: SmartSearchOptions) {
    if (!z.int().min(1).max(1000).safeParse(pagination.size).success) {
      throw new Error(`Invalid value for 'size': ${pagination.size}`);
    }

    return this.db.transaction().execute(async (trx) => {
      const skip = (pagination.page - 1) * pagination.size;
      const items = await this.searchSmartWithFrames(
        () => searchAssetBuilderLegacy(trx, options),
        trx,
        options.embedding,
        skip + pagination.size + 1,
      );
      return paginationHelper(items.slice(skip), pagination.size);
    });
  }

  /**
   * Ranks assets by their best match: the thumbnail embedding or, for analyzed videos, the closest
   * sampled frame. Both lookups use their vector index with the same filters, then the lists are
   * merged so every asset appears once. The result is the exact top `limit` of the merged ranking.
   */
  private async searchSmartWithFrames(
    // both search builders fit here, their result types only differ in joined tables
    getBuilder: () => SelectQueryBuilder<any, any, any>,
    trx: Kysely<DB>,
    embedding: string,
    limit: number,
  ): Promise<MapAsset[]> {
    await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Clip])}`.execute(trx);
    const thumbnailMatches = await getBuilder()
      .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
      .select(columns.searchAsset)
      .select(sql<number>`smart_search.embedding <=> ${embedding}`.as('distance'))
      .orderBy(sql`smart_search.embedding <=> ${embedding}`)
      .orderBy('asset.id', 'asc')
      .limit(limit)
      .$castTo<MapAsset & { distance: number }>()
      .execute();

    await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.ClipFrame])}`.execute(trx);
    const frameDistances = new Map<string, number>();
    // several frames of one video can match, so fetch more rows until enough distinct assets are found
    for (let frameLimit = limit * 4, attempt = 0; attempt < 4; frameLimit *= 4, attempt++) {
      const frameMatches = await getBuilder()
        .innerJoin('smart_search_frame', 'asset.id', 'smart_search_frame.assetId')
        .select(['asset.id', sql<number>`smart_search_frame.embedding <=> ${embedding}`.as('distance')])
        .orderBy(sql`smart_search_frame.embedding <=> ${embedding}`)
        .limit(frameLimit)
        .$castTo<{ id: string; distance: number }>()
        .execute();

      frameDistances.clear();
      for (const { id, distance } of frameMatches) {
        if (!frameDistances.has(id)) {
          frameDistances.set(id, distance);
        }
      }

      if (frameMatches.length < frameLimit || frameDistances.size >= limit) {
        break;
      }
    }

    if (frameDistances.size === 0) {
      return thumbnailMatches.map(({ distance: _, ...asset }) => asset);
    }

    const ranked = thumbnailMatches.map(({ distance, ...asset }) => ({
      asset,
      distance: Math.min(distance, frameDistances.get(asset.id) ?? Infinity),
    }));

    const thumbnailIds = new Set(thumbnailMatches.map(({ id }) => id));
    const frameOnlyIds = frameDistances
      .keys()
      .filter((id) => !thumbnailIds.has(id))
      .toArray();
    if (frameOnlyIds.length > 0) {
      const frameOnlyAssets = await getBuilder()
        .select(columns.searchAsset)
        .where('asset.id', '=', anyUuid(frameOnlyIds))
        .$castTo<MapAsset>()
        .execute();
      for (const asset of frameOnlyAssets) {
        ranked.push({ asset, distance: frameDistances.get(asset.id)! });
      }
    }

    return ranked
      .toSorted((a, b) => a.distance - b.distance || a.asset.id.localeCompare(b.asset.id))
      .slice(0, limit)
      .map(({ asset }) => asset);
  }

  @GenerateSql({
    params: [DummyValue.UUID],
  })
  async getEmbedding(assetId: string) {
    return this.db.selectFrom('smart_search').selectAll().where('assetId', '=', assetId).executeTakeFirst();
  }

  @GenerateSql({
    params: [
      {
        userIds: [DummyValue.UUID],
        embedding: DummyValue.VECTOR,
        numResults: 10,
        maxDistance: 0.6,
      },
    ],
  })
  searchFaces({ clusterGroupId, embedding, numResults, maxDistance, hasPerson, minBirthDate }: FaceEmbeddingSearch) {
    if (!z.int().min(1).max(1000).safeParse(numResults).success) {
      throw new Error(`Invalid value for 'numResults': ${numResults}`);
    }

    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Face])}`.execute(trx);
      return await trx
        .with('cte', (qb) =>
          qb
            .selectFrom('asset_face')
            .innerJoin('asset', 'asset.id', 'asset_face.assetId')
            .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
            .select([
              'asset_face.id',
              'asset_face.personGroupId',
              sql<number>`face_search.embedding <=> ${embedding}`.as('distance'),
            ])
            .where('asset.ownerId', 'in', (eb) =>
              eb.selectFrom('user').select('user.id').where('user.clusterGroupId', '=', clusterGroupId),
            )
            .where('asset.deletedAt', 'is', null)
            .$if(!!hasPerson, (qb) => qb.where('asset_face.personGroupId', 'is not', null))
            .$if(!!minBirthDate, (qb) =>
              qb.where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('person')
                      .select('person.personGroupId')
                      .whereRef('person.personGroupId', '=', 'asset_face.personGroupId')
                      .where('person.birthDate', '>', minBirthDate!),
                  ),
                ),
              ),
            )
            .orderBy('distance')
            .limit(numResults),
        )
        .selectFrom('cte')
        .selectAll()
        .where('cte.distance', '<=', maxDistance)
        .execute();
    });
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  searchPlaces(placeName: string) {
    return this.db
      .selectFrom('geodata_places')
      .selectAll()
      .where(
        () =>
          // kysely doesn't support trigram %>> or <->>> operators
          sql`
            f_unaccent(name) %>> f_unaccent(${placeName}) or
            f_unaccent("admin2Name") %>> f_unaccent(${placeName}) or
            f_unaccent("admin1Name") %>> f_unaccent(${placeName}) or
            f_unaccent("alternateNames") %>> f_unaccent(${placeName})
          `,
      )
      .orderBy(
        sql`
          coalesce(f_unaccent(name) <->>> f_unaccent(${placeName}), 0.1) +
          coalesce(f_unaccent("admin2Name") <->>> f_unaccent(${placeName}), 0.1) +
          coalesce(f_unaccent("admin1Name") <->>> f_unaccent(${placeName}), 0.1) +
          coalesce(f_unaccent("alternateNames") <->>> f_unaccent(${placeName}), 0.1)
        `,
      )
      .limit(20)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], { privateMode: false, userId: DummyValue.UUID }] })
  getAssetsByCity(userIds: string[], scope: PrivateScope) {
    return this.db
      .withRecursive('cte', (qb) => {
        const base = qb
          .selectFrom('asset_exif')
          .select(['city', 'assetId'])
          .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
          .where('asset.ownerId', '=', anyUuid(userIds))
          .where('asset.visibility', '=', AssetVisibility.Timeline)
          .where('asset.type', '=', AssetType.Image)
          .where('asset.deletedAt', 'is', null)
          .where((eb) =>
            scope.privateMode
              ? eb.or([eb('asset.isPrivate', '=', false), eb('asset.ownerId', '=', scope.userId)])
              : eb('asset.isPrivate', '=', false),
          )
          .$if(!isViewUnrestricted(scope.view), (qb) => qb.where((eb) => viewAssetPredicate(eb, scope.view!)))
          .orderBy('city')
          .limit(1);

        const recursive = qb
          .selectFrom('cte')
          .select(['l.city', 'l.assetId'])
          .innerJoinLateral(
            (qb) =>
              qb
                .selectFrom('asset_exif')
                .select(['city', 'assetId'])
                .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
                .where('asset.ownerId', '=', anyUuid(userIds))
                .where('asset.visibility', '=', AssetVisibility.Timeline)
                .where('asset.type', '=', AssetType.Image)
                .where('asset.deletedAt', 'is', null)
                .where((eb) =>
                  scope.privateMode
                    ? eb.or([eb('asset.isPrivate', '=', false), eb('asset.ownerId', '=', scope.userId)])
                    : eb('asset.isPrivate', '=', false),
                )
                .$if(!isViewUnrestricted(scope.view), (qb) => qb.where((eb) => viewAssetPredicate(eb, scope.view!)))
                .whereRef('asset_exif.city', '>', 'cte.city')
                .orderBy('city')
                .limit(1)
                .as('l'),
            (join) => join.onTrue(),
          );

        return sql<{ city: string; assetId: string }>`(${base} union all ${recursive})`;
      })
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .innerJoin('cte', 'asset.id', 'cte.assetId')
      .select(columns.searchAsset)
      .select((eb) =>
        eb
          .fn('to_jsonb', [eb.table('asset_exif')])
          .$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>>>()
          .as('exifInfo'),
      )
      .orderBy('asset_exif.city')
      .execute();
  }

  async replaceFrames(assetId: string, frames: { frameTimestamp: number; embedding: string }[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('smart_search_frame').where('assetId', '=', assetId).execute();
      if (frames.length > 0) {
        await trx
          .insertInto('smart_search_frame')
          .values(frames.map(({ frameTimestamp, embedding }) => ({ assetId, frameTimestamp, embedding })))
          .execute();
      }
    });
  }

  @GenerateSql({ params: [DummyValue.VECTOR, [DummyValue.UUID]] })
  async getMinFaceDistance(embedding: string, personGroupIds: string[]): Promise<number | null> {
    if (personGroupIds.length === 0) {
      return null;
    }

    const result = await this.db
      .selectFrom('asset_face')
      .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
      .select(sql<number | null>`min(face_search.embedding <=> ${embedding})`.as('distance'))
      .where('asset_face.personGroupId', '=', anyUuid(personGroupIds))
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();

    return result?.distance ?? null;
  }

  async upsert(assetId: string, embedding: string): Promise<void> {
    await this.db
      .insertInto('smart_search')
      .values({ assetId, embedding })
      .onConflict((oc) => oc.column('assetId').doUpdateSet((eb) => ({ embedding: eb.ref('excluded.embedding') })))
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], { privateMode: false, userId: DummyValue.UUID }] })
  async getCountries(userIds: string[], scope: PrivateScope): Promise<string[]> {
    const res = await this.getExifField('country', userIds, scope).execute();
    return res.map((row) => row.country!);
  }

  @GenerateSql({
    params: [[DummyValue.UUID], { country: DummyValue.STRING }, { privateMode: false, userId: DummyValue.UUID }],
  })
  async getStates(userIds: string[], { country }: GetStatesOptions, scope: PrivateScope): Promise<string[]> {
    const res = await this.getExifField('state', userIds, scope)
      .$if(!!country, (qb) => qb.where('country', '=', country!))
      .execute();

    return res.map((row) => row.state!);
  }

  @GenerateSql({
    params: [
      [DummyValue.UUID],
      { country: DummyValue.STRING, state: DummyValue.STRING },
      { privateMode: false, userId: DummyValue.UUID },
    ],
  })
  async getCities(userIds: string[], { country, state }: GetCitiesOptions, scope: PrivateScope): Promise<string[]> {
    const res = await this.getExifField('city', userIds, scope)
      .$if(!!country, (qb) => qb.where('country', '=', country!))
      .$if(!!state, (qb) => qb.where('state', '=', state!))
      .execute();

    return res.map((row) => row.city!);
  }

  @GenerateSql({
    params: [
      [DummyValue.UUID],
      { model: DummyValue.STRING, lensModel: DummyValue.STRING },
      { privateMode: false, userId: DummyValue.UUID },
    ],
  })
  async getCameraMakes(
    userIds: string[],
    { model, lensModel }: GetCameraMakesOptions,
    scope: PrivateScope,
  ): Promise<string[]> {
    const res = await this.getExifField('make', userIds, scope)
      .$if(!!model, (qb) => qb.where('model', '=', model!))
      .$if(!!lensModel, (qb) => qb.where('lensModel', '=', lensModel!))
      .execute();

    return res.map((row) => row.make!);
  }

  @GenerateSql({
    params: [
      [DummyValue.UUID],
      { make: DummyValue.STRING, lensModel: DummyValue.STRING },
      { privateMode: false, userId: DummyValue.UUID },
    ],
  })
  async getCameraModels(
    userIds: string[],
    { make, lensModel }: GetCameraModelsOptions,
    scope: PrivateScope,
  ): Promise<string[]> {
    const res = await this.getExifField('model', userIds, scope)
      .$if(!!make, (qb) => qb.where('make', '=', make!))
      .$if(!!lensModel, (qb) => qb.where('lensModel', '=', lensModel!))
      .execute();

    return res.map((row) => row.model!);
  }

  @GenerateSql({
    params: [
      [DummyValue.UUID],
      { make: DummyValue.STRING, model: DummyValue.STRING },
      { privateMode: false, userId: DummyValue.UUID },
    ],
  })
  async getCameraLensModels(
    userIds: string[],
    { make, model }: GetCameraLensModelsOptions,
    scope: PrivateScope,
  ): Promise<string[]> {
    const res = await this.getExifField('lensModel', userIds, scope)
      .$if(!!make, (qb) => qb.where('make', '=', make!))
      .$if(!!model, (qb) => qb.where('model', '=', model!))
      .execute();

    return res.map((row) => row.lensModel!);
  }

  // TODO(v4): drop the V3 suffix once the legacy methods are removed
  @GenerateSql(...searchMetadataV3Examples)
  async searchMetadataV3(pagination: PaginationOptions, options: AssetSearchBuilderV3Options, scope: AssetSearchScope) {
    const items = await withSearchOrder(searchAssetBuilder(this.db, options, scope), options.order)
      .select(columns.searchAsset)
      .limit(pagination.take + 1)
      .offset(pagination.skip ?? 0)
      .execute();
    return paginationHelper(items, pagination.take);
  }

  // TODO(v4): drop the V3 suffix once the legacy methods are removed
  @GenerateSql(...searchRandomV3Examples)
  searchRandomV3(
    size: number,
    options: Omit<AssetSearchBuilderV3Options, 'order'>,
    scope: AssetSearchScope,
  ): Promise<MapAsset[]> {
    return searchAssetBuilder(this.db, options, scope)
      .select(columns.searchAsset)
      .orderBy(sql`random()`)
      .limit(size)
      .execute();
  }

  // TODO(v4): drop the V3 suffix once the legacy methods are removed
  @GenerateSql(...searchSmartV3Examples)
  searchSmartV3(
    pagination: PaginationOptions,
    options: Omit<AssetSearchBuilderV3Options, 'order'> & { embedding: string },
    scope: AssetSearchScope,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const skip = pagination.skip ?? 0;
      const items = await this.searchSmartWithFrames(
        () => searchAssetBuilder(trx, options, scope),
        trx,
        options.embedding,
        skip + pagination.take + 1,
      );
      return paginationHelper(items.slice(skip), pagination.take);
    });
  }

  // TODO(v4): drop the V3 suffix once the legacy methods are removed
  @GenerateSql(...searchStatisticsV3Examples)
  searchStatisticsV3(options: AssetSearchBuilderV3Options, scope: AssetSearchScope) {
    return searchAssetBuilder(this.db, options, scope)
      .select((qb) => qb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
  }

  private getExifField(
    field: 'city' | 'state' | 'country' | 'make' | 'model' | 'lensModel',
    userIds: string[],
    scope: PrivateScope,
  ) {
    return this.db
      .selectFrom('asset_exif')
      .select(field)
      .distinctOn(field)
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .where('ownerId', '=', anyUuid(userIds))
      .where('visibility', '=', AssetVisibility.Timeline)
      .where('deletedAt', 'is', null)
      .where((eb) =>
        scope.privateMode
          ? eb.or([eb('asset.isPrivate', '=', false), eb('asset.ownerId', '=', scope.userId)])
          : eb('asset.isPrivate', '=', false),
      )
      .$if(!isViewUnrestricted(scope.view), (qb) => qb.where((eb) => viewAssetPredicate(eb, scope.view!)))
      .where(field, 'is not', null)
      .where(field, '!=', '');
  }
}
