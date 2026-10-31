import { StackActionMode, StackSource, type StackResponseDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import StackSelectionModal from '$lib/modals/StackSelectionModal.svelte';
import { getCollapsedStackIds, resolveStackSelection } from '$lib/services/stack-selection.service';
import { assetFactory, timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    modalManager: {
      show: vi.fn(),
      showDialog: vi.fn(),
    },
    toastManager: {
      primary: vi.fn(),
      danger: vi.fn(),
    },
  };
});

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: () => Promise.resolve((key: string) => key),
  getPreferredLocale: vi.fn(),
}));

const buildStack = (id: string, primaryAssetId: string, memberIds: string[]): StackResponseDto => ({
  id,
  primaryAssetId,
  source: StackSource.Manual,
  assets: [primaryAssetId, ...memberIds].map((assetId) => assetFactory.build({ id: assetId })),
});

const setMode = (mode: StackActionMode) => {
  authManager.setPreferences(preferencesFactory.build({ stackActions: { mode } }));
};

describe('stack selection service', () => {
  const plain = timelineAssetFactory.build({ id: 'plain' });
  const stacked = timelineAssetFactory.build({
    id: 'primary',
    stack: { id: 'stack-1', primaryAssetId: 'primary', assetCount: 3 },
  });
  const stack = buildStack('stack-1', 'primary', ['member-1', 'member-2']);

  beforeEach(() => {
    vi.clearAllMocks();
    authManager.setUser(userAdminFactory.build());
    setMode(StackActionMode.Ask);
    sdkMock.getStack.mockResolvedValue(stack);
  });

  afterEach(() => {
    authManager.reset();
  });

  describe('getCollapsedStackIds', () => {
    it('lists each stack that hides assets once', () => {
      const other = timelineAssetFactory.build({ stack: { id: 'stack-1', primaryAssetId: 'x', assetCount: 3 } });
      const single = timelineAssetFactory.build({ stack: { id: 'stack-2', primaryAssetId: 'y', assetCount: 1 } });

      expect(getCollapsedStackIds([plain, stacked, other, single])).toEqual(['stack-1']);
    });
  });

  describe('resolveStackSelection', () => {
    it('acts on the selection as is when it holds no stack', async () => {
      await expect(resolveStackSelection([plain])).resolves.toEqual(['plain']);

      expect(modalManager.show).not.toHaveBeenCalled();
      expect(sdkMock.getStack).not.toHaveBeenCalled();
    });

    it('asks and keeps the top items only', async () => {
      vi.mocked(modalManager.show).mockResolvedValue({ includeStacked: false, remember: false } as never);

      await expect(resolveStackSelection([stacked, plain])).resolves.toEqual(['primary', 'plain']);

      expect(modalManager.show).toHaveBeenCalledExactlyOnceWith(StackSelectionModal, { stackCount: 1 });
      expect(sdkMock.getStack).not.toHaveBeenCalled();
      expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();
    });

    it('asks and adds the stacked assets after the selection', async () => {
      vi.mocked(modalManager.show).mockResolvedValue({ includeStacked: true, remember: false } as never);

      await expect(resolveStackSelection([stacked, plain])).resolves.toEqual([
        'primary',
        'plain',
        'member-1',
        'member-2',
      ]);

      expect(sdkMock.getStack).toHaveBeenCalledExactlyOnceWith({ id: 'stack-1' });
    });

    it('cancels when the dialog is closed', async () => {
      vi.mocked(modalManager.show).mockResolvedValue(undefined as never);

      await expect(resolveStackSelection([stacked])).resolves.toBeUndefined();

      expect(sdkMock.getStack).not.toHaveBeenCalled();
    });

    it('remembers the choice in the user preferences', async () => {
      vi.mocked(modalManager.show).mockResolvedValue({ includeStacked: true, remember: true } as never);
      const updated = preferencesFactory.build({ stackActions: { mode: StackActionMode.Stack } });
      sdkMock.updateMyPreferences.mockResolvedValue(updated);

      await resolveStackSelection([stacked]);

      expect(sdkMock.updateMyPreferences).toHaveBeenCalledExactlyOnceWith({
        userPreferencesUpdateDto: { stackActions: { mode: StackActionMode.Stack } },
      });
      expect(authManager.preferences.stackActions.mode).toBe(StackActionMode.Stack);
    });

    it('uses a remembered top items only choice without asking', async () => {
      setMode(StackActionMode.Primary);

      await expect(resolveStackSelection([stacked])).resolves.toEqual(['primary']);

      expect(modalManager.show).not.toHaveBeenCalled();
      expect(sdkMock.getStack).not.toHaveBeenCalled();
    });

    it('uses a remembered include choice without asking', async () => {
      setMode(StackActionMode.Stack);

      await expect(resolveStackSelection([stacked])).resolves.toEqual(['primary', 'member-1', 'member-2']);

      expect(modalManager.show).not.toHaveBeenCalled();
    });

    it('keeps the primary asset of a stack that cannot be loaded, like a partner stack', async () => {
      setMode(StackActionMode.Stack);
      const partner = timelineAssetFactory.build({
        id: 'partner',
        stack: { id: 'stack-partner', primaryAssetId: 'partner', assetCount: 2 },
      });
      sdkMock.getStack.mockImplementation(({ id }) =>
        id === 'stack-1' ? Promise.resolve(stack) : Promise.reject(new Error('Not found or no stack.read access')),
      );

      await expect(resolveStackSelection([stacked, partner])).resolves.toEqual([
        'primary',
        'partner',
        'member-1',
        'member-2',
      ]);
    });

    it('loads many stacks with a single search', async () => {
      setMode(StackActionMode.Stack);
      const assets = Array.from({ length: 25 }, (_, index) =>
        timelineAssetFactory.build({
          id: `primary-${index}`,
          stack: { id: `stack-${index}`, primaryAssetId: `primary-${index}`, assetCount: 2 },
        }),
      );
      sdkMock.searchStacks.mockResolvedValue([
        ...assets.map((_, index) => buildStack(`stack-${index}`, `primary-${index}`, [`member-${index}`])),
        buildStack('not-selected', 'other-primary', ['other-member']),
      ]);

      const ids = await resolveStackSelection(assets);

      expect(sdkMock.searchStacks).toHaveBeenCalledOnce();
      expect(sdkMock.getStack).not.toHaveBeenCalled();
      expect(ids).toHaveLength(50);
      expect(ids).toContain('member-24');
      expect(ids).not.toContain('other-member');
    });
  });
});
