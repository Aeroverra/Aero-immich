import { AssetVisibility, StackSource, updateAsset, type AssetResponseDto } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import {
  canCopyImageToClipboard,
  getAssetFilename,
  getFilenameExtension,
  isGroupingAutoStacks,
  isStackGrouped,
  toggleArchive,
} from './asset-utils';

vi.mock('@immich/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@immich/sdk')>();
  return {
    ...actual,
    updateAsset: vi.fn(),
  };
});

describe('get file extension from filename', () => {
  it('returns the extension without including the dot', () => {
    expect(getFilenameExtension('filename.txt')).toEqual('txt');
  });

  it('takes the last file extension and ignores the rest', () => {
    expect(getFilenameExtension('filename.txt.pdf')).toEqual('pdf');
    expect(getFilenameExtension('filename.txt.pdf.jpg')).toEqual('jpg');
  });

  it('returns an empty string when no file extension is found', () => {
    expect(getFilenameExtension('filename')).toEqual('');
    expect(getFilenameExtension('filename.')).toEqual('');
    expect(getFilenameExtension('filename..')).toEqual('');
    expect(getFilenameExtension('.filename')).toEqual('');
  });

  it('returns the extension from a filepath', () => {
    expect(getFilenameExtension('/folder/file.txt')).toEqual('txt');
    expect(getFilenameExtension('./folder/file.txt')).toEqual('txt');
    expect(getFilenameExtension('~/folder/file.txt')).toEqual('txt');
    expect(getFilenameExtension('./folder/.file.txt')).toEqual('txt');
    expect(getFilenameExtension('/folder.with.dots/file.txt')).toEqual('txt');
  });
});

describe('get asset filename', () => {
  it('returns the filename including file extension', () => {
    for (const { asset, result } of [
      {
        asset: {
          originalFileName: 'filename',
          originalPath: '/data/library/test/2016/2016-08-30/filename.jpg',
        },
        result: 'filename.jpg',
      },
      {
        asset: {
          originalFileName: 'new-filename',
          originalPath: '/data/library/89d14e47-a40d-4cae-a347-a914cdef1f22/2016/2016-08-30/filename.jpg',
        },
        result: 'new-filename.jpg',
      },
      {
        asset: {
          originalFileName: 'new-filename.txt',
          originalPath: '/data/library/test/2016/2016-08-30/filename.txt.jpg',
        },
        result: 'new-filename.txt.jpg',
      },
    ]) {
      expect(getAssetFilename(asset as AssetResponseDto)).toEqual(result);
    }
  });
});

describe('copy image to clipboard', () => {
  // This test is dubious, as it totally on the environment where the test is run which is mocked.
  it('should allow copy image to clipboard', () => {
    expect(canCopyImageToClipboard()).toEqual(true);
  });
});

describe('toggleArchive', () => {
  beforeEach(() => {
    vi.mocked(updateAsset).mockReset();
  });

  it('updates both isArchived and visibility when archiving', async () => {
    vi.mocked(updateAsset).mockResolvedValue({
      isArchived: true,
      visibility: AssetVisibility.Archive,
    } as AssetResponseDto);

    const asset = { id: '1', isArchived: false, visibility: AssetVisibility.Timeline } as AssetResponseDto;
    await toggleArchive(asset);

    expect(asset.isArchived).toBe(true);
    // regression: visibility must be refreshed so the timeline correctly excludes the archived asset
    expect(asset.visibility).toBe(AssetVisibility.Archive);
  });

  it('updates both isArchived and visibility when unarchiving', async () => {
    vi.mocked(updateAsset).mockResolvedValue({
      isArchived: false,
      visibility: AssetVisibility.Timeline,
    } as AssetResponseDto);

    const asset = { id: '1', isArchived: true, visibility: AssetVisibility.Archive } as AssetResponseDto;
    await toggleArchive(asset);

    expect(asset.isArchived).toBe(false);
    expect(asset.visibility).toBe(AssetVisibility.Timeline);
  });
});

describe('automatic stack grouping', () => {
  afterEach(() => {
    authManager.reset();
  });

  const signIn = (groupAuto: boolean) => {
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build({ stacks: { groupAuto } }));
  };

  it('groups automatic stacks when nobody is signed in', () => {
    expect(isGroupingAutoStacks()).toBe(true);
    expect(isStackGrouped({ source: StackSource.Auto })).toBe(true);
  });

  it('follows the preference for automatic stacks only', () => {
    signIn(false);

    expect(isGroupingAutoStacks()).toBe(false);
    expect(isStackGrouped({ source: StackSource.Auto })).toBe(false);
    expect(isStackGrouped({ source: StackSource.Manual })).toBe(true);
    expect(isStackGrouped({})).toBe(true);
  });

  it('groups every stack while the preference is on', () => {
    signIn(true);

    expect(isStackGrouped({ source: StackSource.Auto })).toBe(true);
    expect(isStackGrouped({ source: StackSource.Manual })).toBe(true);
  });
});
