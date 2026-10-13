import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  mapVideoBookmark,
  VideoBookmarkCreateDto,
  VideoBookmarkResponseDto,
  VideoBookmarkSearchDto,
  VideoBookmarkUpdateDto,
} from 'src/dtos/video-bookmark.dto';
import { AssetType, Permission } from 'src/enum';
import { BaseService } from 'src/services/base.service';

@Injectable()
export class VideoBookmarkService extends BaseService {
  async getAll(auth: AuthDto, dto: VideoBookmarkSearchDto): Promise<VideoBookmarkResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.assetId] });
    const bookmarks = await this.videoBookmarkRepository.getByAssetId(dto.assetId, auth.user.id);
    return bookmarks.map((bookmark) => mapVideoBookmark(bookmark));
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
