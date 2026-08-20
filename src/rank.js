import {
  compareConstraint,
  buildConstraintGraph,
  buildConstraintGraphAsync,
  stronglyConnectedComponents,
  detectConstraintCycles,
  DEFAULT_CONSTRAINTS,
} from "./constraints.js";
import { throwIfAborted } from "./cancel.js";

/** @param {unknown} v */
function boolNum(v) {
  return v ? 1 : 0;
}

/** @param {unknown} v */
function versionNum(v) {
  if (v === "dotted" || v === "compact-dotted") return 1;
  if (v === "compact-weak" || v === "dotted-weak") return 0.35;
  return 0;
}

/** @param {unknown} v */
function equivNum(v) {
  if (v === "key-in-title") return 1;
  if (v === "expansion") return 0.8;
  return 0;
}

/**
 * Interpretable within-constraint score. Used only inside unordered
 * components of the constraint partial order.
 */
/** @param {Partial<import("./types.js").FeatureVector>} f */
export function scoreFeatures(f) {
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
    (f.phraseAdjacency || 0) * 0.8 +
    (f.bodyLexicalMatch || 0) * 0.25 +
    (f.relationshipStrength || 0) * 0.45 +
    (f.retrievalScore || 0)
  );
}

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function idCmp(a, b) {
  if (a.document.id < b.document.id) return -1;
  if (a.document.id > b.document.id) return 1;
  return 0;
}

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b @param {import("./types.js").ConstraintDef[]} [defs] */
export function compareCandidates(a, b, defs = DEFAULT_CONSTRAINTS) {
  const constrained = compareConstraint(a, b, defs);
  if (constrained.order !== 0) return constrained.order;
  if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
  return idCmp(a, b);
}

/**
 * Rank by constraint partial order:
 *   graph of must-outrank edges → SCCs → topo order of components
 *   → score + stable id inside each component.
 * Cycles/conflicts are attached for explain/tests; they never fail silently.
 */
/**
 * @param {import("./types.js").FeaturedHit[]} candidates
 * @param {{ constraints?: import("./types.js").ConstraintDef[], signal?: AbortSignal }} [options]
 * @returns {import("./types.js").RankedHit[]}
 */
export function rankCandidates(candidates, { constraints = DEFAULT_CONSTRAINTS, signal } = {}) {
  throwIfAborted(signal);
  const decorated = candidates.map((c) => ({
    ...c,
    score: Number(scoreFeatures(c.features).toFixed(6)),
  }));
  const { n, edges } = buildConstraintGraph(decorated, constraints, { signal });
  return orderFromGraph(decorated, n, edges, constraints, { signal });
}

/** @param {import("./types.js").FeaturedHit[]} candidates @param {{ constraints?: import("./types.js").ConstraintDef[], signal?: AbortSignal }} [options] */
export async function rankCandidatesAsync(candidates, { constraints = DEFAULT_CONSTRAINTS, signal } = {}) {
  throwIfAborted(signal);
  await Promise.resolve();
  throwIfAborted(signal);
  const decorated = candidates.map((c) => ({
    ...c,
    score: Number(scoreFeatures(c.features).toFixed(6)),
  }));
  const { n, edges } = await buildConstraintGraphAsync(decorated, constraints, { signal });
  return orderFromGraph(decorated, n, edges, constraints, { signal });
}

/**
 * @param {import("./types.js").FeaturedHit[]} decorated
 * @param {number} n
 * @param {number[][]} edges
 * @param {import("./types.js").ConstraintDef[]} constraints
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {import("./types.js").RankedHit[]}
 */
function orderFromGraph(decorated, n, edges, constraints, { signal } = {}) {
  throwIfAborted(signal);
  const { comp, groups } = stronglyConnectedComponents(n, edges);

  const succ = Array.from({ length: groups.length }, () => new Set());
  const indeg = new Array(groups.length).fill(0);
  for (const [u, v] of edges) {
    if (comp[u] === comp[v]) continue;
    if (!succ[comp[u]].has(comp[v])) {
      succ[comp[u]].add(comp[v]);
      indeg[comp[v]] += 1;
    }
  }

  /** @type {number[]} */
  const ready = [];
  for (let g = 0; g < groups.length; g++) if (indeg[g] === 0) ready.push(g);

  /** @param {number} g */
  function bestOf(g) {
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
  /** @type {number[]} */
  const topo = [];
  while (ready.length) {
    const g = /** @type {number} */ (ready.shift());
    topo.push(g);
    const next = [...succ[g]];
    for (const h of next) {
      indeg[h] -= 1;
      if (indeg[h] === 0) ready.push(h);
    }
    readySort();
  }
  // If the DAG walk missed nodes (shouldn't with SCCs), append remaining by id.
  if (topo.length < groups.length) {
    for (let g = 0; g < groups.length; g++) if (!topo.includes(g)) topo.push(g);
  }

  /** @type {import("./types.js").FeaturedHit[]} */
  const ordered = [];
  for (const g of topo) {
    const members = groups[g].map((i) => decorated[i]);
    members.sort((a, b) => {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      return idCmp(a, b);
    });
    ordered.push(...members);
  }

  const diagnosis = detectConstraintCycles(decorated, constraints, { signal });

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

export { detectConstraintCycles, compareConstraint };
