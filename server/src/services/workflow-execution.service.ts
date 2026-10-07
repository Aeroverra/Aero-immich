import { CurrentPlugin } from '@extism/extism';
import {
  WorkflowChanges,
  WorkflowEventData,
  WorkflowEventPayload,
  WorkflowResponse,
  WorkflowTrigger,
} from '@immich/plugin-sdk';
import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { join } from 'node:path';
import { DummyValue, OnEvent, OnJob } from 'src/decorators';
import { AlbumsAddAssetsDto, CreateAlbumDto, GetAlbumsDto } from 'src/dtos/album.dto';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { PluginManifestDto } from 'src/dtos/plugin-manifest.dto';
import { TagBulkAssetsDto, TagUpsertDto } from 'src/dtos/tag.dto';
import { WorkflowPreviewDto, WorkflowPreviewResponseDto } from 'src/dtos/workflow.dto';
import {
  BootstrapEventPriority,
  DatabaseLock,
  ImmichEnvironment,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  WorkflowResult,
  WorkflowType,
} from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { WorkflowRepository } from 'src/repositories/workflow.repository';
import { AlbumService } from 'src/services/album.service';
import { AssetService } from 'src/services/asset.service';
import { BaseService } from 'src/services/base.service';
import { TagService } from 'src/services/tag.service';
import { JobOf } from 'src/types';
import { batched } from 'src/utils/misc';

const dummy = () => {
  throw new Error(
    `Calling host functions is not allowed without setting methods[].hostFunctions=true in the plugin manifest`,
  );
};

type ExecuteOptions<T extends WorkflowType> = {
  read: (type: T) => Promise<{ authUserId: string; data: WorkflowEventData<T>; entityId?: string }>;
  write: (auth: AuthDto, changes: WorkflowChanges<T>) => Promise<void>;
};

type AssetTrigger = { userId: string; assetId: string; trigger: WorkflowTrigger };

type WorkflowForRun = NonNullable<Awaited<ReturnType<WorkflowRepository['getForWorkflowRun']>>>;
type WorkflowStepForRun = WorkflowForRun['steps'][number];

/** how many assets a manual run or a preview reads and filters at once */
const RUN_BATCH_SIZE = 500;
/** a preview stops after this long and reports what it found so far */
const PREVIEW_TIME_LIMIT_MS = 15_000;

type HostContext = {
  allowedHosts: string[];
};

export class WorkflowExecutionService extends BaseService {
  private jwtSecret!: string;

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.PluginSync, workers: [ImmichWorker.Microservices] })
  async onPluginSync() {
    await this.databaseRepository.withLock(DatabaseLock.PluginImport, async () => {
      // TODO avoid importing plugins in each worker
      // Can this use system metadata similar to geocoding?

      const { environment, resourcePaths, plugins } = this.configRepository.getEnv();
      await this.importFolder(resourcePaths.corePlugin, { force: environment === ImmichEnvironment.Development });

      if (plugins.external.allow && plugins.external.installFolder) {
        await this.importFolders(plugins.external.installFolder);
      }
    });
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.PluginLoad, workers: [ImmichWorker.Microservices] })
  async onPluginLoad() {
    this.jwtSecret = this.cryptoRepository.randomBytesAsText(32);

    const albumService = BaseService.create(AlbumService, this);
    const tagService = BaseService.create(TagService, this);

    const searchAlbums = this.wrap<[dto: GetAlbumsDto]>((authDto, ctx, args) => albumService.getAll(authDto, ...args));
    const createAlbum = this.wrap<[dto: CreateAlbumDto]>((authDto, ctx, args) => albumService.create(authDto, ...args));
    const addAssetsToAlbum = this.wrap<[id: string, dto: BulkIdsDto]>((authDto, ctx, args) =>
      albumService.addAssets(authDto, ...args),
    );
    const addAssetsToAlbums = this.wrap<[dto: AlbumsAddAssetsDto]>((authDto, ctx, args) =>
      albumService.addAssetsToAlbums(authDto, ...args),
    );
    const httpRequest = this.wrap<
      [
        url: string,
        options?: {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        },
      ]
    >(async (authDto, context, args) => {
      const hostname = new URL(args[0]).hostname;

      for (const pattern of context.allowedHosts) {
        const regex = new RegExp(pattern.replaceAll('.', String.raw`\.`).replaceAll('*', '.*'));
        if (regex.test(hostname)) {
          // eslint-disable-next-line unicorn/no-invalid-argument-count
          const res = await fetch(...args);

          return {
            ok: res.ok,
            status: res.status,
            body: await res.text(),
          };
        }
      }

      throw new Error('Hostname did not match any listed in methods[].allowedHosts in the plugin manifest');
    });
    const bulkTagAssets = this.wrap<[dto: TagBulkAssetsDto]>((authDto, ctx, args) =>
      tagService.bulkTagAssets(authDto, ...args),
    );
    const upsertTags = this.wrap<[dto: TagUpsertDto]>((authDto, ctx, args) => tagService.upsert(authDto, ...args));

    const functions = {
      searchAlbums,
      createAlbum,
      addAssetsToAlbum,
      addAssetsToAlbums,
      httpRequest,
      bulkTagAssets,
      upsertTags,
    };

    const plugins = await this.pluginRepository.getForLoad();
    for (const { id, name, version, wasmBytes, sha256hash, methods } of plugins) {
      const isMethod = methods.some(({ hostFunctions }) => !hostFunctions);
      if (isMethod) {
        await this.loadWithoutHostFunctions({ id, name, version, wasmBytes, sha256hash });
      }

      const isMethodWithFunction = methods.some(({ hostFunctions }) => hostFunctions);
      if (isMethodWithFunction) {
        const label = `${name}@${version}/worker`;
        const key = this.getPluginKey({ id, hostFunctions: true });
        try {
          await this.pluginRepository.load({ key, label, wasmBytes }, { runInWorker: true, functions });
          this.logger.log(`Loaded plugin with host functions: ${label}`);
        } catch (error) {
          this.logger.error(`Unable to load plugin with host functions ${label} (${id})`, error);
        }
      }
    }
  }

  private async loadWithoutHostFunctions(plugin: {
    id: string;
    name: string;
    version: string;
    wasmBytes: Buffer;
    sha256hash: Buffer;
  }) {
    const stubs = {
      searchAlbums: dummy,
      createAlbum: dummy,
      addAssetsToAlbum: dummy,
      addAssetsToAlbums: dummy,
      httpRequest: dummy,
      bulkTagAssets: dummy,
      upsertTags: dummy,
    };

    const { id, wasmBytes, sha256hash } = plugin;
    const label = `${plugin.name}@${plugin.version}`;
    const key = this.getPluginKey({ id, hostFunctions: false });
    try {
      await this.pluginRepository.load({ key, label, wasmBytes, sha256hash }, { runInWorker: false, functions: stubs });
      this.logger.log(`Loaded plugin: ${label}`);
    } catch (error) {
      this.logger.error(`Unable to load plugin ${label} (${id})`, error);
    }
  }

  /**
   * previews run in the api worker, which does not load plugins at startup: load the plugins of the filters on first
   * use, and again when their manifest changed since
   */
  private async ensureFiltersLoaded(steps: WorkflowStepForRun[]) {
    for (const pluginId of new Set(steps.map((step) => step.pluginId))) {
      const key = this.getPluginKey({ id: pluginId, hostFunctions: false });
      const current = await this.pluginRepository.getHash(pluginId);
      if (!current || this.pluginRepository.isLoaded(key, current.sha256hash)) {
        continue;
      }

      const [plugin] = await this.pluginRepository.getForLoad({ id: pluginId });
      if (plugin) {
        await this.loadWithoutHostFunctions(plugin);
      }
    }
  }

  private getPluginKey({ id, hostFunctions }: { id: string; hostFunctions: boolean }) {
    return id + (hostFunctions ? '/worker' : '');
  }

  private wrap<T>(fn: (authDto: AuthDto, context: HostContext, args: T) => Promise<unknown>) {
    return async (plugin: CurrentPlugin, offset: bigint) => {
      try {
        const handle = plugin.read(offset);
        if (!handle) {
          return plugin.store(
            JSON.stringify({ success: false, status: 400, message: 'Called host function without input' }),
          );
        }

        const { authToken, args } = handle.json() as { authToken: string; args: T };
        if (!authToken) {
          throw new Error('authToken is required');
        }

        const context = plugin.hostContext<HostContext>();
        const authDto = this.validate(authToken);
        const response = await fn(authDto, context, args);

        return plugin.store(JSON.stringify({ success: true, response }));
      } catch (error: Error | any) {
        if (error instanceof HttpException) {
          this.logger.error(`Plugin host exception: ${error}`);
          return plugin.store(
            JSON.stringify({ success: false, status: error.getStatus(), message: error.getResponse() }),
          );
        }

        this.logger.error(`Plugin host exception: ${error}`, error?.stack);

        return plugin.store(
          JSON.stringify({
            success: false,
            status: 500,
            message: `Internal server error: ${error}`,
          }),
        );
      }
    };
  }

  private async importFolders(installFolder: string): Promise<void> {
    try {
      const entries = await this.storageRepository.readdirWithTypes(installFolder);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        await this.importFolder(join(installFolder, entry.name));
      }
    } catch (error) {
      this.logger.error(`Failed to import plugins folder ${installFolder}:`, error);
    }
  }

  private async importFolder(folder: string, options?: { force?: boolean }) {
    try {
      const manifestPath = join(folder, 'manifest.json');
      const bytes = await this.storageRepository.readFile(manifestPath);
      const contents = bytes.toString('utf8');
      const sha256hash = this.cryptoRepository.hashSha256(contents) as Buffer;

      if (!options?.force) {
        const match = await this.pluginRepository.getByHash(sha256hash);
        if (match) {
          this.logger.log(`Plugin up to date (name=${match.name}@${match.version}, hash=${sha256hash.toString('hex')}`);
          return;
        }
      }

      const dto = JSON.parse(contents);
      const result = PluginManifestDto.schema.safeParse(dto);
      if (!result.success) {
        const issues = result.error.issues.map((issue) => `  - [${issue.path.join('.')}] ${issue.message}`).join('\n');
        this.logger.warn(`Invalid plugin manifest at ${manifestPath}:\n${issues}`);
        return;
      }
      const manifest = result.data;

      const existing = await this.pluginRepository.getByName(manifest.name);
      const wasmPath = `${folder}/${manifest.wasmPath}`;
      const wasmBytes = await this.storageRepository.readFile(wasmPath);

      const plugin = await this.pluginRepository.upsert(
        {
          // NOTE: new properties here need to be added to the on conflict clause in the repository
          enabled: true,
          name: manifest.name,
          title: manifest.title,
          description: manifest.description,
          author: manifest.author,
          version: manifest.version,
          templates: manifest.templates,
          wasmBytes,
          sha256hash,
        },
        manifest.methods,
      );

      if (existing) {
        this.logger.log(
          `Upgraded plugin ${manifest.name} (${plugin.methods.length} methods) from ${existing.version} to ${manifest.version} `,
        );
      } else {
        this.logger.log(
          `Imported plugin ${manifest.name}@${manifest.version} (${plugin.methods.length} methods) from ${folder}`,
        );
      }

      return manifest;
    } catch {
      this.logger.warn(`Failed to import plugin from ${folder}:`);
    }
  }

  private validate(authToken: string): AuthDto {
    try {
      const jwt = this.cryptoRepository.verifyJwt<{ userId: string }>(authToken, this.jwtSecret);
      if (!jwt.userId) {
        throw new UnauthorizedException('Invalid token: missing userId');
      }

      return {
        user: {
          id: jwt.userId,
        },
      } as AuthDto;
    } catch (error) {
      this.logger.error('Token validation failed:', error);
      throw new UnauthorizedException('Invalid token');
    }
  }

  private sign(userId: string) {
    return this.cryptoRepository.signJwt({ userId }, this.jwtSecret);
  }

  @OnEvent({ name: 'AssetCreate' })
  onAssetCreate({ asset: { ownerId: userId, id: assetId } }: ArgOf<'AssetCreate'>) {
    return this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetCreate });
  }

  @OnEvent({ name: 'AssetMetadataExtracted' })
  onAssetMetadataExtracted({ userId, assetId, source }: ArgOf<'AssetMetadataExtracted'>) {
    // prevent loops
    // TODO loop detection in job service directly
    if (source === 'sidecar-write') {
      return;
    }

    return this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetMetadataExtraction });
  }

  @OnEvent({ name: 'AssetTag' })
  onAssetTagged({ assetId, userId }: ArgOf<'AssetTag'>) {
    return this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetTagged });
  }

  @OnEvent({ name: 'AssetOcr' })
  onAssetOcr({ assetId, userId }: ArgOf<'AssetOcr'>) {
    return this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetOcr });
  }

  private async onAssetTrigger({ userId, assetId, trigger }: AssetTrigger) {
    const items = await this.workflowRepository.search({ userId, trigger });
    await this.jobRepository.queueAll(
      items.map((workflow) => ({
        name: JobName.WorkflowAssetTrigger,
        data: { workflowId: workflow.id, assetId, trigger },
      })),
    );
  }

  @OnJob({ name: JobName.WorkflowRunQueueAll, queue: QueueName.Workflow })
  async handleWorkflowRun({ workflowId, runId }: JobOf<JobName.WorkflowRunQueueAll>): Promise<JobStatus> {
    const workflow = await this.workflowRepository.getForWorkflowRun(workflowId, { includeDisabled: true });
    if (!workflow) {
      return JobStatus.Skipped;
    }

    let total = 0;
    for await (const assets of batched(this.workflowRepository.streamForRun(workflow.ownerId), RUN_BATCH_SIZE)) {
      const assetIds = await this.filterAssets(
        workflow,
        assets.map(({ id }) => id),
      );
      await this.jobRepository.queueAll(
        assetIds.map((assetId) => ({
          name: JobName.WorkflowAssetTrigger,
          data: { workflowId, assetId, manualRunId: runId },
        })),
      );
      total += assetIds.length;
    }

    this.logger.log(`Workflow ${workflowId} run ${runId}: queued ${total} asset(s)`);
    return JobStatus.Success;
  }

  /** checks the leading filters of a workflow against the assets a manual run goes through, without changing them */
  async preview(workflowId: string, { limit }: WorkflowPreviewDto): Promise<WorkflowPreviewResponseDto> {
    const workflow = await this.workflowRepository.getForWorkflowRun(workflowId, { includeDisabled: true });
    if (!workflow) {
      throw new BadRequestException('Workflow not found');
    }

    const filters = this.getLeadingFilters(workflow.steps);
    await this.ensureFiltersLoaded(filters);

    const total = await this.workflowRepository.getRunAssetCount(workflow.ownerId);
    const deadline = Date.now() + PREVIEW_TIME_LIMIT_MS;
    const assetIds: string[] = [];
    let scanned = 0;
    let matched = 0;
    let complete = true;

    for await (const assets of batched(this.workflowRepository.streamForRun(workflow.ownerId), RUN_BATCH_SIZE)) {
      const matches = await this.filterAssets(
        workflow,
        assets.map(({ id }) => id),
      );
      scanned += assets.length;
      matched += matches.length;
      assetIds.push(...matches.slice(0, Math.max(0, limit - assetIds.length)));

      if (filters.length === 0) {
        // without filters every asset matches, so there is nothing left to check
        scanned = total;
        matched = total;
        break;
      }

      if (Date.now() > deadline) {
        complete = false;
        break;
      }
    }

    return { total, scanned, matched, complete, filters: filters.length, assetIds };
  }

  /** the filter steps at the start of a workflow, which can be checked without side effects */
  private getLeadingFilters(steps: WorkflowStepForRun[]) {
    const filters: WorkflowStepForRun[] = [];
    for (const step of steps) {
      if (step.methodName.startsWith('noop')) {
        continue;
      }

      if (step.hostFunctions || !step.uiHints?.includes('Filter')) {
        break;
      }

      filters.push(step);
    }

    return filters;
  }

  /** returns the assets that pass the leading filters of the workflow, in the given order */
  private async filterAssets(workflow: WorkflowForRun, assetIds: string[]) {
    const filters = this.getLeadingFilters(workflow.steps);
    if (filters.length === 0 || assetIds.length === 0) {
      return assetIds;
    }

    const type = this.getWorkflowType(workflow);
    if (!type) {
      throw new Error('Unable to infer workflow event type from steps');
    }

    const assets = await this.workflowRepository.getForAssetsV1(assetIds);
    const matches = new Set<string>();

    for (const asset of assets) {
      let isMatch = true;
      for (const step of filters) {
        const payload: WorkflowEventPayload<WorkflowType> = {
          trigger: workflow.trigger,
          type,
          config: step.config ?? {},
          workflow: { id: workflow.id, authToken: '', stepId: step.id },
          data: { asset } as any,
        };
        const result = await this.pluginRepository.callMethod<WorkflowResponse<WorkflowType>>(
          { pluginKey: this.getPluginKey({ id: step.pluginId, hostFunctions: false }), methodName: step.methodName },
          payload,
          { allowedHosts: [] } satisfies HostContext,
        );

        if (result?.workflow?.continue === false) {
          isMatch = false;
          break;
        }
      }

      if (isMatch) {
        matches.add(asset.id);
      }
    }

    return assetIds.filter((id) => matches.has(id));
  }

  private getWorkflowType(workflow: WorkflowForRun) {
    // TODO infer from steps
    for (const targetType of Object.values(WorkflowType)) {
      const isMissing = workflow.steps.some((step) => !step.types.includes(targetType));
      if (!isMissing) {
        return targetType;
      }
    }
  }

  @OnJob({ name: JobName.WorkflowAssetTrigger, queue: QueueName.Workflow })
  handleAssetTrigger({ workflowId, assetId, manualRunId }: JobOf<JobName.WorkflowAssetTrigger>) {
    return this.execute(workflowId, { manualRunId }, (type) => {
      const assetService = BaseService.create(AssetService, this);

      switch (type) {
        case WorkflowType.AssetV1: {
          return {
            read: async () => {
              const asset = await this.workflowRepository.getForAssetV1(assetId);
              return {
                data: { asset } as any,
                authUserId: asset.ownerId,
                entityId: asset.id,
              };
            },
            write: async (auth, changes) => {
              const asset = changes.asset;
              if (!asset) {
                return;
              }

              await assetService.update(auth, assetId, {
                isFavorite: asset.isFavorite,
                visibility: asset.visibility,
                dateTimeOriginal: asset.exifInfo?.dateTimeOriginal ?? undefined,
                // TODO allow setting to null
                longitude: asset.exifInfo?.longitude ?? undefined,
                // TODO allow setting to null
                latitude: asset.exifInfo?.latitude ?? undefined,
                // TODO allow setting to null
                description: asset.exifInfo?.description ?? undefined,
                rating: asset.exifInfo?.rating,

                // TODO add to update dto
                // make: asset.exifInfo?.make,
                // model: asset.exifInfo?.model,
                // city: asset.exifInfo?.city,
                // state: asset.exifInfo?.state,
                // country: asset.exifInfo?.country,
                // lensModel: asset.exifInfo?.lensModel,
                // fNumber: asset.exifInfo?.fNumber,
                // fps: asset.exifInfo?.fps,
                // iso: asset.exifInfo?.iso,
              });
            },
          } satisfies ExecuteOptions<typeof type>;
        }
      }
    });
  }

  private async execute<T extends WorkflowType>(
    workflowId: string,
    { manualRunId }: { manualRunId?: string },
    getHandler: (type: T) => ExecuteOptions<T> | undefined,
  ) {
    // a manual run is started on purpose, so it also runs a workflow that is disabled
    const workflow = await this.workflowRepository.getForWorkflowRun(workflowId, { includeDisabled: !!manualRunId });
    if (!workflow) {
      return;
    }

    const type = this.getWorkflowType(workflow) as T | undefined;
    if (!type) {
      throw new Error('Unable to infer workflow event type from steps');
    }

    const handler = getHandler(type);
    if (!handler) {
      this.logger.error(`Misconfigured workflow ${workflowId}: no handler for type ${type}`);
      return;
    }

    const { read, write } = handler;
    const readResult = await read(type);
    let data = readResult.data;
    const runId = manualRunId ?? crypto.randomUUID();
    const isManual = !!manualRunId;

    for (const step of workflow.steps) {
      try {
        const payload: WorkflowEventPayload<typeof type> = {
          trigger: workflow.trigger,
          type,
          config: step.config ?? {},
          workflow: {
            id: workflowId,
            authToken: this.sign(readResult.authUserId),
            stepId: step.id,
          },
          data,
        };

        const context: HostContext = {
          allowedHosts: step.allowedHosts,
        };

        if (step.methodName.startsWith('noop')) {
          continue;
        }

        const result = await this.pluginRepository.callMethod<WorkflowResponse<T>>(
          {
            pluginKey: this.getPluginKey({ id: step.pluginId, hostFunctions: step.hostFunctions }),
            methodName: step.methodName,
          },
          payload,
          context,
        );
        if (result?.changes) {
          await write(
            {
              user: {
                id: readResult.authUserId,
              },
              session: {
                id: DummyValue.UUID,
                hasElevatedPermission: true,
                privateMode: true,
              },
            } as AuthDto,
            result.changes,
          );
          ({ data } = await read(type));
        }

        if (result?.config) {
          await this.workflowRepository.updateStep(step.id, { config: result.config });
        }

        const shouldContinue = result?.workflow?.continue ?? true;
        if (!shouldContinue) {
          if (workflow.logging) {
            await this.workflowRepository.log({
              workflowId,
              result: WorkflowResult.Halted,
              workflowStepId: step.id,
              triggerDataId: readResult.entityId,
              runId,
              isManual,
            });
          }

          this.logger.debug(`Workflow ${workflowId} run ${runId} stopped on step ${step.id}`);
          return;
        }
      } catch (error) {
        this.logger.error(`Error executing workflow ${workflowId} run ${runId}:`, error);

        if (workflow.logging) {
          await this.workflowRepository.log({
            workflowId,
            result: WorkflowResult.Error,
            workflowStepId: step.id,
            triggerDataId: readResult.entityId,
            runId,
          });
        }

        return JobStatus.Failed;
      }
    }

    if (workflow.logging) {
      await this.workflowRepository.log({
        workflowId,
        result: WorkflowResult.Completed,
        triggerDataId: readResult.entityId,
        runId,
        isManual,
      });
    }

    this.logger.debug(`Workflow ${workflowId} run ${runId} executed successfully`);
  }
}
