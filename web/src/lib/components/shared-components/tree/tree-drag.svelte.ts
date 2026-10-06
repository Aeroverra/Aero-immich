import type { TreeNode } from '$lib/utils/tree-utils';

/** The tree node being dragged, shared by every node of a tree so drop targets can tell whether they accept it */
export const treeDrag = $state<{ node: TreeNode | undefined }>({ node: undefined });

/** Whether [node] may move under [target]: not onto itself, one of its descendants, or its current parent */
export const canMoveTo = (node: TreeNode | undefined, target: TreeNode) =>
  !!node &&
  target.path !== node.path &&
  !target.path.startsWith(`${node.path}/`) &&
  target.path !== (node.parent?.path ?? '');
