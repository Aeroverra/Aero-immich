import { BadRequestException, Injectable } from '@nestjs/common';
import { LRUMap } from 'mnemonist';
import { AssetMapOptions, AssetResponseDto, MapAsset, mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { SystemConfig } from 'src/dtos/config.dto';
import { mapPerson, PersonResponseDto } from 'src/dtos/person.dto';
import {
  isFullyAlbumConfined,
  isNewShapeRequest,
  LargeAssetSearchDto,
  mapPlaces,
  MetadataSearchDto,
  PlacesResponseDto,
  RandomSearchDto,
  SearchFilter,
  SearchPeopleDto,
  SearchPlacesDto,
  SearchResponseDto,
  SearchStatisticsResponseDto,
  SearchSuggestionRequestDto,
  SearchSuggestionType,
  SmartSearchDto,
  StatisticsSearchDto,
} from 'src/dtos/search.dto';
import { AssetOrder, AssetVisibility, Permission } from 'src/enum';
import { AssetSearchScope } from 'src/repositories/search.repository';
import { BaseService } from 'src/services/base.service';
import {
  getActiveView,
  isPrivateMode,
  requireElevatedPermission,
  requirePrivateMode,
  toPrivateScope,
} from 'src/utils/access';
import { getMyPartnerIds } from 'src/utils/asset.util';
import { PrivateScope } from 'src/utils/database';
import { isSmartSearchEnabled } from 'src/utils/misc';
import { decodeSearchCursor, encodeSearchCursor } from 'src/utils/search-cursor';
import { applyLockedVisibilityPolicy, applyPrivatePolicy, collectFilterIds } from 'src/utils/search-filter';

/** Every tag a flat search names, to find or to leave out; null (untagged) names none */
const searchedTagIds = (dto: { tagIds?: string[] | null; excludeTagIds?: string[] }) =>
  dto.tagIds === null && !dto.excludeTagIds ? null : [...(dto.tagIds ?? []), ...(dto.excludeTagIds ?? [])];

@Injectable()
export class SearchService extends BaseService {
  private embeddingCache = new LRUMap<string, string>(100);

  async searchPerson(auth: AuthDto, dto: SearchPeopleDto): Promise<PersonResponseDto[]> {
    const people = await this.personRepository.getByName(auth.user.id, dto.name, { withHidden: dto.withHidden });
    return people.map((person) => mapPerson(person));
  }

  async searchPlaces(dto: SearchPlacesDto): Promise<PlacesResponseDto[]> {
    const places = await this.searchRepository.searchPlaces(dto.name);
    return places.map((place) => mapPlaces(place));
  }

  async getExploreData(auth: AuthDto) {
    const options = { maxFields: 12, minAssetsPerField: 5 };
    const scope = toPrivateScope(auth);

    const cities = await this.assetRepository.getAssetIdByCity(auth.user.id, options, scope);
    const cityAssets = await this.assetRepository.getByIdsWithAllRelationsButStacks(
      cities.items.map(({ data }) => data),
      auth.user.id,
    );
    const cityItems = cityAssets.map((asset) => ({ value: asset.exifInfo!.city!, data: mapAsset(asset, { auth }) }));

    const recents = await this.assetRepository.getRecentlyCreatedAssetIds(auth.user.id, options.maxFields, scope);
    const recentAssets = await this.assetRepository.getByIdsWithAllRelationsButStacks(
      recents.items.map((item) => item.data),
      auth.user.id,
    );
    const recentItems = recentAssets.map((asset) => ({
      value: asset.createdAt.toISOString(),
      data: mapAsset(asset, { auth }),
    }));

    return [
      { fieldName: cities.fieldName, items: cityItems },
      { fieldName: recents.fieldName, items: recentItems },
    ];
  }

  async searchMetadata(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchMetadataV3(auth, dto);
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    if (dto.isPrivate !== undefined) {
      requirePrivateMode(auth);
    }

    let checksum: Buffer | undefined;
    if (dto.checksum) {
      const encoding = dto.checksum.length === 28 ? 'base64' : 'hex';
      checksum = Buffer.from(dto.checksum, encoding);
    }

    if (!dto.albumIds?.length && auth.sharedLink) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    }

    const userIds = await this.getUserIdsToSearchIn(auth, dto);

    const page = dto.page ?? 1;
    const size = dto.size;
    const { hasNextPage, items } = await this.searchRepository.searchMetadata(
      { page, size },
      {
        ...dto,
        checksum,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
        userIds,
        viewingUserId: auth.user.id,
        privateScope: toPrivateScope(auth),
        orderDirection: dto.order ?? AssetOrder.Desc,
      },
    );

    return this.mapResponse(items, { auth }, { nextPage: hasNextPage ? (page + 1).toString() : null });
  }

  async searchStatistics(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchStatisticsV3(auth, dto);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility, searchedTagIds(dto));
    await this.requireExcludedAlbumAccess(auth, dto);
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    if (dto.isPrivate !== undefined) {
      requirePrivateMode(auth);
    }

    return await this.searchRepository.searchStatistics({
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      viewingUserId: auth.user.id,
      privateScope: toPrivateScope(auth),
    });
  }

  async searchRandom(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    if (isNewShapeRequest(dto)) {
      return this.searchRandomV3(auth, dto);
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    if (dto.isPrivate !== undefined) {
      requirePrivateMode(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility, searchedTagIds(dto));
    await this.requireExcludedAlbumAccess(auth, dto);
    const items = await this.searchRepository.searchRandom(dto.size, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      viewingUserId: auth.user.id,
      privateScope: toPrivateScope(auth),
    });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchLargeAssets(auth: AuthDto, dto: LargeAssetSearchDto): Promise<AssetResponseDto[]> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    if (dto.isPrivate !== undefined) {
      requirePrivateMode(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility, searchedTagIds(dto));
    await this.requireExcludedAlbumAccess(auth, dto);
    const items = await this.searchRepository.searchLargeAssets(dto.size, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      viewingUserId: auth.user.id,
      privateScope: toPrivateScope(auth),
    });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchSmart(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchSmartV3(auth, dto);
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    if (dto.isPrivate !== undefined) {
      requirePrivateMode(auth);
    }

    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    const userIds = this.getUserIdsToSearchIn(auth, dto);
    const embedding = await this.resolveEmbedding(auth, dto, machineLearning);
    const page = dto.page ?? 1;
    const size = dto.size;
    const { hasNextPage, items, frameTimestamps } = await this.searchRepository.searchSmart(
      { page, size },
      {
        ...dto,
        userIds: await userIds,
        viewingUserId: auth.user.id,
        privateScope: toPrivateScope(auth),
        embedding,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      },
    );

    return this.mapResponse(items, { auth }, { nextPage: hasNextPage ? (page + 1).toString() : null }, frameTimestamps);
  }

  async getAssetsByCity(auth: AuthDto): Promise<AssetResponseDto[]> {
    const userIds = await this.getUserIdsToSearch(auth);
    const assets = await this.searchRepository.getAssetsByCity(userIds, toPrivateScope(auth));
    return assets.map((asset) => mapAsset(asset));
  }

  async getSearchSuggestions(auth: AuthDto, dto: SearchSuggestionRequestDto) {
    const userIds = await this.getUserIdsToSearch(auth);
    const suggestions = await this.getSuggestions(userIds, dto, toPrivateScope(auth));
    if (dto.includeNull) {
      suggestions.push(null);
    }
    return suggestions;
  }

  private getSuggestions(
    userIds: string[],
    dto: SearchSuggestionRequestDto,
    scope: PrivateScope,
  ): Promise<Array<string | null>> {
    switch (dto.type) {
      case SearchSuggestionType.COUNTRY: {
        return this.searchRepository.getCountries(userIds, scope);
      }
      case SearchSuggestionType.STATE: {
        return this.searchRepository.getStates(userIds, dto, scope);
      }
      case SearchSuggestionType.CITY: {
        return this.searchRepository.getCities(userIds, dto, scope);
      }
      case SearchSuggestionType.CAMERA_MAKE: {
        return this.searchRepository.getCameraMakes(userIds, dto, scope);
      }
      case SearchSuggestionType.CAMERA_MODEL: {
        return this.searchRepository.getCameraModels(userIds, dto, scope);
      }
      case SearchSuggestionType.CAMERA_LENS_MODEL: {
        return this.searchRepository.getCameraLensModels(userIds, dto, scope);
      }
      default: {
        return Promise.resolve([]);
      }
    }
  }

  private async searchMetadataV3(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);

    const { offset } = decodeSearchCursor(dto.cursor);
    const size = dto.size;
    const { hasNextPage, items } = await this.searchRepository.searchMetadataV3(
      { take: size, skip: offset },
      {
        filter,
        withExif: dto.withExif,
        withPeople: dto.withPeople,
        withStacked: dto.withStacked,
        order: dto.orderBy,
      },
      scope,
    );

    return this.mapResponse(items, { auth }, { nextCursor: hasNextPage ? encodeSearchCursor(offset + size) : null });
  }

  private async searchStatisticsV3(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
    return this.searchRepository.searchStatisticsV3({ filter }, scope);
  }

  private async searchRandomV3(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
    const items = await this.searchRepository.searchRandomV3(
      dto.size,
      {
        filter,
        withExif: dto.withExif,
        withPeople: dto.withPeople,
        withStacked: dto.withStacked,
      },
      scope,
    );
    return items.map((item) => mapAsset(item, { auth }));
  }

  private async searchSmartV3(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    const [{ filter, scope }, embedding] = await Promise.all([
      this.resolveSearchScopeV3(auth, dto),
      this.resolveEmbedding(auth, dto, machineLearning),
    ]);

    // no cursor until a rank-aware pagination strategy for smart search is decided
    const { items, frameTimestamps } = await this.searchRepository.searchSmartV3(
      { take: dto.size },
      { filter, withExif: dto.withExif, embedding },
      scope,
    );

    return this.mapResponse(items, { auth }, {}, frameTimestamps);
  }

  private async resolveSearchScopeV3(
    auth: AuthDto,
    dto: { filter?: SearchFilter },
  ): Promise<{ filter: SearchFilter; scope: AssetSearchScope }> {
    const filter = dto.filter ?? {};
    const effectiveFilter = applyPrivatePolicy(auth, applyLockedVisibilityPolicy(auth, filter));

    const fullyConfined = isFullyAlbumConfined(filter);
    // a shared link visitor does not have a universe, so there every branch must be confined
    if (auth.sharedLink && !fullyConfined) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    }

    await this.requireVisibleTags(auth, collectFilterIds(filter, 'tagIds'));

    const albumIds = collectFilterIds(filter, 'albumIds');
    const [userIds] = await Promise.all([
      // a fully confined filter searches albums only, so the unused universe can skip the partner lookup
      fullyConfined ? [auth.user.id] : this.getUserIdsToSearch(auth),
      albumIds.length > 0 ? this.requireAccess({ auth, ids: albumIds, permission: Permission.AlbumRead }) : undefined,
    ]);

    return {
      filter: effectiveFilter,
      scope: {
        userIds,
        lockedOwnerId: auth.user.id,
        privateOwnerId: isPrivateMode(auth) ? auth.user.id : null,
        viewingUserId: auth.user.id,
        view: getActiveView(auth),
      },
    };
  }

  private async resolveEmbedding(
    auth: AuthDto,
    dto: SmartSearchDto,
    machineLearning: SystemConfig['machineLearning'],
  ): Promise<string> {
    if (dto.query) {
      const key = machineLearning.clip.modelName + dto.query + dto.language;
      let embedding = this.embeddingCache.get(key);
      if (!embedding) {
        embedding = await this.machineLearningRepository.encodeText(dto.query, {
          modelName: machineLearning.clip.modelName,
          language: dto.language,
        });
        this.embeddingCache.set(key, embedding);
      }
      return embedding;
    }

    if (dto.queryAssetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.queryAssetId] });
      const getEmbeddingResponse = await this.searchRepository.getEmbedding(dto.queryAssetId);
      const assetEmbedding = getEmbeddingResponse?.embedding;
      if (!assetEmbedding) {
        throw new BadRequestException(`Asset ${dto.queryAssetId} has no embedding`);
      }
      return assetEmbedding;
    }

    throw new BadRequestException('Either `query` or `queryAssetId` must be set');
  }

  /** a hidden tag does not exist while private mode is locked, so filtering by it is refused like an unknown tag */
  private async requireVisibleTags(auth: AuthDto, tagIds?: string[] | null) {
    if (!tagIds || tagIds.length === 0 || isPrivateMode(auth)) {
      return;
    }

    const owned = await this.accessRepository.tag.checkOwnerAccess(auth.user.id, new Set(tagIds), true);
    const visible = await this.accessRepository.tag.checkOwnerAccess(auth.user.id, owned, false);
    if (visible.size < owned.size) {
      throw new BadRequestException(`Not found or no ${Permission.TagRead} access`);
    }
  }

  /**
   * Whose assets a flat search covers: a search in albums covers everything in them, whoever added it,
   * like the album page does; otherwise the user and their timeline partners. Albums named to search in
   * or to leave out must be readable.
   */
  private async getUserIdsToSearchIn(
    auth: AuthDto,
    dto: Pick<SmartSearchDto, 'albumIds' | 'excludeAlbumIds' | 'visibility' | 'tagIds' | 'excludeTagIds'>,
  ): Promise<string[] | undefined> {
    await this.requireExcludedAlbumAccess(auth, dto);
    if (!dto.albumIds?.length) {
      return this.getUserIdsToSearch(auth, dto.visibility, searchedTagIds(dto));
    }

    await this.requireAccess({ auth, ids: dto.albumIds, permission: Permission.AlbumRead });
    await this.requireVisibleTags(auth, searchedTagIds(dto));
    return undefined;
  }

  private async requireExcludedAlbumAccess(auth: AuthDto, dto: { excludeAlbumIds?: string[] }) {
    if (dto.excludeAlbumIds?.length) {
      await this.requireAccess({ auth, ids: dto.excludeAlbumIds, permission: Permission.AlbumRead });
    }
  }

  private async getUserIdsToSearch(
    auth: AuthDto,
    visibility?: AssetVisibility,
    tagIds?: string[] | null,
  ): Promise<string[]> {
    await this.requireVisibleTags(auth, tagIds);

    // Locked assets are personal. Never include partner IDs, regardless of A's elevated session.
    if (visibility === AssetVisibility.Locked) {
      return [auth.user.id];
    }
    const partnerIds = await getMyPartnerIds({
      userId: auth.user.id,
      repository: this.partnerRepository,
      timelineEnabled: true,
    });
    return [auth.user.id, ...partnerIds];
  }

  /**
   * Search results list assets one by one, stack members included, so each result says which stack it belongs to:
   * clients show the stack badge and act on the whole stack like they do in the timeline.
   */
  private async withStacks(assets: MapAsset[]): Promise<MapAsset[]> {
    const stackIds = [...new Set(assets.map((asset) => asset.stackId).filter((id): id is string => !!id))];
    if (stackIds.length === 0) {
      return assets;
    }

    const summaries = await this.stackRepository.getSummaries(stackIds);
    const stacks = new Map(summaries.map((stack) => [stack.id, stack]));
    return assets.map((asset) => {
      const stack = asset.stackId ? stacks.get(asset.stackId) : undefined;
      return stack ? { ...asset, stack: { ...stack, assetCount: stack.assetCount ?? 0, assets: [] } } : asset;
    });
  }

  /** `frameTimestamps` are the positions of the frames that smart search matched in videos, by asset ID */
  private async mapResponse(
    assets: MapAsset[],
    options: AssetMapOptions,
    page: { nextPage?: string | null; nextCursor?: string | null } = {},
    frameTimestamps?: Map<string, number>,
  ): Promise<SearchResponseDto> {
    const items = await this.withStacks(assets);
    return {
      albums: { total: 0, count: 0, items: [], facets: [] },
      assets: {
        total: assets.length,
        count: assets.length,
        items: items.map((asset) => mapAsset(asset, { ...options, withStack: true })),
        facets: [],
        nextPage: page.nextPage ?? null,
        nextCursor: page.nextCursor ?? null,
        ...(frameTimestamps && {
          matchedFrames: assets.flatMap(({ id }) => {
            const frameTimestamp = frameTimestamps.get(id);
            return frameTimestamp === undefined ? [] : [{ assetId: id, frameTimestamp }];
          }),
        }),
      },
    };
  }
}
