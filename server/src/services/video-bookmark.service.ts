import { BadRequestException, Injectable } from '@nestjs/common';
import { Selectable } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  mapVideoBookmark,
  VideoBookmarkCreateDto,
  VideoBookmarkResponseDto,
  VideoBookmarkSearchDto,
  VideoBookmarkUpdateDto,
} from 'src/dtos/video-bookmark.dto';
import { AssetType, Permission } from 'src/enum';
import { VideoBookmarkTable } from 'src/schema/tables/video-bookmark.table';
import { BaseService } from 'src/services/base.service';

/** Stacked videos whose lengths differ by at most this much are copies of one video and share their bookmarks */
const SHARED_DURATION_TOLERANCE_MS = 1000;

/** A bookmark of another copy this close to a bookmark already listed marks the same moment and is left out */
const SHARED_DUPLICATE_WINDOW_MS = 500;

type VideoBookmark = Selectable<VideoBookmarkTable>;

const isKnownDuration = (duration: number | null | undefined): duration is number => !!duration && duration > 0;

const byTime = (a: VideoBookmark, b: VideoBookmark) =>
  a.time - b.time || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

const byCreation = (a: VideoBookmark, b: VideoBookmark) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.time - b.time;

/**
 * Every bookmark of the video itself is listed. A bookmark of another copy is left out when a listed bookmark of a
 * different video is within SHARED_DUPLICATE_WINDOW_MS, so a moment bookmarked on two copies shows once: the one on the
 * video itself, else the earliest created.
 */
const withoutSharedDuplicates = (bookmarks: VideoBookmark[], assetId: string) => {
  const kept = bookmarks.filter((bookmark) => bookmark.assetId === assetId);
  const shared = bookmarks.filter((bookmark) => bookmark.assetId !== assetId).sort(byCreation);
  for (const bookmark of shared) {
    const isDuplicate = kept.some(
      (item) => item.assetId !== bookmark.assetId && Math.abs(item.time - bookmark.time) <= SHARED_DUPLICATE_WINDOW_MS,
    );
    if (!isDuplicate) {
      kept.push(bookmark);
    }
  }
  return kept.sort(byTime);
};

@Injectable()
export class VideoBookmarkService extends BaseService {
  /**
   * The bookmarks of the user on the video and on the stacked copies of it (videos in the same stack whose lengths
   * match within a second). Sharing is worked out on every read, so stacking or unstacking needs no change to the data.
   */
  async getAll(auth: AuthDto, dto: VideoBookmarkSearchDto): Promise<VideoBookmarkResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.assetId] });
    const assetIds = await this.getSharingAssetIds(auth, dto.assetId);
    const bookmarks = await this.videoBookmarkRepository.getByAssetIds(assetIds, auth.user.id);
    return withoutSharedDuplicates(bookmarks, dto.assetId).map((bookmark) => mapVideoBookmark(bookmark));
  }

  /** The video and the stacked copies of it the user can view */
  private async getSharingAssetIds(auth: AuthDto, assetId: string): Promise<string[]> {
    const videos = await this.videoBookmarkRepository.getStackVideos(assetId);
    const duration = videos.find((video) => video.id === assetId)?.duration;
    if (!isKnownDuration(duration)) {
      return [assetId];
    }

    const copyIds = videos
      .filter(
        (video) =>
          video.id !== assetId &&
          isKnownDuration(video.duration) &&
          Math.abs(video.duration - duration) <= SHARED_DURATION_TOLERANCE_MS,
      )
      .map((video) => video.id);
    if (copyIds.length === 0) {
      return [assetId];
    }

    // a copy the user cannot view (private mode locked, a stack only partly shared) keeps its bookmarks to itself
    const allowedIds = await this.checkAccess({ auth, permission: Permission.AssetRead, ids: copyIds });
    return [assetId, ...copyIds.filter((id) => allowedIds.has(id))];
  }

  async create(auth: AuthDto, dto: VideoBookmarkCreateDto): Promise<VideoBookmarkResponseDto> {
    // any video the user can view can be bookmarked, the bookmark stays theirs
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.assetId] });
    const asset = await this.assetRepository.getById(dto.assetId);
    if (asset?.type !== AssetType.Video) {
      throw new BadRequestException('Only videos can have bookmarks');
    }

    const bookmark = await this.videoBookmarkRepository.create({
      assetId: dto.assetId,
      userId: auth.user.id,
      time: dto.time,
      label: dto.label ?? '',
    });
    return mapVideoBookmark(bookmark);
  }

  async update(auth: AuthDto, id: string, dto: VideoBookmarkUpdateDto): Promise<VideoBookmarkResponseDto> {
    await this.findOrFail(auth, id, Permission.VideoBookmarkUpdate);
    const bookmark = await this.videoBookmarkRepository.update(id, { time: dto.time, label: dto.label });
    return mapVideoBookmark(bookmark);
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.findOrFail(auth, id, Permission.VideoBookmarkDelete);
    await this.videoBookmarkRepository.delete(id);
  }

  private async findOrFail(auth: AuthDto, id: string, permission: Permission) {
    await this.requireAccess({ auth, permission, ids: [id] });
    const bookmark = await this.videoBookmarkRepository.get(id);
    if (!bookmark) {
      throw new BadRequestException('Bookmark not found');
    }

    // a bookmark on a video the user can no longer view (private mode locked, album left) is out of reach as well
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [bookmark.assetId] });
    return bookmark;
  }
}
