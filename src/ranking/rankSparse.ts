/**
 * Identity-preserving sparse ranker for builtin constraint functions.
 *
 * Candidates are grouped by constraintSignature. compareConstraint runs on
 * signature representatives (O(B²)), never on every candidate pair. Dominating
 * signatures become bucket-graph edges; complete bipartite A×B candidate edges
 * are not materialized.
 *
 * Kahn walks a frontier of ready buckets/blocks whose heap key is the next
 * best candidate under compareScoreThenWeakBodyThenId: rounded score, then
 * bodyPhraseCount when both candidates are the weak single-token body pack,
 * then equivalentRecallBodyOccurrenceCount when both are equivalent-body-only,
 * then document id. Incomparable buckets therefore interleave instead of
 * concatenating. A non-trivial bucket SCC is one candidate SCC and is emitted
 * as a block, matching all-pairs Kosaraju.
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
import { checkpoint, createCooperation, enterCooperationStage, type Cooperation } from "../execution/cooperate.js";
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

function groupBySignature(
  decorated: FeaturedHit[],
  cooperation: Cooperation | null,
  signal?: AbortSignal
): number[][] | Promise<number[][]> {
  const map = new Map<string, number[]>();
  const keys: string[] = [];
  let i = 0;
  const run = (): number[][] | Promise<number[][]> => {
    while (i < decorated.length) {
      if (cooperation && (i & 63) === 0) {
        const pending = checkpoint(cooperation, signal, 64);
        if (pending) return pending.then(run);
      }
      const key = constraintSignature(decorated[i].features);
      let members = map.get(key);
      if (!members) {
        members = [];
        map.set(key, members);
        keys.push(key);
      }
      members.push(i);
      i += 1;
    }
    return keys.map((key) => map.get(key) as number[]);
  };
  return run();
}

export function rankSparse(
  decorated: FeaturedHit[],
  constraints: ConstraintDef[],
  { signal, onStats, cooperation = null }: { signal?: AbortSignal; onStats?: (stats: RankerStats) => void; cooperation?: Cooperation | null } = {}
): RankedHit[] | Promise<RankedHit[]> {
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

  if (cooperation) enterCooperationStage(cooperation, "rank");
  const grouped = groupBySignature(decorated, cooperation, signal);
  if (grouped && typeof (grouped as Promise<number[][]>).then === "function") {
    return (grouped as Promise<number[][]>).then((buckets) => rankGrouped(buckets));
  }
  return rankGrouped(grouped as number[][]);

  function rankGrouped(buckets: number[][]): RankedHit[] | Promise<RankedHit[]> {
  const B = buckets.length;
  // Same abort opportunity as the all-pairs loop's first k===0 poll when C>=2.
  if (C >= 2) throwIfAborted(signal);
  const reps = buckets.map((members) => decorated[members[0]]);
  const edges = new PackedConstraintEdges();
  let conflictCount = 0;
  let bucketCompares = 0;
  let k = 0;
  let p = 0;
  let q = 1;

  const comparePairs = (): void | Promise<void> => {
    while (p < B) {
      while (q < B) {
        if ((k & 63) === 0) {
          const pending = checkpoint(cooperation, signal, 64);
          if (pending) return pending.then(comparePairs);
        }
        k += 1;
        bucketCompares += 1;
        const cmp = compareConstraint(reps[p], reps[q], constraints);
        if (cmp.conflict) conflictCount += buckets[p].length * buckets[q].length;
        if (cmp.order < 0) edges.append(p, q);
        else if (cmp.order > 0) edges.append(q, p);
        q += 1;
      }
      p += 1;
      q = p + 1;
    }
  };
  const finishRank = (): RankedHit[] | Promise<RankedHit[]> => {
  const scc = stronglyConnectedComponents(B, edges);
  const nSuper = scc.groups.length;
  const supers: SuperNode[] = [];
  const cycleGroups: number[][] = [];
  let g = 0;
  let bucketCursor = 0;
  let copyAt = 0;
  let members: number[] = [];
  let bucketIds: number[] = [];

  const indeg = computeComponentIndegrees(scc.comp, scc.groups, scc.adj);
  const marks = new Uint32Array(nSuper);
  let generation = 0;
  const inHeap = new Uint8Array(nSuper);
  const ordered: FeaturedHit[] = [];
  let active: number | null = null;

  function keyHit(group: number) {
    const node = supers[group];
    const index = node.isBlock ? node.sorted[0] : node.sorted[node.cursor];
    return decorated[index];
  }

  const heap = new BinaryMaxHeap<number>((ga, gb) => scoreThenWeakBodyThenIdBetter(keyHit(ga), keyHit(gb)));

  function offer(group: number) {
    if (inHeap[group]) return;
    inHeap[group] = 1;
    heap.push(group);
  }

  function unlock(group: number) {
    generation = advanceConstraintStamp(marks, generation);
    forEachOutgoingComponent(group, scc.comp, scc.groups, scc.adj, marks, generation, (h) => {
      indeg[h] -= 1;
      if (indeg[h] === 0) offer(h);
    });
  }

  const publish = (cycles: string[][]): RankedHit[] | Promise<RankedHit[]> => {
    if (!cooperation) {
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
    let i = 0;
    const out: RankedHit[] = [];
    const run = (): RankedHit[] | Promise<RankedHit[]> => {
      while (i < ordered.length) {
        if ((i & 63) === 0) {
          const pending = checkpoint(cooperation, signal, 64);
          if (pending) return pending.then(run);
        }
        const hit = ordered[i];
        out.push({
          ...hit,
          score: hit.score ?? 0,
          rank: i + 1,
          constraintVsNext:
            i + 1 < ordered.length
              ? compareConstraint(hit, ordered[i + 1], constraints)
              : { order: 0, applied: [], conflict: false, resolution: "unordered" },
          constraintMeta: { cycles, conflictCount },
        });
        i += 1;
      }
      onStats?.({
        mode: "sparse",
        C,
        B,
        kAmbiguous: 0,
        bucketCompares,
        candidatePairCompares: 0,
        bucketEdges: edges.length,
      });
      return out;
    };
    return run();
  };

  const fillGaps = (cycles: string[][]): RankedHit[] | Promise<RankedHit[]> => {
    if (ordered.length >= C) return publish(cycles);
    const seen = new Set(ordered.map((hit) => hit.document.id));
    let i = 0;
    const run = (): RankedHit[] | Promise<RankedHit[]> => {
      while (i < decorated.length) {
        if (cooperation && (i & 63) === 0) {
          const pending = checkpoint(cooperation, signal, 64);
          if (pending) return pending.then(run);
        }
        if (!seen.has(decorated[i].document.id)) ordered.push(decorated[i]);
        i += 1;
      }
      return publish(cycles);
    };
    return run();
  };

  const drain = (): RankedHit[] | Promise<RankedHit[]> => {
    while (active !== null || heap.size) {
      if (cooperation && (ordered.length & 63) === 0) {
        const pending = checkpoint(cooperation, signal, 64);
        if (pending) return pending.then(drain);
      }
      if (active === null) {
        const next = heap.pop();
        inHeap[next] = 0;
        active = next;
      }
      const node = supers[active];
      if (node.cursor < node.sorted.length) {
        ordered.push(decorated[node.sorted[node.cursor]]);
        node.cursor += 1;
      }
      if (node.cursor < node.sorted.length) {
        if (!node.isBlock) offer(active);
        if (!node.isBlock) active = null;
        continue;
      }
      unlock(active);
      active = null;
    }
    const cycles = cycleGroups.map((idxs) => idxs.map((index) => decorated[index].document.id));
    return fillGaps(cycles);
  };

  const buildGroups = (): RankedHit[] | Promise<RankedHit[]> => {
    while (g < nSuper) {
      if (bucketCursor === 0 && copyAt === 0 && members.length === 0) bucketIds = scc.groups[g];
      while (bucketCursor < bucketIds.length) {
        const source = buckets[bucketIds[bucketCursor]];
        while (copyAt < source.length) {
          if (cooperation && (copyAt & 63) === 0) {
            const pending = checkpoint(cooperation, signal, 64);
            if (pending) return pending.then(buildGroups);
          }
          members.push(source[copyAt]);
          copyAt += 1;
        }
        bucketCursor += 1;
        copyAt = 0;
      }
      // The native sort is one atomic step. Checkpoints surround it.
      if (cooperation) {
        const pending = checkpoint(cooperation, signal, 0);
        if (pending) return pending.then(buildGroups);
      }
      const isBlock = bucketIds.length > 1;
      const sorted = members.slice().sort((ia, ib) => cmpScoreId(decorated[ia], decorated[ib]));
      supers.push({ isBlock, members, sorted, cursor: 0 });
      if (isBlock && members.length > 1) cycleGroups.push(members.slice().sort((a, b) => a - b));
      g += 1;
      bucketCursor = 0;
      copyAt = 0;
      members = [];
    }
    for (let group = 0; group < nSuper; group++) if (indeg[group] === 0) offer(group);
    return drain();
  };
  return buildGroups();
  };
  const pendingPairs = comparePairs();
  if (pendingPairs) return pendingPairs.then(finishRank);
  return finishRank();
  }
}

export async function rankSparseAsync(
  decorated: FeaturedHit[],
  constraints: ConstraintDef[],
  opts: { signal?: AbortSignal; onStats?: (stats: RankerStats) => void; cooperation?: Cooperation | null } = {}
): Promise<RankedHit[]> {
  const cooperation = opts.cooperation ?? createCooperation();
  const ranked = rankSparse(decorated, constraints, { ...opts, cooperation });
  return typeof (ranked as Promise<RankedHit[]>).then === "function"
    ? ranked as Promise<RankedHit[]>
    : ranked as RankedHit[];
}
