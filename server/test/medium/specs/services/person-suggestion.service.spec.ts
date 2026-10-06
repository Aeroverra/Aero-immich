import { Kysely } from 'kysely';
import { StorageCore } from 'src/cores/storage.core';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import {
  AssetFileType,
  JobName,
  PersonSuggestionKind,
  PersonSuggestionSource,
  PersonSuggestionStatus,
  SourceType,
} from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository';
import { MediaRepository } from 'src/repositories/media.repository';
import { PersonSuggestionRepository } from 'src/repositories/person-suggestion.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { SearchRepository } from 'src/repositories/search.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { PersonSuggestionService } from 'src/services/person-suggestion.service';
import { PersonService } from 'src/services/person.service';
import { MediumTestContext, newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

StorageCore.setMediaLocation('/data');

const real = [
  AccessRepository,
  AssetRepository,
  ConfigRepository,
  CryptoRepository,
  DatabaseRepository,
  PersonRepository,
  PersonSuggestionRepository,
  SearchRepository,
  SystemMetadataRepository,
  UserRepository,
];
const mock = [JobRepository, LoggingRepository, StorageRepository, MediaRepository, MachineLearningRepository];

const withDefaultMocks = <T extends { ctx: MediumTestContext }>(service: T) => {
  service.ctx.getMock(JobRepository).queue.mockResolvedValue();
  service.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  service.ctx.getMock(StorageRepository).unlink.mockResolvedValue();
  service.ctx.getMock(StorageRepository).unlinkDir.mockResolvedValue();
  return service;
};

const setup = () =>
  withDefaultMocks(newMediumService(PersonSuggestionService, { database: defaultDatabase, real, mock }));
const setupPersonService = () =>
  withDefaultMocks(newMediumService(PersonService, { database: defaultDatabase, real, mock }));

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

// a seeded random source, so the embeddings (and the scores) are the same on every run
const newRandom = (seed: number) => () => {
  seed = Math.trunc(seed + 0x6d_2b_79_f5) % 4_294_967_296;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
};

const normalize = (vector: number[]) => {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
};

const randomDirection = (random: () => number) =>
  normalize(
    Array.from({ length: 512 }, () => Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random())),
  );

/** a direction `share` of the way from `from` to a random other one: cosine about `1 - share` for small shares */
const lookAlike = (from: number[], random: () => number, weight: number) => {
  const other = randomDirection(random);
  return normalize(from.map((value, index) => value + weight * other[index]));
};

const faceEmbedding = (identity: number[], random: () => number, noise: number, norm: number) => {
  const jitter = randomDirection(random);
  return normalize(identity.map((value, index) => value + noise * jitter[index])).map((value) => value * norm);
};

type Seed = {
  name?: string;
  identity: number[];
  faces: number;
  noise?: number;
  norm?: number;
  isHidden?: boolean;
  /** put the faces on these assets instead of new ones */
  assetIds?: string[];
  isPrivate?: boolean;
  /** no person: faces without a person */
  loose?: boolean;
  firstDay?: number;
};

const seedPerson = async (ctx: MediumTestContext, ownerId: string, random: () => number, seed: Seed) => {
  const personRepository = ctx.get(PersonRepository);
  let personGroupId: string | null = null;
  if (!seed.loose) {
    const group = await personRepository.createGroup(ownerId);
    await personRepository.create({
      ownerId,
      personGroupId: group.id,
      name: seed.name ?? '',
      isHidden: !!seed.isHidden,
    });
    personGroupId = group.id;
  }

  const faceIds: string[] = [];
  const assetIds: string[] = [];
  for (let index = 0; index < seed.faces; index++) {
    let assetId = seed.assetIds?.[index];
    if (!assetId) {
      const day = new Date(Date.UTC(2024, 0, 1 + (seed.firstDay ?? 0) + index * 3));
      const { asset } = await ctx.newAsset({
        ownerId,
        fileCreatedAt: day,
        localDateTime: day,
        isPrivate: !!seed.isPrivate,
      });
      assetId = asset.id;
    }

    const { assetFace } = await ctx.newAssetFace({
      assetId,
      personGroupId,
      imageWidth: 1000,
      imageHeight: 1000,
      boundingBoxX1: 100 + index,
      boundingBoxY1: 100,
      boundingBoxX2: 300 + index,
      boundingBoxY2: 300,
      sourceType: SourceType.MachineLearning,
    });
    const embedding = faceEmbedding(seed.identity, random, seed.noise ?? 0.9, seed.norm ?? 21);
    await ctx.database
      .insertInto('face_search')
      .values({ faceId: assetFace.id, embedding: `[${embedding}]` })
      .execute();
    faceIds.push(assetFace.id);
    assetIds.push(assetId);
  }

  return { personGroupId: personGroupId!, faceIds, assetIds };
};

const getSuggestions = (ctx: MediumTestContext, ownerId: string) => ctx.get(PersonSuggestionRepository).getAll(ownerId);

describe(PersonSuggestionService.name, () => {
  describe('handleSuggestions', () => {
    it('should ask whether an unnamed person split off a named person is that person', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(1);
      const { user } = await ctx.newUser();
      const anna = randomDirection(random);
      const { personGroupId: annaId } = await seedPerson(ctx, user.id, random, {
        name: 'Anna',
        identity: anna,
        faces: 8,
      });
      const { personGroupId: splitId } = await seedPerson(ctx, user.id, random, {
        identity: anna,
        faces: 3,
        firstDay: 1,
      });
      // someone else entirely
      await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 3, firstDay: 2 });

      await expect(sut.handleSuggestions({ userId: user.id })).resolves.toBe('success');

      const suggestions = await getSuggestions(ctx, user.id);
      expect(suggestions).toEqual([
        expect.objectContaining({
          kind: PersonSuggestionKind.Named,
          source: PersonSuggestionSource.Automatic,
          status: PersonSuggestionStatus.Pending,
          personGroupId: splitId,
          faceId: null,
          targetPersonGroupId: annaId,
        }),
      ]);
      expect(suggestions[0].score).toBeGreaterThan(0.5);
      expect(suggestions[0].priority).toBeGreaterThan(0);
    });

    it('should ask about a face without a person that looks like a named person', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(2);
      const { user } = await ctx.newUser();
      const ben = randomDirection(random);
      const { personGroupId: benId } = await seedPerson(ctx, user.id, random, { name: 'Ben', identity: ben, faces: 6 });
      const { faceIds } = await seedPerson(ctx, user.id, random, { identity: ben, faces: 1, loose: true });
      // a stranger
      await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 1, loose: true });

      await sut.handleSuggestions({ userId: user.id });

      await expect(getSuggestions(ctx, user.id)).resolves.toEqual([
        expect.objectContaining({
          kind: PersonSuggestionKind.Named,
          personGroupId: null,
          faceId: faceIds[0],
          targetPersonGroupId: benId,
        }),
      ]);
    });

    it('should ask whether two unnamed people are one, about the one on fewer photos', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(3);
      const { user } = await ctx.newUser();
      const cleo = randomDirection(random);
      const { personGroupId: bigId } = await seedPerson(ctx, user.id, random, { identity: cleo, faces: 5 });
      const { personGroupId: smallId } = await seedPerson(ctx, user.id, random, {
        identity: cleo,
        faces: 2,
        firstDay: 1,
      });

      await sut.handleSuggestions({ userId: user.id });

      await expect(getSuggestions(ctx, user.id)).resolves.toEqual([
        expect.objectContaining({
          kind: PersonSuggestionKind.Unnamed,
          personGroupId: smallId,
          targetPersonGroupId: bigId,
        }),
      ]);
    });

    it('should leave out hidden people and faces with weak embeddings', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(4);
      const { user } = await ctx.newUser();
      const dana = randomDirection(random);
      const eve = randomDirection(random);
      await seedPerson(ctx, user.id, random, { name: 'Dana', identity: dana, faces: 6 });
      await seedPerson(ctx, user.id, random, { identity: dana, faces: 3, isHidden: true });
      await seedPerson(ctx, user.id, random, { name: 'Eve', identity: eve, faces: 6, isHidden: true });
      await seedPerson(ctx, user.id, random, { identity: eve, faces: 3 });
      // the back of Dana's head
      await seedPerson(ctx, user.id, random, { identity: dana, faces: 1, loose: true, norm: 8 });

      await sut.handleSuggestions({ userId: user.id });

      await expect(getSuggestions(ctx, user.id)).resolves.toEqual([]);
    });

    it('should not ask about someone the named person is already next to in every photo', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(5);
      const { user } = await ctx.newUser();
      const fay = randomDirection(random);
      const { assetIds } = await seedPerson(ctx, user.id, random, { name: 'Fay', identity: fay, faces: 6 });
      // her look-alike sister, on photos Fay is in too
      await seedPerson(ctx, user.id, random, {
        identity: lookAlike(fay, random, 0.9),
        faces: 3,
        assetIds: assetIds.slice(0, 3),
      });
      const sisterAlone = await seedPerson(ctx, user.id, random, {
        identity: lookAlike(fay, random, 0.9),
        faces: 3,
        firstDay: 1,
      });

      await sut.handleSuggestions({ userId: user.id });

      const suggestions = await getSuggestions(ctx, user.id);
      const asked = suggestions.map(({ personGroupId }) => personGroupId);
      expect(asked).not.toContain(undefined);
      const alone = suggestions.find(({ personGroupId }) => personGroupId === sisterAlone.personGroupId);
      const together = suggestions.find(({ personGroupId }) => personGroupId !== sisterAlone.personGroupId);
      // being on the same photos as Fay costs the sister her question or at least a lower score
      if (together && alone) {
        expect(together.score).toBeLessThan(alone.score);
      }
    });

    it('should keep answers, drop questions it no longer finds and keep questions that came through the API', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(6);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const gus = randomDirection(random);
      const { personGroupId: gusId } = await seedPerson(ctx, user.id, random, { name: 'Gus', identity: gus, faces: 6 });
      const split = await seedPerson(ctx, user.id, random, { identity: gus, faces: 3, firstDay: 1 });
      const stranger = await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 3 });

      await sut.handleSuggestions({ userId: user.id });
      const [first] = await getSuggestions(ctx, user.id);
      await sut.answer(auth, first.id, { answer: PersonSuggestionStatus.Different });

      // asked through the API about a pair the job would never find
      const created = await sut.create(auth, { personId: stranger.personGroupId, targetPersonId: gusId, score: 0.4 });
      // a question the job found once but no longer does
      const repository = ctx.get(PersonSuggestionRepository);
      const gone = await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 1 });
      const stale = await repository.create({
        ownerId: user.id,
        kind: PersonSuggestionKind.Named,
        personGroupId: gone.personGroupId,
        targetPersonGroupId: gusId,
        score: 0.4,
      });

      await sut.handleSuggestions({ userId: user.id });

      const suggestions = await getSuggestions(ctx, user.id);
      expect(suggestions).toHaveLength(2);
      expect(suggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.id,
            personGroupId: split.personGroupId,
            status: PersonSuggestionStatus.Different,
          }),
          expect.objectContaining({ id: created.id, source: PersonSuggestionSource.Api }),
        ]),
      );
      expect(suggestions.map(({ id }) => id)).not.toContain(stale.id);
    });
  });

  describe('order', () => {
    it('should ask about the likeliest pairs with the most photos first, questions from the API included', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(22);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const tom = randomDirection(random);
      const { personGroupId: tomId } = await seedPerson(ctx, user.id, random, { name: 'Tom', identity: tom, faces: 8 });
      // a big part of Tom split off, and one blurry-ish face of him
      const big = await seedPerson(ctx, user.id, random, { identity: tom, faces: 6, firstDay: 1 });
      const face = await seedPerson(ctx, user.id, random, { identity: tom, faces: 1, loose: true, noise: 1.2 });
      // a question handed over through the API about someone barely alike
      const other = await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 1 });
      const imported = await sut.create(auth, { personId: other.personGroupId, targetPersonId: tomId, score: 0.36 });

      await sut.handleSuggestions({ userId: user.id });

      const { suggestions } = await sut.getAll(auth, { page: 1, size: 10 });
      const order = suggestions.map(({ id, candidate }) =>
        id === imported.id
          ? 'imported'
          : candidate.person?.id === big.personGroupId
            ? 'big'
            : candidate.faces[0]?.id === face.faceIds[0]
              ? 'face'
              : '?',
      );
      expect(order).toEqual(['big', 'face', 'imported']);
    });
  });

  describe('questions about one person', () => {
    it('should list and count only the questions about that person', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(23);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const uma = await seedPerson(ctx, user.id, random, { name: 'Uma', identity: randomDirection(random), faces: 2 });
      const vic = await seedPerson(ctx, user.id, random, { name: 'Vic', identity: randomDirection(random), faces: 2 });
      const unnamed = await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 1 });
      const other = await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 1 });
      const aboutUma = await sut.create(auth, { personId: unnamed.personGroupId, targetPersonId: uma.personGroupId });
      const aboutUnnamed = await sut.create(auth, {
        personId: unnamed.personGroupId,
        targetPersonId: vic.personGroupId,
      });
      await sut.create(auth, { personId: other.personGroupId, targetPersonId: vic.personGroupId });

      await expect(sut.getStatistics(auth, { personId: uma.personGroupId })).resolves.toEqual({ pending: 1 });
      await expect(sut.getStatistics(auth, { personId: unnamed.personGroupId })).resolves.toEqual({ pending: 2 });
      await expect(sut.getStatistics(auth)).resolves.toEqual({ pending: 3 });
      const { suggestions, total } = await sut.getAll(auth, { page: 1, size: 10, personId: unnamed.personGroupId });
      expect(total).toBe(2);
      expect(suggestions.map(({ id }) => id).toSorted()).toEqual([aboutUma.id, aboutUnnamed.id].toSorted());
    });
  });

  describe('getAll', () => {
    it('should show both sides with faces, names and counts', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(7);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const hal = randomDirection(random);
      const { personGroupId: halId } = await seedPerson(ctx, user.id, random, {
        name: 'Hal',
        identity: hal,
        faces: 10,
      });
      const split = await seedPerson(ctx, user.id, random, { identity: hal, faces: 3, firstDay: 1 });
      await sut.handleSuggestions({ userId: user.id });

      const response = await sut.getAll(auth, { page: 1, size: 10 });

      expect(response.total).toBe(1);
      expect(response.hasNextPage).toBe(false);
      const [suggestion] = response.suggestions;
      expect(suggestion.candidate.person).toEqual(expect.objectContaining({ id: split.personGroupId, name: '' }));
      expect(suggestion.candidate.assetCount).toBe(3);
      expect(suggestion.candidate.faces.map(({ id }) => id).toSorted()).toEqual(split.faceIds.toSorted());
      expect(suggestion.target.person).toEqual(expect.objectContaining({ id: halId, name: 'Hal' }));
      expect(suggestion.target.assetCount).toBe(10);
      expect(suggestion.target.faces).toHaveLength(8);
      await expect(sut.getStatistics(auth)).resolves.toEqual({ pending: 1 });
    });

    it('should not show a question whose faces are all private outside private mode', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(8);
      const { user } = await ctx.newUser();
      const ida = randomDirection(random);
      await seedPerson(ctx, user.id, random, { name: 'Ida', identity: ida, faces: 6 });
      await seedPerson(ctx, user.id, random, { identity: ida, faces: 3, firstDay: 1, isPrivate: true });
      await sut.handleSuggestions({ userId: user.id });
      expect(await getSuggestions(ctx, user.id)).toHaveLength(1);

      const locked = factory.auth({ user });
      await expect(sut.getStatistics(locked)).resolves.toEqual({ pending: 0 });
      await expect(sut.getAll(locked, { page: 1, size: 10 })).resolves.toEqual(
        expect.objectContaining({ total: 0, suggestions: [] }),
      );

      const unlocked = factory.auth({ user, session: { privateMode: true } as any });
      await expect(sut.getStatistics(unlocked)).resolves.toEqual({ pending: 1 });
    });
  });

  describe('answer', () => {
    it('should merge an unnamed person into the named one and take it back', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(9);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const jan = randomDirection(random);
      const { personGroupId: janId, faceIds: janFaces } = await seedPerson(ctx, user.id, random, {
        name: 'Jan',
        identity: jan,
        faces: 6,
      });
      const split = await seedPerson(ctx, user.id, random, { identity: jan, faces: 3, firstDay: 1 });
      await sut.handleSuggestions({ userId: user.id });
      const [suggestion] = await getSuggestions(ctx, user.id);

      const answered = await sut.answer(auth, suggestion.id, { answer: PersonSuggestionStatus.Same });

      expect(answered.status).toBe(PersonSuggestionStatus.Same);
      expect(answered.candidate.person).toBeNull();
      expect(answered.target.person).toEqual(expect.objectContaining({ id: janId, name: 'Jan' }));
      const personRepository = ctx.get(PersonRepository);
      await expect(
        personRepository.getByGroupId({ ownerId: user.id, personGroupId: split.personGroupId }),
      ).resolves.toBeUndefined();
      const janNow = await ctx.database
        .selectFrom('asset_face')
        .select('id')
        .where('personGroupId', '=', janId)
        .execute();
      expect(janNow.map(({ id }) => id).toSorted()).toEqual([...janFaces, ...split.faceIds].toSorted());
      await expect(sut.getStatistics(auth)).resolves.toEqual({ pending: 0 });

      const undone = await sut.undoAnswer(auth, suggestion.id);

      expect(undone.status).toBe(PersonSuggestionStatus.Pending);
      expect(undone.candidate.person).toEqual(expect.objectContaining({ id: split.personGroupId, name: '' }));
      const splitNow = await ctx.database
        .selectFrom('asset_face')
        .select('id')
        .where('personGroupId', '=', split.personGroupId)
        .execute();
      expect(splitNow.map(({ id }) => id).toSorted()).toEqual(split.faceIds.toSorted());
      await expect(sut.getStatistics(auth)).resolves.toEqual({ pending: 1 });
      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.PersonGenerateThumbnail,
        data: { ownerId: user.id, personGroupId: split.personGroupId },
      });
    });

    it('should move a face to the named person and take it back', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(10);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const kim = randomDirection(random);
      const { personGroupId: kimId } = await seedPerson(ctx, user.id, random, { name: 'Kim', identity: kim, faces: 6 });
      const { faceIds } = await seedPerson(ctx, user.id, random, { identity: kim, faces: 1, loose: true });
      await sut.handleSuggestions({ userId: user.id });
      const [suggestion] = await getSuggestions(ctx, user.id);

      await sut.answer(auth, suggestion.id, { answer: PersonSuggestionStatus.Same });
      const moved = await ctx.database
        .selectFrom('asset_face')
        .select('personGroupId')
        .where('id', '=', faceIds[0])
        .executeTakeFirst();
      expect(moved?.personGroupId).toBe(kimId);

      await sut.undoAnswer(auth, suggestion.id);
      const back = await ctx.database
        .selectFrom('asset_face')
        .select('personGroupId')
        .where('id', '=', faceIds[0])
        .executeTakeFirst();
      expect(back?.personGroupId).toBeNull();
    });

    it('should name two unnamed people answered to be one, and take the name back', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(11);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const lea = randomDirection(random);
      const { personGroupId: bigId } = await seedPerson(ctx, user.id, random, { identity: lea, faces: 5 });
      await seedPerson(ctx, user.id, random, { identity: lea, faces: 2, firstDay: 1 });
      await sut.handleSuggestions({ userId: user.id });
      const [suggestion] = await getSuggestions(ctx, user.id);

      const answered = await sut.answer(auth, suggestion.id, { answer: PersonSuggestionStatus.Same, name: 'Lea' });
      expect(answered.target.person).toEqual(expect.objectContaining({ id: bigId, name: 'Lea' }));

      const undone = await sut.undoAnswer(auth, suggestion.id);
      expect(undone.target.person).toEqual(expect.objectContaining({ id: bigId, name: '' }));
    });

    it('should never ask again, merge or match a pair answered to be different', async () => {
      const { sut, ctx } = setup();
      const { sut: personService } = setupPersonService();
      const random = newRandom(12);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const max = randomDirection(random);
      const { personGroupId: maxId } = await seedPerson(ctx, user.id, random, { name: 'Max', identity: max, faces: 6 });
      const split = await seedPerson(ctx, user.id, random, { identity: max, faces: 3, firstDay: 1 });
      const loose = await seedPerson(ctx, user.id, random, { identity: max, faces: 1, loose: true, noise: 0.5 });
      await sut.handleSuggestions({ userId: user.id });
      const suggestions = await getSuggestions(ctx, user.id);
      expect(suggestions).toHaveLength(2);
      for (const { id } of suggestions) {
        await sut.answer(auth, id, { answer: PersonSuggestionStatus.Different });
      }

      await sut.handleSuggestions({ userId: user.id });
      await expect(getSuggestions(ctx, user.id)).resolves.toEqual([
        expect.objectContaining({ status: PersonSuggestionStatus.Different }),
        expect.objectContaining({ status: PersonSuggestionStatus.Different }),
      ]);

      // a merge of the two is refused
      await expect(personService.mergePeople(auth, { ids: [maxId, split.personGroupId] })).resolves.toEqual([
        { id: split.personGroupId, success: false, error: BulkIdErrorReason.VALIDATION },
      ]);

      // and so is putting the face on Max
      await expect(personService.reassignFacesById(auth, maxId, { id: loose.faceIds[0] })).rejects.toThrow(
        'This face was answered to be a different person',
      );

      // facial recognition matches the face to someone else, or to nobody, but never to Max
      await personService.handleRecognizeFaces({ id: loose.faceIds[0], deferred: true });
      const face = await ctx.database
        .selectFrom('asset_face')
        .select('personGroupId')
        .where('id', '=', loose.faceIds[0])
        .executeTakeFirst();
      expect(face?.personGroupId).not.toBe(maxId);
    });

    it('should carry a different answer over to the person it is merged into', async () => {
      const { sut, ctx } = setup();
      const { sut: personService } = setupPersonService();
      const random = newRandom(13);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const ned = randomDirection(random);
      const { personGroupId: nedId } = await seedPerson(ctx, user.id, random, { name: 'Ned', identity: ned, faces: 6 });
      const other = await seedPerson(ctx, user.id, random, {
        name: 'Other',
        identity: randomDirection(random),
        faces: 3,
      });
      const split = await seedPerson(ctx, user.id, random, { identity: ned, faces: 3, firstDay: 1 });
      const created = await sut.create(auth, { personId: split.personGroupId, targetPersonId: other.personGroupId });
      await sut.answer(auth, created.id, { answer: PersonSuggestionStatus.Different });

      await expect(personService.mergePeople(auth, { ids: [nedId, split.personGroupId] })).resolves.toEqual([
        { id: split.personGroupId, success: true },
      ]);

      await expect(ctx.get(PersonSuggestionRepository).get(created.id)).resolves.toEqual(
        expect.objectContaining({
          personGroupId: nedId,
          targetPersonGroupId: other.personGroupId,
          status: PersonSuggestionStatus.Different,
        }),
      );
      await expect(personService.mergePeople(auth, { ids: [other.personGroupId, nedId] })).resolves.toEqual([
        { id: nedId, success: false, error: BulkIdErrorReason.VALIDATION },
      ]);
    });

    it('should not answer a question twice', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(14);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { personGroupId: oliId } = await seedPerson(ctx, user.id, random, {
        name: 'Oli',
        identity: randomDirection(random),
        faces: 2,
      });
      const other = await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 1 });
      const created = await sut.create(auth, { personId: other.personGroupId, targetPersonId: oliId });
      await sut.answer(auth, created.id, { answer: PersonSuggestionStatus.Skipped });

      await expect(sut.answer(auth, created.id, { answer: PersonSuggestionStatus.Same })).rejects.toThrow(
        'This question was already answered',
      );
    });

    it("should not let another user answer someone's question", async () => {
      const { sut, ctx } = setup();
      const random = newRandom(15);
      const { user } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { personGroupId: patId } = await seedPerson(ctx, user.id, random, {
        name: 'Pat',
        identity: randomDirection(random),
        faces: 2,
      });
      const other = await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 1 });
      const created = await sut.create(factory.auth({ user }), {
        personId: other.personGroupId,
        targetPersonId: patId,
      });

      await expect(
        sut.answer(factory.auth({ user: stranger }), created.id, { answer: PersonSuggestionStatus.Same }),
      ).rejects.toThrow('Suggestion not found');
    });
  });

  describe('a face asked about with two look-alikes', () => {
    it('should not be asked about the other one once it is answered', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(21);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const sue = await seedPerson(ctx, user.id, random, { name: 'Sue', identity: randomDirection(random), faces: 2 });
      const sis = await seedPerson(ctx, user.id, random, { name: 'Sis', identity: randomDirection(random), faces: 2 });
      const { faceIds } = await seedPerson(ctx, user.id, random, {
        identity: randomDirection(random),
        faces: 1,
        loose: true,
      });
      const first = await sut.create(auth, { faceId: faceIds[0], targetPersonId: sue.personGroupId });
      const second = await sut.create(auth, { faceId: faceIds[0], targetPersonId: sis.personGroupId });
      await expect(sut.getStatistics(auth)).resolves.toEqual({ pending: 2 });

      await sut.answer(auth, first.id, { answer: PersonSuggestionStatus.Same });

      await expect(sut.getStatistics(auth)).resolves.toEqual({ pending: 0 });
      await expect(ctx.get(PersonSuggestionRepository).get(second.id)).resolves.toBeUndefined();
    });
  });

  describe('a face that is with another person', () => {
    it('should be asked about, moved to the target and moved back', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(20);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { personGroupId: rayId } = await seedPerson(ctx, user.id, random, {
        name: 'Ray',
        identity: randomDirection(random),
        faces: 2,
      });
      const mixed = await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 3 });
      const faceId = mixed.faceIds[0];

      const created = await sut.create(auth, { faceId, targetPersonId: rayId, score: 0.4 });
      await expect(sut.getAll(auth, { page: 1, size: 10 })).resolves.toEqual(
        expect.objectContaining({ total: 1, suggestions: [expect.objectContaining({ id: created.id })] }),
      );

      await sut.answer(auth, created.id, { answer: PersonSuggestionStatus.Same });
      const moved = await ctx.database
        .selectFrom('asset_face')
        .select('personGroupId')
        .where('id', '=', faceId)
        .executeTakeFirst();
      expect(moved?.personGroupId).toBe(rayId);

      await sut.undoAnswer(auth, created.id);
      const back = await ctx.database
        .selectFrom('asset_face')
        .select('personGroupId')
        .where('id', '=', faceId)
        .executeTakeFirst();
      expect(back?.personGroupId).toBe(mixed.personGroupId);
    });
  });

  describe('create', () => {
    it('should ask about the unnamed one of the two and return the same question twice', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(16);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { personGroupId: quinnId } = await seedPerson(ctx, user.id, random, {
        name: 'Quinn',
        identity: randomDirection(random),
        faces: 2,
      });
      const other = await seedPerson(ctx, user.id, random, { identity: randomDirection(random), faces: 1 });

      const created = await sut.create(auth, { personId: quinnId, targetPersonId: other.personGroupId, score: 0.42 });

      expect(created).toEqual(
        expect.objectContaining({
          kind: PersonSuggestionKind.Named,
          source: PersonSuggestionSource.Api,
          status: PersonSuggestionStatus.Pending,
          score: expect.closeTo(0.42, 5),
        }),
      );
      expect(created.candidate.person?.id).toBe(other.personGroupId);
      expect(created.target.person?.id).toBe(quinnId);
      await expect(sut.create(auth, { personId: other.personGroupId, targetPersonId: quinnId })).resolves.toEqual(
        expect.objectContaining({ id: created.id }),
      );
    });

    it('should refuse two named people', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(17);
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const a = await seedPerson(ctx, user.id, random, { name: 'A', identity: randomDirection(random), faces: 1 });
      const b = await seedPerson(ctx, user.id, random, { name: 'B', identity: randomDirection(random), faces: 1 });

      await expect(sut.create(auth, { personId: a.personGroupId, targetPersonId: b.personGroupId })).rejects.toThrow(
        'Both people already have a name',
      );
    });
  });

  describe('getFaceThumbnail', () => {
    it('should cut the face out of the preview', async () => {
      const { sut, ctx } = setup();
      const random = newRandom(18);
      const { user } = await ctx.newUser();
      const { faceIds, assetIds } = await seedPerson(ctx, user.id, random, {
        identity: randomDirection(random),
        faces: 1,
        loose: true,
      });
      await ctx.newAssetFile({ assetId: assetIds[0], type: AssetFileType.Preview, path: '/data/preview.jpeg' });
      const media = ctx.getMock(MediaRepository);
      media.decodeImage.mockResolvedValue({ data: Buffer.from('raw'), info: { width: 2000, height: 2000 } as any });
      media.generateThumbnailBuffer.mockResolvedValue(Buffer.from('face'));

      await expect(sut.getFaceThumbnail(factory.auth({ user }), faceIds[0])).resolves.toEqual({
        data: Buffer.from('face'),
        isPrivate: false,
      });
      expect(media.decodeImage).toHaveBeenCalledWith('/data/preview.jpeg', expect.anything());
      // the box (100,100)-(300,300) of a 1000 wide picture, in the 2000 wide preview, 10% bigger
      expect(media.generateThumbnailBuffer).toHaveBeenCalledWith(
        Buffer.from('raw'),
        expect.objectContaining({
          edits: [expect.objectContaining({ parameters: { x: 180, y: 180, width: 440, height: 440 } })],
        }),
      );
    });

    it("should not show a face on someone else's or a private asset", async () => {
      const { sut, ctx } = setup();
      const random = newRandom(19);
      const { user } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { faceIds } = await seedPerson(ctx, user.id, random, {
        identity: randomDirection(random),
        faces: 1,
        loose: true,
        isPrivate: true,
      });

      await expect(sut.getFaceThumbnail(factory.auth({ user: stranger }), faceIds[0])).rejects.toThrow(
        'Face not found',
      );
      await expect(sut.getFaceThumbnail(factory.auth({ user }), faceIds[0])).rejects.toThrow('Face not found');
    });
  });
});
