import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { DateTime, Duration } from 'luxon';
import { Writable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { ViewFilter } from 'src/database';
import { OnJob } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  SyncAckDeleteDto,
  SyncAckSetDto,
  syncAlbumV2ToV1,
  SyncAssetV2,
  SyncItem,
  syncStackV2ToV1,
  SyncStreamDto,
} from 'src/dtos/sync.dto';
import { JobName, QueueName, SyncEntityType, SyncRequestType } from 'src/enum';
import { AlbumViewStateChanges, AlbumViewStateRow, SyncQueryOptions } from 'src/repositories/sync.repository';
import { SessionSyncCheckpointTable } from 'src/schema/tables/sync-checkpoint.table';
import { BaseService } from 'src/services/base.service';
import { SyncAck } from 'src/types';
import { hexOrBufferToBase64 } from 'src/utils/bytes';
import { isViewUnrestricted } from 'src/utils/database';
import { ClientDisconnectedError, waitForDrain } from 'src/utils/response';
import { fromAck, mapJsonLine, serialize, SerializeOptions, toAck } from 'src/utils/sync';

type CheckpointMap = Partial<Record<SyncEntityType, SyncAck>>;
type AssetLike = Omit<SyncAssetV2, 'checksum' | 'thumbhash'> & {
  checksum: Buffer<ArrayBufferLike>;
  thumbhash: Buffer<ArrayBufferLike> | null;
};

const COMPLETE_ID = 'complete';
const MAX_DAYS = 30;
const MAX_DURATION = Duration.fromObject({ days: MAX_DAYS });

const mapSyncAssetV2 = ({ checksum, thumbhash, ...data }: AssetLike): SyncAssetV2 => ({
  ...data,
  checksum: hexOrBufferToBase64(checksum),
  thumbhash: thumbhash ? hexOrBufferToBase64(thumbhash) : null,
});

const isEntityBackfillComplete = (createId: string, checkpoint: SyncAck | undefined): boolean =>
  createId === checkpoint?.updateId && checkpoint.extraId === COMPLETE_ID;

const getStartId = (createId: string, checkpoint: SyncAck | undefined): string | undefined =>
  createId === checkpoint?.updateId ? checkpoint?.extraId : undefined;

/** sync types that read albums; a client limited to the default view brings album_view_state up to date for them */
const ALBUM_SYNC_TYPES = new Set<SyncRequestType>([
  SyncRequestType.AlbumsV1,
  SyncRequestType.AlbumsV2,
  SyncRequestType.AlbumUsersV1,
  SyncRequestType.AlbumAssetsV2,
  SyncRequestType.AlbumAssetExifsV1,
  SyncRequestType.AlbumToAssetsV1,
]);

/** an album row with the cover a client limited to the default view receives, when the album has a view state */
const withViewThumbnail = <T extends { thumbnailAssetId: string | null }>(
  album: T,
  viewStateAlbumId?: string | null,
  viewThumbnailAssetId?: string | null,
): T => (viewStateAlbumId ? { ...album, thumbnailAssetId: viewThumbnailAssetId ?? null } : album);

/**
 * The state an album has under the default view of a user, compared with the state stored for it: a non-empty album
 * whose assets the view all hides is hidden, and a cover the view hides is replaced by the newest asset it shows (as
 * the album endpoints do). Only a real change (hidden or shown, or another cover) sends the album again.
 */
export const toAlbumViewStateChanges = (rows: AlbumViewStateRow[]): AlbumViewStateChanges => {
  const changes: AlbumViewStateChanges = { upserts: [], deletes: [], touched: [], shown: [] };
  for (const row of rows) {
    const isHidden = row.hasAssets && !row.hasVisibleAssets;
    const thumbnailAssetId = isHidden ? null : row.visibleThumbnailAssetId;
    const hasState = !!row.stateAlbumId;
    const wasHidden = hasState && !!row.stateIsHidden;
    const previousThumbnailAssetId = hasState ? row.stateThumbnailAssetId : row.albumThumbnailAssetId;

    if (isHidden || thumbnailAssetId !== row.albumThumbnailAssetId) {
      if (!hasState || wasHidden !== isHidden || row.stateThumbnailAssetId !== thumbnailAssetId) {
        changes.upserts.push({ albumId: row.albumId, isHidden, thumbnailAssetId });
      }
    } else if (hasState) {
      changes.deletes.push(row.albumId);
    }

    if (isHidden !== wasHidden) {
      changes.touched.push(row.albumId);
      if (!isHidden) {
        changes.shown.push(row.albumId);
      }
    } else if (!isHidden && thumbnailAssetId !== previousThumbnailAssetId) {
      changes.touched.push(row.albumId);
    }
  }
  return changes;
};

/** the type and ack of the event written last to a response, and whether it was the ack of withheld rows */
type LastWrite = { type: SyncEntityType; ackType: SyncEntityType; ack: string; withheld: boolean };
const lastWrites = new WeakMap<Writable, LastWrite>();

const write = async <T extends keyof SyncItem, D extends SyncItem[T]>(
  response: Writable,
  item: SerializeOptions<T, D>,
  { withheld = false }: { withheld?: boolean } = {},
) => {
  if (response.destroyed || response.writableEnded) {
    throw new ClientDisconnectedError();
  }

  // The mobile apps handle every run of consecutive events of one type as one batch and acknowledge only its last
  // ack. Two checkpoint events in a row for different streams (a withheld run ending one stream, a skipped row or a
  // backfill marker starting the next) would lose the first ack, and the rows behind it would be scanned and sent
  // again on every sync. SyncAckV1 and SyncCompleteV1 are both no-ops for the apps and carry any ack, so the second
  // one is written with the other type to start its own batch. Only done next to the acks of withheld rows, so the
  // stream of a client that receives everything stays exactly as upstream writes it.
  const ackType = item.ackType ?? item.type;
  const last = lastWrites.get(response);
  let type: SyncEntityType = item.type;
  let lines = '';
  if (last && (withheld || last.withheld) && last.ackType !== ackType && last.type === type) {
    if (type === SyncEntityType.SyncAckV1) {
      type = SyncEntityType.SyncCompleteV1;
    } else if (type === SyncEntityType.SyncCompleteV1) {
      lines += mapJsonLine({ type: SyncEntityType.SyncAckV1, data: {}, ack: last.ack });
    }
  }

  const ack = toAck({ type: ackType, updateId: item.ids[0], extraId: item.ids[1] });
  lines += type === item.type ? serialize(item) : mapJsonLine({ type, data: item.data, ack });
  lastWrites.set(response, { type, ackType, ack, withheld });

  // indicates back pressure, so we wait for 'drain' event
  if (!response.write(lines)) {
    await waitForDrain(response);
  }
};

/** the checkpoint move of the withheld rows written last, not sent yet (see deferWithheldAck) */
type PendingAck = { ackType: SyncEntityType; updateId: string; count: number };
const pendingAcks = new WeakMap<Writable, PendingAck>();

/** a long run of withheld rows still moves the checkpoint now and then, so an interrupted sync keeps its progress */
export const WITHHELD_ACK_INTERVAL = 1000;

const flushWithheldAck = async (response: Writable) => {
  const pending = pendingAcks.get(response);
  if (!pending) {
    return;
  }
  pendingAcks.delete(response);
  await write(
    response,
    { type: SyncEntityType.SyncAckV1, data: {}, ackType: pending.ackType, ids: [pending.updateId] },
    { withheld: true },
  );
};

/**
 * Moves the checkpoint of `ackType` past a withheld row. Consecutive withheld rows share one SyncAckV1: the mobile
 * apps process (and acknowledge over HTTP) every run of events of the same type as one batch, so a delete followed by
 * an ack per row turned a view change over tens of thousands of assets into one database transaction and one ack
 * request per event, and the official app needed hours to drop them.
 */
const deferWithheldAck = async (response: Writable, ackType: SyncEntityType, updateId: string) => {
  const pending = pendingAcks.get(response);
  if (pending && pending.ackType !== ackType) {
    await flushWithheldAck(response);
  }

  const count = pending?.ackType === ackType ? pending.count + 1 : 1;
  pendingAcks.set(response, { ackType, updateId, count });
  if (count >= WITHHELD_ACK_INTERVAL) {
    await flushWithheldAck(response);
  }
};

export const send = async <T extends keyof SyncItem, D extends SyncItem[T]>(
  response: Writable,
  item: SerializeOptions<T, D>,
) => {
  // anything else written ends a run of withheld rows; their ack goes first so checkpoints never move backwards
  await flushWithheldAck(response);
  await write(response, item);
};

const sendEntityBackfillCompleteAck = async (response: Writable, ackType: SyncEntityType, id: string) => {
  await send(response, { type: SyncEntityType.SyncAckV1, data: {}, ackType, ids: [id, COMPLETE_ID] });
};

export const SYNC_TYPES_ORDER = [
  SyncRequestType.AuthUsersV1,
  SyncRequestType.UsersV1,
  SyncRequestType.PartnersV1,
  SyncRequestType.AssetsV1,
  SyncRequestType.AssetsV2,
  SyncRequestType.StacksV1,
  SyncRequestType.StacksV2,
  SyncRequestType.PartnerAssetsV1,
  SyncRequestType.PartnerAssetsV2,
  SyncRequestType.PartnerStacksV1,
  SyncRequestType.PartnerStacksV2,
  SyncRequestType.AlbumAssetsV1,
  SyncRequestType.AlbumAssetsV2,
  SyncRequestType.AlbumsV1,
  SyncRequestType.AlbumsV2,
  SyncRequestType.AlbumUsersV1,
  SyncRequestType.AlbumToAssetsV1,
  SyncRequestType.AssetExifsV1,
  SyncRequestType.AlbumAssetExifsV1,
  SyncRequestType.AssetOcrV1,
  SyncRequestType.PartnerAssetExifsV1,
  SyncRequestType.MemoriesV1,
  SyncRequestType.MemoryToAssetsV1,
  SyncRequestType.PeopleV1,
  SyncRequestType.AssetFacesV1,
  SyncRequestType.AssetFacesV2,
  SyncRequestType.UserMetadataV1,
  SyncRequestType.AssetMetadataV1,
  SyncRequestType.AssetEditsV1,
  SyncRequestType.TagsV1,
  SyncRequestType.TagAssetsV1,
  SyncRequestType.ViewsV1,
  SyncRequestType.ViewTagsV1,
];

const throwSessionRequired = () => {
  throw new ForbiddenException('Sync endpoints cannot be used with API keys');
};

@Injectable()
export class SyncService extends BaseService {
  getAcks(auth: AuthDto) {
    const sessionId = auth.session?.id;
    if (!sessionId) {
      return throwSessionRequired();
    }

    return this.syncCheckpointRepository.getAll(sessionId);
  }

  async setAcks(auth: AuthDto, dto: SyncAckSetDto) {
    const sessionId = auth.session?.id;
    if (!sessionId) {
      return throwSessionRequired();
    }

    const checkpoints: Record<string, Insertable<SessionSyncCheckpointTable>> = {};
    for (const ack of dto.acks) {
      const { type } = fromAck(ack);
      if (type === SyncEntityType.SyncResetV1) {
        await this.sessionRepository.resetSyncProgress(sessionId);
        return;
      }
      // TODO proper ack validation via class validator
      if (!Object.values(SyncEntityType).includes(type)) {
        throw new BadRequestException(`Invalid ack type: ${type}`);
      }

      // TODO pick the latest ack for each type, instead of using the last one
      checkpoints[type] = { sessionId, type, ack };
    }

    await this.syncCheckpointRepository.upsertAll(Object.values(checkpoints));
  }

  async deleteAcks(auth: AuthDto, dto: SyncAckDeleteDto) {
    const sessionId = auth.session?.id;
    if (!sessionId) {
      return throwSessionRequired();
    }

    await this.syncCheckpointRepository.deleteAll(sessionId, dto.types);
  }

  async stream(auth: AuthDto, response: Writable, dto: SyncStreamDto) {
    try {
      await this.streamInternal(auth, response, dto);
    } catch (error) {
      if (error instanceof ClientDisconnectedError) {
        this.logger.debug('Client closed the connection');
        return;
      }

      throw error;
    }
  }

  private async streamInternal(auth: AuthDto, response: Writable, dto: SyncStreamDto) {
    const session = auth.session;
    if (!session) {
      return throwSessionRequired();
    }

    if (dto.reset) {
      await this.sessionRepository.resetSyncProgress(session.id);
    }

    const isPendingSyncReset = await this.sessionRepository.isPendingSyncReset(session.id);
    if (isPendingSyncReset) {
      await send(response, { type: SyncEntityType.SyncResetV1, ids: ['reset'], data: {} });
      response.end();
      return;
    }

    const checkpoints = await this.syncCheckpointRepository.getAll(session.id);
    const checkpointMap: CheckpointMap = Object.fromEntries(checkpoints.map(({ type, ack }) => [type, fromAck(ack)]));

    if (this.needsFullSync(checkpointMap)) {
      await send(response, { type: SyncEntityType.SyncResetV1, ids: ['reset'], data: {} });
      response.end();
      return;
    }

    // a client without the views flag only receives the assets that pass the default view
    const view = dto.includeViews ? null : ((await this.customViewRepository.getDefault(auth.user.id)) ?? null);
    if (!dto.includeViews && dto.types.some((type) => ALBUM_SYNC_TYPES.has(type))) {
      const touched = await this.refreshAlbumViewState(auth.user.id, view);
      if (touched) {
        // nowId leaves out the current millisecond, so the rows touched just now are only part of this run once the
        // clock moved past it
        await setTimeout(2);
      }
    }

    const { nowId } = await this.syncCheckpointRepository.getNow();
    const options: SyncQueryOptions = {
      nowId,
      userId: auth.user.id,
      includePrivate: dto.includePrivate ?? false,
      view,
    };

    const handlers: Record<SyncRequestType, () => Promise<void>> = {
      // deprecated handlers
      [SyncRequestType.AssetsV1]: () => this.syncAssetsV1(),
      [SyncRequestType.AssetFacesV1]: () => this.syncAssetFacesV1(),
      [SyncRequestType.PartnerAssetsV1]: () => this.syncPartnerAssetsV1(),
      [SyncRequestType.AlbumAssetsV1]: () => this.syncAlbumAssetsV1(),

      [SyncRequestType.AuthUsersV1]: () => this.syncAuthUsersV1(options, response, checkpointMap),
      [SyncRequestType.UsersV1]: () => this.syncUsersV1(options, response, checkpointMap),
      [SyncRequestType.PartnersV1]: () => this.syncPartnersV1(options, response, checkpointMap),
      [SyncRequestType.AssetsV2]: () => this.syncAssetsV2(options, response, checkpointMap),
      [SyncRequestType.AssetExifsV1]: () => this.syncAssetExifsV1(options, response, checkpointMap),
      [SyncRequestType.AssetEditsV1]: () => this.syncAssetEditsV1(options, response, checkpointMap),
      [SyncRequestType.PartnerAssetsV2]: () => this.syncPartnerAssetsV2(options, response, checkpointMap, session.id),
      [SyncRequestType.AssetMetadataV1]: () => this.syncAssetMetadataV1(options, response, checkpointMap, auth),
      [SyncRequestType.PartnerAssetExifsV1]: () =>
        this.syncPartnerAssetExifsV1(options, response, checkpointMap, session.id),
      [SyncRequestType.AlbumsV1]: () => this.syncAlbumsV1(options, response, checkpointMap),
      [SyncRequestType.AlbumsV2]: () => this.syncAlbumsV2(options, response, checkpointMap),
      [SyncRequestType.AlbumUsersV1]: () => this.syncAlbumUsersV1(options, response, checkpointMap, session.id),
      [SyncRequestType.AlbumAssetsV2]: () => this.syncAlbumAssetsV2(options, response, checkpointMap, session.id),
      [SyncRequestType.AlbumToAssetsV1]: () => this.syncAlbumToAssetsV1(options, response, checkpointMap, session.id),
      [SyncRequestType.AlbumAssetExifsV1]: () =>
        this.syncAlbumAssetExifsV1(options, response, checkpointMap, session.id),
      [SyncRequestType.MemoriesV1]: () => this.syncMemoriesV1(options, response, checkpointMap),
      [SyncRequestType.MemoryToAssetsV1]: () => this.syncMemoryAssetsV1(options, response, checkpointMap),
      [SyncRequestType.StacksV1]: () => this.syncStacks(options, response, checkpointMap, SyncEntityType.StackV1),
      [SyncRequestType.StacksV2]: () => this.syncStacks(options, response, checkpointMap, SyncEntityType.StackV2),
      [SyncRequestType.PartnerStacksV1]: () =>
        this.syncPartnerStacks(options, response, checkpointMap, session.id, {
          backfillType: SyncEntityType.PartnerStackBackfillV1,
          upsertType: SyncEntityType.PartnerStackV1,
        }),
      [SyncRequestType.PartnerStacksV2]: () =>
        this.syncPartnerStacks(options, response, checkpointMap, session.id, {
          backfillType: SyncEntityType.PartnerStackBackfillV2,
          upsertType: SyncEntityType.PartnerStackV2,
        }),
      [SyncRequestType.PeopleV1]: () => this.syncPeopleV1(options, response, checkpointMap),
      [SyncRequestType.AssetFacesV2]: () => this.syncAssetFacesV2(options, response, checkpointMap),
      [SyncRequestType.UserMetadataV1]: () => this.syncUserMetadataV1(options, response, checkpointMap),
      [SyncRequestType.AssetOcrV1]: () => this.syncAssetOcrV1(options, response, checkpointMap, auth),
      [SyncRequestType.TagsV1]: () => this.syncTagsV1(options, response, checkpointMap),
      [SyncRequestType.TagAssetsV1]: () => this.syncTagAssetsV1(options, response, checkpointMap),
      [SyncRequestType.ViewsV1]: () => this.syncViewsV1(options, response, checkpointMap),
      [SyncRequestType.ViewTagsV1]: () => this.syncViewTagsV1(options, response, checkpointMap),
    } as const;

    for (const type of SYNC_TYPES_ORDER) {
      if (!dto.types.includes(type)) {
        continue;
      }

      const handler = handlers[type as keyof typeof handlers];
      await handler();
    }

    await send(response, { type: SyncEntityType.SyncCompleteV1, ids: [nowId], data: {} });

    response.end();
  }

  @OnJob({ name: JobName.AuditTableCleanup, queue: QueueName.BackgroundTask })
  async onAuditTableCleanup() {
    const pruneThreshold = MAX_DAYS + 1;

    await this.syncRepository.album.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.albumUser.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.albumToAsset.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.asset.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.assetFace.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.assetMetadata.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.assetEdit.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.memory.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.memoryToAsset.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.partner.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.person.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.personGroup.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.stack.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.user.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.userMetadata.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.assetOcr.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.tag.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.tagAsset.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.view.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.viewTag.cleanupAuditTable(pruneThreshold);
  }

  /**
   * Brings album_view_state up to date for a client limited to the default view: an album whose assets the default view
   * all hides is withheld, and a cover it hides is replaced. Only albums that changed since the last run are evaluated,
   * and only albums whose state really changes are sent again, so the album list of the official app does not reorder.
   */
  private async refreshAlbumViewState(userId: string, view: ViewFilter | null): Promise<boolean> {
    const repository = this.syncRepository.albumViewState;
    if (isViewUnrestricted(view)) {
      const rows = await repository.getAll(userId);
      const checkpoint = await repository.getCheckpoint(userId);
      if (rows.length === 0 && !checkpoint) {
        return false;
      }
      const changes = toAlbumViewStateChanges(rows);
      await repository.update(userId, changes, null);
      return changes.touched.length > 0;
    }

    const { updateId: next } = await repository.getNextCheckpoint();
    const checkpoint = await repository.getCheckpoint(userId);
    const albumIds = await repository.getChangedAlbumIds(userId, checkpoint?.updateId);
    const rows = await repository.getStates(userId, view, albumIds);
    const changes = toAlbumViewStateChanges(rows);
    await repository.update(userId, changes, next);
    if (changes.touched.length === 0) {
      return false;
    }

    this.logger.debug(
      `Album view state of ${userId}: ${rows.length} album(s) evaluated, ${changes.touched.length} sent again`,
    );
    return true;
  }

  private needsFullSync(checkpointMap: CheckpointMap) {
    const completeAck = checkpointMap[SyncEntityType.SyncCompleteV1];
    if (!completeAck) {
      return false;
    }

    const milliseconds = Number.parseInt(completeAck.updateId.replaceAll('-', '').slice(0, 12), 16);

    return DateTime.fromMillis(milliseconds) < DateTime.now().minus(MAX_DURATION);
  }

  private async syncAuthUsersV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const upsertType = SyncEntityType.AuthUserV1;
    const upserts = this.syncRepository.authUser.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, profileImagePath, ...data } of upserts) {
      await send(response, {
        type: upsertType,
        ids: [updateId],
        data: { ...data, hasProfileImage: !!profileImagePath },
      });
    }
  }

  private async syncUsersV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.UserDeleteV1;
    const deletes = this.syncRepository.user.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.UserV1;
    const upserts = this.syncRepository.user.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, profileImagePath, ...data } of upserts) {
      await send(response, {
        type: upsertType,
        ids: [updateId],
        data: { ...data, hasProfileImage: !!profileImagePath },
      });
    }
  }

  private async syncPartnersV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.PartnerDeleteV1;
    const deletes = this.syncRepository.partner.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.PartnerV1;
    const upserts = this.syncRepository.partner.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private syncAssetsV1(): Promise<void> {
    throw new BadRequestException('SyncRequestType.AssetsV1 is deprecated, use SyncRequestType.AssetsV2 instead');
  }

  private async syncAssetsV2(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AssetDeleteV1;
    const deletes = this.syncRepository.asset.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AssetV2;
    const upserts = this.syncRepository.asset.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: data.isPrivate, isViewHidden })) {
        await this.withholdPrivate(response, { type: deleteType, data: { assetId: data.id } }, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data: mapSyncAssetV2(data) });
    }
  }

  /**
   * true when the stream should not carry this row: it is private and the client did not opt in, or the client is
   * limited to the default view (no views flag) and the view hides the asset of the row
   */
  private isWithheldPrivate(options: SyncQueryOptions, row: { isPrivate: boolean; isViewHidden?: boolean }) {
    return (!options.includePrivate && row.isPrivate) || !!row.isViewHidden;
  }

  /**
   * Move the checkpoint of an upsert stream past a row that was withheld from the client, so it is not scanned again
   * on the next sync. Nothing is deleted: the client never held the row, or drops it through a cascade.
   */
  private skipPrivate(response: Writable, upsertType: SyncEntityType, updateId: string) {
    return deferWithheldAck(response, upsertType, updateId);
  }

  /**
   * Replace a withheld private row with a delete (so a client that already holds the row drops it) and move the
   * upsert checkpoint past the row. The delete carries the row's updateId, which is time-ordered like the audit ids.
   */
  private async withholdPrivate<T extends keyof SyncItem>(
    response: Writable,
    deletion: { type: T; data: SyncItem[T] },
    upsertType: SyncEntityType,
    updateId: string,
  ) {
    // written without ending the run, so the deletes of consecutive withheld rows reach the client as one batch
    await write(response, { type: deletion.type, ids: [updateId], data: deletion.data });
    await this.skipPrivate(response, upsertType, updateId);
  }

  private syncPartnerAssetsV1(): Promise<void> {
    throw new BadRequestException(
      'SyncRequestType.PartnerAssetsV1 is deprecated, use SyncRequestType.PartnerAssetsV2 instead',
    );
  }

  private async syncPartnerAssetsV2(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const deleteType = SyncEntityType.PartnerAssetDeleteV1;
    const deletes = this.syncRepository.partnerAsset.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const backfillType = SyncEntityType.PartnerAssetBackfillV2;
    const backfillCheckpoint = checkpointMap[backfillType];
    const partners = await this.syncRepository.partner.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const upsertType = SyncEntityType.PartnerAssetV2;
    const upsertCheckpoint = checkpointMap[upsertType];
    if (upsertCheckpoint) {
      const endId = upsertCheckpoint.updateId;

      for (const partner of partners) {
        const createId = partner.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.partnerAsset.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          partner.sharedById,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, {
            type: backfillType,
            ids: [createId, updateId],
            data: mapSyncAssetV2(data),
          });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (partners.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: partners.at(-1)!.createId,
      });
    }

    const upserts = this.syncRepository.partnerAsset.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: data.isPrivate, isViewHidden })) {
        await this.withholdPrivate(response, { type: deleteType, data: { assetId: data.id } }, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data: mapSyncAssetV2(data) });
    }
  }

  private async syncAssetExifsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const upsertType = SyncEntityType.AssetExifV1;
    const upserts = this.syncRepository.assetExif.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncAssetEditsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AssetEditDeleteV1;
    const deletes = this.syncRepository.assetEdit.getDeletes({ ...options, ack: checkpointMap[deleteType] });

    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }
    const upsertType = SyncEntityType.AssetEditV1;
    const upserts = this.syncRepository.assetEdit.getUpserts({ ...options, ack: checkpointMap[upsertType] });

    for await (const { updateId, isAssetPrivate, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: isAssetPrivate, isViewHidden })) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncPartnerAssetExifsV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const backfillType = SyncEntityType.PartnerAssetExifBackfillV1;
    const backfillCheckpoint = checkpointMap[backfillType];
    const partners = await this.syncRepository.partner.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });

    const upsertType = SyncEntityType.PartnerAssetExifV1;
    const upsertCheckpoint = checkpointMap[upsertType];
    if (upsertCheckpoint) {
      const endId = upsertCheckpoint.updateId;

      for (const partner of partners) {
        const createId = partner.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.partnerAssetExif.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          partner.sharedById,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, { type: backfillType, ids: [partner.createId, updateId], data });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, partner.createId);
      }
    } else if (partners.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: partners.at(-1)!.createId,
      });
    }

    const upserts = this.syncRepository.partnerAssetExif.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncAlbumsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AlbumDeleteV1;
    const deletes = this.syncRepository.album.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AlbumV1;
    const upserts = this.syncRepository.album.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isViewHidden, viewStateAlbumId, viewThumbnailAssetId, ...album } of upserts) {
      const data = withViewThumbnail(album, viewStateAlbumId, viewThumbnailAssetId);
      if (this.isWithheldPrivate(options, { isPrivate: data.isPrivate, isViewHidden })) {
        await this.withholdPrivate(response, { type: deleteType, data: { albumId: data.id } }, upsertType, updateId);
        continue;
      }
      const albumUsers = await this.syncRepository.album.getAlbumUsers(data.id);
      await send(response, {
        type: upsertType,
        ids: [updateId],
        // TODO: return null instead of '' in v4
        data: syncAlbumV2ToV1({ ...data, description: data.description ?? '' }, albumUsers),
      });
    }
  }

  private async syncAlbumsV2(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AlbumDeleteV1;
    const deletes = this.syncRepository.album.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AlbumV2;
    const upserts = this.syncRepository.album.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isViewHidden, viewStateAlbumId, viewThumbnailAssetId, ...album } of upserts) {
      const data = withViewThumbnail(album, viewStateAlbumId, viewThumbnailAssetId);
      if (this.isWithheldPrivate(options, { isPrivate: data.isPrivate, isViewHidden })) {
        // the client drops the album and, through its cascade, every link it holds for it
        await this.withholdPrivate(response, { type: deleteType, data: { albumId: data.id } }, upsertType, updateId);
        continue;
      }
      // TODO: return null instead of '' in v4
      await send(response, {
        type: upsertType,
        ids: [updateId],
        data: { ...data, description: data.description ?? '' },
      });
    }
  }

  private async syncAlbumUsersV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const deleteType = SyncEntityType.AlbumUserDeleteV1;
    const deletes = this.syncRepository.albumUser.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const backfillType = SyncEntityType.AlbumUserBackfillV1;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.syncRepository.album.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const upsertType = SyncEntityType.AlbumUserV1;
    const upsertCheckpoint = checkpointMap[upsertType];
    if (upsertCheckpoint) {
      const endId = upsertCheckpoint.updateId;

      for (const album of albums) {
        const createId = album.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.albumUser.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          album.id,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, { type: backfillType, ids: [createId, updateId], data });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (albums.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: albums.at(-1)!.createId,
      });
    }

    const upserts = this.syncRepository.albumUser.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isAlbumPrivate, isAlbumViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: isAlbumPrivate, isViewHidden: isAlbumViewHidden })) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private syncAlbumAssetsV1(): Promise<void> {
    throw new BadRequestException(
      'SyncRequestType.AlbumAssetsV1 is deprecated, use SyncRequestType.AlbumAssetsV2 instead',
    );
  }

  private async syncAlbumAssetsV2(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const backfillType = SyncEntityType.AlbumAssetBackfillV2;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.syncRepository.album.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const updateType = SyncEntityType.AlbumAssetUpdateV2;
    const createType = SyncEntityType.AlbumAssetCreateV2;
    const updateCheckpoint = checkpointMap[updateType];
    const createCheckpoint = checkpointMap[createType];
    if (createCheckpoint) {
      const endId = createCheckpoint.updateId;

      for (const album of albums) {
        const createId = album.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.albumAsset.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          album.id,
          options.userId,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, { type: backfillType, ids: [createId, updateId], data: mapSyncAssetV2(data) });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (albums.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: albums.at(-1)!.createId,
      });
    }

    if (createCheckpoint) {
      const updates = this.syncRepository.albumAsset.getUpdates(
        { ...options, ack: updateCheckpoint },
        createCheckpoint,
      );
      for await (const { updateId, isAlbumPrivate, isViewHidden, isAlbumViewHidden, ...data } of updates) {
        if (this.isWithheldPrivate(options, { isPrivate: data.isPrivate, isViewHidden })) {
          await this.withholdPrivate(
            response,
            { type: SyncEntityType.AssetDeleteV1, data: { assetId: data.id } },
            updateType,
            updateId,
          );
          continue;
        }
        if (this.isWithheldPrivate(options, { isPrivate: isAlbumPrivate, isViewHidden: isAlbumViewHidden })) {
          await this.skipPrivate(response, updateType, updateId);
          continue;
        }
        await send(response, { type: updateType, ids: [updateId], data: mapSyncAssetV2(data) });
      }
    }

    const creates = this.syncRepository.albumAsset.getCreates({ ...options, ack: createCheckpoint });
    let isFirst = true;
    for await (const { updateId, isAlbumPrivate, isViewHidden, isAlbumViewHidden, ...data } of creates) {
      if (isFirst) {
        await send(response, {
          type: SyncEntityType.SyncAckV1,
          data: {},
          ackType: SyncEntityType.AlbumAssetUpdateV2,
          ids: [options.nowId],
        });
        isFirst = false;
      }
      if (
        this.isWithheldPrivate(options, {
          isPrivate: data.isPrivate || isAlbumPrivate,
          isViewHidden: isViewHidden || isAlbumViewHidden,
        })
      ) {
        // never delivered, so nothing to delete; just move the checkpoint past it
        await this.skipPrivate(response, createType, updateId);
        continue;
      }
      await send(response, { type: createType, ids: [updateId], data: mapSyncAssetV2(data) });
    }
  }

  private async syncAlbumAssetExifsV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const backfillType = SyncEntityType.AlbumAssetExifBackfillV1;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.syncRepository.album.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const updateType = SyncEntityType.AlbumAssetExifUpdateV1;
    const createType = SyncEntityType.AlbumAssetExifCreateV1;
    const upsertCheckpoint = checkpointMap[updateType];
    const createCheckpoint = checkpointMap[createType];
    if (createCheckpoint) {
      const endId = createCheckpoint.updateId;

      for (const album of albums) {
        const createId = album.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.albumAssetExif.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          album.id,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, { type: backfillType, ids: [createId, updateId], data });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (albums.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: albums.at(-1)!.createId,
      });
    }

    if (createCheckpoint) {
      const updates = this.syncRepository.albumAssetExif.getUpdates(
        { ...options, ack: upsertCheckpoint },
        createCheckpoint,
      );
      for await (const { updateId, isAlbumPrivate, isAlbumViewHidden, ...data } of updates) {
        if (this.isWithheldPrivate(options, { isPrivate: isAlbumPrivate, isViewHidden: isAlbumViewHidden })) {
          await this.skipPrivate(response, updateType, updateId);
          continue;
        }
        await send(response, { type: updateType, ids: [updateId], data });
      }
    }

    const creates = this.syncRepository.albumAssetExif.getCreates({ ...options, ack: createCheckpoint });
    let isFirst = true;
    for await (const { updateId, isAlbumPrivate, isAlbumViewHidden, ...data } of creates) {
      if (isFirst) {
        await send(response, {
          type: SyncEntityType.SyncAckV1,
          data: {},
          ackType: SyncEntityType.AlbumAssetExifUpdateV1,
          ids: [options.nowId],
        });
        isFirst = false;
      }
      if (this.isWithheldPrivate(options, { isPrivate: isAlbumPrivate, isViewHidden: isAlbumViewHidden })) {
        await this.skipPrivate(response, createType, updateId);
        continue;
      }
      await send(response, { type: createType, ids: [updateId], data });
    }
  }

  private async syncAlbumToAssetsV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const deleteType = SyncEntityType.AlbumToAssetDeleteV1;
    const deletes = this.syncRepository.albumToAsset.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const backfillType = SyncEntityType.AlbumToAssetBackfillV1;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.syncRepository.album.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const upsertType = SyncEntityType.AlbumToAssetV1;
    const upsertCheckpoint = checkpointMap[upsertType];
    if (upsertCheckpoint) {
      const endId = upsertCheckpoint.updateId;

      for (const album of albums) {
        const createId = album.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.albumToAsset.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          album.id,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, { type: backfillType, ids: [createId, updateId], data });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (albums.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: albums.at(-1)!.createId,
      });
    }

    const upserts = this.syncRepository.albumToAsset.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isAlbumPrivate, isViewHidden, isAlbumViewHidden, ...data } of upserts) {
      if (
        this.isWithheldPrivate(options, { isPrivate: isAlbumPrivate, isViewHidden: isViewHidden || isAlbumViewHidden })
      ) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncMemoriesV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.MemoryDeleteV1;
    const deletes = this.syncRepository.memory.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.MemoryV1;
    const upserts = this.syncRepository.memory.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isPrivate, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate })) {
        // a memory holding any private asset is private as a whole; the client drops it and its links
        await this.withholdPrivate(response, { type: deleteType, data: { memoryId: data.id } }, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncMemoryAssetsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.MemoryToAssetDeleteV1;
    const deletes = this.syncRepository.memoryToAsset.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.MemoryToAssetV1;
    const upserts = this.syncRepository.memoryToAsset.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isMemoryPrivate, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: isMemoryPrivate, isViewHidden })) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncStacks(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    upsertType: SyncEntityType.StackV1 | SyncEntityType.StackV2,
  ) {
    const deleteType = SyncEntityType.StackDeleteV1;
    const deletes = this.syncRepository.stack.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upserts = this.syncRepository.stack.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isAssetPrivate, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: isAssetPrivate, isViewHidden })) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      const stack = upsertType === SyncEntityType.StackV1 ? syncStackV2ToV1(data) : data;
      await send(response, { type: upsertType, ids: [updateId], data: stack });
    }
  }

  private async syncPartnerStacks(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
    {
      backfillType,
      upsertType,
    }: {
      backfillType: SyncEntityType.PartnerStackBackfillV1 | SyncEntityType.PartnerStackBackfillV2;
      upsertType: SyncEntityType.PartnerStackV1 | SyncEntityType.PartnerStackV2;
    },
  ) {
    // V1 predates the stack source
    const mapStack = upsertType === SyncEntityType.PartnerStackV1 ? syncStackV2ToV1 : <T>(stack: T) => stack;

    const deleteType = SyncEntityType.PartnerStackDeleteV1;
    const deletes = this.syncRepository.partnerStack.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const backfillCheckpoint = checkpointMap[backfillType];
    const partners = await this.syncRepository.partner.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const upsertCheckpoint = checkpointMap[upsertType];
    if (upsertCheckpoint) {
      const endId = upsertCheckpoint.updateId;

      for (const partner of partners) {
        const createId = partner.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.partnerStack.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          partner.sharedById,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, {
            type: backfillType,
            ids: [createId, updateId],
            data: mapStack(data),
          });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (partners.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: partners.at(-1)!.createId,
      });
    }

    const upserts = this.syncRepository.partnerStack.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isAssetPrivate, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: isAssetPrivate, isViewHidden })) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data: mapStack(data) });
    }
  }

  private async syncPeopleV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.PersonDeleteV1;
    const deletes = this.syncRepository.person.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.PersonV1;
    const upserts = this.syncRepository.person.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isPrivate, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate, isViewHidden })) {
        // every visible face of this person sits on a private asset (or one the default view hides), so the person
        // does not exist for this client
        await this.withholdPrivate(response, { type: deleteType, data: { personId: data.id } }, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private syncAssetFacesV1(): Promise<void> {
    throw new BadRequestException(
      'SyncRequestType.AssetFacesV1 is deprecated, use SyncRequestType.AssetFacesV2 instead',
    );
  }

  private async syncAssetFacesV2(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AssetFaceDeleteV1;
    const deletes = this.syncRepository.assetFace.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AssetFaceV2;
    const upserts = this.syncRepository.assetFace.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isAssetPrivate, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: isAssetPrivate, isViewHidden })) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncUserMetadataV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.UserMetadataDeleteV1;
    const deletes = this.syncRepository.userMetadata.getDeletes({ ...options, ack: checkpointMap[deleteType] });

    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.UserMetadataV1;
    const upserts = this.syncRepository.userMetadata.getUpserts({ ...options, ack: checkpointMap[upsertType] });

    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncAssetMetadataV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    auth: AuthDto,
  ) {
    const deleteType = SyncEntityType.AssetMetadataDeleteV1;
    const deletes = this.syncRepository.assetMetadata.getDeletes(
      { ...options, ack: checkpointMap[deleteType] },
      auth.user.id,
    );

    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AssetMetadataV1;
    const upserts = this.syncRepository.assetMetadata.getUpserts(
      { ...options, ack: checkpointMap[upsertType] },
      auth.user.id,
    );

    for await (const { updateId, isAssetPrivate, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: isAssetPrivate, isViewHidden })) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncAssetOcrV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    auth: AuthDto,
  ) {
    const deleteType = SyncEntityType.AssetOcrDeleteV1;
    const deletes = this.syncRepository.assetOcr.getDeletes(
      { ...options, ack: checkpointMap[deleteType] },
      auth.user.id,
    );

    for await (const row of deletes) {
      await send(response, { type: deleteType, ids: [row.id], data: row });
    }

    const upsertType = SyncEntityType.AssetOcrV1;
    const upserts = this.syncRepository.assetOcr.getUpserts(
      { ...options, ack: checkpointMap[upsertType] },
      auth.user.id,
    );

    for await (const { updateId, isAssetPrivate, isViewHidden, ...data } of upserts) {
      if (this.isWithheldPrivate(options, { isPrivate: isAssetPrivate, isViewHidden })) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncTagsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.TagDeleteV1;
    const deletes = this.syncRepository.tag.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.TagV1;
    const upserts = this.syncRepository.tag.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncTagAssetsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.TagAssetDeleteV1;
    const deletes = this.syncRepository.tagAsset.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.TagAssetV1;
    const upserts = this.syncRepository.tagAsset.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, isAssetPrivate, isViewHidden, ...data } of upserts) {
      // the client never holds the asset, so it never needs the link either
      if (this.isWithheldPrivate(options, { isPrivate: isAssetPrivate, isViewHidden })) {
        await this.skipPrivate(response, upsertType, updateId);
        continue;
      }
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncViewsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.ViewDeleteV1;
    const deletes = this.syncRepository.view.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.ViewV1;
    const upserts = this.syncRepository.view.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncViewTagsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.ViewTagDeleteV1;
    const deletes = this.syncRepository.viewTag.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.ViewTagV1;
    const upserts = this.syncRepository.viewTag.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async upsertBackfillCheckpoint(item: { type: SyncEntityType; sessionId: string; createId: string }) {
    const { type, sessionId, createId } = item;
    await this.syncCheckpointRepository.upsertAll([
      {
        type,
        sessionId,
        ack: toAck({
          type,
          updateId: createId,
          extraId: COMPLETE_ID,
        }),
      },
    ]);
  }
}
