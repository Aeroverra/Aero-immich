import { Kysely } from 'kysely';
import { AssetType, AssetVisibility } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { SearchRepository } from 'src/repositories/search.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { TranscriptRepository } from 'src/repositories/transcript.repository';
import { DB } from 'src/schema';
import { AssetService } from 'src/services/asset.service';
import { SearchService } from 'src/services/search.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const real = [
  AccessRepository,
  AssetRepository,
  AssetJobRepository,
  DatabaseRepository,
  SearchRepository,
  PartnerRepository,
  PersonRepository,
  StackRepository,
  TranscriptRepository,
];

const setup = (db?: Kysely<DB>) =>
  newMediumService(SearchService, { database: db || defaultDatabase, real, mock: [LoggingRepository] });

const diary = [
  { startTime: 110, endTime: 4490, text: "I'm going to do the best I can because I'm driving." },
  {
    startTime: 6790,
    endTime: 14_850,
    text: 'But I just went to the last full moon party at St. Thomas at Sapphire Beach here.',
  },
  { startTime: 16_130, endTime: 19_290, text: "And I don't know what to feel." },
  { startTime: 484_000, endTime: 488_000, text: 'The full moon came up over the water, the best night of the trip.' },
];

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(TranscriptRepository.name, () => {
  it('should store a transcript and read its lines in order', async () => {
    const { ctx } = setup();
    const sut = ctx.get(TranscriptRepository);
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });

    await sut.replace({ assetId: asset.id, language: 'en', modelName: 'large-v3-turbo' }, diary);

    await expect(sut.getByAssetId(asset.id)).resolves.toEqual({
      assetId: asset.id,
      language: 'en',
      modelName: 'large-v3-turbo',
      segments: diary,
    });
  });

  it('should replace the lines of an earlier transcript', async () => {
    const { ctx } = setup();
    const sut = ctx.get(TranscriptRepository);
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });

    await sut.replace({ assetId: asset.id, language: 'en', modelName: 'small' }, diary);
    await sut.replace({ assetId: asset.id, language: null, modelName: 'large-v3-turbo' }, []);

    await expect(sut.getByAssetId(asset.id)).resolves.toEqual({
      assetId: asset.id,
      language: null,
      modelName: 'large-v3-turbo',
      segments: [],
    });
  });

  it('should be removed with its asset', async () => {
    const { ctx } = setup();
    const sut = ctx.get(TranscriptRepository);
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    await sut.replace({ assetId: asset.id, language: 'en', modelName: 'large-v3-turbo' }, diary);

    await ctx.database.deleteFrom('asset').where('id', '=', asset.id).execute();

    await expect(sut.getByAssetId(asset.id)).resolves.toBeUndefined();
    await expect(
      ctx.database.selectFrom('asset_transcript_segment').where('assetId', '=', asset.id).execute(),
    ).resolves.toEqual([]);
  });

  it('should pick the line that matches best, the earliest one on a tie', async () => {
    const { ctx } = setup();
    const sut = ctx.get(TranscriptRepository);
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    const { asset: other } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    await sut.replace({ assetId: asset.id, language: 'en', modelName: 'large-v3-turbo' }, diary);
    await sut.replace({ assetId: other.id, language: 'en', modelName: 'large-v3-turbo' }, [
      { startTime: 1000, endTime: 2000, text: 'Nothing about the sky here.' },
    ]);

    await expect(sut.getBestMatches([asset.id, other.id], 'full moon')).resolves.toEqual([
      { assetId: asset.id, ...diary[1] },
    ]);
    await expect(sut.getBestMatches([asset.id], 'night of the trip')).resolves.toEqual([
      { assetId: asset.id, ...diary[3] },
    ]);
    await expect(sut.getBestMatches([], 'full moon')).resolves.toEqual([]);
  });
});

describe(AssetJobRepository.name, () => {
  describe('streamForVideoTranscription', () => {
    it('should list the visible videos without a transcript, or every one when forced', async () => {
      const { ctx } = setup();
      const sut = ctx.get(AssetJobRepository);
      const transcripts = ctx.get(TranscriptRepository);
      const { user } = await ctx.newUser();
      const { asset: missing } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      const { asset: done } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      const { asset: hidden } = await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Video,
        visibility: AssetVisibility.Hidden,
      });
      const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      await ctx.softDeleteAsset(trashed.id);
      await transcripts.replace({ assetId: done.id, language: null, modelName: 'large-v3-turbo' }, []);

      const ids = new Set([missing.id, done.id, photo.id, hidden.id, trashed.id]);
      const list = async (force: boolean) => {
        const assets = await Array.fromAsync(sut.streamForVideoTranscription(force));
        return assets.map(({ id }) => id).filter((id) => ids.has(id));
      };

      await expect(list(false)).resolves.toEqual([missing.id]);
      await expect(list(true)).resolves.toEqual(expect.arrayContaining([missing.id, done.id]));
      await expect(list(true)).resolves.toHaveLength(2);
    });
  });

  describe('getForVideoTranscription', () => {
    it('should include the audio stream', async () => {
      const { ctx } = setup();
      const sut = ctx.get(AssetJobRepository);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      const { asset: silent } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      await ctx.database
        .insertInto('asset_audio')
        .values({ assetId: asset.id, index: 1, codecName: 'aac', bitrate: 128_000, profile: null })
        .execute();

      await expect(sut.getForVideoTranscription(asset.id)).resolves.toEqual(
        expect.objectContaining({
          id: asset.id,
          type: AssetType.Video,
          audioStream: { index: 1, codecName: 'aac', profile: null, bitrate: 128_000 },
        }),
      );
      await expect(sut.getForVideoTranscription(silent.id)).resolves.toEqual(
        expect.objectContaining({ id: silent.id, audioStream: null, videoStreamAssetId: null }),
      );
    });
  });
});

const newLibrary = async () => {
  const { sut, ctx } = setup();
  const { user } = await ctx.newUser();
  const { asset: diaryVideo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
  const { asset: otherVideo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
  const { asset: photo } = await ctx.newAsset({ ownerId: user.id });
  for (const { id } of [diaryVideo, otherVideo, photo]) {
    await ctx.newExif({ assetId: id, make: 'Canon' });
  }
  const transcripts = ctx.get(TranscriptRepository);
  await transcripts.replace({ assetId: diaryVideo.id, language: 'en', modelName: 'large-v3-turbo' }, diary);
  await transcripts.replace({ assetId: otherVideo.id, language: 'en', modelName: 'large-v3-turbo' }, [
    { startTime: 3000, endTime: 5000, text: 'Happy birthday to you.' },
  ]);
  const auth = factory.auth({ user: { id: user.id } });
  return { sut, ctx, auth, diaryVideo, otherVideo, photo };
};

describe('spoken words search', () => {
  it('should find the videos where the words were said, with the line that matched', async () => {
    const { sut, auth, diaryVideo } = await newLibrary();

    const { assets } = await sut.searchMetadata(auth, { transcript: 'full moon party', size: 100 });

    expect(assets.items.map(({ id }) => id)).toEqual([diaryVideo.id]);
    expect(assets.matchedTranscripts).toEqual([{ assetId: diaryVideo.id, ...diary[1] }]);
  });

  it('should ignore case and accents and find words that are close', async () => {
    const { sut, auth, otherVideo } = await newLibrary();

    const { assets } = await sut.searchMetadata(auth, { transcript: 'BIRTHDAYS', size: 100 });

    expect(assets.items.map(({ id }) => id)).toEqual([otherVideo.id]);
    expect(assets.matchedTranscripts).toEqual([
      { assetId: otherVideo.id, startTime: 3000, endTime: 5000, text: 'Happy birthday to you.' },
    ]);
  });

  it('should combine with the other filters', async () => {
    const { sut, auth } = await newLibrary();

    const { assets } = await sut.searchMetadata(auth, { transcript: 'full moon', make: 'Nikon', size: 100 });

    expect(assets.items).toEqual([]);
    expect(assets.matchedTranscripts).toEqual([]);
  });

  it('should find nothing for words nobody said', async () => {
    const { sut, auth } = await newLibrary();

    const { assets } = await sut.searchMetadata(auth, { transcript: 'quantum chromodynamics', size: 100 });

    expect(assets.items).toEqual([]);
  });

  it('should leave the matches out of searches without spoken words', async () => {
    const { sut, auth } = await newLibrary();

    const { assets } = await sut.searchMetadata(auth, { make: 'Canon', size: 100 });

    expect(assets.items).toHaveLength(3);
    expect(assets.matchedTranscripts).toBeUndefined();
  });

  it('should support the structured filter', async () => {
    const { sut, auth, diaryVideo } = await newLibrary();

    const { assets } = await sut.searchMetadata(auth, {
      filter: { transcript: { matches: 'full moon party' } },
      size: 100,
    });

    expect(assets.items.map(({ id }) => id)).toEqual([diaryVideo.id]);
    expect(assets.matchedTranscripts).toEqual([{ assetId: diaryVideo.id, ...diary[1] }]);
  });

  it('should only search the videos the user can see', async () => {
    const { sut, ctx } = await newLibrary();
    const { user: stranger } = await ctx.newUser();

    const { assets } = await sut.searchMetadata(factory.auth({ user: { id: stranger.id } }), {
      transcript: 'full moon party',
      size: 100,
    });

    expect(assets.items).toEqual([]);
  });
});

describe('asset transcript endpoint', () => {
  it('should return the transcript to someone who can see the video', async () => {
    const { sut, ctx } = newMediumService(AssetService, {
      database: defaultDatabase,
      real,
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    await ctx.get(TranscriptRepository).replace({ assetId: asset.id, language: 'en', modelName: 'x' }, diary);

    await expect(sut.getTranscript(factory.auth({ user: { id: user.id } }), asset.id)).resolves.toEqual({
      assetId: asset.id,
      language: 'en',
      segments: diary,
    });
    await expect(sut.getTranscript(factory.auth({ user: { id: stranger.id } }), asset.id)).rejects.toThrow();
  });
});
