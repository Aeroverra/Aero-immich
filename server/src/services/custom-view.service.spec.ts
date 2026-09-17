import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ViewFilter } from 'src/database';
import { CustomView, mapCustomView } from 'src/dtos/custom-view.dto';
import { Permission, ViewAccess, ViewPrivateAssets } from 'src/enum';
import { CustomViewService } from 'src/services/custom-view.service';
import { getActiveView, toPrivateScope } from 'src/utils/access';
import { isViewUnrestricted } from 'src/utils/database';
import { factory, newUuid } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';

const newView = (dto: Partial<CustomView> = {}): CustomView => ({
  id: newUuid(),
  ownerId: newUuid(),
  name: 'View',
  order: 0,
  isDefault: false,
  access: ViewAccess.Open,
  includeAll: true,
  includeUntagged: false,
  includeTagIds: [],
  excludeTagIds: [],
  privateAssets: ViewPrivateAssets.Unlocked,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...dto,
});

const toFilter = ({
  id,
  ownerId,
  access,
  includeAll,
  includeUntagged,
  includeTagIds,
  excludeTagIds,
  privateAssets,
}: CustomView): ViewFilter => ({
  id,
  ownerId,
  access,
  includeAll,
  includeUntagged,
  includeTagIds,
  excludeTagIds,
  privateAssets,
});

describe(CustomViewService.name, () => {
  let sut: CustomViewService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(CustomViewService));
  });

  describe('isViewUnrestricted', () => {
    it('should only skip the predicate for views that let everything through', () => {
      expect(isViewUnrestricted(null)).toBe(true);
      expect(isViewUnrestricted(toFilter(newView()))).toBe(true);
      expect(isViewUnrestricted(toFilter(newView({ excludeTagIds: [newUuid()] })))).toBe(false);
      expect(isViewUnrestricted(toFilter(newView({ privateAssets: ViewPrivateAssets.Hide })))).toBe(false);
      expect(isViewUnrestricted(toFilter(newView({ includeAll: false, includeUntagged: true })))).toBe(false);
    });
  });

  describe('getActiveView', () => {
    it('should only apply views to login sessions', () => {
      const view = toFilter(newView({ includeAll: false }));
      const session = factory.auth({ session: {} });
      session.session!.view = view;
      expect(getActiveView(session)).toBe(view);
      expect(toPrivateScope(session)).toEqual(expect.objectContaining({ view }));

      const apiKey = factory.auth({ apiKey: {} });
      apiKey.session = session.session;
      expect(getActiveView(apiKey)).toBeNull();
      expect(toPrivateScope(apiKey)).not.toHaveProperty('view');
    });
  });

  describe('getAll', () => {
    it('should leave private views out while private mode is locked', async () => {
      const auth = factory.auth({ session: {} });
      const open = newView({ name: 'Open' });
      const hidden = newView({ name: 'Hidden', access: ViewAccess.Private });
      mocks.customView.getAll.mockResolvedValue([open, hidden]);

      await expect(sut.getAll(auth, {})).resolves.toEqual([mapCustomView(open)]);

      const unlocked = factory.auth({ session: { privateMode: true } });
      await expect(sut.getAll(unlocked, {})).resolves.toEqual([mapCustomView(open), mapCustomView(hidden)]);
    });
  });

  describe('create', () => {
    it('should require private mode', async () => {
      await expect(sut.create(factory.auth({ session: {} }), { name: 'View' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mocks.customView.create).not.toHaveBeenCalled();
    });

    it('should check access to every tag it names', async () => {
      const auth = factory.auth({ session: { privateMode: true } });
      const tagId = newUuid();
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.create(auth, { name: 'View', includeTagIds: [tagId] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.customView.create).not.toHaveBeenCalled();
    });

    it('should not touch assets when the default view does not change', async () => {
      const auth = factory.auth({ session: { privateMode: true } });
      const view = newView();
      mocks.customView.getDefault.mockResolvedValue(undefined);
      mocks.customView.create.mockResolvedValue(view.id);
      mocks.customView.get.mockResolvedValue(view);

      await expect(sut.create(auth, { name: 'View', includeAll: true })).resolves.toEqual(mapCustomView(view));
      expect(mocks.customView.getChangedAssetIds).not.toHaveBeenCalled();
    });

    it('should touch the assets that changed when a default view is created', async () => {
      const auth = factory.auth({ session: { privateMode: true } });
      const view = newView({ isDefault: true, includeAll: false, includeUntagged: true });
      mocks.customView.getDefault.mockResolvedValueOnce(undefined).mockResolvedValueOnce(toFilter(view));
      mocks.customView.create.mockResolvedValue(view.id);
      mocks.customView.get.mockResolvedValue(view);
      mocks.customView.getChangedAssetIds.mockResolvedValue(['asset-1']);
      mocks.customView.touchAssets.mockResolvedValue();

      await sut.create(auth, { name: 'View', isDefault: true, includeUntagged: true });
      expect(mocks.customView.getChangedAssetIds).toHaveBeenCalledWith(auth.user.id, null, toFilter(view));
      expect(mocks.customView.touchAssets).toHaveBeenCalledWith(['asset-1']);
    });
  });

  describe('setActive', () => {
    it('should refuse API keys', async () => {
      await expect(sut.setActive(factory.auth({ apiKey: {} }), { viewId: null })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should switch to an open view without a PIN', async () => {
      const auth = factory.auth({ session: {} });
      const view = newView({ ownerId: auth.user.id });
      mocks.access.view.checkOwnerAccess.mockResolvedValue(new Set([view.id]));
      mocks.customView.get.mockResolvedValue(view);
      mocks.session.get.mockResolvedValue(undefined);
      mocks.session.update.mockResolvedValue({} as never);
      mocks.user.getMetadata.mockResolvedValue([]);

      await expect(sut.setActive(auth, { viewId: view.id })).resolves.toMatchObject({ viewId: view.id });
      expect(mocks.session.update).toHaveBeenCalledWith(auth.session!.id, {
        viewId: view.id,
        viewExpiresAt: expect.any(Date),
      });
      expect(mocks.user.getForPinCode).not.toHaveBeenCalled();
    });

    it('should require the PIN for a locked view', async () => {
      const auth = factory.auth({ session: {} });
      const view = newView({ ownerId: auth.user.id, access: ViewAccess.Locked });
      mocks.access.view.checkOwnerAccess.mockResolvedValue(new Set([view.id]));
      mocks.customView.get.mockResolvedValue(view);
      mocks.session.get.mockResolvedValue(undefined);
      mocks.user.getForPinCode.mockResolvedValue({ pinCode: 'hash', password: 'hash' });

      await expect(sut.setActive(auth, { viewId: view.id })).rejects.toBeInstanceOf(UnauthorizedException);

      mocks.crypto.compareBcrypt.mockReturnValue(false);
      await expect(sut.setActive(auth, { viewId: view.id, pinCode: '000000' })).rejects.toThrow('Wrong PIN code');
      expect(mocks.session.update).not.toHaveBeenCalled();
    });

    it('should not find a private view while private mode is locked', async () => {
      const auth = factory.auth({ session: {} });
      const view = newView({ ownerId: auth.user.id, access: ViewAccess.Private });
      mocks.access.view.checkOwnerAccess.mockResolvedValue(new Set([view.id]));
      mocks.customView.get.mockResolvedValue(view);
      mocks.session.get.mockResolvedValue(undefined);

      await expect(sut.setActive(auth, { viewId: view.id })).rejects.toThrow('View not found');
    });

    it('should return to the default view without anything', async () => {
      const auth = factory.auth({ session: {} });
      mocks.session.get.mockResolvedValue(undefined);
      mocks.session.update.mockResolvedValue({} as never);
      mocks.customView.getDefault.mockResolvedValue(undefined);

      await expect(sut.setActive(auth, { viewId: null })).resolves.toEqual({
        viewId: null,
        view: null,
        expiresAt: null,
      });
      expect(mocks.session.update).toHaveBeenCalledWith(auth.session!.id, { viewId: null, viewExpiresAt: null });
    });
  });

  describe('permissions', () => {
    it('should check view ownership with the view permissions', async () => {
      const auth = factory.auth({ session: {} });
      mocks.access.view.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.get(auth, newUuid())).rejects.toBeInstanceOf(BadRequestException);
      expect(Permission.ViewRead).toBe('view.read');
    });
  });
});
