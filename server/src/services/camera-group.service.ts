import { Injectable } from '@nestjs/common';
import { OnEvent, OnJob } from 'src/decorators';
import {
  AssetType,
  AssetVisibility,
  DatabaseLock,
  JobName,
  JobStatus,
  QueueName,
  StackSource,
  StackUserEditAction,
} from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { BaseService } from 'src/services/base.service';
import { JobOf } from 'src/types';
import {
  CameraGroupKind,
  getCameraGroupFile,
  getCameraGroupTagChanges,
  orderCameraGroup,
} from 'src/utils/camera-group';
import { getPreferences } from 'src/utils/preferences';

/** how long a new file waits before its shot is stacked, so the other files uploaded with it are there too */
export const CAMERA_GROUP_DELAY_MS = 5000;

type Candidate = Awaited<ReturnType<BaseService['stackRepository']['getCameraGroupCandidates']>>[number];

/**
 * Stacks the files a camera saved from one shot (Pixel Video Boost and Night Sight videos, Pixel photo sets such as
 * long exposure or RAW, bursts) when one of them is uploaded, wherever the others are in the library. Uploads from
 * the apps, the CLI and imports all end in metadata extraction, so every way a file arrives is covered, including
 * imports that only group files within one folder.
 */
@Injectable()
export class CameraGroupService extends BaseService {
  @OnEvent({ name: 'AssetMetadataExtracted' })
  async onAssetMetadataExtracted({ assetId }: ArgOf<'AssetMetadataExtracted'>) {
    const asset = await this.assetRepository.getById(assetId);
    if (!asset || !getCameraGroupFile(asset.originalFileName)) {
      return;
    }

    await this.jobRepository.queue({
      name: JobName.StackCameraGroup,
      data: { id: assetId, delay: CAMERA_GROUP_DELAY_MS },
    });
  }

  @OnJob({ name: JobName.StackCameraGroup, queue: QueueName.BackgroundTask })
  async handleStackCameraGroup({ id }: JobOf<JobName.StackCameraGroup>): Promise<JobStatus> {
    const asset = await this.assetRepository.getById(id);
    const file = asset ? getCameraGroupFile(asset.originalFileName) : null;
    if (!asset || asset.deletedAt || !file) {
      return JobStatus.Skipped;
    }

    const { cameraGroups } = getPreferences(await this.userRepository.getMetadata(asset.ownerId));
    if (!cameraGroups.enabled) {
      return JobStatus.Skipped;
    }

    // the files of a shot are often uploaded together, so their jobs run one after the other
    return this.databaseRepository.withLock(DatabaseLock.CameraGroupStack, async () => {
      const candidates = await this.stackRepository.getCameraGroupCandidates(asset.ownerId, file.pattern);
      const members = candidates
        .map((candidate) => ({ ...candidate, file: getCameraGroupFile(candidate.originalFileName) }))
        .filter((candidate): candidate is Candidate & { file: NonNullable<typeof file> } => {
          return candidate.file?.key === file.key && candidate.file.kind === file.kind;
        });

      // a file the user took out of a stack stays out; a locked file is never touched
      const included = members.filter(({ isExcluded }) => !isExcluded);
      if (included.some(({ visibility }) => visibility === AssetVisibility.Locked)) {
        return JobStatus.Skipped;
      }
      if (new Set(included.map(({ visibility }) => visibility)).size > 1) {
        this.logger.debug(`Not stacking ${file.key}: its files are not all in the same place (timeline or archive)`);
        return JobStatus.Skipped;
      }

      const ordered = orderCameraGroup(file.kind, included, ({ type }) => type === AssetType.Video);
      if (!ordered) {
        return JobStatus.Skipped;
      }

      const stackIds = new Set(ordered.map(({ stackId }) => stackId).filter((stackId) => stackId !== null));
      const unstacked = ordered.filter(({ stackId }) => !stackId);
      if (unstacked.length === 0 && stackIds.size === 1) {
        return JobStatus.Skipped;
      }

      // files in an automatic stack were grouped by similarity: leave them
      if (ordered.some(({ stackSource }) => stackSource === StackSource.Auto)) {
        this.logger.debug(`Not stacking ${file.key}: its files are in an automatic stack`);
        return JobStatus.Skipped;
      }

      if (stackIds.size > 1) {
        // an import that groups files per folder can leave one shot in several stacks, such as a burst's cover frame
        // on its own; those stacks become one when they hold nothing but files of this shot
        const stacks = await this.stackRepository.getForUserEdit({ stackIds: [...stackIds] });
        const shot = new Set(ordered.map(({ id }) => id));
        if (
          stacks.some(({ source, assets }) => source !== StackSource.Manual || assets.some(({ id }) => !shot.has(id)))
        ) {
          this.logger.debug(`Not stacking ${file.key}: its files are in stacks that hold other files`);
          return JobStatus.Skipped;
        }
        await this.createStack(asset.ownerId, ordered, stacks);
      } else if (stackIds.size === 1) {
        await this.addToStack(asset.ownerId, [...stackIds][0], ordered, unstacked);
      } else {
        await this.createStack(asset.ownerId, ordered);
      }

      if (cameraGroups.copyTags && file.kind !== CameraGroupKind.Burst) {
        await this.syncTags(
          asset.ownerId,
          ordered.map(({ id }) => id),
          cameraGroups,
        );
      }

      this.logger.log(`Stacked ${ordered.length} files of ${file.key}`);
      return JobStatus.Success;
    });
  }

  /** a new stack with the file that belongs on top first; [previous] stacks of the shot are merged into it */
  private async createStack(
    ownerId: string,
    ordered: Candidate[],
    previous: Array<{ id: string; source: StackSource; assets: { id: string }[] }> = [],
  ) {
    const assetIds = ordered.map(({ id }) => id);
    const stack = await this.stackRepository.create({ ownerId, source: StackSource.Manual }, assetIds, {
      privateMode: true,
      userId: ownerId,
    });
    await this.makeStackPrivate(ownerId, ordered);
    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: ownerId });
    for (const { id, source, assets } of previous) {
      await this.eventRepository.emit('StackUserEdit', {
        userId: ownerId,
        stackId: id,
        source,
        action: StackUserEditAction.Merge,
        assetIds: assets.map(({ id }) => id),
        targetStackId: stack.id,
      });
    }
  }

  /** the new files join the stack; the file that belongs on top takes the top when it is one of them */
  private async addToStack(ownerId: string, stackId: string, ordered: Candidate[], unstacked: Candidate[]) {
    await this.assetRepository.updateAll(
      unstacked.map(({ id }) => id),
      { stackId },
    );

    const [primary] = ordered;
    if (unstacked.some(({ id }) => id === primary.id)) {
      await this.stackRepository.update(
        stackId,
        { primaryAssetId: primary.id },
        { privateMode: true, userId: ownerId },
      );
    }

    const stack = await this.stackRepository.getById(stackId, { privateMode: true, userId: ownerId });
    await this.makeStackPrivate(ownerId, stack?.assets ?? ordered);
    await this.eventRepository.emit('StackUpdate', { stackId, userId: ownerId });
  }

  /** a stack is never half private: one private member makes every member private */
  private async makeStackPrivate(ownerId: string, assets: Array<{ id: string; isPrivate: boolean }>) {
    if (assets.every(({ isPrivate }) => !isPrivate)) {
      return;
    }

    const assetIds = assets.filter(({ isPrivate }) => !isPrivate).map(({ id }) => id);
    if (assetIds.length > 0) {
      await this.assetRepository.updateAll(assetIds, { isPrivate: true });
      await this.eventRepository.emit('AssetPrivateUpdateAll', { assetIds, userId: ownerId });
    }
  }

  private async syncTags(
    ownerId: string,
    assetIds: string[],
    { keepTags, reviewTags }: { keepTags: string[]; reviewTags: string[] },
  ) {
    const rows = await this.tagRepository.getAssetTags(assetIds);
    const members = assetIds.map((assetId) => ({
      assetId,
      tags: rows.filter((row) => row.assetId === assetId).map(({ id, value }) => ({ id, value })),
    }));

    const { add, remove } = getCameraGroupTagChanges(members, { keep: keepTags, review: reviewTags });
    await this.tagRepository.upsertAssetIds(add);
    for (const { assetId, tagId } of remove) {
      await this.tagRepository.removeAssetIds(tagId, [assetId]);
    }

    // the tag repository keeps the tags in asset_exif (and their lock) in step, the events write the sidecars
    const tagged = new Set(add.map(({ assetId }) => assetId));
    const untagged = new Set(remove.map(({ assetId }) => assetId));
    for (const assetId of tagged.union(untagged)) {
      await (tagged.has(assetId)
        ? this.eventRepository.emit('AssetTag', { assetId, userId: ownerId })
        : this.eventRepository.emit('AssetUntag', { assetId }));
    }
  }
}
