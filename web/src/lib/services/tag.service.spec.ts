import type { TagResponseDto } from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { handleMoveTag, handleUpdateTagPath, parseTagPath } from '$lib/services/tag.service';
import { TreeNode } from '$lib/utils/tree-utils';

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    modalManager: { show: vi.fn(), showDialog: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  };
});

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: () => Promise.resolve((key: string) => key),
  getPreferredLocale: vi.fn(),
}));

const newTag = (id: string, value: string): TagResponseDto => ({
  id,
  value,
  name: value.split('/').at(-1)!,
  isHidden: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('tag service', () => {
  // People, People/Christina, People/Christina/Kids, Friends
  const tree = TreeNode.fromTags([
    newTag('people', 'People'),
    newTag('christina', 'People/Christina'),
    newTag('kids', 'People/Christina/Kids'),
    newTag('friends', 'Friends'),
  ]);
  const christina = tree.traverse('People/Christina');
  const friends = tree.traverse('Friends');

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.updateTag.mockImplementation(({ id }) => Promise.resolve(newTag(id, 'updated')));
  });

  describe('parseTagPath', () => {
    it('drops stray slashes and spaces around the parts', () => {
      expect(parseTagPath(' /People// Family /Christina/ ')).toEqual(['People', 'Family', 'Christina']);
      expect(parseTagPath('  ')).toEqual([]);
    });
  });

  describe('handleUpdateTagPath', () => {
    it('renames in place when the parent path stays the same', async () => {
      await handleUpdateTagPath(christina, 'People/Chris', { color: null });

      expect(sdkMock.upsertTags).not.toHaveBeenCalled();
      expect(sdkMock.updateTag).toHaveBeenCalledWith({ id: 'christina', tagUpdateDto: { color: null, name: 'Chris' } });
    });

    it('moves under another parent, creating the parent path first', async () => {
      sdkMock.upsertTags.mockResolvedValue([newTag('family', 'Friends/Family')]);

      await handleUpdateTagPath(christina, 'Friends/Family/Christina');

      expect(sdkMock.upsertTags).toHaveBeenCalledWith({ tagUpsertDto: { tags: ['Friends/Family'] } });
      expect(sdkMock.updateTag).toHaveBeenCalledWith({
        id: 'christina',
        tagUpdateDto: { name: 'Christina', parentId: 'family' },
      });
    });

    it('moves to the top level for a plain name', async () => {
      await handleUpdateTagPath(christina, 'Christina');

      expect(sdkMock.updateTag).toHaveBeenCalledWith({
        id: 'christina',
        tagUpdateDto: { name: 'Christina', parentId: null },
      });
    });

    it('refuses to move a tag into itself or its children, and an empty name', async () => {
      await handleUpdateTagPath(christina, 'People/Christina/Kids/Christina');
      await handleUpdateTagPath(christina, ' / ');

      expect(toastManager.danger).toHaveBeenCalledWith('errors.tag_move_into_itself');
      expect(toastManager.danger).toHaveBeenCalledWith('errors.tag_name_required');
      expect(sdkMock.upsertTags).not.toHaveBeenCalled();
      expect(sdkMock.updateTag).not.toHaveBeenCalled();
    });
  });

  describe('handleMoveTag', () => {
    it('moves a dragged tag under the target after confirming', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);
      sdkMock.upsertTags.mockResolvedValue([newTag('friends', 'Friends')]);

      await handleMoveTag(christina, friends);

      expect(modalManager.showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'tag_move_confirm' }));
      expect(sdkMock.updateTag).toHaveBeenCalledWith({
        id: 'christina',
        tagUpdateDto: { name: 'Christina', parentId: 'friends' },
      });
    });

    it('moves to the top level when dropped on the tree root', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(true);

      await handleMoveTag(christina, tree);

      expect(modalManager.showDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'tag_move_to_top_level_confirm' }),
      );
      expect(sdkMock.updateTag).toHaveBeenCalledWith({
        id: 'christina',
        tagUpdateDto: { name: 'Christina', parentId: null },
      });
    });

    it('does nothing when cancelled, or for a drop on its own parent or child', async () => {
      vi.mocked(modalManager.showDialog).mockResolvedValue(false);
      await handleMoveTag(christina, friends);

      await handleMoveTag(christina, tree.traverse('People'));
      await handleMoveTag(tree.traverse('People'), tree.traverse('People/Christina/Kids'));

      expect(modalManager.showDialog).toHaveBeenCalledOnce();
      expect(sdkMock.updateTag).not.toHaveBeenCalled();
    });
  });
});
