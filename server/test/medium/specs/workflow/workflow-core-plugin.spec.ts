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
import { isMethodCompatible, resolveMethod } from 'src/utils/workflow';
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

const manifest = JSON.parse(readFileSync('../packages/plugin-core/manifest.json').toString()) as PluginManifestDto;

const runTemplate = async (name: string, assetId: string, ownerId: string) => {
  const template = manifest.templates.find((template) => template.name === name)!;
  // swap the action for a favorite, to see which assets the filters let through
  const filters = template.steps.filter((step) => !step.method.endsWith('#assetAddTags'));
  const steps = [...filters, { method: 'immich-plugin-core#assetFavorite' }] as WorkflowTemplateStep[];
  const workflow = await createWorkflow({ ownerId, trigger: template.trigger as WorkflowTrigger, steps });
  await ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId });
  return isFavorite(assetId);
};

const fileFilter = (pattern: string, extra: Record<string, unknown> = {}) => ({
  method: 'immich-plugin-core#assetFileFilter',
  config: { pattern, matchType: 'regex', ...extra },
});
const typeFilter = (allowedTypes: string[]) => ({
  method: 'immich-plugin-core#assetTypeFilter',
  config: { allowedTypes },
});
const filterGroup = (mode: string, filters: WorkflowTemplateStep[]): WorkflowTemplateStep => ({
  method: 'immich-plugin-core#assetFilterGroup',
  config: { mode, filters } as WorkflowStepConfig,
});

const setupFilterGroup = async () => {
  const { user } = await ctx.newUser();
  const [{ asset: beach }, { asset: party }, { asset: partyClip }, { asset: other }] = await Promise.all([
    ctx.newAsset({ ownerId: user.id, originalFileName: 'beach_day.jpg' }),
    ctx.newAsset({ ownerId: user.id, originalFileName: 'party_night.jpg' }),
    ctx.newAsset({ ownerId: user.id, originalFileName: 'party_clip.mp4', type: AssetType.Video }),
    ctx.newAsset({ ownerId: user.id, originalFileName: 'receipt.jpg' }),
  ]);
  return { user, beach, party, partyClip, other };
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

  describe('assetFilterGroup', () => {
    it('should let an asset through when any filter matches', async () => {
      const { user, beach, party, other } = await setupFilterGroup();
      const config = { mode: 'any', filters: [fileFilter('^beach_'), fileFilter('^party_')] };

      await expect(passesFilter(beach.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
      await expect(passesFilter(party.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
      await expect(passesFilter(other.id, user.id, 'assetFilterGroup', config)).resolves.toBe(false);
    });

    it('should use any when the mode is missing', async () => {
      const { user, beach, other } = await setupFilterGroup();
      const config = { filters: [fileFilter('^receipt'), fileFilter('^beach_')] };

      await expect(passesFilter(beach.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
      await expect(passesFilter(other.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
    });

    it('should require every filter to match with all', async () => {
      const { user, party, partyClip } = await setupFilterGroup();
      const config = { mode: 'all', filters: [fileFilter('^party_'), typeFilter(['VIDEO'])] };

      await expect(passesFilter(partyClip.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
      await expect(passesFilter(party.id, user.id, 'assetFilterGroup', config)).resolves.toBe(false);
    });

    it('should let an asset through when no filter matches with none', async () => {
      const { user, beach, party, other } = await setupFilterGroup();
      const config = { mode: 'none', filters: [fileFilter('^beach_'), fileFilter('^party_')] };

      await expect(passesFilter(other.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
      await expect(passesFilter(beach.id, user.id, 'assetFilterGroup', config)).resolves.toBe(false);
      await expect(passesFilter(party.id, user.id, 'assetFilterGroup', config)).resolves.toBe(false);
    });

    it('should evaluate nested groups', async () => {
      const { user, beach, party, partyClip, other } = await setupFilterGroup();
      // beach photos, or party videos
      const config = {
        mode: 'any',
        filters: [fileFilter('^beach_'), filterGroup('all', [fileFilter('^party_'), typeFilter(['VIDEO'])])],
      };

      await expect(passesFilter(beach.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
      await expect(passesFilter(partyClip.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
      await expect(passesFilter(party.id, user.id, 'assetFilterGroup', config)).resolves.toBe(false);
      await expect(passesFilter(other.id, user.id, 'assetFilterGroup', config)).resolves.toBe(false);
    });

    it.each(['any', 'all', 'none'])('should let every asset through when the group is empty (%s)', async (mode) => {
      const { user, other } = await setupFilterGroup();

      await expect(passesFilter(other.id, user.id, 'assetFilterGroup', { mode, filters: [] })).resolves.toBe(true);
      await expect(passesFilter(other.id, user.id, 'assetFilterGroup', { mode })).resolves.toBe(true);
    });

    it('should honor inverse on a filter inside a group', async () => {
      const { user, party, partyClip, other } = await setupFilterGroup();
      // party assets that are not videos
      const config = {
        mode: 'all',
        filters: [fileFilter('^party_'), fileFilter(String.raw`\.mp4$`, { inverse: true })],
      };

      await expect(passesFilter(party.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
      await expect(passesFilter(partyClip.id, user.id, 'assetFilterGroup', config)).resolves.toBe(false);
      await expect(passesFilter(other.id, user.id, 'assetFilterGroup', config)).resolves.toBe(false);
    });

    it('should check exif values inside a group like in a step', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: camera }, { asset: download }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
      ]);
      await ctx.newExif({ assetId: camera.id, make: 'Canon' });
      const config = {
        mode: 'all',
        filters: [{ method: 'immich-plugin-core#assetExifFilter', config: { property: 'make', matchType: 'empty' } }],
      };

      await expect(passesFilter(download.id, user.id, 'assetFilterGroup', config)).resolves.toBe(true);
      await expect(passesFilter(camera.id, user.id, 'assetFilterGroup', config)).resolves.toBe(false);
    });

    it('should fail the run when the group holds something that is not a filter', async () => {
      const { user, beach } = await setupFilterGroup();
      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetCreate,
        logging: true,
        steps: [
          filterGroup('any', [{ method: 'immich-plugin-core#assetFavorite', config: {} }]),
          { method: 'immich-plugin-core#assetFavorite' },
        ],
      });

      await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: beach.id })).resolves.toBe('failed');
      await expect(isFavorite(beach.id)).resolves.toBe(false);
      const logs = await ctx.get(WorkflowRepository).getLogs(workflow.id, { limit: 10 });
      expect(logs.map(({ result }) => result)).toEqual(['error']);
    });

    it('should preview and run a workflow that starts with a group', async () => {
      const { user, beach, partyClip, party, other } = await setupFilterGroup();
      const workflow = await createWorkflow({
        ownerId: user.id,
        trigger: WorkflowTrigger.AssetMetadataExtraction,
        enabled: false,
        steps: [
          filterGroup('any', [
            fileFilter('^beach_'),
            filterGroup('all', [fileFilter('^party_'), typeFilter(['VIDEO'])]),
          ]),
          { method: 'immich-plugin-core#assetFavorite' },
        ],
      });

      const preview = await ctx.sut.preview(workflow.id, { limit: 12 });
      expect(preview).toMatchObject({ total: 4, scanned: 4, matched: 2, complete: true, filters: 1 });
      expect(preview.assetIds.toSorted()).toEqual([beach.id, partyClip.id].toSorted());
      await expect(isFavorite(beach.id)).resolves.toBe(false);

      const queueAll = ctx.getMock(JobRepository).queueAll;
      queueAll.mockClear();
      const runId = '6c1d2f4a-8b3e-4d5f-9a7b-1c2d3e4f5a6b';
      await expect(ctx.sut.handleWorkflowRun({ workflowId: workflow.id, runId })).resolves.toBe('success');
      const jobs = queueAll.mock.calls.flatMap(([items]) => items);
      expect(jobs.map((job) => (job.data as { assetId: string }).assetId).toSorted()).toEqual(
        [beach.id, partyClip.id].toSorted(),
      );
      for (const job of jobs) {
        await ctx.sut.handleAssetTrigger(job.data as any);
      }

      await expect(isFavorite(beach.id)).resolves.toBe(true);
      await expect(isFavorite(partyClip.id)).resolves.toBe(true);
      await expect(isFavorite(party.id)).resolves.toBe(false);
      await expect(isFavorite(other.id)).resolves.toBe(false);
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

  describe('templates', () => {
    it('should only use known methods compatible with their trigger', async () => {
      const methods = await ctx.get(PluginRepository).getForValidation();
      for (const template of manifest.templates) {
        for (const step of template.steps) {
          const method = resolveMethod(methods, step.method);
          expect(method, `${template.name}: ${step.method}`).toBeDefined();
          expect(isMethodCompatible(method!, template.trigger as WorkflowTrigger)).toBe(true);
        }
      }
    });

    it('should only put filters of the core plugin in groups', () => {
      const filters = new Set(
        manifest.methods
          .filter(({ uiHints }) => uiHints?.includes('Filter'))
          .map(({ name }) => `immich-plugin-core#${name}`),
      );
      const check = (name: string, steps: Array<{ method: string; config?: Record<string, unknown> | null }>) => {
        for (const step of steps) {
          if (step.method !== 'immich-plugin-core#assetFilterGroup') {
            continue;
          }

          const children = (step.config?.filters ?? []) as typeof steps;
          expect(children.length, `${name}: empty group`).toBeGreaterThan(0);
          for (const child of children) {
            expect(filters.has(child.method), `${name}: ${child.method}`).toBe(true);
          }
          check(name, children);
        }
      };

      for (const template of manifest.templates) {
        check(template.name, template.steps);
      }
    });

    it('should have one template per pack and keep the status bar on its own', () => {
      const names = manifest.templates.map(({ name }) => name);
      expect(names).toEqual(
        expect.arrayContaining(['screenshots-smart-album', 'screenshots-status-bar', 'tiktok-downloads']),
      );
      expect(names.filter((name) => name.startsWith('tiktok-'))).toEqual(['tiktok-downloads']);
      for (const name of ['screenshots-smart-album', 'screenshots-status-bar', 'tiktok-downloads']) {
        const template = manifest.templates.find((template) => template.name === name)!;
        // rule hits go to a tag to review, not straight into a curated one
        expect(template.steps.at(-1)).toMatchObject({
          method: 'immich-plugin-core#assetAddTags',
          config: { tags: [], tagName: expect.stringMatching(/^review\//) },
        });
      }
    });

    it.each([
      ['someuser_2025-01-01-00-00-00_1735689600000.mp4', true],
      ['some.user_2025-01-01-00-00-00_1735689600000_mute (1).mp4', true],
      ['ssstik.io_1735689600000.mp4', true],
      ['Snaptik.app_7123456789012345678.mp4', true],
      ['v12044gd0000abcdefghijklmnopqrst.mp4', true],
      ['7123456789012345678.mp4', true],
      ['12345678_7123456789012345678_1234567890123456_n.jpg', false],
      ['PXL_20250101_000000000.mp4', false],
      ['IMG_1234.MOV', false],
    ])('should recognize TikTok file names: %s', async (originalFileName, expected) => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName, type: AssetType.Video });
      await expect(runTemplate('tiktok-downloads', asset.id, user.id)).resolves.toBe(expected);
    });

    it('should recognize older TikTok saves by name, width and missing make', async () => {
      const { user } = await ctx.newUser();
      const name = '0123456789abcdef0123456789abcdef.mp4';
      const [{ asset: save }, { asset: camera }, { asset: wide }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, originalFileName: name, type: AssetType.Video }),
        ctx.newAsset({ ownerId: user.id, originalFileName: name, type: AssetType.Video }),
        ctx.newAsset({ ownerId: user.id, originalFileName: name, type: AssetType.Video }),
      ]);
      await ctx.newExif({ assetId: save.id, make: null, exifImageWidth: 576 });
      await ctx.newExif({ assetId: camera.id, make: 'Apple', exifImageWidth: 576 });
      await ctx.newExif({ assetId: wide.id, make: null, exifImageWidth: 1080 });

      await expect(runTemplate('tiktok-downloads', save.id, user.id)).resolves.toBe(true);
      await expect(runTemplate('tiktok-downloads', camera.id, user.id)).resolves.toBe(false);
      await expect(runTemplate('tiktok-downloads', wide.id, user.id)).resolves.toBe(false);
    });

    it('should recognize photo mode images by name, ratio and missing make', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: png }, { asset: jpg }, { asset: square }] = await Promise.all([
        ctx.newAsset({
          ownerId: user.id,
          originalFileName: '0123456789abcdef0123456789abcdef.png',
          width: 1080,
          height: 1440,
        }),
        ctx.newAsset({
          ownerId: user.id,
          originalFileName: '0123456789abcdef0123456789abcdef.jpg',
          width: 1080,
          height: 1440,
        }),
        ctx.newAsset({
          ownerId: user.id,
          originalFileName: '0123456789abcdef0123456789abcdef.png',
          width: 1080,
          height: 1080,
        }),
      ]);

      await expect(runTemplate('tiktok-downloads', png.id, user.id)).resolves.toBe(true);
      await expect(runTemplate('tiktok-downloads', jpg.id, user.id)).resolves.toBe(false);
      await expect(runTemplate('tiktok-downloads', square.id, user.id)).resolves.toBe(false);
    });

    it('should recognize the TikTok watermark but not screen recordings of the app', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: download }, { asset: recording }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, originalFileName: 'video_2025.mp4', type: AssetType.Video }),
        ctx.newAsset({ ownerId: user.id, originalFileName: 'Screen_Recording_20250101.mp4', type: AssetType.Video }),
      ]);
      await addOcr(download.id, [{ text: 'TikTok' }, { text: '@someuser' }]);
      await addOcr(recording.id, [{ text: 'TikTok' }]);

      await expect(runTemplate('tiktok-downloads', download.id, user.id)).resolves.toBe(true);
      await expect(runTemplate('tiktok-downloads', recording.id, user.id)).resolves.toBe(false);
    });

    it.each([
      ['Screenshot_20250101-000000.png', true],
      ['Screenshot 2025-01-01 at 00.00.00.png', true],
      ['screen-20250101-000000.mp4', true],
      ['RPReplay_Final1735689600.MP4', true],
      ['Bildschirmfoto 2025-01-01 um 00.00.00.png', true],
      ['Capture d’écran 2025-01-01.png', true],
      ['IMG_1234.JPG', false],
      ['IMG_1234.PNG', true],
      ['screenplay.pdf', false],
    ])('should recognize screenshot file names: %s', async (originalFileName, expected) => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName });
      await expect(runTemplate('screenshots-smart-album', asset.id, user.id)).resolves.toBe(expected);
    });

    it('should recognize iPhone screenshots by name and missing make', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: screenshot }, { asset: photo }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_1234.PNG' }),
        ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_1235.PNG' }),
      ]);
      await ctx.newExif({ assetId: photo.id, make: 'Apple' });

      await expect(runTemplate('screenshots-smart-album', screenshot.id, user.id)).resolves.toBe(true);
      await expect(runTemplate('screenshots-smart-album', photo.id, user.id)).resolves.toBe(false);
    });

    it('should recognize a status bar clock', async () => {
      const { user } = await ctx.newUser();
      const [{ asset: screenshot }, { asset: photo }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id, originalFileName: 'image.jpg' }),
        ctx.newAsset({ ownerId: user.id, originalFileName: 'image.jpg' }),
      ]);
      await addOcr(screenshot.id, [
        { text: '12:30', y: 0.01 },
        { text: 'Settings', y: 0.1 },
      ]);
      await addOcr(photo.id, [{ text: 'Open 9:00 to 17:00', y: 0.5 }]);

      await expect(runTemplate('screenshots-status-bar', screenshot.id, user.id)).resolves.toBe(true);
      await expect(runTemplate('screenshots-status-bar', photo.id, user.id)).resolves.toBe(false);
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
