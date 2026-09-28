<script lang="ts">
  import {
    getBaseUrl,
    getTakeoutRunFiles,
    TakeoutRunFileAction,
    TakeoutRunFileStatus,
    type TakeoutRunFileDto,
  } from '@immich/sdk';
  import { Button, Icon, Input, Select, Text } from '@immich/ui';
  import { mdiChevronLeft, mdiChevronRight, mdiDownload, mdiOpenInNew } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Route } from '$lib/route';
  import { runFileActionLabel } from '$lib/services/takeout.service';
  import { locale } from '$lib/stores/preferences.store';

  interface Props {
    runId: string;
  }

  let { runId }: Props = $props();

  const PAGE_SIZE = 100;

  let items = $state<TakeoutRunFileDto[]>([]);
  let total = $state(0);
  let hasNextPage = $state(false);
  let page = $state(1);
  let action = $state<TakeoutRunFileAction | ''>('');
  let status = $state<TakeoutRunFileStatus | ''>('');
  let search = $state('');
  let loading = $state(false);

  const actionOptions = [
    { value: '', label: $t('all') },
    ...Object.values(TakeoutRunFileAction).map((value) => ({ value, label: runFileActionLabel($t, value) })),
  ];
  const statusOptions = [
    { value: '', label: $t('all') },
    ...Object.values(TakeoutRunFileStatus).map((value) => ({ value, label: value })),
  ];

  const reportUrl = $derived(`${getBaseUrl()}/takeouts/runs/${runId}/report.csv`);

  const load = async () => {
    loading = true;
    try {
      const result = await getTakeoutRunFiles({
        id: runId,
        page,
        size: PAGE_SIZE,
        action: action || undefined,
        status: status || undefined,
        search: search || undefined,
      });
      items = result.items;
      total = result.total;
      hasNextPage = result.hasNextPage;
    } finally {
      loading = false;
    }
  };

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const onSearchInput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page = 1;
      void load();
    }, 300);
  };

  const onFilterChange = () => {
    page = 1;
    void load();
  };

  const goPrevious = () => {
    if (page <= 1) {
      return;
    }
    page--;
    void load();
  };
  const goNext = () => {
    if (!hasNextPage) {
      return;
    }
    page++;
    void load();
  };

  onMount(load);
</script>

<div class="flex flex-col gap-3">
  <div class="flex flex-wrap items-end gap-2">
    <div class="w-48">
      <Text size="tiny" color="muted">{$t('action')}</Text>
      <Select options={actionOptions} bind:value={action} onChange={onFilterChange} />
    </div>
    <div class="w-48">
      <Text size="tiny" color="muted">{$t('status')}</Text>
      <Select options={statusOptions} bind:value={status} onChange={onFilterChange} />
    </div>
    <div class="grow">
      <Text size="tiny" color="muted">{$t('search')}</Text>
      <Input bind:value={search} oninput={onSearchInput} placeholder={$t('search')} />
    </div>
    <Button href={reportUrl} leadingIcon={mdiDownload} size="small" variant="outline" color="secondary">
      {$t('takeout_download_report')}
    </Button>
  </div>

  <div class="w-full overflow-x-auto">
    <table class="w-full text-left text-sm">
      <thead>
        <tr class="border-b text-immich-fg/60 dark:text-immich-dark-fg/60">
          <th class="py-1 pr-2 font-medium">{$t('path')}</th>
          <th class="py-1 pr-2 font-medium">JSON</th>
          <th class="py-1 pr-2 font-medium">{$t('action')}</th>
          <th class="py-1 pr-2 font-medium">{$t('result')}</th>
          <th class="py-1 pr-2 font-medium">{$t('timezone')}</th>
          <th class="py-1 pr-2 font-medium">{$t('error')}</th>
        </tr>
      </thead>
      <tbody>
        {#each items as file (file.id)}
          <tr class="border-b align-top">
            <td class="py-1 pr-2 break-all">{file.takeoutPath}</td>
            <td class="py-1 pr-2 break-all">
              {#if file.jsonPath}<Text size="tiny">{file.jsonPath}</Text>{/if}
              {#if file.matcher}<Text size="tiny" color="muted" class="block">{file.matcher}</Text>{/if}
            </td>
            <td class="py-1 pr-2 whitespace-nowrap">{runFileActionLabel($t, file.action)}</td>
            <td class="py-1 pr-2 whitespace-nowrap">
              {file.status}
              {#if file.assetId}
                <a class="ml-1 inline-flex items-center text-primary" href={Route.viewAsset({ id: file.assetId })}>
                  <Icon icon={mdiOpenInNew} size="14" />
                </a>
              {/if}
            </td>
            <td class="py-1 pr-2 whitespace-nowrap">
              {#if file.zone}{file.zone}{#if file.zoneSource}<Text size="tiny" color="muted" class="block"
                    >{file.zoneSource}</Text
                  >{/if}{/if}
              {#if file.fallbacks.length > 0}<Text size="tiny" color="warning" class="block"
                  >{file.fallbacks.join(', ')}</Text
                >{/if}
            </td>
            <td class="py-1 pr-2 break-all">
              {#if file.error}<Text size="tiny" color="danger">{file.error}</Text>{/if}
            </td>
          </tr>
        {/each}
        {#if items.length === 0 && !loading}
          <tr><td colspan="6" class="py-3 text-center"><Text color="muted">{$t('no_results')}</Text></td></tr>
        {/if}
      </tbody>
    </table>
  </div>

  <div class="flex items-center justify-between">
    <Text size="tiny" color="muted">{total.toLocaleString($locale)}</Text>
    <div class="flex items-center gap-2">
      <Button
        size="tiny"
        variant="ghost"
        color="secondary"
        leadingIcon={mdiChevronLeft}
        disabled={page <= 1}
        onclick={goPrevious}
      >
        {$t('previous')}
      </Button>
      <Text size="tiny">{page}</Text>
      <Button
        size="tiny"
        variant="ghost"
        color="secondary"
        trailingIcon={mdiChevronRight}
        disabled={!hasNextPage}
        onclick={goNext}
      >
        {$t('next')}
      </Button>
    </div>
  </div>
</div>
