<script lang="ts">
  import Tree from '$lib/components/shared-components/tree/Tree.svelte';
  import { canMoveTo, treeDrag } from '$lib/components/shared-components/tree/tree-drag.svelte';
  import { type TreeNode } from '$lib/utils/tree-utils';
  import { t } from 'svelte-i18n';

  interface Props {
    tree: TreeNode;
    active: string;
    icons: { default: string; active: string };
    getLink: (path: string) => string;
    /** makes the nodes draggable: a node dropped on another node, or on the top level zone, moves there */
    onMove?: (node: TreeNode, target: TreeNode) => void;
  }

  let { tree, active, icons, getLink, onMove }: Props = $props();

  const isRoot = $derived(tree.path === '');
  const showTopLevelZone = $derived(!!onMove && isRoot && canMoveTo(treeDrag.node, tree));
  let isOverTopLevel = $state(false);

  const onTopLevelDrop = (event: DragEvent) => {
    event.preventDefault();
    isOverTopLevel = false;
    const node = treeDrag.node;
    treeDrag.node = undefined;
    if (node && onMove) {
      onMove(node, tree);
    }
  };
</script>

{#if showTopLevelZone}
  <div
    role="region"
    aria-label={$t('tag_move_to_top_level')}
    class="ms-2 mb-1 rounded-lg border-2 border-dashed px-2 py-1 text-sm {isOverTopLevel
      ? 'border-primary bg-primary/10 text-primary'
      : 'border-gray-300 text-gray-500 dark:border-gray-600'}"
    data-testid="tree-top-level-drop"
    ondragover={(event) => {
      event.preventDefault();
      isOverTopLevel = true;
    }}
    ondragleave={() => (isOverTopLevel = false)}
    ondrop={onTopLevelDrop}
  >
    {$t('tag_move_to_top_level')}
  </div>
{/if}

<ul class="ms-2 list-none">
  {#each tree.children as node (node.color ? node.path + node.color : node.path)}
    <li>
      <Tree {node} {icons} {active} {getLink} {onMove} />
    </li>
  {/each}
</ul>
