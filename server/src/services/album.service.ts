import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AddUsersDto,
  AlbumAddAssetsDto,
  AlbumResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  AlbumStatisticsResponseDto,
  CreateAlbumDto,
  GetAlbumsDto,
  mapAlbum,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
} from 'src/dtos/album.dto';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { MapMarkerResponseDto } from 'src/dtos/map.dto';
import { AlbumUserRole, Permission } from 'src/enum';
import { AlbumAssetCount, AlbumInfoOptions } from 'src/repositories/album.repository';
import { BaseService } from 'src/services/base.service';
import { isPrivateMode, requirePrivateMode, toPrivateScope } from 'src/utils/access';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { PrivateScope } from 'src/utils/database';
import { asDateTimeString } from 'src/utils/date';
import { findOrFail } from 'src/utils/misc';
import { getPreferences } from 'src/utils/preferences';

// Shared-link viewers see everything the owner put behind the link, private assets included.
const toAlbumScope = (auth: AuthDto): PrivateScope =>
  auth.sharedLink ? { privateMode: true, userId: auth.user.id } : toPrivateScope(auth);

// an album whose contents reach someone other than the owner: other album users or a shared link
const isAlbumShared = (album: { albumUsers: unknown[]; sharedLinks: unknown[] }) =>
  album.albumUsers.length > 1 || album.sharedLinks.length > 0;

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const privateMode = isPrivateMode(auth);
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getAll(auth.user.id, { isOwned: true, privateMode }),
      this.albumRepository.getAll(auth.user.id, { isShared: true, privateMode }),
      this.albumRepository.getAll(auth.user.id, { isOwned: true, isShared: false, privateMode }),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll(auth: AuthDto, { assetId, ...rest }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    const ownerId = auth.user.id;
    await this.albumRepository.updateThumbnails();

    const scope = toAlbumScope(auth);
    const albums = assetId
      ? await this.albumRepository.getByAssetId(ownerId, assetId, scope)
      : await this.albumRepository.getAll(ownerId, { ...rest, privateMode: scope.privateMode });

    if (albums.length === 0) {
      return [];
    }

    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const results = await this.albumRepository.getMetadataForIds(
      albums.map((album) => album.id),
      scope,
    );
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }

    return albums.map((album) => ({
      ...mapAlbum(album),
      sharedLinks: undefined,
      startDate: asDateTimeString(albumMetadata[album.id]?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadata[album.id]?.endDate ?? undefined),
      assetCount: albumMetadata[album.id]?.assetCount ?? 0,
      // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined),
    }));
  }

  async get(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    const scope = toAlbumScope(auth);
    const [albumMetadataForIds] = await this.albumRepository.getMetadataForIds([album.id], scope);

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 1;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    return {
      ...mapAlbum(album),
      startDate: asDateTimeString(albumMetadataForIds?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadataForIds?.endDate ?? undefined),
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined),
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id, scope) : undefined,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      return [];
    }

    return this.mapRepository.getAlbumMapMarkers(id, toAlbumScope(auth));
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = (dto.albumUsers || []).filter(({ userId }) => userId !== auth.user.id);

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        this.logger.debug('Album creation failed: user not found');
        throw new BadRequestException('Invalid user');
      }
    }

    const allowedAssetIdsSet = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: dto.assetIds || [],
    });
    const assetIds = [...allowedAssetIdsSet].map((id) => id);

    // creating a shared album with private assets shares them with the other users
    if (albumUsers.length > 0 && !dto.confirmPrivate && (await this.sharedLinkRepository.hasPrivateAssets(assetIds))) {
      throw new BadRequestException('Album contains private assets, confirmPrivate is required');
    }

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assetIds[0] || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
      },
      assetIds,
      [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
      auth.user.id,
    );

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId, senderName: auth.user.name });
    }

    // the album_asset trigger derives isPrivate after the insert, so re-read the flag
    const created = assetIds.length > 0 ? await this.albumRepository.getById(album.id, { withAssets: false }) : null;

    return mapAlbum({ ...album, isPrivate: created?.isPrivate ?? album.isPrivate });
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: true, scope: toAlbumScope(auth) });

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }
    const updatedAlbum = await this.albumRepository.update(
      album.id,
      {
        id: album.id,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: dto.albumThumbnailAssetId,
        isActivityEnabled: dto.isActivityEnabled,
        order: dto.order,
      },
      auth.user.id,
    );

    return mapAlbum({ ...updatedAlbum, assets: album.assets });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: AlbumAddAssetsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    // adding into a private album makes the new assets private, which needs an unlocked session
    if (album.isPrivate) {
      requirePrivateMode(auth);
    }

    // adding private assets to a shared album shares them with the other users and link viewers
    if (!dto.confirmPrivate && isAlbumShared(album)) {
      const shareable = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.ids });
      if (await this.sharedLinkRepository.hasPrivateAssets([...shareable])) {
        throw new BadRequestException('Album contains private assets, confirmPrivate is required');
      }
    }

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, permission: Permission.AssetShare },
    );

    const { id: firstNewAssetId } = results.find(({ success }) => success) || {};
    if (firstNewAssetId) {
      await this.albumRepository.update(
        id,
        {
          id,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? firstNewAssetId,
        },
        auth.user.id,
      );

      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds });
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    if (allowedAssetIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    // every album is checked before anything is written, so a refused album leaves the others untouched
    let hasPrivateAssets: boolean | undefined;
    const pending: { albumId: string; albumThumbnailAssetId: string; albumUsers: { user: { id: string } }[] }[] = [];
    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds.difference(existingAssetIds)];
      if (notPresentAssetIds.length === 0) {
        continue;
      }
      const album = await this.findOrFail(albumId, auth.user.id, { withAssets: false });
      // adding into a private album makes the new assets private, which needs an unlocked session
      if (album.isPrivate) {
        requirePrivateMode(auth);
      }
      // adding private assets to a shared album shares them with the other users and link viewers
      if (!dto.confirmPrivate && isAlbumShared(album)) {
        hasPrivateAssets ??= await this.sharedLinkRepository.hasPrivateAssets([...allowedAssetIds]);
        if (hasPrivateAssets) {
          throw new BadRequestException('Album contains private assets, confirmPrivate is required');
        }
      }

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumId, assetId });
      }
      pending.push({
        albumId,
        albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
        albumUsers: album.albumUsers,
      });
    }

    const events: { id: string; userIds: string[]; recipientIds: string[] }[] = [];
    for (const { albumId, albumThumbnailAssetId, albumUsers } of pending) {
      results.error = undefined;
      results.success = true;
      await this.albumRepository.update(
        albumId,
        { id: albumId, updatedAt: new Date(), albumThumbnailAssetId },
        auth.user.id,
      );
      const userIds = albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      events.push({ id: albumId, userIds, recipientIds });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    for (const event of events) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });

      const owner = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner);
      if (owner) {
        const { deletedReimport } = getPreferences(await this.userRepository.getMetadata(owner.user.id));
        if (deletedReimport.albumId === id) {
          await this.assetDeletedChecksumRepository.forgetAssets(removedIds);
        }
      }
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers, confirmPrivate }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });

    if (album.isPrivate && !confirmPrivate) {
      throw new BadRequestException('Album contains private assets, confirmPrivate is required');
    }

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }

      const exists = album.albumUsers.some(({ user: { id } }) => id === userId);
      if (exists) {
        continue;
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        this.logger.debug('Adding user to album failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role });
      await this.eventRepository.emit('AlbumInvite', { id, userId, senderName: auth.user.name });
    }

    return mapAlbum(await this.findOrFail(id, auth.user.id, { withAssets: true, scope: toAlbumScope(auth) }));
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      throw new BadRequestException('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new BadRequestException('Cannot remove the last album owner');
    }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, userId, { withAssets: false });
    const owner = album.albumUsers[0];

    if (owner.user.id === userId) {
      throw new BadRequestException('User is owner');
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  private findOrFail(id: string, authUserId: string, options: AlbumInfoOptions) {
    return findOrFail(() => this.albumRepository.getById(id, options, authUserId), 'Album');
  }
}
