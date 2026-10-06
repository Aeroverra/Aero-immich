import { WorkflowStepConfig, WorkflowTrigger } from '@immich/plugin-sdk';
import { Kysely } from 'kysely';
import { readFileSync } from 'node:fs';
import { PluginManifestDto } from 'src/dtos/plugin-manifest.dto';
import { AssetType, AssetVisibility, JobName, LogLevel } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { OcrRepository } from 'src/repositories/ocr.repository';
import { PluginRepository } from 'src/repositories/plugin.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { WorkflowRepository } from 'src/repositories/workflow.repository';
import { DB } from 'src/schema';
import { WorkflowExecutionService } from 'src/services/workflow-execution.service';
import { resolveMethod } from 'src/utils/workflow';
import { MediumTestContext } from 'test/medium.factory';
import { mockEnvData } from 'test/repositories/config.repository.mock';
import { getKyselyDB } from 'test/utils';

let isInitialized = false;

class WorkflowTestContext extends MediumTestContext<typeof WorkflowExecutionService> {
  constructor(database: Kysely<DB>) {
    super(WorkflowExecutionService, {
      database,
      real: [
        AccessRepository,
        AlbumRepository,
        AssetRepository,
        CryptoRepository,
        DatabaseRepository,
        LoggingRepository,
        OcrRepository,
        PluginRepository,
        StorageRepository,
        TagRepository,
        UserRepository,
        WorkflowRepository,
      ],
      mock: [ConfigRepository, EventRepository, JobRepository],
    });
  }

  async init() {
    if (isInitialized) {
      return;
    }

    const mockData = mockEnvData({});
    mockData.resourcePaths.corePlugin = '../packages/plugin-core';
    mockData.plugins.external.allow = false;
    this.getMock(ConfigRepository).getEnv.mockReturnValue(mockData);
    this.getMock(EventRepository).emit.mockResolvedValue();
    this.getMock(JobRepository).queueAll.mockResolvedValue();
    this.getMock(JobRepository).queue.mockResolvedValue();
    this.get(LoggingRepository).setLogLevel(LogLevel.Verbose);

    await this.sut.onPluginSync();
    await this.sut.onPluginLoad();

    isInitialized = true;
  }
}

type WorkflowTemplate = {
  ownerId: string;
  trigger: WorkflowTrigger;
  steps: WorkflowTemplateStep[];
  enabled?: boolean;
  logging?: boolean;
};

type WorkflowTemplateStep = {
  method: string;
  config?: WorkflowStepConfig;
};

const createWorkflow = async (template: WorkflowTemplate) => {
  const workflowRepo = ctx.get(WorkflowRepository);
  const pluginRepo = ctx.get(PluginRepository);

  const methods = await pluginRepo.getForValidation();
  const steps = template.steps.map((step) => {
    const pluginMethod = resolveMethod(methods, step.method);
    if (!pluginMethod) {
      throw new Error(`Plugin method not found: ${step.method}`);
    }

    return { ...step, pluginMethod };
  });

  return workflowRepo.create(
    {
      enabled: template.enabled ?? true,
      logging: template.logging ?? false,
      name: 'Test workflow',
      description: 'A workflow to test the core plugin',
      ownerId: template.ownerId,
      trigger: template.trigger,
    },
    steps.map((step) => ({
      enabled: true,
      pluginMethodId: step.pluginMethod.id,
      config: step.config,
    })),
  );
};

let ctx: WorkflowTestContext;

const isFavorite = async (assetId: string) => {
  const asset = await ctx.get(AssetRepository).getById(assetId);
  return asset?.isFavorite;
};

/** runs a workflow that favorites the asset when the given filter lets it through */
const passesFilter = async (assetId: string, ownerId: string, method: string, config: WorkflowStepConfig) => {
  const workflow = await createWorkflow({
    ownerId,
    trigger: WorkflowTrigger.AssetCreate,
    steps: [{ method: `immich-plugin-core#${method}`, config }, { method: 'immich-plugin-core#assetFavorite' }],
  });

  await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId });
  const result = await isFavorite(assetId);
  await ctx.get(AssetRepository).update({ id: assetId, isFavorite: false });
  return result;
};

const newOcrLine = (assetId: string, text: string, y = 0.5) => ({
  assetId,
  text,
  boxScore: 0.9,
  textScore: 0.9,
  x1: 0.1,
  y1: y,
  x2: 0.4,
  y2: y,
  x3: 0.4,
  y3: y + 0.02,
  x4: 0.1,
  y4: y + 0.02,
});

const addOcr = (assetId: string, lines: Array<{ text: string; y?: number }>) =>
  ctx.get(OcrRepository).upsert(
    assetId,
    lines.map(({ text, y }) => newOcrLine(assetId, text, y)),
    lines.map(({ text }) => text).join(' '),
  );

beforeAll(async () => {
  const db = await getKyselyDB();
  ctx = new WorkflowTestContext(db);
  await ctx.init();
}, 30_000);

const setupRun = async () => {
  const { user } = await ctx.newUser();
  const [{ asset: match1 }, { asset: match2 }, { asset: other }, { asset: trashed }] = await Promise.all([
    ctx.newAsset({ ownerId: user.id, originalFileName: 'someuser_2025-01-01-00-00-00_1735689600000.mp4' }),
    ctx.newAsset({ ownerId: user.id, originalFileName: 'otheruser_2025-02-01-00-00-00_1738368000000.mp4' }),
    ctx.newAsset({ ownerId: user.id, originalFileName: 'PXL_20250101_000000000.mp4' }),
    ctx.newAsset({
      ownerId: user.id,
      originalFileName: 'deleted_2025-03-01-00-00-00_1740787200000.mp4',
      deletedAt: new Date(),
    }),
  ]);

  // another user's matching asset is never part of the run
  const { user: otherUser } = await ctx.newUser();
  await ctx.newAsset({ ownerId: otherUser.id, originalFileName: 'someuser_2025-01-01-00-00-00_1735689600001.mp4' });

  const workflow = await createWorkflow({
    ownerId: user.id,
    trigger: WorkflowTrigger.AssetMetadataExtraction,
    enabled: false,
    logging: true,
    steps: [
      {
        method: 'immich-plugin-core#assetFileFilter',
        config: { pattern: String.raw`_\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d_\d{13}\.mp4$`, matchType: 'regex' },
      },
      { method: 'immich-plugin-core#assetFavorite' },
    ],
  });

  return { user, workflow, match1, match2, other, trashed };
};

describe('core plugin', () => {
  describe('validation', () => {
    it('should have a valid manifest.json', () => {
      const buffer = readFileSync('../packages/plugin-core/manifest.json');
      const result = PluginManifestDto.schema.safeParse(JSON.parse(buffer.toString()));
      if (!result.success) {
        const issues =
          'error' in result
            ? result.error.issues.map((issue) => `  - [${issue.path.join('.')}] ${issue.message}`).join('\n')
            : '';
        const message = `Invalid packages/plugin-core/manifest.json:\n${issues}`;
        expect(result.success, message).toBe(true);
      }

      expect(result.success).toBe(true);
    });
  });

  describe('assetArchive', () => {
    it('should archive an asset', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetArchive' }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({
        visibility: AssetVisibility.Archive,
      });
    });

    it('should unarchive an asset', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetArchive', config: { inverse: true } }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({
        visibility: AssetVisibility.Timeline,
      });
    });
  });

  describe('assetLock', () => {
    it('should lock an asset', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetLock' }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({
        visibility: AssetVisibility.Locked,
      });
    });

    it('should unlock an asset', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetLock', config: { inverse: true } }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({
        visibility: AssetVisibility.Timeline,
      });
    });
  });

  describe('assetFavorite', () => {
    it('should favorite an asset', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetFavorite' }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ isFavorite: true });
    });

    it('should unfavorite an asset', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetFavorite', config: { inverse: true } }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ isFavorite: false });
    });
  });

  describe('assetAddToAlbums', () => {
    it('should create an album by name', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetAddToAlbums', config: { albumIds: [], albumName: 'Screenshots' } }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      const albums = await ctx.get(AlbumRepository).getAll(user.id);
      expect(albums).toHaveLength(1);

      const album = albums[0]!;
      expect(album.albumName).toEqual('Screenshots');

      const updated = await ctx.get(WorkflowRepository).get(workflow.id);
      expect(updated?.steps[0].config).toEqual({ albumIds: [album.id], albumName: 'Screenshots' });

      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toContain(asset.id);
    });

    it('should not use the name when there is an albumId', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [
          { method: 'immich-plugin-core#assetAddToAlbums', config: { albumIds: [album.id], albumName: 'Screenshots' } },
        ],
      });

      const albums = await ctx.get(AlbumRepository).getAll(user.id);
      expect(albums).toHaveLength(1);
      expect(albums[0].albumName).toEqual(album.albumName);

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toContain(asset.id);
    });

    it('should add an asset to an album', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetAddToAlbums', config: { albumIds: [album.id] } }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toContain(asset.id);
    });

    it('should add an asset to multiple albums', async () => {
      const { user } = await ctx.newUser();
      const [{ asset }, { album: album1 }, { album: album2 }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, isFavorite: true }),
        ctx.newAlbum({ ownerId: user.id }),
        ctx.newAlbum({ ownerId: user.id }),
      ]);

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetAddToAlbums', config: { albumIds: [album1.id, album2.id] } }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

      await expect(ctx.get(AlbumRepository).getAssetIds(album1.id, [asset.id])).resolves.toContain(asset.id);
      await expect(ctx.get(AlbumRepository).getAssetIds(album2.id, [asset.id])).resolves.toContain(asset.id);
    });

    it('should require album access', async () => {
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user1.id, isFavorite: true });
      const { album } = await ctx.newAlbum({ ownerId: user2.id });

      const workflow = await createWorkflow({
        ownerId: user1.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetAddToAlbums', config: { albumIds: [album.id] } }],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeTruthy();

      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.not.toContain(asset.id);
    });
  });

  describe('assetLocationFilter', () => {
    it('should favorite an asset within a given radius', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, latitude: 49.27335322114536, longitude: -123.10387144078764 });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetMetadataExtraction,
        steps: [
          {
            method: 'immich-plugin-core#assetLocationFilter',
            config: { coordinate: { latitude: 49.28882167994929, longitude: -123.1111530988137, radius: 2 } },
          },
          {
            method: 'immich-plugin-core#assetFavorite',
          },
        ],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();
      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ isFavorite: true });
    });

    it('should not favorite asset outside a given radius', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, latitude: 49.26126605257035, longitude: -123.24895939078196 });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetMetadataExtraction,
        steps: [
          {
            method: 'immich-plugin-core#assetLocationFilter',
            config: { coordinate: { latitude: 49.28882167994929, longitude: -123.1111530988137, radius: 10 } },
          },
          {
            method: 'immich-plugin-core#assetFavorite',
          },
        ],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();
      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ isFavorite: false });
    });

    it('should favorite asset by location name', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, city: 'Vancouver' });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetMetadataExtraction,
        steps: [
          {
            method: 'immich-plugin-core#assetLocationFilter',
            config: { region: { city: 'Vancouver' } },
          },
          {
            method: 'immich-plugin-core#assetFavorite',
          },
        ],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();
      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ isFavorite: true });
    });
  });

  describe('assetFileFilter', () => {
    it('should match assets case-insensitively', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, originalFileName: 'exampleFile.png' }),
        ctx.newAsset({ ownerId: user.id, originalFileName: 'anotherfile.jpg' }),
      ]);

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [
          {
            method: 'immich-plugin-core#assetFileFilter',
            config: { matchType: 'contains', pattern: 'File' },
          },
          {
            method: 'immich-plugin-core#assetFavorite',
          },
        ],
      });

      await expect(
        ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset1.id }),
      ).resolves.toBeUndefined();
      await expect(
        ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset2.id }),
      ).resolves.toBeUndefined();
      await expect(ctx.get(AssetRepository).getById(asset1.id)).resolves.toMatchObject({ isFavorite: true });
      await expect(ctx.get(AssetRepository).getById(asset2.id)).resolves.toMatchObject({ isFavorite: true });
    });

    it('should match assets by regex', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, originalFileName: 'exampleFile.png' }),
        ctx.newAsset({ ownerId: user.id, originalFileName: 'anotherfile.jpg' }),
      ]);

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [
          {
            method: 'immich-plugin-core#assetFileFilter',
            config: { matchType: 'regex', pattern: '.+png' },
          },
          {
            method: 'immich-plugin-core#assetFavorite',
          },
        ],
      });

      await expect(
        ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset1.id }),
      ).resolves.toBeUndefined();
      await expect(
        ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset2.id }),
      ).resolves.toBeUndefined();
      await expect(ctx.get(AssetRepository).getById(asset1.id)).resolves.toMatchObject({ isFavorite: true });
      await expect(ctx.get(AssetRepository).getById(asset2.id)).resolves.toMatchObject({ isFavorite: false });
    });

    it('should filter assets by path if specified', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, originalPath: '/library/folder/file1.png' }),
        ctx.newAsset({ ownerId: user.id, originalPath: '/library/file2.png' }),
      ]);

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [
          {
            method: 'immich-plugin-core#assetFileFilter',
            config: { matchType: 'contains', pattern: 'folder', usePath: true },
          },
          {
            method: 'immich-plugin-core#assetFavorite',
          },
        ],
      });

      await expect(
        ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset1.id }),
      ).resolves.toBeUndefined();
      await expect(
        ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset2.id }),
      ).resolves.toBeUndefined();
      await expect(ctx.get(AssetRepository).getById(asset1.id)).resolves.toMatchObject({ isFavorite: true });
      await expect(ctx.get(AssetRepository).getById(asset2.id)).resolves.toMatchObject({ isFavorite: false });
    });
  });

  describe('assetTypeFilter', () => {
    it('should favorite asset if it is a video', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [
          {
            method: 'immich-plugin-core#assetTypeFilter',
            config: { allowedTypes: ['VIDEO'] },
          },
          {
            method: 'immich-plugin-core#assetFavorite',
          },
        ],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();
      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ isFavorite: true });
    });
  });

  describe('assetDateFilter', () => {
    it('should favorite assets created during the first 7 days of a specific year and month', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: asset1 }, { asset: asset2 }, { asset: asset3 }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, localDateTime: new Date('2000-04-01') }),
        ctx.newAsset({ ownerId: user.id, localDateTime: new Date('2000-04-07T23:59:59Z') }),
        ctx.newAsset({ ownerId: user.id, localDateTime: new Date('2000-04-08T00:00:00Z') }),
      ]);

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [
          {
            method: 'immich-plugin-core#assetDateFilter',
            config: {
              startDate: { day: 1, month: 4, year: 2000 },
              endDate: { day: 7, month: 4, year: 2000 },
              recurring: false,
            },
          },
          {
            method: 'immich-plugin-core#assetFavorite',
          },
        ],
      });

      await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset1.id });
      await expect(ctx.get(AssetRepository).getById(asset1.id)).resolves.toMatchObject({ isFavorite: true });

      await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset2.id });
      await expect(ctx.get(AssetRepository).getById(asset2.id)).resolves.toMatchObject({ isFavorite: true });

      await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset3.id });
      await expect(ctx.get(AssetRepository).getById(asset3.id)).resolves.toMatchObject({ isFavorite: false });
    });

    it('should match recurring dates regardless of the year', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: asset1 }, { asset: asset2 }, { asset: asset3 }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, localDateTime: new Date('2026-03-01') }),
        ctx.newAsset({ ownerId: user.id, localDateTime: new Date('1998-12-21') }),
        ctx.newAsset({ ownerId: user.id, localDateTime: new Date('2000-04-08T00:00:00Z') }),
      ]);
      await ctx.newAsset({ ownerId: user.id, localDateTime: new Date('2010-06-15') });

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [
          {
            method: 'immich-plugin-core#assetDateFilter',
            config: {
              startDate: { day: 12, month: 12, year: 2000 },
              endDate: { day: 30, month: 3, year: 2001 },
              recurring: true,
            },
          },
          {
            method: 'immich-plugin-core#assetFavorite',
          },
        ],
      });

      await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset1.id });
      await expect(ctx.get(AssetRepository).getById(asset1.id)).resolves.toMatchObject({ isFavorite: true });

      await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset2.id });
      await expect(ctx.get(AssetRepository).getById(asset2.id)).resolves.toMatchObject({ isFavorite: true });

      await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset3.id });
      await expect(ctx.get(AssetRepository).getById(asset3.id)).resolves.toMatchObject({ isFavorite: false });
    });
  });

  describe('assetFileFilter inverse', () => {
    it('should keep assets that do not match', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: screenshot }, { asset: video }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, originalFileName: 'Screenshot_20250101-000000.png' }),
        ctx.newAsset({ ownerId: user.id, originalFileName: 'someuser_2025-01-01-00-00-00_1735689600000.mp4' }),
      ]);
      const config = { pattern: '^(Screenshot|screen-)', matchType: 'regex', inverse: true };

      await expect(passesFilter(screenshot.id, user.id, 'assetFileFilter', config)).resolves.toBe(false);
      await expect(passesFilter(video.id, user.id, 'assetFileFilter', config)).resolves.toBe(true);
    });

    it('should not lowercase escapes of a case-insensitive regex', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: digits }, { asset: letters }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, originalFileName: '1234.jpg' }),
        ctx.newAsset({ ownerId: user.id, originalFileName: 'abcd.jpg' }),
      ]);
      // \D would turn into \d when lowercased
      const config = { pattern: String.raw`^\D+\.JPG$`, matchType: 'regex', caseSensitive: false };

      await expect(passesFilter(digits.id, user.id, 'assetFileFilter', config)).resolves.toBe(false);
      await expect(passesFilter(letters.id, user.id, 'assetFileFilter', config)).resolves.toBe(true);
    });
  });

  describe('assetExifFilter', () => {
    it('should match an empty camera make', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: camera }, { asset: download }, { asset: noExif }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
      ]);
      await ctx.newExif({ assetId: camera.id, make: 'Google', model: 'Pixel' });
      await ctx.newExif({ assetId: download.id, make: null, exifImageWidth: 576 });

      const config = { property: 'make', matchType: 'empty' };
      await expect(passesFilter(camera.id, user.id, 'assetExifFilter', config)).resolves.toBe(false);
      await expect(passesFilter(download.id, user.id, 'assetExifFilter', config)).resolves.toBe(true);
      await expect(passesFilter(noExif.id, user.id, 'assetExifFilter', config)).resolves.toBe(true);

      const inverse = { ...config, inverse: true };
      await expect(passesFilter(camera.id, user.id, 'assetExifFilter', inverse)).resolves.toBe(true);
      await expect(passesFilter(download.id, user.id, 'assetExifFilter', inverse)).resolves.toBe(false);
    });

    it('should match numbers by regex and invert the result', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: narrow }, { asset: wide }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
      ]);
      await ctx.newExif({ assetId: narrow.id, exifImageWidth: 576 });
      await ctx.newExif({ assetId: wide.id, exifImageWidth: 1920 });

      const config = { property: 'exifImageWidth', pattern: '^(540|576)$', matchType: 'regex' };
      await expect(passesFilter(narrow.id, user.id, 'assetExifFilter', config)).resolves.toBe(true);
      await expect(passesFilter(wide.id, user.id, 'assetExifFilter', config)).resolves.toBe(false);
      await expect(passesFilter(wide.id, user.id, 'assetExifFilter', { ...config, inverse: true })).resolves.toBe(true);
    });
  });

  describe('assetOcrFilter', () => {
    it('should match the recognized text', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: watermark }, { asset: other }, { asset: noText }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
      ]);
      await addOcr(watermark.id, [{ text: 'TikTok' }, { text: '@someuser' }]);
      await addOcr(other.id, [{ text: 'Happy birthday' }]);

      const config = { pattern: String.raw`\btik\s?tok\b`, matchType: 'regex' };
      await expect(passesFilter(watermark.id, user.id, 'assetOcrFilter', config)).resolves.toBe(true);
      await expect(passesFilter(other.id, user.id, 'assetOcrFilter', config)).resolves.toBe(false);
      await expect(passesFilter(noText.id, user.id, 'assetOcrFilter', config)).resolves.toBe(false);
      await expect(passesFilter(noText.id, user.id, 'assetOcrFilter', { ...config, inverse: true })).resolves.toBe(
        true,
      );
      await expect(
        passesFilter(other.id, user.id, 'assetOcrFilter', { pattern: 'happy birthday', matchType: 'exact' }),
      ).resolves.toBe(true);
      await expect(
        passesFilter(noText.id, user.id, 'assetOcrFilter', { pattern: '', matchType: 'empty' }),
      ).resolves.toBe(true);
    });

    it('should only use text in the given area', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: statusBar }, { asset: lowerClock }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
      ]);
      await addOcr(statusBar.id, [
        { text: '9:41', y: 0.01 },
        { text: 'Messages', y: 0.3 },
      ]);
      await addOcr(lowerClock.id, [{ text: 'Meet at 9:41', y: 0.6 }]);

      const config = { pattern: String.raw`(^|\D)([01]?\d|2[0-3]):[0-5]\d(\D|$)`, matchType: 'regex', maxY: 0.045 };
      await expect(passesFilter(statusBar.id, user.id, 'assetOcrFilter', config)).resolves.toBe(true);
      await expect(passesFilter(lowerClock.id, user.id, 'assetOcrFilter', config)).resolves.toBe(false);
      await expect(passesFilter(lowerClock.id, user.id, 'assetOcrFilter', { ...config, maxY: 1 })).resolves.toBe(true);
    });

    it('should ignore hidden text', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await addOcr(asset.id, [{ text: 'TikTok' }]);
      await ctx.database.updateTable('asset_ocr').set({ isVisible: false }).where('assetId', '=', asset.id).execute();

      await expect(passesFilter(asset.id, user.id, 'assetOcrFilter', { pattern: 'tiktok' })).resolves.toBe(false);
    });
  });

  describe('assetDimensionFilter', () => {
    it('should match an aspect ratio with a tolerance', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: portrait }, { asset: almost }, { asset: landscape }, { asset: unknown }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, width: 1080, height: 1440 }),
        ctx.newAsset({ ownerId: user.id, width: 1080, height: 1436 }),
        ctx.newAsset({ ownerId: user.id, width: 1440, height: 1080 }),
        ctx.newAsset({ ownerId: user.id, width: null, height: null }),
      ]);

      const config = { aspectRatio: '3:4', tolerance: 1.5 };
      await expect(passesFilter(portrait.id, user.id, 'assetDimensionFilter', config)).resolves.toBe(true);
      await expect(passesFilter(almost.id, user.id, 'assetDimensionFilter', config)).resolves.toBe(true);
      await expect(passesFilter(landscape.id, user.id, 'assetDimensionFilter', config)).resolves.toBe(false);
      await expect(passesFilter(unknown.id, user.id, 'assetDimensionFilter', config)).resolves.toBe(false);
      await expect(
        passesFilter(landscape.id, user.id, 'assetDimensionFilter', { orientation: 'landscape' }),
      ).resolves.toBe(true);
      await expect(
        passesFilter(portrait.id, user.id, 'assetDimensionFilter', { orientation: 'landscape', inverse: true }),
      ).resolves.toBe(true);
    });

    it('should fall back to the exif dimensions', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, width: null, height: null });
      await ctx.newExif({ assetId: asset.id, exifImageWidth: 1200, exifImageHeight: 1600 });

      await expect(passesFilter(asset.id, user.id, 'assetDimensionFilter', { aspectRatio: '3:4' })).resolves.toBe(true);
    });
  });

  describe('assetAddTags', () => {
    it('should create a tag by name and keep using it', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
      ]);

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetAddTags', config: { tags: [], tagName: 'Downloads/TikTok' } }],
      });

      await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset1.id });
      await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset2.id });

      const tags = await ctx.get(TagRepository).getAll(user.id);
      const tag = tags.find(({ value }) => value === 'Downloads/TikTok');
      expect(tag).toBeDefined();
      expect(tags.filter(({ value }) => value === 'Downloads/TikTok')).toHaveLength(1);

      const updated = await ctx.get(WorkflowRepository).get(workflow.id);
      expect(updated?.steps[0].config).toEqual({ tags: [tag!.id], tagName: 'Downloads/TikTok' });

      const tagged = await ctx.database
        .selectFrom('tag_asset')
        .select('assetId')
        .where('tagId', '=', tag!.id)
        .execute();
      expect(tagged.map(({ assetId }) => assetId).toSorted()).toEqual([asset1.id, asset2.id].toSorted());
    });
  });

  describe('AssetOcr trigger', () => {
    it('should queue the workflows that run after text recognition', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const ocrWorkflow = await createWorkflow({ ownerId: user.id, trigger: WorkflowTrigger.AssetOcr, steps: [] });
      await createWorkflow({ ownerId: user.id, trigger: WorkflowTrigger.AssetCreate, steps: [] });
      const queueAll = ctx.getMock(JobRepository).queueAll;
      queueAll.mockClear();

      await ctx.sut.onAssetOcr({ assetId: asset.id, userId: user.id });

      expect(queueAll).toHaveBeenCalledWith([
        {
          name: JobName.WorkflowAssetTrigger,
          data: { workflowId: ocrWorkflow.id, assetId: asset.id, trigger: WorkflowTrigger.AssetOcr },
        },
      ]);
    });
  });

  describe('manual runs', () => {
    it('should preview the matching assets without changing them', async () => {
      const { workflow, match1, match2, other } = await setupRun();

      const preview = await ctx.sut.preview(workflow.id, { limit: 1 });

      expect(preview).toEqual({
        total: 3,
        scanned: 3,
        matched: 2,
        complete: true,
        filters: 1,
        assetIds: [expect.any(String)],
      });
      expect([match1.id, match2.id]).toContain(preview.assetIds[0]);
      await expect(isFavorite(match1.id)).resolves.toBe(false);
      await expect(isFavorite(other.id)).resolves.toBe(false);
    });

    it('should count every asset when there are no filters', async () => {
      const { user } = await ctx.newUser();
      await Promise.all([ctx.newAsset({ ownerId: user.id }), ctx.newAsset({ ownerId: user.id })]);
      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ method: 'immich-plugin-core#assetFavorite' }],
      });

      await expect(ctx.sut.preview(workflow.id, { limit: 12 })).resolves.toEqual({
        total: 2,
        scanned: 2,
        matched: 2,
        complete: true,
        filters: 0,
        assetIds: [expect.any(String), expect.any(String)],
      });
    });

    it('should queue only matching assets and run a disabled workflow on them', async () => {
      const { workflow, match1, match2, other, trashed } = await setupRun();
      const queueAll = ctx.getMock(JobRepository).queueAll;
      queueAll.mockClear();
      const runId = '2b3f4e2c-6f1d-4a4e-9c55-6f0a6a3c1e11';

      await expect(ctx.sut.handleWorkflowRun({ workflowId: workflow.id, runId })).resolves.toBe('success');

      const jobs = queueAll.mock.calls.flatMap(([items]) => items);
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job).toMatchObject({
          name: JobName.WorkflowAssetTrigger,
          data: { workflowId: workflow.id, manualRunId: runId },
        });
        await ctx.sut.handleAssetTrigger(job.data as any);
      }

      await expect(isFavorite(match1.id)).resolves.toBe(true);
      await expect(isFavorite(match2.id)).resolves.toBe(true);
      await expect(isFavorite(other.id)).resolves.toBe(false);
      await expect(isFavorite(trashed.id)).resolves.toBe(false);

      const logs = await ctx.get(WorkflowRepository).getLogs(workflow.id, { limit: 10 });
      expect(logs).toHaveLength(2);
      expect(logs.every((log) => log.runId === runId && log.isManual && log.result === 'completed')).toBe(true);
    });

    it('should not run a disabled workflow from its trigger', async () => {
      const { workflow, match1 } = await setupRun();

      await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: match1.id });

      await expect(isFavorite(match1.id)).resolves.toBe(false);
    });
  });

  describe('webhook', () => {
    it('should trigger a webhook on asset upload', async () => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') }));
      vi.stubGlobal('fetch', fetchMock);

      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        steps: [
          {
            method: 'immich-plugin-core#webhook',
            config: { url: 'http://localhost', method: 'POST' },
          },
        ],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalled();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });
  });
});
