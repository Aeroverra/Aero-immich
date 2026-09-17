import { Injectable } from '@nestjs/common';
import { OnEvent, OnJob } from 'src/decorators';
import {
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  QueueName,
  StackAutoExclusionReason,
  StackSource,
  StackUserEditAction,
} from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { BaseService } from 'src/services/base.service';
import { JobOf } from 'src/types';
import {
  AutoStackAsset,
  AutoStackOptions,
  groupAutoStackAssets,
  parseEmbedding,
  planAutoStackChanges,
} from 'src/utils/auto-stack';
import { batched, isAutoStackEnabled, isFaceAttributesEnabled, isFacialRecognitionEnabled } from 'src/utils/misc';
import { getPreferences } from 'src/utils/preferences';

/** a neighbour uploaded this recently that is still missing its embedding or faces is waited for */
const PENDING_NEIGHBOUR_MS = 24 * 60 * 60 * 1000;

/** how often the time window around an asset is widened while photos keep following each other closely */
const MAX_WINDOW_EXPANSIONS = 8;

/** most assets grouped in one job; a longer series of similar photos is grouped in parts of this size */
export const MAX_SESSION_ASSETS = 500;

type Candidate = Awaited<ReturnType<BaseService['autoStackRepository']['getCandidates']>>[number];
type TimelineItem = Awaited<ReturnType<BaseService['autoStackRepository']['getTimeline']>>[number];
type JobAsset = NonNullable<Awaited<ReturnType<BaseService['autoStackRepository']['getForAutoStackJob']>>>;

/**
 * An asset of an automatic stack whose face attributes were stored after it was last evaluated. Its neighbours
 * refresh the same session, so after a backfill only the first of them evaluates it again.
 */
const isRefreshNeeded = ({ stackSource, autoStackedAt, qualityUpdatedAt }: JobAsset) =>
  stackSource === StackSource.Auto &&
  (!autoStackedAt || !qualityUpdatedAt || new Date(qualityUpdatedAt).getTime() > new Date(autoStackedAt).getTime());

@Injectable()
export class AutoStackService extends BaseService {
  @OnJob({ name: JobName.AutoStackQueueAll, queue: QueueName.AutoStack })
  async handleQueueAutoStack({ force }: JobOf<JobName.AutoStackQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isAutoStackEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (force) {
      // stacks the user changed are protected by their exclusions, everything else is evaluated again
      await this.autoStackRepository.resetAutoStackedAt();
    }

    for await (const assets of batched(this.autoStackRepository.streamForAutoStack())) {
      await this.jobRepository.queueAll(assets.map(({ id }) => ({ name: JobName.AutoStack, data: { id } })));
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AutoStack, queue: QueueName.AutoStack })
  async handleAutoStack({ id, refresh }: JobOf<JobName.AutoStack>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isAutoStackEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.autoStackRepository.getForAutoStackJob(id);
    if (!asset) {
      this.logger.debug(`Asset ${id} not found, skipping`);
      return JobStatus.Skipped;
    }

    if (asset.autoStackedAt && !(refresh && isRefreshNeeded(asset))) {
      // evaluated together with a neighbour already, after its face attributes were stored
      return JobStatus.Skipped;
    }

    const { autoStack } = getPreferences(await this.userRepository.getMetadata(asset.ownerId));
    if (!autoStack.enabled) {
      return JobStatus.Skipped;
    }

    const isCandidate =
      !asset.deletedAt &&
      asset.type === AssetType.Image &&
      (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive) &&
      !!asset.make &&
      !!asset.model;
    if (!isCandidate) {
      await this.autoStackRepository.setAutoStackedAt([asset.id], new Date());
      return JobStatus.Skipped;
    }

    // taken before anything is read, so attributes stored while the job runs refresh the session again
    const evaluatedAt = new Date();
    const options = machineLearning.autoStack;
    const session = await this.getSession(
      { id: asset.id, ownerId: asset.ownerId, make: asset.make!, model: asset.model!, capturedAt: asset.fileCreatedAt },
      options,
    );
    if (!session) {
      return JobStatus.Skipped;
    }

    const facesEnabled = isFacialRecognitionEnabled(machineLearning);
    const attributesEnabled = isFaceAttributesEnabled(machineLearning);
    /** the embedding and the faces are known, so the asset can be grouped */
    const isReady = (candidate: Candidate) =>
      candidate.type !== AssetType.Image || (!!candidate.embedding && (!facesEnabled || !!candidate.facesRecognizedAt));
    /** the face attributes and image quality for the top pick are known as well */
    const isComplete = (candidate: Candidate) =>
      isReady(candidate) && (candidate.type !== AssetType.Image || !attributesEnabled || !!candidate.hasQuality);

    const now = Date.now();
    const pending = session.filter(
      (candidate) => !isComplete(candidate) && now - new Date(candidate.createdAt).getTime() < PENDING_NEIGHBOUR_MS,
    );
    if (pending.length > 0) {
      // the last neighbour to finish processing evaluates the whole neighbourhood
      this.logger.debug(`Waiting for ${pending.length} neighbours of asset ${id} to be processed`);
      return JobStatus.Skipped;
    }

    const assets: AutoStackAsset[] = session
      // a photo the user took out of a stack is ignored, the photos around it can still form a stack
      .filter((candidate) => !candidate.isExcluded || candidate.stackId)
      .map((candidate) => ({
        id: candidate.id,
        capturedAt: new Date(candidate.fileCreatedAt),
        originalFileName: candidate.originalFileName,
        make: candidate.make,
        model: candidate.model,
        type: candidate.type,
        visibility: candidate.visibility,
        isFavorite: candidate.isFavorite,
        embedding: isReady(candidate) ? parseEmbedding(candidate.embedding) : null,
        faces: candidate.faces,
        sharpness: candidate.sharpness,
        exposureClipped: candidate.exposureClipped,
        isLocked: !!candidate.isExcluded || !!candidate.isInUserStack,
      }));

    const groups = groupAutoStackAssets(assets, options);

    const ownedStackIds = [
      ...new Set(
        session
          .filter((candidate) => !candidate.isExcluded && !candidate.isInUserStack && candidate.stackId)
          .map((candidate) => candidate.stackId!),
      ),
    ];
    const ownedStacks = ownedStackIds.length > 0 ? await this.autoStackRepository.getStacks(ownedStackIds) : [];
    const existing = ownedStacks.map((stack) => ({
      id: stack.id,
      primaryAssetId: stack.primaryAssetId,
      assetIds: stack.assets.map(({ id }) => id),
    }));

    const plan = planAutoStackChanges(groups, existing);

    if (plan.delete.length > 0) {
      await this.stackRepository.deleteAll(plan.delete);

      // members of a replaced stack outside this session are grouped again by their own session
      const sessionIds = new Set(session.map(({ id }) => id));
      const outside = existing
        .filter((stack) => plan.delete.includes(stack.id))
        .flatMap((stack) => stack.assetIds)
        .filter((assetId) => !sessionIds.has(assetId));
      if (outside.length > 0) {
        await this.autoStackRepository.setAutoStackedAt(outside, null);
        await this.jobRepository.queueAll(
          outside.map((assetId) => ({ name: JobName.AutoStack, data: { id: assetId } })),
        );
      }
    }

    for (const { id: stackId, primaryAssetId } of plan.update) {
      await this.autoStackRepository.updatePrimaryAsset(stackId, primaryAssetId);
    }

    const privateIds = new Set(session.filter(({ isPrivate }) => isPrivate).map(({ id }) => id));
    for (const group of plan.create) {
      await this.stackRepository.create({ ownerId: asset.ownerId, source: StackSource.Auto }, group.assetIds, {
        privateMode: true,
        userId: asset.ownerId,
      });

      // a stack is never half private: one private member makes every member private
      if (group.assetIds.some((assetId) => privateIds.has(assetId))) {
        const assetIds = group.assetIds.filter((assetId) => !privateIds.has(assetId));
        if (assetIds.length > 0) {
          await this.assetRepository.updateAll(assetIds, { isPrivate: true });
          await this.eventRepository.emit('AssetPrivateUpdateAll', { assetIds, userId: asset.ownerId });
        }
      }
    }

    await this.autoStackRepository.setAutoStackedAt(
      session.filter((candidate) => isReady(candidate)).map((candidate) => candidate.id),
      evaluatedAt,
    );

    const changes = plan.create.length + plan.delete.length + plan.update.length;
    if (changes > 0) {
      this.logger.debug(
        `Automatic stacks around asset ${id}: ${plan.create.length} created, ${plan.update.length} updated, ${plan.delete.length} removed`,
      );
      this.websocketRepository.clientSend('on_asset_stack_update', asset.ownerId);
    }

    return JobStatus.Success;
  }

  /**
   * The assets of the same owner and camera around an asset that can end up in the same stacks. A photo taken more
   * than the maximum gap after the previous one, or that looks different from it, always starts a new stack, so the
   * series is cut there and every asset between two cuts gets the same session, whichever of them runs the job.
   * The window is widened while no cut is found; a longer series without cuts is grouped in parts.
   */
  private async getSession(
    asset: { id: string; ownerId: string; make: string; model: string; capturedAt: Date },
    options: AutoStackOptions,
  ) {
    const gap = options.maxGapSeconds * 1000;
    const step = Math.max(options.maxSpanSeconds * 1000, gap) + gap;
    const time = new Date(asset.capturedAt).getTime();
    const getTime = (item: TimelineItem) => new Date(item.fileCreatedAt).getTime();

    let from = time - step;
    let to = time + step;
    let timeline: TimelineItem[] = [];
    let index = -1;
    let first = 0;
    let last = 0;

    for (let expansion = 0; expansion <= MAX_WINDOW_EXPANSIONS; expansion++) {
      timeline = await this.autoStackRepository.getTimeline({
        ownerId: asset.ownerId,
        make: asset.make,
        model: asset.model,
        from: new Date(from),
        to: new Date(to),
      });

      index = timeline.findIndex(({ id }) => id === asset.id);
      if (index === -1) {
        return;
      }

      // a missing distance (no embedding yet) is not a cut, so a neighbour that is still processed is waited for
      const isCut = (i: number) =>
        getTime(timeline[i]) - getTime(timeline[i - 1]) > gap || (timeline[i].distance ?? 0) > options.maxDistance;

      first = index;
      while (first > 0 && !isCut(first)) {
        first--;
      }

      last = index;
      while (last < timeline.length - 1 && !isCut(last + 1)) {
        last++;
      }

      const widenStart = first === 0 && getTime(timeline[0]) - from <= gap;
      const widenEnd = last === timeline.length - 1 && to - getTime(timeline[last]) <= gap;
      if (!widenStart && !widenEnd) {
        break;
      }

      const widen = step * 2 ** (expansion + 1);
      if (widenStart) {
        from -= widen;
      }
      if (widenEnd) {
        to += widen;
      }
    }

    if (last - first + 1 > MAX_SESSION_ASSETS) {
      first += Math.floor((index - first) / MAX_SESSION_ASSETS) * MAX_SESSION_ASSETS;
      last = Math.min(last, first + MAX_SESSION_ASSETS - 1);
    }

    const ids = timeline.slice(first, last + 1).map(({ id }) => id);
    return this.autoStackRepository.getCandidates(asset.ownerId, ids);
  }

  /** remember what the user changed by hand so the job never undoes it */
  @OnEvent({ name: 'StackUserEdit' })
  async onStackUserEdit({ userId, stackId, source, action, assetIds }: ArgOf<'StackUserEdit'>) {
    switch (action) {
      case StackUserEditAction.Delete: {
        await this.autoStackRepository.upsertExclusions(
          assetIds.map((assetId) => ({ assetId, ownerId: userId, reason: StackAutoExclusionReason.Unstacked })),
        );
        break;
      }

      case StackUserEditAction.RemoveAssets: {
        await this.autoStackRepository.upsertExclusions(
          assetIds.map((assetId) => ({ assetId, ownerId: userId, reason: StackAutoExclusionReason.Removed })),
        );
        break;
      }

      case StackUserEditAction.UpdatePrimary: {
        if (source !== StackSource.Auto) {
          break;
        }

        const members = await this.autoStackRepository.getStackAssetIds(stackId);
        await this.autoStackRepository.upsertExclusions(
          members.map(({ id: assetId }) => ({ assetId, ownerId: userId, reason: StackAutoExclusionReason.Edited })),
        );
        break;
      }

      case StackUserEditAction.Merge: {
        // the assets moved into a stack the user made, which the job never touches
        break;
      }
    }
  }
}
