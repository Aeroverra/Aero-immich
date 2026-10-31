import { BadRequestException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { OnJob } from 'src/decorators';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  TagAssetCountResponseDto,
  TagAssetCountsDto,
  TagBulkAssetsDto,
  TagBulkAssetsResponseDto,
  TagCreateDto,
  TagResponseDto,
  TagUpdateDto,
  TagUpsertDto,
  mapTag,
} from 'src/dtos/tag.dto';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table';
import { BaseService } from 'src/services/base.service';
import { isPrivateMode } from 'src/utils/access';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { findOrFail } from 'src/utils/misc';
import { upsertTags } from 'src/utils/tag';

@Injectable()
export class TagService extends BaseService {
  async getAll(auth: AuthDto) {
    const tags = await this.tagRepository.getAll(auth.user.id, { withHidden: isPrivateMode(auth) });
    return tags.map((tag) => mapTag(tag));
  }

  /** How many of the assets carry each tag; hidden tags are left out while private mode is locked */
  async getAssetCounts(auth: AuthDto, dto: TagAssetCountsDto): Promise<TagAssetCountResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: dto.assetIds });
    return this.tagRepository.getAssetCounts(auth.user.id, dto.assetIds, { withHidden: isPrivateMode(auth) });
  }

  async get(auth: AuthDto, id: string): Promise<TagResponseDto> {
    await this.requireAccess({ auth, permission: Permission.TagRead, ids: [id] });
    const tag = await this.findOrFail(id);
    return mapTag(tag);
  }

  async create(auth: AuthDto, dto: TagCreateDto) {
    let parent;
    if (dto.parentId) {
      await this.requireAccess({ auth, permission: Permission.TagRead, ids: [dto.parentId] });
      parent = await this.tagRepository.get(dto.parentId);
      if (!parent) {
        throw new BadRequestException('Tag not found');
      }
    }

    const userId = auth.user.id;
    const value = parent ? `${parent.value}/${dto.name}` : dto.name;
    const duplicate = await this.tagRepository.getByValue(userId, value);
    if (duplicate) {
      throw new BadRequestException(`A tag with that name already exists`);
    }

    const { color, isHidden } = dto;
    const tag = await this.tagRepository.create({ userId, value, color, parentId: parent?.id, isHidden });

    return mapTag(tag);
  }

  async update(auth: AuthDto, id: string, dto: TagUpdateDto): Promise<TagResponseDto> {
    await this.requireAccess({ auth, permission: Permission.TagUpdate, ids: [id] });

    const { name, color, isHidden, parentId } = dto;
    const existing = await this.findOrFail(id);

    const parts = existing.value.split('/');
    const leaf = name || parts.at(-1)!;
    const moved = parentId !== undefined && parentId !== existing.parentId;
    const parentValue = moved ? await this.getNewParentValue(auth, id, parentId) : parts.slice(0, -1).join('/');
    const value = parentValue ? `${parentValue}/${leaf}` : leaf;

    if (value !== existing.value) {
      const duplicate = await this.tagRepository.getByValue(auth.user.id, value);
      if (duplicate) {
        throw new BadRequestException('A tag with that name already exists');
      }
    }

    const tag = await this.tagRepository.update(id, { value, color, isHidden, ...(moved && { parentId }) });
    if (value !== existing.value) {
      await this.onTagPathChange(id, { moved });
    }
    return mapTag(tag);
  }

  /** The path of the tag a tag moves under, which must not be the tag itself or one of its children */
  private async getNewParentValue(auth: AuthDto, id: string, parentId: string | null) {
    if (!parentId) {
      return '';
    }

    await this.requireAccess({ auth, permission: Permission.TagRead, ids: [parentId] });
    if (await this.tagRepository.isInSubtree(id, parentId)) {
      throw new BadRequestException('A tag cannot move under itself or one of its children');
    }

    const parent = await this.findOrFail(parentId);
    return parent.value;
  }

  /**
   * A renamed or moved tag changes the tag names written into the assets' metadata, so the stored values and the
   * sidecars follow. A move also changes which views include the assets (a rule on a parent tag covers its children),
   * so they sync again for clients that only receive the default view.
   */
  private async onTagPathChange(tagId: string, { moved }: { moved: boolean }) {
    const assetIds = await this.tagRepository.getSubtreeAssetIds(tagId);
    if (assetIds.length === 0) {
      return;
    }

    await this.tagRepository.refreshAssetTagValues(assetIds);
    await this.jobRepository.queueAll(assetIds.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
    if (moved) {
      await this.customViewRepository.touchAssets(assetIds);
    }
  }

  async upsert(auth: AuthDto, dto: TagUpsertDto) {
    const tags = await upsertTags(this.tagRepository, { userId: auth.user.id, tags: dto.tags });
    return tags.map((tag) => mapTag(tag));
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.TagDelete, ids: [id] });

    // TODO sync tag changes for affected assets

    await this.tagRepository.delete(id);
  }

  async bulkTagAssets(auth: AuthDto, dto: TagBulkAssetsDto): Promise<TagBulkAssetsResponseDto> {
    const [tagIds, assetIds] = await Promise.all([
      this.checkAccess({ auth, permission: Permission.TagAsset, ids: dto.tagIds }),
      this.checkAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds }),
    ]);

    const items: Insertable<TagAssetTable>[] = [];
    for (const tagId of tagIds) {
      for (const assetId of assetIds) {
        items.push({ tagId, assetId });
      }
    }

    const results = await this.tagRepository.upsertAssetIds(items);
    for (const assetId of new Set(results.map((item) => item.assetId))) {
      await this.eventRepository.emit('AssetTag', { assetId, userId: auth.user.id });
    }

    return { count: results.length };
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.TagAsset, ids: [id] });

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.tagRepository },
      { parentId: id, assetIds: dto.ids, permission: Permission.AssetUpdate },
    );

    for (const { id: assetId, success } of results) {
      if (!success) {
        continue;
      }

      await this.eventRepository.emit('AssetTag', { assetId, userId: auth.user.id });
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.TagAsset, ids: [id] });

    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.tagRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.TagDelete },
    );

    for (const { id: assetId, success } of results) {
      if (!success) {
        continue;
      }

      await this.eventRepository.emit('AssetUntag', { assetId });
    }

    return results;
  }

  @OnJob({ name: JobName.TagCleanup, queue: QueueName.BackgroundTask })
  async handleTagCleanup() {
    await this.tagRepository.deleteEmptyTags();
    return JobStatus.Success;
  }

  private findOrFail(id: string) {
    return findOrFail(() => this.tagRepository.get(id), 'Tag');
  }
}
