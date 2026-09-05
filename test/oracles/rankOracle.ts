/**
 * Frozen all-pairs ranking oracle.
 *
 * This is the 0.3.x production algorithm: every unordered candidate pair is
 * compared, then Kahn extracts SCCs with a full `ready.sort()` after every pop.
 * Production ranking may change; tests treat this module as the behavioral truth.
 *
 * Not a public package API. Transpiled into build/test/oracles/ for tests and
 * benchmarks; excluded from production dist and the npm tarball.
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
} from "../../src/ranking/constraints.js";
import { throwIfAborted } from "../../src/cancel.js";
import { scoreFeatures } from "../../src/ranking/rank.js";
import { compareScoreThenWeakBodyThenId } from "../../src/ranking/rankTieBreak.js";
import type { ConstraintDef, ConstraintGraph, FeaturedHit, RankedHit } from "../../src/types.js";

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
    members.sort(compareScoreThenWeakBodyThenId);
    return members[0];
  }
  function readySort() {
    ready.sort((ga, gb) => compareScoreThenWeakBodyThenId(bestOf(ga), bestOf(gb)));
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
    members.sort(compareScoreThenWeakBodyThenId);
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
