import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Insertable, Selectable, Updateable } from 'kysely';
import _ from 'lodash';
import { join } from 'node:path';
import { FACE_THUMBNAIL_SIZE } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { Person } from 'src/database';
import { Chunked, OnJob } from 'src/decorators';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  AssetFaceCreateDto,
  AssetFaceDeleteDto,
  AssetFaceResponseDto,
  AssetFaceUpdateDto,
  FaceDto,
  mapFaces,
  mapPerson,
  MergePersonDto,
  PeopleResponseDto,
  PeopleUpdateDto,
  PersonAssetCountResponseDto,
  PersonAssetCountsDto,
  PersonCreateDto,
  PersonResponseDto,
  PersonSearchDto,
  PersonStatisticsResponseDto,
  PersonThumbnailDto,
  PersonUpdateDto,
} from 'src/dtos/person.dto';
import {
  AssetType,
  AssetVisibility,
  CacheControl,
  ImageFormat,
  JobName,
  JobStatus,
  Permission,
  PersonPathType,
  QueueName,
  SourceType,
  SystemMetadataKey,
  VectorIndex,
} from 'src/enum';
import { BoundingBox } from 'src/repositories/machine-learning.repository';
import { PersonId, UpdateFacesData } from 'src/repositories/person.repository';
import { DB } from 'src/schema/index';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table';
import { FaceSearchTable } from 'src/schema/tables/face-search.table';
import { PersonTable } from 'src/schema/tables/person.table';
import { BaseService } from 'src/services/base.service';
import type { JobItem, JobOf } from 'src/types';
import { getActiveView, isPrivateMode, toPrivateScope } from 'src/utils/access';
import { getDimensions } from 'src/utils/asset.util';
import { isViewUnrestricted } from 'src/utils/database';
import { ImmichFileResponse } from 'src/utils/file';
import { mimeTypes } from 'src/utils/mime-types';
import { batched, findOrFail, isFacialRecognitionEnabled, isVideoFrameAnalysisEnabled } from 'src/utils/misc';
import { getOutputDimensions, Point, transformEditedFaceToOriginal, transformPoints } from 'src/utils/transform';

const personKey = ({ ownerId, personGroupId }: PersonId) => `${ownerId}/${personGroupId}`;

/** stand-in person thumbnails being cut on demand, shared by every request this server handles */
const fallbackCuts = { running: 0, waiting: [] as (() => void)[], inFlight: new Map<string, Promise<boolean>>() };

/**
 * The frame a whole-asset face covers: the oriented original for a photo (the space faces drawn on an edited photo are
 * stored in), the video's own dimensions for a video, and a unit frame when neither is known
 */
const getWholeAssetDimensions = (asset: {
  type: AssetType;
  width: number | null;
  height: number | null;
  exifImageWidth: number | null;
  exifImageHeight: number | null;
  orientation: string | null;
}) => {
  const original = getDimensions(asset);
  if (asset.type === AssetType.Image && original.width && original.height) {
    return original;
  }

  if (asset.width && asset.height) {
    return { width: asset.width, height: asset.height };
  }

  return original.width && original.height ? original : { width: 1, height: 1 };
};

@Injectable()
export class PersonService extends BaseService {
  async getAll(auth: AuthDto, dto: PersonSearchDto): Promise<PeopleResponseDto> {
    const { withHidden = false, closestAssetId, closestPersonId, page, size } = dto;
    let closestFaceAssetId = closestAssetId;
    const pagination = {
      take: size,
      skip: (page - 1) * size,
    };

    if (closestPersonId) {
      const person = await this.personRepository.getByGroupId({
        ownerId: auth.user.id,
        personGroupId: closestPersonId,
      });
      if (!person?.faceAssetId) {
        throw new NotFoundException('Person not found');
      }
      closestFaceAssetId = person.faceAssetId;
    }
    const scope = toPrivateScope(auth);
    const { items, hasNextPage } = await this.personRepository.getAllForUser(pagination, auth.user.id, scope, {
      withHidden,
      closestFaceAssetId,
    });
    const { total, hidden } = await this.personRepository.getNumberOfPeople(auth.user.id, scope);

    return {
      people: items.map((person) => mapPerson(person)),
      hasNextPage,
      total,
      hidden,
    };
  }

  async reassignFaces(auth: AuthDto, personGroupId: string, dto: AssetFaceUpdateDto): Promise<PersonResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.PersonUpdate, ids: [personGroupId] });
    const person = await this.findOrFail(auth, personGroupId);
    const result: PersonResponseDto[] = [];
    const changeFeaturePhoto = new Map<string, PersonId>();
    for (const data of dto.data) {
      const faces = await this.personRepository.getFacesByIds(
        [{ personGroupId: data.personId, assetId: data.assetId }],
        { viewingUserId: auth.user.id },
      );

      for (const face of faces) {
        const ids = await this.checkAccess({ auth, permission: Permission.PersonCreate, ids: [face.id] });

        if (ids.size !== 1) {
          continue;
        }

        if (person.faceAssetId === null) {
          changeFeaturePhoto.set(personKey(person), person);
        }
        if (face.person && face.person.faceAssetId === face.id) {
          changeFeaturePhoto.set(personKey(face.person), face.person);
        }

        await this.personRepository.reassignFace(face.id, person.personGroupId);
      }

      result.push(mapPerson(person));
    }
    if (changeFeaturePhoto.size > 0) {
      await this.createNewFeaturePhoto(changeFeaturePhoto.values().toArray());
    }
    return result;
  }

  async reassignFacesById(auth: AuthDto, personGroupId: string, dto: FaceDto): Promise<PersonResponseDto> {
    await this.requireAccess({ auth, permission: Permission.PersonUpdate, ids: [personGroupId] });
    await this.requireAccess({ auth, permission: Permission.PersonCreate, ids: [dto.id] });
    const face = await this.personRepository.getFaceById(dto.id, { viewingUserId: auth.user.id });
    const person = await this.findOrFail(auth, personGroupId);

    await this.personRepository.reassignFace(face.id, person.personGroupId);
    if (person.faceAssetId === null) {
      await this.createNewFeaturePhoto([person]);
    }
    if (face.person && face.person.faceAssetId === face.id) {
      await this.createNewFeaturePhoto([face.person]);
    }

    return mapPerson(await this.findOrFail(auth, personGroupId));
  }

  async getFacesById(auth: AuthDto, dto: FaceDto): Promise<AssetFaceResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.id] });
    const faces = await this.personRepository.getFaces(dto.id, { viewingUserId: auth.user.id, isVisible: true });
    const asset = await this.assetRepository.getForFaces(dto.id);
    const assetDimensions = getDimensions(asset);

    return faces.map((face) => mapFaces(face, auth, asset.edits, assetDimensions));
  }

  async createNewFeaturePhoto(changeFeaturePhoto: PersonId[]) {
    this.logger.debug(
      `Changing feature photos for ${changeFeaturePhoto.length} ${changeFeaturePhoto.length > 1 ? 'people' : 'person'}`,
    );

    const jobs: JobItem[] = [];
    for (const { ownerId, personGroupId } of changeFeaturePhoto) {
      const assetFace = await this.personRepository.getRandomFace(personGroupId);

      if (assetFace) {
        await this.personRepository.update({ ownerId, personGroupId, faceAssetId: assetFace.id });
        jobs.push({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
      }
    }

    await this.jobRepository.queueAll(jobs);
  }

  async getById(auth: AuthDto, personGroupId: string): Promise<PersonResponseDto> {
    await this.requireAccess({ auth, permission: Permission.PersonRead, ids: [personGroupId] });
    return mapPerson(await this.findOrFail(auth, personGroupId));
  }

  async getStatistics(auth: AuthDto, personGroupId: string): Promise<PersonStatisticsResponseDto> {
    await this.requireAccess({ auth, permission: Permission.PersonRead, ids: [personGroupId] });
    return this.personRepository.getStatistics(personGroupId, auth.user.id, toPrivateScope(auth));
  }

  async getThumbnail(auth: AuthDto, personGroupId: string, dto: PersonThumbnailDto = {}): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.PersonRead, ids: [personGroupId] });
    const ownerId = auth.user.id;
    const person = await this.personRepository.getByGroupId({ ownerId, personGroupId });
    if (!person) {
      throw new NotFoundException();
    }

    // a feature photo cut from a private asset is hidden outside private mode, and one cut from an asset the active
    // view hides is hidden too, so a face crop never shows what the caller may not see
    const view = getActiveView(auth);
    const isCoverHidden =
      (!isPrivateMode(auth) && (await this.personRepository.isCoverAssetPrivate({ ownerId, personGroupId }))) ||
      (!isViewUnrestricted(view) &&
        !(await this.personRepository.isCoverAssetInView({ ownerId, personGroupId }, view)));

    if (person.thumbnailPath && !isCoverHidden) {
      return new ImmichFileResponse({
        path: person.thumbnailPath,
        contentType: mimeTypes.lookup(person.thumbnailPath),
        cacheControl: CacheControl.PrivateWithoutCache,
      });
    }

    // stand-ins vary with private mode and the active view; PrivateWithoutCache makes clients revalidate every time
    const fallbackFolder = StorageCore.getPersonFallbackFolder(person);
    let face;
    // shown next to an asset (its people list): the person's face on that asset, which the caller is looking at; an
    // asset the caller may not read is ignored like any other hidden asset, so the tile still gets a stand-in
    const readableAssetIds =
      isCoverHidden && dto.assetId
        ? await this.checkAccess({ auth, permission: Permission.AssetRead, ids: [dto.assetId] })
        : new Set<string>();
    if (dto.assetId && readableAssetIds.has(dto.assetId)) {
      face = await this.personRepository.getVisibleFaceForThumbnail(
        { ownerId, personGroupId },
        toPrivateScope(auth),
        dto.assetId,
      );
    }
    if (isCoverHidden && !face) {
      face = await this.personRepository.getVisibleFaceForThumbnail({ ownerId, personGroupId }, toPrivateScope(auth));
    }

    if (face) {
      // keyed by the face and its last change, so an edited face box gets a new cut
      const facePrefix = `${face.id}-`;
      const facePath = join(fallbackFolder, `${facePrefix}${new Date(face.updatedAt).getTime()}.jpeg`);
      const isCut = await this.cutFallbackOnce(facePath, async (temporaryPath) => {
        if (!(await this.generateFaceThumbnail(face, temporaryPath))) {
          return false;
        }

        // drop the cuts of earlier versions of this face
        const files = await this.storageRepository.readdir(fallbackFolder);
        const stale = files.filter((file) => file.startsWith(facePrefix) && file.endsWith('.jpeg'));
        await Promise.all(stale.map((file) => this.storageRepository.unlink(join(fallbackFolder, file))));
        return true;
      });

      if (isCut) {
        return new ImmichFileResponse({
          path: facePath,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithoutCache,
        });
      }
    }

    // nothing the caller may see (or no thumbnail yet): a neutral silhouette instead of an error tile
    const placeholderPath = join(fallbackFolder, 'placeholder.jpeg');
    await this.cutFallbackOnce(placeholderPath, async (temporaryPath) => {
      const { image } = await this.getConfig({ withCache: true });
      const size = FACE_THUMBNAIL_SIZE;
      const pixels = Buffer.alloc(size * size * 3);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // a head over the top of two shoulders, light gray on mid gray
          const isHead = (x - size / 2) ** 2 + (y - size * 0.4) ** 2 <= (size * 0.18) ** 2;
          const isShoulders = ((x - size / 2) / (size * 0.34)) ** 2 + ((y - size) / (size * 0.32)) ** 2 <= 1;
          pixels.fill(isHead || isShoulders ? 0xe5 : 0xa3, (y * size + x) * 3, (y * size + x) * 3 + 3);
        }
      }

      this.storageCore.ensureFolders(temporaryPath);
      await this.mediaRepository.generateThumbnail(
        pixels,
        {
          colorspace: image.colorspace,
          format: ImageFormat.Jpeg,
          raw: { width: size, height: size, channels: 3 },
          quality: image.thumbnail.quality,
          progressive: false,
          processInvalidImages: false,
        },
        temporaryPath,
      );
      return true;
    });

    return new ImmichFileResponse({
      path: placeholderPath,
      contentType: 'image/jpeg',
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }

  /**
   * Makes a cached stand-in thumbnail unless it is already on disk. The file is written next to its final path and
   * renamed into place, so a reader never sees half a file; requests for the same file share one cut, and at most
   * two cuts run at once because each decodes a whole original or runs ffmpeg.
   */
  private async cutFallbackOnce(path: string, cut: (temporaryPath: string) => Promise<boolean>): Promise<boolean> {
    if (await this.storageRepository.checkFileExists(path)) {
      return true;
    }

    let running = fallbackCuts.inFlight.get(path);
    if (!running) {
      running = (async () => {
        while (fallbackCuts.running >= 2) {
          await new Promise<void>((resolve) => {
            fallbackCuts.waiting.push(resolve);
          });
        }

        fallbackCuts.running++;
        const temporaryPath = `${path}.${this.cryptoRepository.randomUUID()}.tmp`;
        try {
          if (!(await cut(temporaryPath))) {
            return false;
          }

          await this.storageRepository.rename(temporaryPath, path);
          return true;
        } catch (error: Error | any) {
          this.logger.error(`Unable to cut person thumbnail ${path}: ${error}`, error?.stack);
          await this.storageRepository.unlink(temporaryPath).catch(() => {});
          return false;
        } finally {
          fallbackCuts.running--;
          fallbackCuts.waiting.shift()?.();
          fallbackCuts.inFlight.delete(path);
        }
      })();
      fallbackCuts.inFlight.set(path, running);
    }

    return running;
  }

  async create(auth: AuthDto, dto: PersonCreateDto): Promise<PersonResponseDto> {
    const group = await this.personRepository.createGroup(auth.user.id);
    const person = await this.personRepository.create({
      ownerId: auth.user.id,
      personGroupId: group.id,
      name: dto.name,
      birthDate: dto.birthDate,
      isHidden: dto.isHidden,
      isFavorite: dto.isFavorite,
      color: dto.color,
    });

    return mapPerson(person);
  }

  async update(auth: AuthDto, personGroupId: string, dto: PersonUpdateDto): Promise<PersonResponseDto> {
    await this.requireAccess({ auth, permission: Permission.PersonUpdate, ids: [personGroupId] });

    const { ownerId } = await this.findOrFail(auth, personGroupId);
    const { name, birthDate, isHidden, featureFaceAssetId: assetId, isFavorite, color } = dto;
    // TODO: set by faceId directly
    let faceId: string | undefined;
    if (assetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
      const face = await this.personRepository.getForFeatureFaceUpdate({ personGroupId, assetId });
      if (!face) {
        throw new BadRequestException('Invalid assetId for feature face or asset is offline');
      }

      faceId = face.id;
    }

    const person = await this.personRepository.update({
      ownerId,
      personGroupId,
      faceAssetId: faceId,
      name,
      birthDate,
      isHidden,
      isFavorite,
      color,
    });

    if (assetId) {
      await this.jobRepository.queue({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
    }

    return mapPerson(person);
  }

  delete(auth: AuthDto, id: string): Promise<void> {
    return this.deleteAll(auth, { ids: [id] });
  }

  async updateAll(auth: AuthDto, dto: PeopleUpdateDto): Promise<BulkIdResponseDto[]> {
    const results: BulkIdResponseDto[] = [];
    for (const person of dto.people) {
      try {
        await this.update(auth, person.id, {
          isHidden: person.isHidden,
          name: person.name,
          birthDate: person.birthDate,
          featureFaceAssetId: person.featureFaceAssetId,
          isFavorite: person.isFavorite,
        });
        results.push({ id: person.id, success: true });
      } catch (error: Error | any) {
        this.logger.error(`Unable to update ${person.id} : ${error}`, error?.stack);
        results.push({ id: person.id, success: false, error: BulkIdErrorReason.UNKNOWN });
      }
    }
    return results;
  }

  async deleteAll(auth: AuthDto, { ids }: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.PersonDelete, ids });
    await this.removeAllPersonGroups(ids, auth.user.id);
  }

  @Chunked()
  private async removeAllPersonGroups(groupIds: string[], ownerId?: string) {
    if (groupIds.length === 0) {
      return;
    }

    const people = await this.personRepository.delete(groupIds, ownerId);
    await Promise.all(people.map((person) => this.storageRepository.unlink(person.thumbnailPath)));
    await Promise.all(
      people.map((person) =>
        this.storageRepository.unlinkDir(StorageCore.getPersonFallbackFolder(person), { recursive: true, force: true }),
      ),
    );
    await this.personRepository.deleteEmptyGroups();
    this.logger.debug(`Deleted ${groupIds.length} people`);
  }

  @OnJob({ name: JobName.PersonCleanup, queue: QueueName.BackgroundTask })
  async handlePersonCleanup(): Promise<JobStatus> {
    // each step can leave the next one something to clean up, so the order matters
    const people = await this.personRepository.getAllWithoutFaces();
    await this.removeAllPersonGroups(people.map((person) => person.personGroupId));

    const personGroups = await this.personRepository.deleteEmptyGroups();
    const clusterGroups = await this.personRepository.deleteOrphanedClusterGroups();

    this.logger.debug(`Deleted ${personGroups} empty person groups and ${clusterGroups} orphaned cluster groups`);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDetectFacesQueueAll, queue: QueueName.FaceDetection })
  async handleQueueDetectFaces({ force }: JobOf<JobName.AssetDetectFacesQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (force) {
      await this.personRepository.deleteFaces({ sourceType: SourceType.MachineLearning });
      await this.handlePersonCleanup();
      await this.vacuum('asset_face', 'person', 'face_search');
    }

    for await (const assets of batched(this.assetJobRepository.streamForDetectFacesJob(force))) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetDetectFaces, data: { id: asset.id } })),
      );
    }

    if (force === undefined) {
      await this.jobRepository.queue({ name: JobName.PersonCleanup });
    }

    if (force && isVideoFrameAnalysisEnabled(machineLearning) && machineLearning.videoFrameAnalysis.detectFaces) {
      // removing all machine learning faces also removed the faces found in video frames
      await this.jobRepository.queue({ name: JobName.AssetAnalyzeVideoFramesQueueAll, data: { force: true } });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDetectFaces, queue: QueueName.FaceDetection })
  async handleDetectFaces({ id }: JobOf<JobName.AssetDetectFaces>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForDetectFacesJob(id);
    const previewFile = asset?.previewFile;
    if (!asset || !previewFile) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const { imageHeight, imageWidth, faces } = await this.machineLearningRepository.detectFaces(
      previewFile.path,
      machineLearning.facialRecognition,
    );
    this.logger.debug(`${faces.length} faces detected in ${previewFile.path}`);

    const facesToAdd: (Insertable<AssetFaceTable> & { id: string })[] = [];
    const embeddings: FaceSearchTable[] = [];
    const mlFaceIds = new Set<string>();
    // faces found in other frames of a video are managed by the video frame analysis, never matched or removed here
    const previewFaces = asset.faces.filter((face) => face.frameTimestamp === null);

    for (const face of previewFaces) {
      if (face.sourceType === SourceType.MachineLearning) {
        mlFaceIds.add(face.id);
      }
    }

    // faces are stored relative to the unedited image, so a face found on the edited preview is mapped back first
    const isEditedPreview = previewFile.isEdited && asset.edits.length > 0;
    const original = getDimensions(asset.exifInfo);
    const edited =
      original.width && original.height
        ? getOutputDimensions(asset.edits, original)
        : { width: asset.width ?? imageWidth, height: asset.height ?? imageHeight };

    for (const { boundingBox, embedding } of faces) {
      const box = isEditedPreview
        ? transformEditedFaceToOriginal(boundingBox, asset.edits, {
            source: { width: imageWidth, height: imageHeight },
            edited,
            original,
          })
        : {
            imageWidth,
            imageHeight,
            boundingBoxX1: boundingBox.x1,
            boundingBoxY1: boundingBox.y1,
            boundingBoxX2: boundingBox.x2,
            boundingBoxY2: boundingBox.y2,
          };

      // compare in the space each existing face is stored in
      const match = previewFaces.find((face) => {
        const scaleX = face.imageWidth / (box.imageWidth || 1);
        const scaleY = face.imageHeight / (box.imageHeight || 1);
        const scaledBox = {
          x1: box.boundingBoxX1 * scaleX,
          y1: box.boundingBoxY1 * scaleY,
          x2: box.boundingBoxX2 * scaleX,
          y2: box.boundingBoxY2 * scaleY,
        };
        return this.iou(face, scaledBox) > 0.5;
      });

      if (match && !mlFaceIds.delete(match.id)) {
        embeddings.push({ faceId: match.id, embedding });
      } else if (!match) {
        const faceId = this.cryptoRepository.randomUUID();
        facesToAdd.push({ id: faceId, assetId: asset.id, ...box });
        embeddings.push({ faceId, embedding });
      }
    }
    const faceIdsToRemove = [...mlFaceIds];

    if (facesToAdd.length > 0 || faceIdsToRemove.length > 0 || embeddings.length > 0) {
      await this.personRepository.refreshFaces(facesToAdd, faceIdsToRemove, embeddings);
    }

    if (faceIdsToRemove.length > 0) {
      this.logger.log(`Removed ${faceIdsToRemove.length} faces below detection threshold in asset ${id}`);
    }

    if (facesToAdd.length > 0) {
      this.logger.log(`Detected ${facesToAdd.length} new faces in asset ${id}`);
      const jobs = facesToAdd.map((face) => ({ name: JobName.FacialRecognition, data: { id: face.id } }) as const);
      await this.jobRepository.queueAll([{ name: JobName.FacialRecognitionQueueAll, data: { force: false } }, ...jobs]);
    } else if (embeddings.length > 0) {
      this.logger.log(`Added ${embeddings.length} face embeddings for asset ${id}`);
    }

    await this.assetRepository.upsertJobStatus({ assetId: asset.id, facesRecognizedAt: new Date() });

    return JobStatus.Success;
  }

  private iou(
    face: { boundingBoxX1: number; boundingBoxY1: number; boundingBoxX2: number; boundingBoxY2: number },
    newBox: BoundingBox,
  ): number {
    const x1 = Math.max(face.boundingBoxX1, newBox.x1);
    const y1 = Math.max(face.boundingBoxY1, newBox.y1);
    const x2 = Math.min(face.boundingBoxX2, newBox.x2);
    const y2 = Math.min(face.boundingBoxY2, newBox.y2);

    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const area1 = (face.boundingBoxX2 - face.boundingBoxX1) * (face.boundingBoxY2 - face.boundingBoxY1);
    const area2 = (newBox.x2 - newBox.x1) * (newBox.y2 - newBox.y1);
    const union = area1 + area2 - intersection;

    return intersection / union;
  }

  @OnJob({ name: JobName.FacialRecognitionQueueAll, queue: QueueName.FacialRecognition })
  async handleQueueRecognizeFaces({
    force,
    nightly,
    clusterGroupId,
  }: JobOf<JobName.FacialRecognitionQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    await this.jobRepository.waitForQueueCompletion(QueueName.ThumbnailGeneration, QueueName.FaceDetection);

    if (nightly) {
      const [state, latestFaceDate] = await Promise.all([
        this.systemMetadataRepository.get(SystemMetadataKey.FacialRecognitionState),
        this.personRepository.getLatestFaceDate(),
      ]);

      if (state?.lastRun && latestFaceDate && state.lastRun > latestFaceDate) {
        this.logger.debug('Skipping facial recognition nightly since no face has been added since the last run');
        return JobStatus.Skipped;
      }
    }

    const { waiting } = await this.jobRepository.getJobCounts(QueueName.FacialRecognition);

    if (force) {
      await this.personRepository.unassignFaces({ clusterGroupId, sourceType: SourceType.MachineLearning });
      await this.handlePersonCleanup();
      await this.vacuum('asset_face', 'person');
    } else if (waiting) {
      this.logger.debug(
        `Skipping facial recognition queueing because ${waiting} job${waiting > 1 ? 's are' : ' is'} already queued`,
      );
      return JobStatus.Skipped;
    }

    await this.databaseRepository.prewarm(VectorIndex.Face);

    const lastRun = new Date().toISOString();

    const faces = this.personRepository.getAllFaces(
      force
        ? { clusterGroupId, sourceType: clusterGroupId ? SourceType.MachineLearning : undefined }
        : { personGroupId: null, clusterGroupId, sourceType: SourceType.MachineLearning },
    );
    for await (const batch of batched(faces)) {
      await this.jobRepository.queueAll(
        batch.map((face) => ({ name: JobName.FacialRecognition, data: { id: face.id, deferred: false } })),
      );
    }

    await this.systemMetadataRepository.set(SystemMetadataKey.FacialRecognitionState, { lastRun });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.FacialRecognition, queue: QueueName.FacialRecognition })
  async handleRecognizeFaces({ id, deferred }: JobOf<JobName.FacialRecognition>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const face = await this.personRepository.getFaceForFacialRecognitionJob(id);
    if (!face || !face.asset) {
      this.logger.warn(`Face ${id} not found`);
      return JobStatus.Failed;
    }

    if (face.sourceType !== SourceType.MachineLearning) {
      this.logger.warn(`Skipping face ${id} due to source ${face.sourceType}`);
      return JobStatus.Skipped;
    }

    if (!face.faceSearch?.embedding) {
      this.logger.warn(`Face ${id} does not have an embedding`);
      return JobStatus.Failed;
    }

    if (face.personGroupId) {
      this.logger.debug(`Face ${id} already has a person assigned`);
      return JobStatus.Skipped;
    }

    const { ownerId, clusterGroupId } = face.asset;
    const matches = await this.searchRepository.searchFaces({
      clusterGroupId,
      embedding: face.faceSearch.embedding,
      maxDistance: machineLearning.facialRecognition.maxDistance,
      numResults: machineLearning.facialRecognition.minFaces,
      minBirthDate: new Date(face.asset.fileCreatedAt),
    });

    // `matches` also includes the face itself
    if (machineLearning.facialRecognition.minFaces > 1 && matches.length <= 1) {
      this.logger.debug(`Face ${id} only matched the face itself, skipping`);
      return JobStatus.Skipped;
    }

    this.logger.debug(`Face ${id} has ${matches.length} matches`);

    const isCore =
      matches.length >= machineLearning.facialRecognition.minFaces &&
      face.asset.visibility === AssetVisibility.Timeline;
    if (!isCore && !deferred) {
      this.logger.debug(`Deferring non-core face ${id} for later processing`);
      await this.jobRepository.queue({ name: JobName.FacialRecognition, data: { id, deferred: true } });
      return JobStatus.Skipped;
    }

    let personGroupId = matches.find((match) => match.personGroupId)?.personGroupId;
    if (!personGroupId) {
      const [matchWithPerson] = await this.searchRepository.searchFaces({
        clusterGroupId,
        embedding: face.faceSearch.embedding,
        maxDistance: machineLearning.facialRecognition.maxDistance,
        numResults: 1,
        hasPerson: true,
        minBirthDate: new Date(face.asset.fileCreatedAt),
      });

      personGroupId = matchWithPerson?.personGroupId ?? undefined;
    }

    // faces found only in video frames wait for a matching person unless creating people from them is allowed
    const canCreatePerson = face.frameTimestamp === null || machineLearning.videoFrameAnalysis.createPeople;
    if (!personGroupId && isCore && canCreatePerson) {
      const group = await this.personRepository.createGroup(ownerId);
      personGroupId = group.id;
      this.logger.log(`Created person group ${personGroupId} for face ${id}`);
    }

    if (personGroupId) {
      const person = await this.personRepository.getByGroupId({ ownerId, personGroupId });
      if (person) {
        this.logger.debug(`Face ${id} matched person ${person.personGroupId}`);
      } else {
        await this.personRepository.create({ ownerId, faceAssetId: face.id, personGroupId });
        this.logger.log(`Created person for face ${id} in group ${personGroupId}`);
        await this.jobRepository.queue({
          name: JobName.PersonGenerateThumbnail,
          data: { ownerId, personGroupId },
        });
      }

      this.logger.debug(`Assigning face ${id} to person group ${personGroupId}`);
      await this.personRepository.reassignFaces({ faceIds: [id], newPersonGroupId: personGroupId });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.PersonFileMigration, queue: QueueName.Migration })
  async handlePersonMigration({ ownerId, personGroupId }: JobOf<JobName.PersonFileMigration>): Promise<JobStatus> {
    const person = await this.personRepository.getByGroupId({ ownerId, personGroupId });
    if (!person) {
      return JobStatus.Failed;
    }

    await this.storageCore.movePersonFile(person, PersonPathType.Face);

    return JobStatus.Success;
  }

  async mergePeople(auth: AuthDto, { ids }: MergePersonDto): Promise<BulkIdResponseDto[]> {
    if (ids.length < 2) {
      throw new BadRequestException('At least two people are required for merging');
    }

    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Cannot merge a person into themselves');
    }

    const results: BulkIdResponseDto[] = [];

    const allowedIds = await this.checkAccess({ auth, permission: Permission.PersonMerge, ids });

    const peopleMap: Record<string, Selectable<PersonTable>[]> = {};

    for (const mergePerson of await this.personRepository.getForMergePerson(ids)) {
      if (!peopleMap[mergePerson.personGroupId]) {
        peopleMap[mergePerson.personGroupId] = [];
      }
      peopleMap[mergePerson.personGroupId].push(mergePerson);
    }

    const targetPeople: Record<string, Selectable<PersonTable>> = {};
    for (const mergeId of ids) {
      const hasAccess = allowedIds.has(mergeId);
      if (!hasAccess) {
        results.push({ id: mergeId, success: false, error: BulkIdErrorReason.NO_PERMISSION });
        continue;
      }

      for (const mergePerson of peopleMap[mergeId]) {
        if (!targetPeople[mergePerson.ownerId]) {
          targetPeople[mergePerson.ownerId] = mergePerson;
          continue;
        }

        const targetPerson = targetPeople[mergePerson.ownerId];

        if (
          mergePerson.ownerId !== auth.user.id &&
          ((targetPerson.name && mergePerson.name) || (targetPerson.birthDate && mergePerson.birthDate))
        ) {
          continue;
        }

        const changes: Updateable<Person> = _.omitBy(
          {
            name: mergePerson.name && !targetPerson.name ? mergePerson.name : undefined,
            birthDate: mergePerson.birthDate && !targetPerson.birthDate ? mergePerson.birthDate : undefined,
          },
          _.isUndefined,
        );

        if (Object.keys(changes).length > 0) {
          targetPeople[mergePerson.ownerId] = await this.personRepository.update({
            ownerId: targetPerson.ownerId,
            personGroupId: targetPerson.personGroupId,
            ...changes,
          });
        }

        const mergeName = mergePerson.name || mergePerson.personGroupId;
        const mergeData: UpdateFacesData = {
          oldPersonGroupId: mergeId,
          newPersonGroupId: targetPerson.personGroupId,
          ownerId: targetPerson.ownerId,
        };
        this.logger.log(`Merging ${mergeName} into ${targetPerson.name || targetPerson.personGroupId}`);

        try {
          await this.personRepository.reassignFaces(mergeData);
          await this.personRepository.deleteDuplicateWholeAssetFaces(targetPerson.personGroupId);
          await this.removeAllPersonGroups([mergeId], targetPerson.ownerId);

          this.logger.log(`Merged ${mergeName} into ${targetPerson.name || targetPerson.personGroupId}`);
          results.push({ id: mergeId, success: true });
        } catch (error: any) {
          this.logger.error(`Unable to merge ${mergeId} into ${targetPerson.personGroupId}: ${error}`, error?.stack);
          results.push({ id: mergeId, success: false, error: BulkIdErrorReason.UNKNOWN });
        }
      }
    }

    return results;
  }

  private findOrFail(auth: AuthDto, personGroupId: string) {
    return findOrFail(() => this.personRepository.getByGroupId({ ownerId: auth.user.id, personGroupId }), 'Person');
  }

  // TODO return a asset face response
  async createFace(auth: AuthDto, dto: AssetFaceCreateDto): Promise<void> {
    await Promise.all([
      this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [dto.assetId] }),
      this.requireAccess({ auth, permission: Permission.PersonRead, ids: [dto.personId] }),
    ]);

    const [asset, person] = await Promise.all([
      this.assetRepository.getById(dto.assetId, { edits: true, exifInfo: true }),
      this.findOrFail(auth, dto.personId),
    ]);

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const { frameTimestamp } = dto;
    if (frameTimestamp !== undefined) {
      if (asset.type !== AssetType.Video) {
        throw new BadRequestException('A frame timestamp can only be set for a video');
      }

      if (asset.duration && frameTimestamp > asset.duration) {
        throw new BadRequestException('Frame timestamp is past the end of the video');
      }
    }

    // a frame face is stored in the space of the frame decoded from the original video, like the faces the video
    // frame analysis finds, so edits are not undone for it
    const edits = frameTimestamp === undefined ? asset.edits || [] : [];

    let topLeft: Point = { x: dto.x, y: dto.y };
    let bottomRight: Point = { x: dto.x + dto.width, y: dto.y + dto.height };

    // the coordinates received from the client are based on the edited preview image
    // we need to convert them to the coordinate space of the original unedited image
    if (edits.length > 0) {
      if (!asset.width || !asset.height || !asset.exifInfo?.exifImageWidth || !asset.exifInfo?.exifImageHeight) {
        throw new BadRequestException('Asset does not have valid dimensions');
      }

      // convert from preview to full dimensions
      const scaleFactor = asset.width / dto.imageWidth;
      topLeft = { x: topLeft.x * scaleFactor, y: topLeft.y * scaleFactor };
      bottomRight = { x: bottomRight.x * scaleFactor, y: bottomRight.y * scaleFactor };

      const [invertedTopLeft, invertedBottomRight] = transformPoints(
        [topLeft, bottomRight],
        edits,
        { width: asset.width, height: asset.height },
        { inverse: true },
      ).points;

      // make sure topLeft is top-left and bottomRight is bottom-right
      topLeft = {
        x: Math.min(invertedTopLeft.x, invertedBottomRight.x),
        y: Math.min(invertedTopLeft.y, invertedBottomRight.y),
      };
      bottomRight = {
        x: Math.max(invertedTopLeft.x, invertedBottomRight.x),
        y: Math.max(invertedTopLeft.y, invertedBottomRight.y),
      };

      // now coordinates are in original image space
      const originalDimensions = getDimensions(asset.exifInfo);
      dto.imageWidth = originalDimensions.width;
      dto.imageHeight = originalDimensions.height;
    }

    const face = {
      personGroupId: person.personGroupId,
      assetId: dto.assetId,
      imageHeight: dto.imageHeight,
      imageWidth: dto.imageWidth,
      boundingBoxX1: Math.round(topLeft.x),
      boundingBoxX2: Math.round(bottomRight.x),
      boundingBoxY1: Math.round(topLeft.y),
      boundingBoxY2: Math.round(bottomRight.y),
      sourceType: SourceType.Manual,
      frameTimestamp,
    };

    if (dto.embedding) {
      // with an embedding, other faces of the person can be recognized by this one
      const faceId = this.cryptoRepository.randomUUID();
      await this.personRepository.refreshFaces(
        [{ id: faceId, ...face }],
        [],
        [{ faceId, embedding: JSON.stringify(dto.embedding) }],
      );
    } else {
      await this.personRepository.createAssetFace(face);
    }

    if (!person.faceAssetId) {
      await this.createNewFeaturePhoto([person]);
    }
  }

  /**
   * Marks assets as having a person in them without a location in the picture: close-ups, backs of heads and videos,
   * which have no face box to draw. Each asset gets a manual face covering the whole asset, flagged as a whole-asset
   * mark, unless the person is already on it in any way (a detected face, a drawn box or an earlier mark).
   */
  async addToAssets(auth: AuthDto, personGroupId: string, { ids }: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.PersonUpdate, ids: [personGroupId] });
    const person = await this.findOrFail(auth, personGroupId);

    const allowedIds = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids });
    const found = await this.personRepository.getAssetsForWholeAssetFaces([...allowedIds]);
    const assets = new Map(found.map((asset) => [asset.id, asset]));
    const faces = await this.personRepository.getFacesByIds(
      [...allowedIds].map((assetId) => ({ assetId, personGroupId })),
      { viewingUserId: auth.user.id },
    );
    const present = new Set(faces.map(({ assetId }) => assetId));

    const results: BulkIdResponseDto[] = [];
    const newFaces: Insertable<AssetFaceTable>[] = [];
    for (const id of ids) {
      if (!allowedIds.has(id)) {
        results.push({ id, success: false, error: BulkIdErrorReason.NO_PERMISSION });
        continue;
      }

      const asset = assets.get(id);
      if (!asset) {
        results.push({ id, success: false, error: BulkIdErrorReason.NOT_FOUND });
        continue;
      }

      if (asset.type !== AssetType.Image && asset.type !== AssetType.Video) {
        results.push({ id, success: false, error: BulkIdErrorReason.VALIDATION });
        continue;
      }

      if (present.has(id)) {
        results.push({ id, success: false, error: BulkIdErrorReason.DUPLICATE });
        continue;
      }

      const { width, height } = getWholeAssetDimensions(asset);
      newFaces.push({
        assetId: id,
        personGroupId: person.personGroupId,
        imageWidth: width,
        imageHeight: height,
        boundingBoxX1: 0,
        boundingBoxY1: 0,
        boundingBoxX2: width,
        boundingBoxY2: height,
        sourceType: SourceType.Manual,
        isWholeAsset: true,
      });
      present.add(id);
      results.push({ id, success: true });
    }

    await this.personRepository.createAssetFaces(newFaces);

    if (newFaces.length > 0 && !person.faceAssetId) {
      await this.createNewFeaturePhoto([person]);
    }

    return results;
  }

  /**
   * Takes a person off assets by removing their whole-asset marks. A face of the person that is located in the picture
   * (detected, or drawn in the face editor) stays: that asset is reported as a validation error, and the person has to
   * be taken off that face in the face editor. An asset without the person is reported as not found.
   */
  async removeFromAssets(auth: AuthDto, personGroupId: string, { ids }: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.PersonUpdate, ids: [personGroupId] });
    const person = await this.findOrFail(auth, personGroupId);

    const allowedIds = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids });
    const faces = await this.personRepository.getFacesByIds(
      [...allowedIds].map((assetId) => ({ assetId, personGroupId })),
      { viewingUserId: auth.user.id },
    );
    const facesByAsset = Map.groupBy(faces, ({ assetId }) => assetId);

    const results: BulkIdResponseDto[] = [];
    const markIds: string[] = [];
    const handled = new Set<string>();
    for (const id of ids) {
      if (!allowedIds.has(id)) {
        results.push({ id, success: false, error: BulkIdErrorReason.NO_PERMISSION });
        continue;
      }

      const assetFaces = handled.has(id) ? [] : (facesByAsset.get(id) ?? []);
      handled.add(id);
      if (assetFaces.length === 0) {
        results.push({ id, success: false, error: BulkIdErrorReason.NOT_FOUND });
        continue;
      }

      markIds.push(...assetFaces.filter(({ isWholeAsset }) => isWholeAsset).map((face) => face.id));
      const located = assetFaces.some(({ isWholeAsset }) => !isWholeAsset);
      results.push(located ? { id, success: false, error: BulkIdErrorReason.VALIDATION } : { id, success: true });
    }

    await this.personRepository.deleteAssetFaces(markIds);

    if (person.faceAssetId && markIds.includes(person.faceAssetId)) {
      await this.createNewFeaturePhoto([person]);
    }

    return results;
  }

  async getAssetCounts(auth: AuthDto, { assetIds }: PersonAssetCountsDto): Promise<PersonAssetCountResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: assetIds });
    const counts = await this.personRepository.getAssetCounts(auth.user.id, assetIds);
    return counts.map(({ personGroupId, count, removableCount }) => ({
      personId: personGroupId,
      count,
      removableCount,
    }));
  }

  async deleteFace(auth: AuthDto, id: string, dto: AssetFaceDeleteDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.FaceDelete, ids: [id] });

    return dto.force ? this.personRepository.deleteAssetFace(id) : this.personRepository.softDeleteAssetFaces(id);
  }

  private vacuum(...tables: (keyof DB)[]): Promise<unknown> {
    return Promise.all(
      tables.map((table) =>
        this.databaseRepository
          .vacuum({ analyze: true, table })
          .then(() => this.databaseRepository.reindex(table, { concurrently: true })),
      ),
    );
  }
}
