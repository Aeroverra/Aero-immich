<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { TakeoutLargerVersionAction } from '@immich/sdk';
  import { Button, HStack, modalManager, Text } from '@immich/ui';
  import { mdiCheckAll, mdiChevronLeft, mdiChevronRight, mdiTrashCanOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TakeoutLargerVersionCompare from '$lib/components/takeouts/TakeoutLargerVersionCompare.svelte';
  import { Route } from '$lib/route';
  import { handleResolveLargerVersion } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let items = $state(data.largerVersions);

  const clamp = (index: number) => Math.max(0, Math.min(index, items.length - 1));

  let index = $derived(
    (() => {
      const raw = page.url.searchParams.get('index') ?? '0';
      const parsed = Math.trunc(Number(raw));
      return clamp(Number.isNaN(parsed) ? 0 : parsed);
    })(),
  );

  const navigateToIndex = (target: number) => goto(Route.takeoutLargerVersions({ index: clamp(target) }));

  const resolve = async (action: TakeoutLargerVersionAction) => {
    const current = items[index];
    if (!current) {
      return;
    }
    if (action === TakeoutLargerVersionAction.DeleteSmaller) {
      const confirmed = await modalManager.showDialog({
        title: $t('takeout_larger_version_delete_smaller'),
        prompt: $t('takeout_larger_version_delete_smaller_confirm'),
        confirmText: $t('delete'),
      });
      if (!confirmed) {
        return;
      }
    }
    const resolved = await handleResolveLargerVersion($t, current.id, action);
    if (resolved) {
      items = items.filter((item) => item.id !== current.id);
      if (items.length === 0) {
        await goto(Route.takeoutLargerVersions());
      } else {
        await navigateToIndex(index);
      }
    }
  };
</script>

<UserPageLayout title={data.meta.title + ` (${items.length.toLocaleString($locale)})`}>
  <div class="mx-auto flex w-full max-w-5xl flex-col gap-4 py-4">
    {#if items.length > 0}
      {#key items[index]?.id}
        <TakeoutLargerVersionCompare item={items[index]} />
      {/key}

      <div class="flex items-center justify-between">
        <HStack gap={1}>
          <Button
            color="danger"
            leadingIcon={mdiTrashCanOutline}
            onclick={() => resolve(TakeoutLargerVersionAction.DeleteSmaller)}
          >
            {$t('takeout_larger_version_delete_smaller')}
          </Button>
          <Button
            variant="outline"
            color="secondary"
            leadingIcon={mdiCheckAll}
            onclick={() => resolve(TakeoutLargerVersionAction.KeepBoth)}
          >
            {$t('takeout_larger_version_keep_both')}
          </Button>
        </HStack>

        <HStack gap={1}>
          <Button
            size="small"
            variant="ghost"
            color="secondary"
            leadingIcon={mdiChevronLeft}
            disabled={index === 0}
            onclick={() => navigateToIndex(index - 1)}
          >
            {$t('previous')}
          </Button>
          <Text size="small">{index + 1} / {items.length.toLocaleString($locale)}</Text>
          <Button
            size="small"
            variant="ghost"
            color="secondary"
            trailingIcon={mdiChevronRight}
            disabled={index >= items.length - 1}
            onclick={() => navigateToIndex(index + 1)}
          >
            {$t('next')}
          </Button>
        </HStack>
      </div>
    {:else}
      <Text color="muted" class="text-center">{$t('no_results')}</Text>
    {/if}
  </div>
</UserPageLayout>
