// Finalize order of the stack groups of a plan (single-pass design 9.2, fix F6): a group whose member depends on an
// asset created by another group (an alreadyProcessed row, or a stack link of its cover) runs after that group.

export interface GroupOrderRow {
  seq: number;
  groupIndex: number | null;
  /** alreadyProcessed: seq of the first row with the same checksum */
  dependsOnSeq: number | null;
  isCover: boolean;
  /** seqs the cover's stack links to */
  links: number[];
}

/** Edges A -> B (A must run before B) derived from the plan rows; self edges are dropped */
export function groupEdges(rows: GroupOrderRow[]): Array<[number, number]> {
  const groupOfSeq = new Map<number, number>();
  for (const row of rows) {
    if (row.groupIndex !== null) {
      groupOfSeq.set(row.seq, row.groupIndex);
    }
  }
  const edges = new Map<string, [number, number]>();
  const add = (from: number | undefined, to: number) => {
    if (from === undefined || from === to) {
      return;
    }
    edges.set(`${from}>${to}`, [from, to]);
  };
  for (const row of rows) {
    if (row.groupIndex === null) {
      continue;
    }
    if (row.dependsOnSeq !== null) {
      add(groupOfSeq.get(row.dependsOnSeq), row.groupIndex);
    }
    if (row.isCover) {
      for (const link of row.links) {
        add(groupOfSeq.get(link), row.groupIndex);
      }
    }
  }
  return edges.values().toArray();
}

class MinHeap {
  private items: number[] = [];

  get size() {
    return this.items.length;
  }

  push(value: number) {
    const items = this.items;
    items.push(value);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent] <= items[i]) {
        break;
      }
      const swap = items[parent];
      items[parent] = items[i];
      items[i] = swap;
      i = parent;
    }
  }

  pop(): number | undefined {
    const items = this.items;
    if (items.length === 0) {
      return undefined;
    }
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left] < items[smallest]) {
          smallest = left;
        }
        if (right < items.length && items[right] < items[smallest]) {
          smallest = right;
        }
        if (smallest === i) {
          break;
        }
        const swap = items[smallest];
        items[smallest] = items[i];
        items[i] = swap;
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Kahn's algorithm with a min-heap on the group index: dependencies first, otherwise index order. Groups caught in
 * a cycle are appended in index order (a cycle cannot be satisfied; index order is what the old code did).
 */
export function orderGroups(groups: Iterable<number>, edges: Iterable<[number, number]>): number[] {
  const nodes = [...new Set(groups)];
  const known = new Set(nodes);
  const indegree = new Map<number, number>(nodes.map((node) => [node, 0]));
  const next = new Map<number, number[]>();
  for (const [from, to] of edges) {
    if (from === to || !known.has(from) || !known.has(to)) {
      continue;
    }
    const list = next.get(from) ?? [];
    list.push(to);
    next.set(from, list);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const heap = new MinHeap();
  for (const node of nodes) {
    if (indegree.get(node) === 0) {
      heap.push(node);
    }
  }
  const order: number[] = [];
  const done = new Set<number>();
  while (heap.size > 0) {
    const node = heap.pop()!;
    order.push(node);
    done.add(node);
    for (const to of next.get(node) ?? []) {
      const left = indegree.get(to)! - 1;
      indegree.set(to, left);
      if (left === 0) {
        heap.push(to);
      }
    }
  }
  if (order.length < nodes.length) {
    order.push(...nodes.filter((node) => !done.has(node)).sort((a, b) => a - b));
  }
  return order;
}
