/**
 * Identity-preserving sparse ranker for builtin constraint functions.
 *
 * Candidates are grouped by constraintSignature. compareConstraint runs on
 * signature representatives (O(B²)), never on every candidate pair. Dominating
 * signatures become bucket-graph edges; complete bipartite A×B candidate edges
 * are not materialized.
 *
 * Kahn walks a frontier of ready buckets/blocks whose heap key is the next
 * best candidate (score, then document.id). Incomparable buckets therefore
 * interleave instead of concatenating. A non-trivial bucket SCC is one
 * candidate SCC and is emitted as a block, matching all-pairs Kosaraju.
 *
 * Custom ConstraintDef.fn values (not the builtin DEFAULT/HYBRID functions)
 * are not signature-safe and must use the pairwise path.
 */

import {
  compareConstraint,
  DEFAULT_CONSTRAINTS,
  HYBRID_CONSTRAINTS,
  PackedConstraintEdges,
  stronglyConnectedComponents,
  computeComponentIndegrees,
  forEachOutgoingComponent,
  advanceConstraintStamp,
} from "./constraints.js";
import { throwIfAborted } from "../cancel.js";
import { BinaryMaxHeap } from "./rankHeap.js";
import { constraintSignature } from "./rankSignature.js";
import { compareScoreThenWeakBodyThenId, scoreThenWeakBodyThenIdBetter } from "./rankTieBreak.js";
import type { ConstraintDef, FeaturedHit, RankedHit } from "../types.js";

const BUILTIN_FNS = new Set<(a: FeaturedHit, b: FeaturedHit) => number>();
for (const d of DEFAULT_CONSTRAINTS) BUILTIN_FNS.add(d.fn);
for (const d of HYBRID_CONSTRAINTS) BUILTIN_FNS.add(d.fn);

export function constraintsAreBuiltin(defs: ConstraintDef[]) {
  return defs.every((d) => BUILTIN_FNS.has(d.fn));
}

export type RankerStats = {
  mode: "pairwise" | "sparse";
  C: number;
  B: number;
  kAmbiguous: number;
  bucketCompares: number;
  candidatePairCompares: number;
  bucketEdges: number;
};

function cmpScoreId(a: FeaturedHit, b: FeaturedHit) {
  return compareScoreThenWeakBodyThenId(a, b);
}

function attachRankMeta(
  ordered: FeaturedHit[],
  cycles: string[][],
  conflictCount: number,
  constraints: ConstraintDef[]
): RankedHit[] {
  return ordered.map((c, i) => ({
    ...c,
    score: c.score ?? 0,
    rank: i + 1,
    constraintVsNext:
      i + 1 < ordered.length
        ? compareConstraint(c, ordered[i + 1], constraints)
        : { order: 0, applied: [], conflict: false, resolution: "unordered" },
    constraintMeta: {
      cycles,
      conflictCount,
    },
  }));
}

type SuperNode = {
  isBlock: boolean;
  members: number[];
  sorted: number[];
  cursor: number;
};

function groupBySignature(decorated: FeaturedHit[]) {
  const map = new Map<string, number[]>();
  const keys: string[] = [];
  for (let i = 0; i < decorated.length; i++) {
    const key = constraintSignature(decorated[i].features);
    let members = map.get(key);
    if (!members) {
      members = [];
      map.set(key, members);
      keys.push(key);
    }
    members.push(i);
  }
  return keys.map((key) => map.get(key) as number[]);
}

export function rankSparse(
  decorated: FeaturedHit[],
  constraints: ConstraintDef[],
  { signal, onStats }: { signal?: AbortSignal; onStats?: (stats: RankerStats) => void } = {}
): RankedHit[] {
  throwIfAborted(signal);
  const C = decorated.length;
  if (C === 0) {
    onStats?.({
      mode: "sparse",
      C: 0,
      B: 0,
      kAmbiguous: 0,
      bucketCompares: 0,
      candidatePairCompares: 0,
      bucketEdges: 0,
    });
    return [];
  }

  const buckets = groupBySignature(decorated);
  const B = buckets.length;
  // Same abort opportunity as the all-pairs loop's first k===0 poll when C>=2.
  if (C >= 2) throwIfAborted(signal);
  const reps = buckets.map((members) => decorated[members[0]]);
  const edges = new PackedConstraintEdges();
  let conflictCount = 0;
  let bucketCompares = 0;
  let k = 0;

  for (let p = 0; p < B; p++) {
    for (let q = p + 1; q < B; q++) {
      if ((k++ & 63) === 0) throwIfAborted(signal);
      bucketCompares += 1;
      const cmp = compareConstraint(reps[p], reps[q], constraints);
      if (cmp.conflict) conflictCount += buckets[p].length * buckets[q].length;
      if (cmp.order < 0) edges.append(p, q);
      else if (cmp.order > 0) edges.append(q, p);
    }
  }

  const scc = stronglyConnectedComponents(B, edges);
  const nSuper = scc.groups.length;
  const supers: SuperNode[] = [];
  const cycleGroups: number[][] = [];

  for (let g = 0; g < nSuper; g++) {
    const bucketIds = scc.groups[g];
    const isBlock = bucketIds.length > 1;
    const members: number[] = [];
    for (const b of bucketIds) members.push(...buckets[b]);
    const sorted = members.slice().sort((ia, ib) => cmpScoreId(decorated[ia], decorated[ib]));
    supers.push({ isBlock, members, sorted, cursor: 0 });
    if (isBlock && members.length > 1) {
      cycleGroups.push(members.slice().sort((a, b) => a - b));
    }
  }

  const indeg = computeComponentIndegrees(scc.comp, scc.groups, scc.adj);
  const marks = new Uint32Array(nSuper);
  let generation = 0;
  const inHeap = new Uint8Array(nSuper);

  function keyHit(g: number) {
    const node = supers[g];
    const i = node.isBlock ? node.sorted[0] : node.sorted[node.cursor];
    return decorated[i];
  }

  const heap = new BinaryMaxHeap<number>((ga, gb) => scoreThenWeakBodyThenIdBetter(keyHit(ga), keyHit(gb)));

  function offer(g: number) {
    if (inHeap[g]) return;
    inHeap[g] = 1;
    heap.push(g);
  }

  for (let g = 0; g < nSuper; g++) if (indeg[g] === 0) offer(g);

  const ordered: FeaturedHit[] = [];

  function unlock(g: number) {
    generation = advanceConstraintStamp(marks, generation);
    forEachOutgoingComponent(g, scc.comp, scc.groups, scc.adj, marks, generation, (h) => {
      indeg[h] -= 1;
      if (indeg[h] === 0) offer(h);
    });
  }

  while (heap.size) {
    const g = heap.pop();
    inHeap[g] = 0;
    const node = supers[g];
    if (node.isBlock) {
      for (const i of node.sorted) ordered.push(decorated[i]);
      node.cursor = node.sorted.length;
      unlock(g);
      continue;
    }
    const i = node.sorted[node.cursor];
    ordered.push(decorated[i]);
    node.cursor += 1;
    if (node.cursor < node.sorted.length) offer(g);
    else unlock(g);
  }

  if (ordered.length < C) {
    const seen = new Set(ordered.map((h) => h.document.id));
    for (const hit of decorated) {
      if (!seen.has(hit.document.id)) ordered.push(hit);
    }
  }

  const cycles = cycleGroups.map((idxs) => idxs.map((i) => decorated[i].document.id));
  onStats?.({
    mode: "sparse",
    C,
    B,
    kAmbiguous: 0,
    bucketCompares,
    candidatePairCompares: 0,
    bucketEdges: edges.length,
  });
  throwIfAborted(signal);
  return attachRankMeta(ordered, cycles, conflictCount, constraints);
}

export async function rankSparseAsync(
  decorated: FeaturedHit[],
  constraints: ConstraintDef[],
  opts: { signal?: AbortSignal; onStats?: (stats: RankerStats) => void } = {}
): Promise<RankedHit[]> {
  throwIfAborted(opts.signal);
  await Promise.resolve();
  throwIfAborted(opts.signal);
  return rankSparse(decorated, constraints, opts);
}
