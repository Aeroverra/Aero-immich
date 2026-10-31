<script lang="ts">
  import { DetailPanelSection, moveDetailPanelSection } from '$lib/utils/detail-panel-sections';
  import { Button, Icon, IconButton, Text } from '@immich/ui';
  import { mdiChevronDown, mdiChevronUp, mdiDragVertical, mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    order: DetailPanelSection[];
    hidden: ReadonlySet<string>;
    onChange: (order: DetailPanelSection[], hidden: string[]) => void;
    onReset: () => void;
    onDone: () => void;
  }

  let { order, hidden, onChange, onReset, onDone }: Props = $props();

  const labels: Record<DetailPanelSection, string> = $derived({
    [DetailPanelSection.Description]: $t('description'),
    [DetailPanelSection.Rating]: $t('rating'),
    [DetailPanelSection.Bookmarks]: $t('video_bookmarks'),
    [DetailPanelSection.People]: $t('people'),
    [DetailPanelSection.Details]: $t('details'),
    [DetailPanelSection.Map]: $t('map'),
    [DetailPanelSection.SharedBy]: $t('shared_by'),
    [DetailPanelSection.Albums]: $t('albums'),
    [DetailPanelSection.Metadata]: $t('asset_metadata'),
    [DetailPanelSection.Tags]: $t('tags'),
  });

  let dragged = $state<DetailPanelSection>();
  let dropTarget = $state<DetailPanelSection>();

  const move = (section: DetailPanelSection, index: number, focusId?: string) => {
    onChange(moveDetailPanelSection(order, section, index), [...hidden]);
    if (focusId) {
      // keep keyboard focus on the arrow that was used, it moved with its row
      requestAnimationFrame(() => {
        const button = document.querySelector<HTMLElement>(`#${focusId}`);
        if (button && !(button as HTMLButtonElement).disabled) {
          button.focus();
        }
      });
    }
  };

  const toggleHidden = (section: DetailPanelSection) => {
    const next = hidden.has(section) ? [...hidden].filter((id) => id !== section) : [...hidden, section];
    onChange(order, next);
  };

  const onDragStart = (event: DragEvent, section: DetailPanelSection) => {
    dragged = section;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', section);
    }
  };

  const onDragOver = (event: DragEvent, section: DetailPanelSection) => {
    if (!dragged) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    dropTarget = section;
  };

  const onDrop = (event: DragEvent, section: DetailPanelSection) => {
    event.preventDefault();
    if (dragged && dragged !== section) {
      move(dragged, order.indexOf(section));
    }
    onDragEnd();
  };

  const onDragEnd = () => {
    dragged = undefined;
    dropTarget = undefined;
  };
</script>

<section class="px-4 pt-4 pb-12 text-sm" data-testid="detail-panel-section-editor">
  <div class="flex h-10 w-full items-center">
    <Text size="small" color="muted">{$t('customize_info_panel')}</Text>
  </div>
  <Text size="small" color="muted" class="pb-3">{$t('customize_info_panel_description')}</Text>

  <ul class="flex flex-col gap-1">
    {#each order as section, index (section)}
      {@const isHidden = hidden.has(section)}
      <li
        class="flex items-center gap-1 rounded-lg border bg-subtle py-1 ps-1 pe-1 transition-colors dark:border-gray-700 dark:bg-immich-dark-gray"
        class:border-primary={dropTarget === section && dragged !== section}
        class:opacity-50={dragged === section}
        draggable="true"
        ondragstart={(event) => onDragStart(event, section)}
        ondragover={(event) => onDragOver(event, section)}
        ondrop={(event) => onDrop(event, section)}
        ondragend={onDragEnd}
        data-testid="detail-panel-section-{section}"
      >
        <span class="cursor-grab px-1 text-gray-500 dark:text-gray-400" aria-hidden="true">
          <Icon icon={mdiDragVertical} size="20" />
        </span>
        <span class="grow truncate" class:line-through={isHidden} class:opacity-60={isHidden}>
          {labels[section]}
        </span>
        <IconButton
          icon={isHidden ? mdiEyeOffOutline : mdiEyeOutline}
          aria-label={isHidden
            ? $t('show_detail_panel_section', { values: { section: labels[section] } })
            : $t('hide_detail_panel_section', { values: { section: labels[section] } })}
          aria-pressed={isHidden}
          size="small"
          shape="round"
          color="secondary"
          variant="ghost"
          onclick={() => toggleHidden(section)}
        />
        <IconButton
          id="detail-panel-section-{section}-up"
          icon={mdiChevronUp}
          aria-label={$t('move_detail_panel_section_up', { values: { section: labels[section] } })}
          size="small"
          shape="round"
          color="secondary"
          variant="ghost"
          disabled={index === 0}
          onclick={() => move(section, index - 1, `detail-panel-section-${section}-up`)}
        />
        <IconButton
          id="detail-panel-section-{section}-down"
          icon={mdiChevronDown}
          aria-label={$t('move_detail_panel_section_down', { values: { section: labels[section] } })}
          size="small"
          shape="round"
          color="secondary"
          variant="ghost"
          disabled={index === order.length - 1}
          onclick={() => move(section, index + 1, `detail-panel-section-${section}-down`)}
        />
      </li>
    {/each}
  </ul>

  <div class="flex justify-end gap-2 pt-4">
    <Button size="small" variant="ghost" color="secondary" onclick={onReset}>{$t('reset_to_default')}</Button>
    <Button size="small" onclick={onDone}>{$t('done')}</Button>
  </div>
</section>
