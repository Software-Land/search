/**
 * Rank by constraint partial order:
 *   builtin: signature buckets → bucket constraint DAG → SCC → heap frontier
 *   custom: all-pairs graph → SCCs → heap extraction of ready components
 *   → score + stable id inside unordered components / cycle blocks.
 * Cycles/conflicts are attached for explain/tests; they never fail silently.
 *
 * Interpretable within-constraint score is used only inside unordered
 * components of the constraint partial order.
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
import { BinaryMaxHeap } from "./rankHeap.js";
import { constraintsAreBuiltin, rankSparse, rankSparseAsync, type RankerStats } from "./rankSparse.js";
import { constraintSignature } from "./rankSignature.js";
import { compareScoreThenWeakBodyThenId, scoreThenWeakBodyThenIdBetter } from "./rankTieBreak.js";
import type { ConstraintDef, ConstraintGraph, FeaturedHit, FeatureVector, RankedHit } from "./types.js";

let lastStats: RankerStats | null = null;

/** Last rankCandidates / rankCandidatesAsync instrumentation. Not a public API. */
export function lastRankStats(): RankerStats | null {
  return lastStats;
}

function recordPairwiseStats(C: number, edgeCount: number) {
  lastStats = {
    mode: "pairwise",
    C,
    B: C,
    kAmbiguous: C,
    bucketCompares: 0,
    candidatePairCompares: C <= 1 ? 0 : (C * (C - 1)) / 2,
    bucketEdges: edgeCount,
  };
}

function boolNum(v: unknown) {
  return v ? 1 : 0;
}

function versionNum(v: unknown) {
  if (v === "dotted" || v === "compact-dotted") return 1;
  if (v === "compact-weak" || v === "dotted-weak") return 0.35;
  return 0;
}

function equivNum(v: unknown) {
  if (v === "key-in-title") return 1;
  if (v === "expansion") return 0.8;
  return 0;
}

/**
 * Interpretable within-constraint score. Used only inside unordered
 * components of the constraint partial order.
 */
export function scoreFeatures(f: Partial<FeatureVector>) {
  return (
    boolNum(f.exactTitleMatch) * 5 +
    boolNum(f.exactTitleTokenMatch) * 1.6 +
    (f.queryCoverage || 0) * 2.4 +
    (f.titleCoverage || 0) * 1.2 +
    (f.titlePrefixQuality || 0) * 1.8 +
    equivNum(f.configuredEquivalenceMatch) * 1.5 +
    boolNum(f.canonicalKeyTitle) * 1.3 +
    (f.expansionEvidence || 0) * 0.8 +
    boolNum(f.morphologyMatch) * 0.4 +
    Math.min(f.typoDistance || 0, 2) * 0.35 +
    versionNum(f.versionMatch) * 2.2 +
    boolNum(f.shortLiteralLeadMatch) * 1.7 +
    boolNum(f.dottedSpanComponentTitleMatch) * 0.9 +
    (f.phraseAdjacency || 0) * 0.8 +
    (f.bodyLexicalMatch || 0) * 0.25 +
    (Number(f.standaloneRecallScore) || 0) +
    (Number(f.topicalRecallScore) || 0) +
    (Number(f.equivalentRecallScore) || 0) +
    (f.relationshipStrength || 0) * 0.45 +
    (f.retrievalScore || 0)
  );
}

export type RepresentativeSelectionStats = {
  exact: boolean;
  requestedDepth: number;
  examined: number;
  signatures: number;
  retained: number;
  maxRepresentativesPerSignature: number;
  fallback: "none" | "custom-constraints";
};

/**
 * Exact builtin-ranker reduction.
 *
 * For one constraint signature every builtin constraint compares identically
 * against every other signature. The sparse ranker orders members of that
 * signature by the rounded final score, then document id. Therefore a member
 * below depth R in its signature has at least R same-signature predecessors
 * and cannot occur in the global top R.
 *
 * Map insertion order is part of the reduction: retained groups are emitted
 * in the first-seen signature order used by rankSparse. Do not reorder the
 * groups independently. SearchEngine feature vectors are query-coherent, but
 * preserving this ordered quotient also keeps the theorem valid for synthetic
 * builtin vectors whose directional comparisons are asymmetric.
 *
 * Callers that need `constraintVsNext` for the first R results must request
 * R + 1 representatives. Unknown/custom constraints fail closed to all
 * candidates because their functions are not covered by constraintSignature.
 */
export function selectTopPerBuiltinSignature(
  candidates: FeaturedHit[],
  depth: number,
  constraints: ConstraintDef[] = DEFAULT_CONSTRAINTS
): { candidates: FeaturedHit[]; stats: RepresentativeSelectionStats } {
  const requestedDepth = Math.max(0, Math.floor(Number(depth) || 0));
  if (!constraintsAreBuiltin(constraints)) {
    return {
      candidates: candidates.slice(),
      stats: {
        exact: true,
        requestedDepth,
        examined: candidates.length,
        signatures: candidates.length,
        retained: candidates.length,
        maxRepresentativesPerSignature: candidates.length ? 1 : 0,
        fallback: "custom-constraints",
      },
    };
  }
  if (requestedDepth === 0 || candidates.length === 0) {
    return {
      candidates: [],
      stats: {
        exact: true,
        requestedDepth,
        examined: candidates.length,
        signatures: candidates.length ? new Set(candidates.map((c) => constraintSignature(c.features))).size : 0,
        retained: 0,
        maxRepresentativesPerSignature: 0,
        fallback: "none",
      },
    };
  }

  const groups = new Map<string, FeaturedHit[]>();
  for (const candidate of candidates) {
    const key = constraintSignature(candidate.features);
    const scored = {
      ...candidate,
      score: Number(scoreFeatures(candidate.features).toFixed(6)),
    };
    const group = groups.get(key);
    if (group) group.push(scored);
    else groups.set(key, [scored]);
  }

  const retained: FeaturedHit[] = [];
  let maxRepresentativesPerSignature = 0;
  // Intentionally iterate Map insertion order to preserve rankSparse's
  // first-seen signature order.
  for (const group of groups.values()) {
    group.sort(compareScoreThenWeakBodyThenId);
    const take = Math.min(requestedDepth, group.length);
    maxRepresentativesPerSignature = Math.max(maxRepresentativesPerSignature, take);
    for (let i = 0; i < take; i++) retained.push(group[i]);
  }
  return {
    candidates: retained,
    stats: {
      exact: true,
      requestedDepth,
      examined: candidates.length,
      signatures: groups.size,
      retained: retained.length,
      maxRepresentativesPerSignature,
      fallback: "none",
    },
  };
}

export function compareCandidates(a: FeaturedHit, b: FeaturedHit, defs: ConstraintDef[] = DEFAULT_CONSTRAINTS) {
  const constrained = compareConstraint(a, b, defs);
  if (constrained.order !== 0) return constrained.order;
  return compareScoreThenWeakBodyThenId(a, b);
}

export function rankCandidates(
  candidates: FeaturedHit[],
  { constraints = DEFAULT_CONSTRAINTS, signal }: { constraints?: ConstraintDef[]; signal?: AbortSignal } = {}
): RankedHit[] {
  throwIfAborted(signal);
  const decorated = candidates.map((c) => ({
    ...c,
    score: Number(scoreFeatures(c.features).toFixed(6)),
  }));
  if (constraintsAreBuiltin(constraints)) {
    return rankSparse(decorated, constraints, { signal, onStats: (s) => (lastStats = s) });
  }
  const graph = buildConstraintGraph(decorated, constraints, { signal });
  recordPairwiseStats(decorated.length, graph.edges.length);
  return orderFromGraph(decorated, graph, constraints, { signal });
}

export async function rankCandidatesAsync(
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
  if (constraintsAreBuiltin(constraints)) {
    return rankSparseAsync(decorated, constraints, { signal, onStats: (s) => (lastStats = s) });
  }
  const graph = await buildConstraintGraphAsync(decorated, constraints, { signal });
  recordPairwiseStats(decorated.length, graph.edges.length);
  return orderFromGraph(decorated, graph, constraints, { signal });
}

function orderComponents(decorated: FeaturedHit[], graph: ConstraintGraph) {
  const { n, edges } = graph;
  const { comp, groups, cycles, adj } = stronglyConnectedComponents(n, edges);

  const nComp = groups.length;
  const indeg = computeComponentIndegrees(comp, groups, adj);
  const marks = new Uint32Array(nComp);
  let generation = 0;

  const bestHit: FeaturedHit[] = new Array(nComp);
  for (let g = 0; g < nComp; g++) {
    let best = decorated[groups[g][0]];
    for (let k = 1; k < groups[g].length; k++) {
      const cand = decorated[groups[g][k]];
      if (scoreThenWeakBodyThenIdBetter(cand, best)) best = cand;
    }
    bestHit[g] = best;
  }

  const heap = new BinaryMaxHeap<number>((ga, gb) => scoreThenWeakBodyThenIdBetter(bestHit[ga], bestHit[gb]));
  for (let g = 0; g < nComp; g++) if (indeg[g] === 0) heap.push(g);

  const topo: number[] = [];
  while (heap.size) {
    const g = heap.pop();
    topo.push(g);
    generation = advanceConstraintStamp(marks, generation);
    forEachOutgoingComponent(g, comp, groups, adj, marks, generation, (h) => {
      indeg[h] -= 1;
      if (indeg[h] === 0) heap.push(h);
    });
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
  // Reverse CSR was never stored on the SCC result. Forward CSR / groups /
  // comp become unreachable when this frame returns; diagnosis keeps only
  // the copied `cycles` rows.
  return { ordered, cycles };
}

function orderFromGraph(
  decorated: FeaturedHit[],
  graph: ConstraintGraph,
  constraints: ConstraintDef[],
  { signal }: { signal?: AbortSignal } = {}
): RankedHit[] {
  throwIfAborted(signal);
  const { ordered, cycles } = orderComponents(decorated, graph);

  // Same abort opportunity the previous second buildConstraintGraph() polled
  // at its first pair (k === 0) before diagnostic work.
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

export { detectConstraintCycles } from "./constraints.js";
export { compareConstraint };
