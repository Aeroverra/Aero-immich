import { BadRequestException, ConflictException } from '@nestjs/common';
import { TakeoutLargerVersionAction } from 'src/dtos/takeout.dto';
import { TakeoutRunStatus } from 'src/enum';
import { TakeoutService } from 'src/services/takeout.service';
import { authStub } from 'test/fixtures/auth.stub';
import { newTestService, ServiceMocks } from 'test/utils';
import { beforeEach, describe, expect, it, vitest } from 'vitest';

describe(TakeoutService.name, () => {
  let sut: TakeoutService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TakeoutService));
  });

  const userId = authStub.admin.user.id;

  describe('getSettings', () => {
    it('returns the defaults when nothing is saved', async () => {
      mocks.takeout.getSettings.mockResolvedValue(undefined as any);
      const settings = await sut.getSettings(authStub.admin);
      expect(settings.homeTimeZone).toBe('America/New_York');
      expect(settings.rawJpg).toBe('StackCoverRaw');
    });

    it('merges saved settings over the defaults', async () => {
      mocks.takeout.getSettings.mockResolvedValue({ settings: { sessionTag: false } } as any);
      const settings = await sut.getSettings(authStub.admin);
      expect(settings.sessionTag).toBe(false);
      expect(settings.peopleTags).toBe(true);
    });
  });

  describe('updateSettings', () => {
    it('rejects an invalid time zone', async () => {
      await expect(sut.updateSettings(authStub.admin, { homeTimeZone: 'Not/AZone' } as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.takeout.upsertSettings).not.toHaveBeenCalled();
    });

    it('saves valid settings merged over what is stored', async () => {
      mocks.takeout.getSettings.mockResolvedValue({ settings: {} } as any);
      mocks.takeout.upsertSettings.mockResolvedValue(undefined as any);
      const result = await sut.updateSettings(authStub.admin, { sessionTag: false } as any);
      expect(mocks.takeout.upsertSettings).toHaveBeenCalledWith(userId, { sessionTag: false });
      expect(result.sessionTag).toBe(false);
    });
  });

  describe('createRun', () => {
    it('rejects a second run while one is active', async () => {
      mocks.takeout.getExport.mockResolvedValue({ id: 'e1', userId, completeness: 'complete', archivesDeletedAt: null } as any);
      mocks.takeout.getActiveRun.mockResolvedValue({ id: 'r1' } as any);
      await expect(sut.createRun(authStub.admin, 'e1', { importAnyway: false })).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an incomplete export unless importAnyway is set', async () => {
      mocks.takeout.getExport.mockResolvedValue({ id: 'e1', userId, completeness: 'uncertain', archivesDeletedAt: null } as any);
      mocks.takeout.getActiveRun.mockResolvedValue(undefined as any);
      await expect(sut.createRun(authStub.admin, 'e1', { importAnyway: false })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404s an export that belongs to another user', async () => {
      mocks.takeout.getExport.mockResolvedValue({ id: 'e1', userId: 'someone-else', completeness: 'complete' } as any);
      await expect(sut.createRun(authStub.admin, 'e1', { importAnyway: false })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('cancelRun', () => {
    it('cleans up a queued run inline', async () => {
      const run = { id: 'r1', userId, status: TakeoutRunStatus.Queued, heartbeatAt: null, attempt: 0, createdAt: new Date() };
      mocks.takeout.getRun.mockResolvedValue(run as any);
      mocks.takeout.getRunFilesWithTargetPath.mockResolvedValue([] as any);
      mocks.takeout.updateRun.mockResolvedValue(undefined as any);
      mocks.job.removeJob.mockResolvedValue(undefined as any);
      await sut.cancelRun(authStub.admin, 'r1');
      expect(mocks.takeout.updateRun).toHaveBeenCalledWith(
        'r1',
        expect.objectContaining({ status: TakeoutRunStatus.Cancelled }),
      );
    });

    it('sends a cancel event for a live run', async () => {
      const run = { id: 'r1', userId, status: TakeoutRunStatus.Importing, heartbeatAt: new Date(), attempt: 0, createdAt: new Date() };
      mocks.takeout.getRun.mockResolvedValue(run as any);
      mocks.takeout.updateRun.mockResolvedValue(undefined as any);
      await sut.cancelRun(authStub.admin, 'r1');
      expect(mocks.takeout.updateRun).toHaveBeenCalledWith('r1', { status: TakeoutRunStatus.Cancelling });
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('TakeoutRunCancel', { runId: 'r1' });
    });

    it('rejects cancelling a completed run', async () => {
      const run = { id: 'r1', userId, status: TakeoutRunStatus.Completed, heartbeatAt: new Date(), attempt: 0, createdAt: new Date() };
      mocks.takeout.getRun.mockResolvedValue(run as any);
      await expect(sut.cancelRun(authStub.admin, 'r1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.takeout.updateRun).not.toHaveBeenCalled();
    });
  });

  describe('resolveLargerVersion', () => {
    it('409s when the smaller version is already gone', async () => {
      mocks.takeout.getLargerVersion.mockResolvedValue({ id: 'lv1', userId, smallerAssetId: null } as any);
      await expect(
        sut.resolveLargerVersion(authStub.admin, 'lv1', { action: TakeoutLargerVersionAction.DeleteSmaller }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('trashes the smaller asset with the same code path as delete', async () => {
      mocks.takeout.getLargerVersion
        .mockResolvedValueOnce({ id: 'lv1', userId, largerAssetId: 'L', smallerAssetId: 'S' } as any)
        .mockResolvedValue({
          id: 'lv1',
          userId,
          largerAssetId: 'L',
          smallerAssetId: 'S',
          status: 'deletedSmaller',
          runId: null,
          createdAt: new Date(),
          resolvedAt: new Date(),
        } as any);
      mocks.asset.getByIds.mockImplementation((ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ id, ownerId: userId, exifInfo: {} }) as any)),
      );
      mocks.asset.updateAll.mockResolvedValue(undefined as any);
      mocks.event.emit.mockResolvedValue(undefined as any);
      // mapAsset is exercised on the returned row; guard against it throwing by spying update only
      const mapSpy = vitest.spyOn(sut as any, 'mapLargerVersion').mockResolvedValue({ id: 'lv1' } as any);

      await sut.resolveLargerVersion(authStub.admin, 'lv1', { action: TakeoutLargerVersionAction.DeleteSmaller });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['S'], expect.objectContaining({ status: expect.anything() }));
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTrashAll', { assetIds: ['S'], userId });
      expect(mocks.takeout.updateLargerVersion).toHaveBeenCalledWith(
        'lv1',
        expect.objectContaining({ status: 'deletedSmaller' }),
      );
      mapSpy.mockRestore();
    });
  });
});
