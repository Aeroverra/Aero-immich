<script lang="ts">
  import OnEvents from '$lib/components/OnEvents.svelte';
  import TagGroups from '$lib/components/tags/TagGroups.svelte';
  import TagTreePicker from '$lib/components/tags/TagTreePicker.svelte';
  import { rememberRecentTags, tagPicker } from '$lib/components/tags/tag-picker.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { resolveAssetStackIds } from '$lib/services/stack-selection.service';
  import { removeTag, tagAssets } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllTags, getAssetInfo, upsertTags, type AssetResponseDto, type TagResponseDto } from '@immich/sdk';
  import { Button, IconButton, Text } from '@immich/ui';
  import { mdiChevronUp, mdiTagEditOutline, mdiTagPlusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
  }

  let { asset = $bindable(), isOwner }: Props = $props();

  const tags = $derived(asset.tags ?? []);
  const tagIds = $derived(new Set(tags.map(({ id }) => id)));
  // loaded when the picker first opens; the panel stays mounted while the viewer moves between assets
  let allTags = $state<TagResponseDto[]>();
  // requests still running per asset: the asset is read back from the server once they are all done
  const pending: Record<string, number> = {};

  const loadTags = async () => {
    try {
      allTags = await getAllTags();
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  $effect(() => {
    if (tagPicker.isOpen.current && !allTags) {
      void loadTags();
    }
  });

  // the viewer can move to another asset while a request runs, so a response only updates the asset it was for.
  // AssetUpdate also gives the viewer (and its cache of assets) the new tags, so going back to the asset shows them
  const refresh = async (id: string) => {
    try {
      const updated = await getAssetInfo({ id });
      if ((pending[id] ?? 0) > 0) {
        return;
      }
      if (asset.id === id) {
        asset = updated;
      }
      eventManager.emit('AssetUpdate', updated);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  const setTag = async (tag: TagResponseDto, checked: boolean) => {
    const current = asset;
    asset = { ...current, tags: checked ? [...tags, tag] : tags.filter(({ id }) => id !== tag.id) };
    pending[current.id] = (pending[current.id] ?? 0) + 1;
    let assetIds = [current.id];
    try {
      // a manual stack (a Video Boost pair, RAW and JPEG) is one item: its tags change together
      assetIds = await resolveAssetStackIds(current);
      if (checked) {
        await tagAssets({ tagIds: [tag.id], assetIds, showNotification: false });
        rememberRecentTags([tag.id]);
      } else {
        await removeTag({ tagIds: [tag.id], assetIds, showNotification: false });
      }
    } catch (error) {
      handleError(error, $t(checked ? 'errors.failed_to_tag_assets' : 'errors.something_went_wrong'));
    } finally {
      pending[current.id] -= 1;
    }
    await refresh(current.id);
    // the other assets of the stack changed too; the viewer may have them cached
    const others = assetIds.filter((id) => id !== current.id);
    if (others.length > 0) {
      eventManager.emit('AssetsTag', others);
    }
  };

  const createTag = async (path: string) => {
    try {
      const [tag] = await upsertTags({ tagUpsertDto: { tags: [path] } });
      // the parents the new path needed are new too
      allTags = await getAllTags();
      eventManager.emit('TagCreate', tag);
      await setTag(tag, true);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  const onAssetsTag = async (ids: string[]) => {
    if (ids.includes(asset.id)) {
      await refresh(asset.id);
    }
  };

  const onTagsChange = async () => {
    if (allTags) {
      await loadTags();
    }
  };

  const toggleOpen = () => (tagPicker.isOpen.current = !tagPicker.isOpen.current);
</script>

<OnEvents {onAssetsTag} onTagCreate={onTagsChange} onTagUpdate={onTagsChange} onTagDelete={onTagsChange} />

{#if isOwner && !authManager.isSharedLink}
  <section class="mt-4 px-4" data-testid="detail-panel-tags-section">
    <div class="flex h-10 w-full items-center justify-between text-sm">
      <Text color="muted">{$t('tags')}</Text>
      <IconButton
        icon={tagPicker.isOpen.current ? mdiChevronUp : mdiTagEditOutline}
        variant="ghost"
        shape="round"
        color="secondary"
        size="small"
        aria-label={tagPicker.isOpen.current ? $t('done') : $t('edit_tags')}
        aria-expanded={tagPicker.isOpen.current}
        title={tagPicker.isOpen.current ? $t('done') : $t('edit_tags')}
        onclick={toggleOpen}
        data-testid="detail-panel-tags-toggle"
      />
    </div>

    <!-- while editing, the tree shows what the asset carries, so the tag list makes way for the search -->
    {#if tagPicker.isOpen.current}
      <div class="pt-2" data-testid="detail-panel-tags-picker">
        {#if allTags}
          <TagTreePicker tags={allTags} checkedIds={tagIds} onToggle={setTag} onCreate={createTag} rememberSearch />
        {/if}
      </div>
    {:else}
      <section class="pt-2" data-testid="detail-panel-tags">
        {#if tags.length > 0}
          <TagGroups {tags} link onRemove={(tag) => setTag(tag, false)} />
        {:else}
          <Button size="small" variant="ghost" leadingIcon={mdiTagPlusOutline} onclick={toggleOpen}>
            {$t('add_tag')}
          </Button>
        {/if}
      </section>
    {/if}
  </section>
{/if}
