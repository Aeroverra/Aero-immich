<script lang="ts">
  import { Route } from '$lib/route';
  import { groupTagsByParent, tagName } from '$lib/utils/tag-tree';
  import type { TagResponseDto } from '@immich/sdk';
  import { Badge, Link } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    tags: TagResponseDto[];
    onRemove?: (tag: TagResponseDto) => void;
    /** the chips link to the tag pages */
    link?: boolean;
  };

  let { tags, onRemove, link = false }: Props = $props();

  const groups = $derived(groupTagsByParent(tags));
</script>

<!-- tags under the same parent share one line with its path, so each chip only needs the last part of its name -->
<div class="flex flex-col gap-2">
  {#each groups as group (group.parent)}
    <div class="flex flex-col gap-1" data-testid="tag-group">
      {#if group.parent}
        <p class="truncate text-xs text-gray-500 dark:text-gray-400" title={group.parent}>
          {group.parent.replaceAll('/', ' › ')}
        </p>
      {/if}
      <div class="flex flex-wrap gap-1">
        {#each group.tags as tag (tag.id)}
          <Badge
            onClose={onRemove ? () => onRemove(tag) : undefined}
            size="small"
            shape="round"
            translations={{ close: $t('remove_tag') }}
          >
            {#if link}
              <Link href={Route.tags({ path: tag.value })} underline={false} class="px-2 font-light" title={tag.value}>
                {tagName(tag.value)}
              </Link>
            {:else}
              <span class="px-2 font-light" title={tag.value}>{tagName(tag.value)}</span>
            {/if}
          </Badge>
        {/each}
      </div>
    </div>
  {/each}
</div>
