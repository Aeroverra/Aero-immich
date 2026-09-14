import { Injectable } from '@nestjs/common';
import { Activity } from 'src/database';
import {
  ActivityCreateDto,
  ActivityDto,
  ActivityResponseDto,
  ActivitySearchDto,
  ActivityStatisticsResponseDto,
  mapActivity,
  MaybeDuplicate,
  ReactionLevel,
  ReactionType,
} from 'src/dtos/activity.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { Permission } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { toPrivateScope } from 'src/utils/access';

@Injectable()
export class ActivityService extends BaseService {
  async getAll(auth: AuthDto, dto: ActivitySearchDto): Promise<ActivityResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [dto.albumId] });
    const activities = await this.activityRepository.search(
      {
        userId: dto.userId,
        albumId: dto.albumId,
        assetId: dto.level === ReactionLevel.ALBUM ? null : dto.assetId,
        isLiked: dto.type && dto.type === ReactionType.LIKE,
      },
      toPrivateScope(auth),
    );

    return activities.map((activity) => mapActivity(activity));
  }

  async getStatistics(auth: AuthDto, dto: ActivityDto): Promise<ActivityStatisticsResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [dto.albumId] });
    return await this.activityRepository.getStatistics(
      { albumId: dto.albumId, assetId: dto.assetId },
      toPrivateScope(auth),
    );
  }

  async create(auth: AuthDto, dto: ActivityCreateDto): Promise<MaybeDuplicate<ActivityResponseDto>> {
    await this.requireAccess({ auth, permission: Permission.ActivityCreate, ids: [dto.albumId] });

    const common = {
      userId: auth.user.id,
      assetId: dto.assetId,
      albumId: dto.albumId,
    };

    let activity: Activity | undefined;
    let isDuplicate = false;

    if (dto.type === ReactionType.LIKE) {
      delete dto.comment;
      // duplicate detection must see the caller's own like even when the asset is private
      [activity] = await this.activityRepository.search(
        {
          ...common,
          // `null` will search for an album like
          assetId: dto.assetId ?? null,
          isLiked: true,
        },
        { privateMode: true, userId: auth.user.id },
      );
      isDuplicate = !!activity;
    }

    if (!activity) {
      activity = await this.activityRepository.create({
        ...common,
        isLiked: dto.type === ReactionType.LIKE,
        comment: dto.comment,
      });
    }

    return { duplicate: isDuplicate, value: mapActivity(activity) };
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.ActivityDelete, ids: [id] });
    await this.activityRepository.delete(id);
  }
}
