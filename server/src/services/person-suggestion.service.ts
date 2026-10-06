import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Insertable, Selectable } from 'kysely';
import { FACE_THUMBNAIL_SIZE } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { OnJob } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetEditAction } from 'src/dtos/editing.dto';
import {
  PersonSuggestionAnswerDto,
  PersonSuggestionAnswersSearchDto,
  PersonSuggestionCreateDto,
  PersonSuggestionFaceDto,
  PersonSuggestionResponseDto,
  PersonSuggestionSearchDto,
  PersonSuggestionsResponseDto,
  PersonSuggestionStatisticsResponseDto,
} from 'src/dtos/person-suggestion.dto';
import { mapPerson } from 'src/dtos/person.dto';
import {
  AssetType,
  ImageFormat,
  JobName,
  JobStatus,
  Permission,
  PersonSuggestionKind,
  PersonSuggestionSource,
  PersonSuggestionStatus,
  QueueName,
} from 'src/enum';
import { SuggestionCandidate, SuggestionPair } from 'src/repositories/person-suggestion.repository';
import { PersonSuggestionTable, PersonSuggestionUndo } from 'src/schema/tables/person-suggestion.table';
import { BaseService } from 'src/services/base.service';
import { getFaceCrop } from 'src/services/media.service';
import type { JobOf } from 'src/types';
import { toPrivateScope } from 'src/utils/access';
import { asDateString } from 'src/utils/date';
import { VideoFrameConfig } from 'src/utils/media';
import { isPersonSuggestionsEnabled } from 'src/utils/misc';
import {
  getFaceMatchScore,
  getSuggestionPriority,
  getSuggestionScore,
  NeighborFace,
  PERSON_SUGGESTION,
  pickTargets,
} from 'src/utils/person-suggestion';

type Suggestion = Selectable<PersonSuggestionTable>;

type ScoredPair = {
  kind: PersonSuggestionKind;
  personGroupId?: string;
  faceId?: string;
  targetPersonGroupId: string;
  centroid: number;
  faceMatch: number;
  score: number;
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * When the questions were last worked out for everyone. Facial recognition queues the work every time its queue
 * drains, which during an import is every few minutes; the work is redone at most once an hour then.
 */
const lastQueueAll = { at: 0 };
const QUEUE_ALL_INTERVAL = 60 * 60 * 1000;

/** The same key for a pair whichever way round two people were compared */
const getPairKey = (pair: { personGroupId?: string | null; faceId?: string | null; targetPersonGroupId: string }) => {
  if (pair.faceId) {
    return `face:${pair.faceId}:${pair.targetPersonGroupId}`;
  }

  if (pair.personGroupId) {
    const [first, second] = [pair.personGroupId, pair.targetPersonGroupId].toSorted();
    return `person:${first}:${second}`;
  }

  return null;
};

const toPair = ({ personGroupId, faceId, targetPersonGroupId }: ScoredPair): SuggestionPair =>
  faceId ? { faceId, targetPersonGroupId } : { personGroupId: personGroupId!, targetPersonGroupId };

const mapFace = (face: { id: string; assetId: string; updatedAt: Date | string; fileCreatedAt: Date | string }) =>
  ({
    id: face.id,
    assetId: face.assetId,
    takenAt: new Date(face.fileCreatedAt).toISOString(),
    updatedAt: new Date(face.updatedAt).toISOString(),
  }) satisfies PersonSuggestionFaceDto;

@Injectable()
export class PersonSuggestionService extends BaseService {
  async getAll(auth: AuthDto, { page, size }: PersonSuggestionSearchDto): Promise<PersonSuggestionsResponseDto> {
    const scope = toPrivateScope(auth);
    const [suggestions, total] = await Promise.all([
      this.personSuggestionRepository.getPending(scope, { take: size + 1, skip: (page - 1) * size }),
      this.personSuggestionRepository.getPendingCount(scope),
    ]);

    return {
      total,
      hasNextPage: suggestions.length > size,
      suggestions: await Promise.all(
        suggestions.slice(0, size).map((suggestion) => this.mapSuggestion(auth, suggestion)),
      ),
    };
  }

  async getStatistics(auth: AuthDto): Promise<PersonSuggestionStatisticsResponseDto> {
    return { pending: await this.personSuggestionRepository.getPendingCount(toPrivateScope(auth)) };
  }

  async getAnswers(auth: AuthDto, { size }: PersonSuggestionAnswersSearchDto): Promise<PersonSuggestionResponseDto[]> {
    const suggestions = await this.personSuggestionRepository.getAnswered(auth.user.id, size);
    return Promise.all(suggestions.map((suggestion) => this.mapSuggestion(auth, suggestion, 4)));
  }

  async create(auth: AuthDto, dto: PersonSuggestionCreateDto): Promise<PersonSuggestionResponseDto> {
    const ownerId = auth.user.id;
    await this.requireAccess({ auth, permission: Permission.PersonRead, ids: [dto.targetPersonId] });
    let target = await this.personRepository.getByGroupId({ ownerId, personGroupId: dto.targetPersonId });
    if (!target) {
      throw new BadRequestException('Person not found');
    }

    let pair: SuggestionPair;
    if (dto.personId) {
      if (dto.personId === dto.targetPersonId) {
        throw new BadRequestException('A person cannot be compared with itself');
      }

      await this.requireAccess({ auth, permission: Permission.PersonRead, ids: [dto.personId] });
      let candidate = await this.personRepository.getByGroupId({ ownerId, personGroupId: dto.personId });
      if (!candidate) {
        throw new BadRequestException('Person not found');
      }

      if (candidate.name && target.name) {
        throw new BadRequestException('Both people already have a name');
      }

      // the one without a name is the one the question is about
      if (candidate.name) {
        [candidate, target] = [target, candidate];
      }

      pair = { personGroupId: candidate.personGroupId, targetPersonGroupId: target.personGroupId };
    } else {
      const faceId = dto.faceId!;
      await this.requireAccess({ auth, permission: Permission.PersonReassign, ids: [faceId] });
      const face = await this.personRepository.getFaceById(faceId, { viewingUserId: ownerId });
      if (face.personGroupId === target.personGroupId) {
        throw new BadRequestException('The face already belongs to the person');
      }

      pair = { faceId, targetPersonGroupId: target.personGroupId };
    }

    const existing = await this.personSuggestionRepository.getByPair(ownerId, pair);
    if (existing) {
      return this.mapSuggestion(auth, existing);
    }

    const kind = target.name ? PersonSuggestionKind.Named : PersonSuggestionKind.Unnamed;
    const score = dto.score ?? 0.5;
    const [statistics] = await this.personSuggestionRepository.getCandidateStatistics(
      ownerId,
      pair.personGroupId ? [pair.personGroupId] : [],
      pair.faceId ? [pair.faceId] : [],
    );
    const suggestion = await this.personSuggestionRepository.create({
      ownerId,
      kind,
      source: PersonSuggestionSource.Api,
      ...pair,
      score,
      priority: getSuggestionPriority({
        kind,
        score,
        assets: statistics?.assets ?? 1,
        days: statistics?.days ?? 1,
        latest: statistics?.latest ?? null,
      }),
    });

    return this.mapSuggestion(auth, suggestion);
  }

  async refresh(auth: AuthDto): Promise<void> {
    await this.jobRepository.queue({ name: JobName.PersonSuggestions, data: { userId: auth.user.id } });
  }

  async answer(auth: AuthDto, id: string, dto: PersonSuggestionAnswerDto): Promise<PersonSuggestionResponseDto> {
    const suggestion = await this.findOrFail(auth, id);
    if (suggestion.status !== PersonSuggestionStatus.Pending) {
      throw new BadRequestException('This question was already answered');
    }

    const answeredAt = new Date();
    const updated =
      dto.answer === PersonSuggestionStatus.Same
        ? await this.answerSame(auth, suggestion, dto.name)
        : await this.personSuggestionRepository.update(id, { status: dto.answer, answeredAt, undo: null });

    return this.mapSuggestion(auth, updated);
  }

  async undoAnswer(auth: AuthDto, id: string): Promise<PersonSuggestionResponseDto> {
    const suggestion = await this.findOrFail(auth, id);
    if (suggestion.status === PersonSuggestionStatus.Pending) {
      throw new BadRequestException('This question has no answer to take back');
    }

    if (suggestion.status === PersonSuggestionStatus.Same) {
      await this.undoSame(auth, suggestion);
    }

    const updated = await this.personSuggestionRepository.update(id, {
      status: PersonSuggestionStatus.Pending,
      answeredAt: null,
      undo: null,
      ...(suggestion.status === PersonSuggestionStatus.Same &&
        !suggestion.faceId && { personGroupId: suggestion.undo!.personGroupId }),
    });

    return this.mapSuggestion(auth, updated);
  }

  /** A face cut out of its picture, for showing it in a question */
  async getFaceThumbnail(auth: AuthDto, id: string): Promise<{ data: Buffer; isPrivate: boolean }> {
    const face = await this.personSuggestionRepository.getFaceForCrop(id);
    if (!face || face.ownerId !== auth.user.id || face.isWholeAsset) {
      throw new NotFoundException('Face not found');
    }

    if (!(await this.personSuggestionRepository.isAssetInScope(toPrivateScope(auth), face.assetId))) {
      throw new NotFoundException('Face not found');
    }

    const { image, ffmpeg } = await this.getConfig({ withCache: true });
    let input: string | Buffer;
    if (face.type === AssetType.Video && face.frameTimestamp !== null && face.videoStream) {
      // the face was found in another frame than the preview, so it is cut from that frame
      const frameConfig = VideoFrameConfig.create({ ...ffmpeg, targetResolution: image.preview.size.toString() });
      input = await this.mediaRepository.extractVideoFrame(
        face.originalPath,
        frameConfig.getFrameCommand(face.frameTimestamp, face.videoStream),
      );
    } else if (face.previewPath) {
      // faces are stored in the space of the unedited preview, which is what this is
      input = face.previewPath;
    } else {
      throw new NotFoundException('Face not found');
    }

    const { data, info } = await this.mediaRepository.decodeImage(input, {
      colorspace: image.colorspace,
      processInvalidImages: false,
    });

    const thumbnail = await this.mediaRepository.generateThumbnailBuffer(data, {
      colorspace: image.colorspace,
      format: ImageFormat.Jpeg,
      raw: info,
      quality: image.thumbnail.quality,
      progressive: false,
      processInvalidImages: false,
      size: FACE_THUMBNAIL_SIZE,
      edits: [
        {
          action: AssetEditAction.Crop,
          parameters: getFaceCrop(
            { old: { width: face.oldWidth, height: face.oldHeight }, new: { width: info.width, height: info.height } },
            { x1: face.x1, y1: face.y1, x2: face.x2, y2: face.y2 },
          ),
        },
      ],
    });

    return { data: thumbnail, isPrivate: face.isPrivate };
  }

  @OnJob({ name: JobName.PersonSuggestionsQueueAll, queue: QueueName.FacialRecognition })
  async handleQueueSuggestions({ force }: JobOf<JobName.PersonSuggestionsQueueAll> = {}): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isPersonSuggestionsEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (!force && Date.now() - lastQueueAll.at < QUEUE_ALL_INTERVAL) {
      this.logger.debug('Skipping person suggestions, they were worked out less than an hour ago');
      return JobStatus.Skipped;
    }

    lastQueueAll.at = Date.now();

    const users = await this.userRepository.getList({ withDeleted: false });
    await this.jobRepository.queueAll(
      users.map((user) => ({ name: JobName.PersonSuggestions, data: { userId: user.id } }) as const),
    );

    return JobStatus.Success;
  }

  /**
   * Works out what to ask a user: unnamed people and faces without a person that may be a named person, and pairs of
   * unnamed people that may be one. Pairs the user already answered are never asked again; questions that no longer
   * hold are dropped, and the rest are ranked by what an answer is worth.
   */
  @OnJob({ name: JobName.PersonSuggestions, queue: QueueName.FacialRecognition })
  async handleSuggestions({ userId }: JobOf<JobName.PersonSuggestions>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isPersonSuggestionsEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const { minScore } = machineLearning.personSuggestions;
    await this.personSuggestionRepository.reopenSkipped(
      userId,
      new Date(Date.now() - PERSON_SUGGESTION.skippedDays * DAY),
    );

    const existing = await this.personSuggestionRepository.getAll(userId);
    const typicalNorm = await this.personSuggestionRepository.getTypicalFaceNorm(userId);
    const found = typicalNorm
      ? await this.findPairs(userId, typicalNorm * PERSON_SUGGESTION.minNormShare, minScore, existing)
      : [];

    await this.saveSuggestions(userId, found, existing);
    this.logger.debug(`Found ${found.length} people suggestions for user ${userId}`);

    return JobStatus.Success;
  }

  private async findPairs(userId: string, minNorm: number, minScore: number, existing: Suggestion[]) {
    const { minFaceSize, shortlist } = PERSON_SUGGESTION;
    const [personRows, faceRows] = await Promise.all([
      this.personSuggestionRepository.getPersonSimilarities(userId, { minNorm, minSimilarity: shortlist }),
      this.personSuggestionRepository.getFaceSimilarities(userId, { minNorm, minFaceSize, minSimilarity: shortlist }),
    ]);

    // pairs the user answered are never asked again, whichever way round
    const answered = new Set(
      existing
        .filter(({ status }) => status !== PersonSuggestionStatus.Pending)
        .map((suggestion) => getPairKey(suggestion))
        .filter((key) => key !== null),
    );

    type Pair = Omit<ScoredPair, 'faceMatch' | 'score'> & { targetFaces: number };
    const pairs: Pair[] = [];
    for (const row of personRows) {
      const centroid = Number(row.similarity);
      if (row.isNamed) {
        pairs.push({
          kind: PersonSuggestionKind.Named,
          personGroupId: row.personGroupId,
          targetPersonGroupId: row.targetPersonGroupId,
          centroid,
          targetFaces: Number(row.targetFaces),
        });
      } else {
        // two unnamed people are compared both ways round, from the faces of each
        pairs.push(
          {
            kind: PersonSuggestionKind.Unnamed,
            personGroupId: row.personGroupId,
            targetPersonGroupId: row.targetPersonGroupId,
            centroid,
            targetFaces: Number(row.targetFaces),
          },
          {
            kind: PersonSuggestionKind.Unnamed,
            personGroupId: row.targetPersonGroupId,
            targetPersonGroupId: row.personGroupId,
            centroid,
            targetFaces: Number(row.faces),
          },
        );
      }
    }

    for (const row of faceRows) {
      pairs.push({
        kind: PersonSuggestionKind.Named,
        faceId: row.faceId,
        targetPersonGroupId: row.targetPersonGroupId,
        centroid: Number(row.similarity),
        targetFaces: Number(row.targetFaces),
      });
    }

    const open = pairs.filter((pair) => !answered.has(getPairKey(pair)!));
    if (open.length === 0) {
      return [];
    }

    // the faces each candidate is judged by: a few of each unnamed person spread over time, or the face itself
    const personGroupIds = [...new Set(open.flatMap((pair) => (pair.personGroupId ? [pair.personGroupId] : [])))];
    const spread = await this.personSuggestionRepository.getSpreadFaceIds(
      userId,
      personGroupIds,
      { minNorm, minFaceSize },
      PERSON_SUGGESTION.facesPerPerson,
    );
    const facesByPerson = new Map<string, string[]>();
    for (const { id, personGroupId } of spread) {
      facesByPerson.set(personGroupId, [...(facesByPerson.get(personGroupId) ?? []), id]);
    }

    const queryFaceIds = [
      ...new Set([...spread.map(({ id }) => id), ...open.flatMap((pair) => (pair.faceId ? [pair.faceId] : []))]),
    ];
    const neighbors = new Map<string, NeighborFace[]>();
    for (let index = 0; index < queryFaceIds.length; index += 64) {
      const rows = await this.personSuggestionRepository.getNearestPersonFaces(
        userId,
        queryFaceIds.slice(index, index + 64),
        { minNorm },
        PERSON_SUGGESTION.neighbors,
      );
      for (const { faceId, ...neighbor } of rows) {
        neighbors.set(faceId, [
          ...(neighbors.get(faceId) ?? []),
          { ...neighbor, similarity: Number(neighbor.similarity) },
        ]);
      }
    }

    const scored: ScoredPair[] = [];
    for (const pair of open) {
      const faceIds = pair.faceId ? [pair.faceId] : (facesByPerson.get(pair.personGroupId!) ?? []);
      if (faceIds.length === 0) {
        continue;
      }

      // a candidate's own faces are not matches
      const nearest = faceIds.map((faceId) =>
        (neighbors.get(faceId) ?? [])
          .filter((neighbor) => neighbor.personGroupId !== pair.personGroupId)
          .toSorted((a, b) => b.similarity - a.similarity),
      );
      const faceMatch = getFaceMatchScore(nearest, pair.targetPersonGroupId, pair.targetFaces);
      scored.push({
        ...pair,
        faceMatch,
        score: getSuggestionScore({ faceMatch, centroid: pair.centroid, sharedAssetShare: 0 }),
      });
    }

    // two unnamed people judged both ways round count as one pair, with the mean of both
    const combined = new Map<string, ScoredPair>();
    for (const pair of scored) {
      const key = getPairKey(pair)!;
      const other = combined.get(key);
      if (other && pair.kind === PersonSuggestionKind.Unnamed) {
        const faceMatch = (other.faceMatch + pair.faceMatch) / 2;
        combined.set(key, { ...other, faceMatch, score: (other.score + pair.score) / 2 });
      } else {
        combined.set(key, pair);
      }
    }

    // the shared-photo penalty only lowers a score, so only pairs that could still make it are looked at
    const likely = combined
      .values()
      .filter((pair) => pair.score >= minScore)
      .toArray();
    const shares = await this.personSuggestionRepository.getSharedAssetShares(
      userId,
      likely.map((pair) => toPair(pair)),
    );
    const shareByPair = new Map(
      shares.map(({ candidateId, targetId, share }) => [`${candidateId}:${targetId}`, share]),
    );
    const final = likely
      .map((pair) => {
        const candidateId = pair.faceId ?? pair.personGroupId!;
        const reverse = pair.kind === PersonSuggestionKind.Unnamed ? `${pair.targetPersonGroupId}:${candidateId}` : '';
        const sharedAssetShare =
          shareByPair.get(`${candidateId}:${pair.targetPersonGroupId}`) ?? shareByPair.get(reverse) ?? 0;
        return {
          ...pair,
          score: getSuggestionScore({ faceMatch: pair.faceMatch, centroid: pair.centroid, sharedAssetShare }),
        };
      })
      .filter((pair) => pair.score >= minScore);

    // per candidate: the best named person and a close runner-up (look-alikes), and the best unnamed one
    const byCandidate = new Map<string, ScoredPair[]>();
    for (const pair of final) {
      const key = `${pair.kind}:${pair.faceId ?? pair.personGroupId}`;
      byCandidate.set(key, [...(byCandidate.get(key) ?? []), pair]);
    }

    const picked: ScoredPair[] = [];
    for (const [key, candidatePairs] of byCandidate) {
      const targets = pickTargets(candidatePairs);
      picked.push(...(key.startsWith(PersonSuggestionKind.Named) ? targets : targets.slice(0, 1)));
    }

    return picked;
  }

  private async saveSuggestions(userId: string, found: ScoredPair[], existing: Suggestion[]) {
    const personGroupIds = new Set<string>();
    const faceIds = new Set<string>();
    for (const pair of found) {
      if (pair.faceId) {
        faceIds.add(pair.faceId);
      } else {
        personGroupIds.add(pair.personGroupId!);
        personGroupIds.add(pair.targetPersonGroupId);
      }
    }

    const statistics = await this.personSuggestionRepository.getCandidateStatistics(
      userId,
      [...personGroupIds],
      [...faceIds],
    );
    const statisticsById = new Map(statistics.map((row) => [row.id, row]));

    const now = new Date();
    const ranked = found.map((pair) => {
      let { personGroupId, targetPersonGroupId } = pair;
      // of two unnamed people, the one on fewer photos is asked about and merged into the other
      if (pair.kind === PersonSuggestionKind.Unnamed && personGroupId) {
        const candidateAssets = statisticsById.get(personGroupId)?.assets ?? 0;
        const targetAssets = statisticsById.get(targetPersonGroupId)?.assets ?? 0;
        if (
          candidateAssets > targetAssets ||
          (candidateAssets === targetAssets && personGroupId > targetPersonGroupId)
        ) {
          [personGroupId, targetPersonGroupId] = [targetPersonGroupId, personGroupId];
        }
      }

      const candidate = statisticsById.get(pair.faceId ?? personGroupId!);
      const priority = getSuggestionPriority({
        kind: pair.kind,
        score: pair.score,
        assets: candidate?.assets ?? 1,
        days: candidate?.days ?? 1,
        latest: candidate?.latest ?? null,
        now,
      });
      return { ...pair, personGroupId, targetPersonGroupId, priority };
    });

    const kept = ranked.toSorted((a, b) => b.priority - a.priority).slice(0, PERSON_SUGGESTION.maxPending);

    const pendingByKey = new Map<string, Suggestion>();
    for (const suggestion of existing) {
      const key = getPairKey(suggestion);
      if (key && suggestion.status === PersonSuggestionStatus.Pending) {
        pendingByKey.set(key, suggestion);
      }
    }

    const toCreate: Insertable<PersonSuggestionTable>[] = [];
    const toUpdate: { id: string; score: number; priority: number }[] = [];
    const keptIds = new Set<string>();
    for (const pair of kept) {
      const current = pendingByKey.get(getPairKey(pair)!);
      if (current) {
        keptIds.add(current.id);
        if (current.source === PersonSuggestionSource.Automatic) {
          toUpdate.push({ id: current.id, score: pair.score, priority: pair.priority });
        }
        continue;
      }

      toCreate.push({
        ownerId: userId,
        kind: pair.kind,
        source: PersonSuggestionSource.Automatic,
        personGroupId: pair.faceId ? null : pair.personGroupId,
        faceId: pair.faceId ?? null,
        targetPersonGroupId: pair.targetPersonGroupId,
        score: pair.score,
        priority: pair.priority,
      });
    }

    // questions the job no longer finds go; the ones that came in through the API stay until answered
    const stale = existing.filter(
      (suggestion) =>
        suggestion.status === PersonSuggestionStatus.Pending &&
        suggestion.source === PersonSuggestionSource.Automatic &&
        !keptIds.has(suggestion.id),
    );

    await this.personSuggestionRepository.deleteAll(stale.map(({ id }) => id));
    await this.personSuggestionRepository.updateScores(toUpdate);
    await this.personSuggestionRepository.createAll(toCreate);
  }

  private async answerSame(auth: AuthDto, suggestion: Suggestion, name?: string): Promise<Suggestion> {
    const ownerId = auth.user.id;
    const targetPersonGroupId = suggestion.targetPersonGroupId;
    await this.requireAccess({ auth, permission: Permission.PersonMerge, ids: [targetPersonGroupId] });
    const target = await this.personRepository.getByGroupId({ ownerId, personGroupId: targetPersonGroupId });
    if (!target) {
      throw new BadRequestException('Person not found');
    }

    const answeredAt = new Date();
    if (suggestion.faceId) {
      await this.requireAccess({ auth, permission: Permission.PersonReassign, ids: [suggestion.faceId] });
      const face = await this.personRepository.getFaceById(suggestion.faceId, { viewingUserId: ownerId });
      const undo: PersonSuggestionUndo = { personGroupId: face.personGroupId, faceIds: [face.id] };
      const updated = await this.personSuggestionRepository.update(suggestion.id, {
        status: PersonSuggestionStatus.Same,
        answeredAt,
        undo,
      });

      await this.personRepository.reassignFace(face.id, targetPersonGroupId);
      await this.personSuggestionRepository.deleteOpenForFace(face.id, suggestion.id);
      if (target.faceAssetId === null) {
        await this.setFeatureFace(ownerId, targetPersonGroupId);
      }

      if (face.person?.faceAssetId === face.id) {
        await this.setFeatureFace(ownerId, face.person.personGroupId);
      }

      return updated;
    }

    const candidateGroupId = suggestion.personGroupId!;
    await this.requireAccess({ auth, permission: Permission.PersonMerge, ids: [candidateGroupId] });
    const candidate = await this.personRepository.getByGroupId({ ownerId, personGroupId: candidateGroupId });
    if (!candidate) {
      throw new BadRequestException('Person not found');
    }

    const isNaming = !!name && !target.name;
    const undo: PersonSuggestionUndo = {
      personGroupId: candidateGroupId,
      faceIds: await this.personSuggestionRepository.getFaceIdsOfPerson(ownerId, candidateGroupId),
      person: {
        name: candidate.name,
        birthDate: asDateString(candidate.birthDate),
        isHidden: candidate.isHidden,
        isFavorite: candidate.isFavorite,
        color: candidate.color,
      },
      ...(isNaming && { targetName: target.name }),
    };

    // the answer is kept, but no longer points at the candidate, which the merge removes
    const updated = await this.personSuggestionRepository.update(suggestion.id, {
      personGroupId: null,
      status: PersonSuggestionStatus.Same,
      answeredAt,
      undo,
    });

    if (isNaming) {
      await this.personRepository.update({ ownerId, personGroupId: targetPersonGroupId, name });
    }

    this.logger.log(
      `Merging ${candidateGroupId} into ${target.name || targetPersonGroupId} (answered the same person)`,
    );
    await this.personRepository.reassignFaces({
      oldPersonGroupId: candidateGroupId,
      newPersonGroupId: targetPersonGroupId,
      ownerId,
    });
    await this.personRepository.deleteDuplicateWholeAssetFaces(targetPersonGroupId);
    await this.personSuggestionRepository.moveToPerson(ownerId, candidateGroupId, targetPersonGroupId);
    await this.removePerson(ownerId, candidateGroupId);
    if (target.faceAssetId === null) {
      await this.setFeatureFace(ownerId, targetPersonGroupId);
    }

    return updated;
  }

  private async undoSame(auth: AuthDto, suggestion: Suggestion) {
    const ownerId = auth.user.id;
    const undo = suggestion.undo;
    if (!undo) {
      throw new BadRequestException('This answer cannot be taken back');
    }

    const targetPersonGroupId = suggestion.targetPersonGroupId;
    await this.requireAccess({ auth, permission: Permission.PersonMerge, ids: [targetPersonGroupId] });
    const target = await this.personRepository.getByGroupId({ ownerId, personGroupId: targetPersonGroupId });
    const faceIds = await this.personSuggestionRepository.getFacesStillWith(undo.faceIds, targetPersonGroupId);
    if (!target || faceIds.length === 0) {
      throw new BadRequestException('The faces were moved since, there is nothing to take back');
    }

    if (suggestion.faceId) {
      // back to the person the face belonged to, or to no person when that person is gone
      const previous =
        undo.personGroupId && (await this.personRepository.getByGroupId({ ownerId, personGroupId: undo.personGroupId }))
          ? undo.personGroupId
          : null;
      await this.personSuggestionRepository.moveFaces(faceIds, targetPersonGroupId, previous);
      if (previous) {
        const person = await this.personRepository.getByGroupId({ ownerId, personGroupId: previous });
        if (person && person.faceAssetId === null) {
          await this.setFeatureFace(ownerId, previous);
        }
      }
    } else {
      const personGroupId = undo.personGroupId!;
      await this.personSuggestionRepository.restoreGroup(ownerId, personGroupId);
      if (!(await this.personRepository.getByGroupId({ ownerId, personGroupId }))) {
        await this.personRepository.create({
          ownerId,
          personGroupId,
          name: undo.person?.name ?? '',
          birthDate: undo.person?.birthDate ?? null,
          isHidden: undo.person?.isHidden ?? false,
          isFavorite: undo.person?.isFavorite ?? false,
          color: undo.person?.color ?? null,
        });
      }

      await this.personSuggestionRepository.moveFaces(faceIds, targetPersonGroupId, personGroupId);
      await this.setFeatureFace(ownerId, personGroupId);
    }

    if (undo.targetName !== undefined) {
      await this.personRepository.update({ ownerId, personGroupId: targetPersonGroupId, name: undo.targetName });
    }

    if (target.faceAssetId && faceIds.includes(target.faceAssetId)) {
      await this.setFeatureFace(ownerId, targetPersonGroupId);
    }
  }

  /** Removes the owner's person of a group whose faces were moved elsewhere, like a merge does */
  private async removePerson(ownerId: string, personGroupId: string) {
    const people = await this.personRepository.delete([personGroupId], ownerId);
    await Promise.all(
      people
        .filter(({ thumbnailPath }) => thumbnailPath)
        .map(({ thumbnailPath }) => this.storageRepository.unlink(thumbnailPath)),
    );
    await Promise.all(
      people.map((person) =>
        this.storageRepository.unlinkDir(StorageCore.getPersonFallbackFolder(person), { recursive: true, force: true }),
      ),
    );
    await this.personRepository.deleteEmptyGroups();
  }

  private async setFeatureFace(ownerId: string, personGroupId: string) {
    const face = await this.personRepository.getRandomFace(personGroupId);
    if (!face) {
      return;
    }

    await this.personRepository.update({ ownerId, personGroupId, faceAssetId: face.id });
    await this.jobRepository.queue({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
  }

  private async findOrFail(auth: AuthDto, id: string) {
    const suggestion = await this.personSuggestionRepository.get(id);
    if (!suggestion || suggestion.ownerId !== auth.user.id) {
      throw new BadRequestException('Suggestion not found');
    }

    return suggestion;
  }

  private async mapSuggestion(auth: AuthDto, suggestion: Suggestion, limit = 8): Promise<PersonSuggestionResponseDto> {
    const ownerId = auth.user.id;
    const scope = toPrivateScope(auth);
    const repository = this.personSuggestionRepository;
    const candidate: SuggestionCandidate | undefined = suggestion.faceId
      ? { faceId: suggestion.faceId }
      : suggestion.personGroupId
        ? { personGroupId: suggestion.personGroupId }
        : undefined;
    const target: SuggestionCandidate = { personGroupId: suggestion.targetPersonGroupId };

    const [candidatePerson, targetPerson, candidateFaces, candidateAssets, similarFaces, spreadFaces, targetAssets] =
      await Promise.all([
        suggestion.personGroupId
          ? this.personRepository.getByGroupId({ ownerId, personGroupId: suggestion.personGroupId })
          : undefined,
        this.personRepository.getByGroupId({ ownerId, personGroupId: suggestion.targetPersonGroupId }),
        // a person merged away by a "same" answer is shown by the faces it brought
        candidate
          ? repository.getShownFaces(scope, candidate, limit)
          : repository.getShownFacesByIds(scope, suggestion.undo?.faceIds ?? [], limit),
        candidate
          ? repository.getShownAssetCount(scope, candidate)
          : Promise.resolve(suggestion.undo?.faceIds.length ?? 0),
        candidate ? repository.getMostSimilarFaces(scope, target.personGroupId!, candidate, Math.ceil(limit / 2)) : [],
        repository.getShownFaces(scope, target, limit),
        repository.getShownAssetCount(scope, target),
      ]);

    const targetFaces = [...similarFaces, ...spreadFaces]
      .filter((face, index, faces) => faces.findIndex(({ id }) => id === face.id) === index)
      .slice(0, limit);

    return {
      id: suggestion.id,
      kind: suggestion.kind,
      source: suggestion.source,
      status: suggestion.status,
      score: suggestion.score,
      answeredAt: suggestion.answeredAt ? new Date(suggestion.answeredAt).toISOString() : null,
      candidate: {
        person: candidatePerson ? mapPerson(candidatePerson) : null,
        assetCount: candidateAssets,
        faces: candidateFaces.map((face) => mapFace(face)),
      },
      target: {
        person: targetPerson ? mapPerson(targetPerson) : null,
        assetCount: targetAssets,
        faces: targetFaces.map((face) => mapFace(face)),
      },
    };
  }
}
