/**
 * Frozen all-pairs ranking oracle.
 *
 * This is the 0.3.x production algorithm: every unordered candidate pair is
 * compared, then Kahn extracts SCCs with a full `ready.sort()` after every pop.
 * Production ranking may change; tests treat this module as the behavioral truth.
 *
 * Not part of the public package API. keep-public-dts strips the declaration.
 */

import {
  compareConstraint,
  buildConstraintGraph,
  buildConstraintGraphAsync,
  stronglyConnectedComponents,
  diagnoseConstraintGraph,
  computeComponentIndegrees,
  forEachOutgoingComponent,
  advanceConstraintStamp,
  DEFAULT_CONSTRAINTS,
} from "./constraints.js";
import { throwIfAborted } from "./cancel.js";
import { scoreFeatures } from "./rank.js";
import type { ConstraintDef, ConstraintGraph, FeaturedHit, RankedHit } from "./types.js";

function idCmp(a: FeaturedHit, b: FeaturedHit) {
  if (a.document.id < b.document.id) return -1;
  if (a.document.id > b.document.id) return 1;
  return 0;
}

function orderComponentsRepeatedSort(decorated: FeaturedHit[], graph: ConstraintGraph) {
  const { n, edges } = graph;
  const { comp, groups, cycles, adj } = stronglyConnectedComponents(n, edges);

  const nComp = groups.length;
  const indeg = computeComponentIndegrees(comp, groups, adj);
  const marks = new Uint32Array(nComp);
  let generation = 0;

  const ready: number[] = [];
  for (let g = 0; g < nComp; g++) if (indeg[g] === 0) ready.push(g);

  function bestOf(g: number) {
    const members = groups[g].map((i) => decorated[i]);
    members.sort((a, b) => ((b.score || 0) !== (a.score || 0) ? (b.score || 0) - (a.score || 0) : idCmp(a, b)));
    return members[0];
  }
  function readySort() {
    ready.sort((ga, gb) => {
      const a = bestOf(ga);
      const b = bestOf(gb);
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      return idCmp(a, b);
    });
  }
  readySort();
  const topo: number[] = [];
  while (ready.length) {
    const g = ready.shift() as number;
    topo.push(g);
    generation = advanceConstraintStamp(marks, generation);
    forEachOutgoingComponent(g, comp, groups, adj, marks, generation, (h) => {
      indeg[h] -= 1;
      if (indeg[h] === 0) ready.push(h);
    });
    readySort();
  }
  if (topo.length < groups.length) {
    for (let g = 0; g < groups.length; g++) if (!topo.includes(g)) topo.push(g);
  }

  const ordered: FeaturedHit[] = [];
  for (const g of topo) {
    const members = groups[g].map((i) => decorated[i]);
    members.sort((a, b) => {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      return idCmp(a, b);
    });
    ordered.push(...members);
  }
  return { ordered, cycles };
}

function orderFromGraphRepeatedSort(
  decorated: FeaturedHit[],
  graph: ConstraintGraph,
  constraints: ConstraintDef[],
  { signal }: { signal?: AbortSignal } = {}
): RankedHit[] {
  throwIfAborted(signal);
  const { ordered, cycles } = orderComponentsRepeatedSort(decorated, graph);
  throwIfAborted(signal);
  const diagnosis = diagnoseConstraintGraph(graph, decorated, { cycles });

  return ordered.map((c, i) => ({
    ...c,
    score: c.score ?? 0,
    rank: i + 1,
    constraintVsNext:
      i + 1 < ordered.length
        ? compareConstraint(c, ordered[i + 1], constraints)
        : { order: 0, applied: [], conflict: false, resolution: "unordered" },
    constraintMeta: {
      cycles: diagnosis.cycles,
      conflictCount: diagnosis.conflicts.length,
    },
  }));
}

/**
 * All-pairs ranker with repeated Kahn `ready.sort()`. Behavioral oracle for
 * identity-preserving ranking optimizations.
 */
export function rankCandidatesPairwise(
  candidates: FeaturedHit[],
  { constraints = DEFAULT_CONSTRAINTS, signal }: { constraints?: ConstraintDef[]; signal?: AbortSignal } = {}
): RankedHit[] {
  throwIfAborted(signal);
  const decorated = candidates.map((c) => ({
    ...c,
    score: Number(scoreFeatures(c.features).toFixed(6)),
  }));
  const graph = buildConstraintGraph(decorated, constraints, { signal });
  return orderFromGraphRepeatedSort(decorated, graph, constraints, { signal });
}

export async function rankCandidatesPairwiseAsync(
  candidates: FeaturedHit[],
  { constraints = DEFAULT_CONSTRAINTS, signal }: { constraints?: ConstraintDef[]; signal?: AbortSignal } = {}
): Promise<RankedHit[]> {
  throwIfAborted(signal);
  await Promise.resolve();
  throwIfAborted(signal);
  const decorated = candidates.map((c) => ({
    ...c,
    score: Number(scoreFeatures(c.features).toFixed(6)),
  }));
  const graph = await buildConstraintGraphAsync(decorated, constraints, { signal });
  return orderFromGraphRepeatedSort(decorated, graph, constraints, { signal });
}
