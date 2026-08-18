/**
 * Partial-order constraints with explicit composition.
 *
 * Each constraint has a class:
 *   absolute — must not be overturned by weaker evidence (H1 exact title, direct vs related)
 *   strong   — genuine relevance relationships (version, coverage, canonical key)
 *   soft     — preferences that yield when they conflict with a stronger class
 *
 * Pairwise aggregation:
 *   1. Evaluate all constraints.
 *   2. The strongest class that produces a unanimous direction decides the pair.
 *   3. Same-class contradiction → unordered (NOT silent "use score" without a flag).
 *   4. Weaker classes that disagree are recorded but do not override.
 *
 * Set ranking uses a constraint graph + SCCs. Cycles become unordered
 * components scored deterministically. Conflicts/cycles are always observable.
 */

import { throwIfAborted } from "./cancel.js";

/** @param {unknown} v */
function versionStrength(v) {
  if (v === "dotted" || v === "compact-dotted") return 2;
  if (v === "compact-weak" || v === "dotted-weak") return 1;
  return 0;
}

/** @param {unknown} v */
function equivalenceStrength(v) {
  if (v === "key-in-title") return 2;
  if (v === "expansion" || v === "related") return 1;
  return 0;
}

/** @type {Record<string, number>} */
const CLASS_RANK = { absolute: 3, strong: 2, soft: 1 };

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function exactTitleConstraint(a, b) {
  if (a.features.exactTitleMatch && !b.features.exactTitleMatch) return -1;
  if (b.features.exactTitleMatch && !a.features.exactTitleMatch) return 1;
  return 0;
}

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function coverageConstraint(a, b) {
  const aFull = a.features.queryCoverage >= 0.999 && a.features.titlePrefixQuality >= 0.5;
  const bFull = b.features.queryCoverage >= 0.999 && b.features.titlePrefixQuality >= 0.5;
  const aWeak = a.features.queryCoverage > 0 && a.features.queryCoverage < 0.67 && !a.features.exactTitleMatch;
  const bWeak = b.features.queryCoverage > 0 && b.features.queryCoverage < 0.67 && !b.features.exactTitleMatch;
  if (aFull && bWeak) return -1;
  if (bFull && aWeak) return 1;
  return 0;
}

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function surfaceOverLemmaConstraint(a, b) {
  if (a.features.exactTitleTokenMatch === b.features.exactTitleTokenMatch) return 0;
  if (a.features.morphologyMatch && b.features.morphologyMatch) {
    if (a.features.exactTitleTokenMatch && !b.features.exactTitleTokenMatch) return -1;
    if (b.features.exactTitleTokenMatch && !a.features.exactTitleTokenMatch) return 1;
  }
  return 0;
}

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function versionConstraint(a, b) {
  const as = versionStrength(a.features.versionMatch);
  const bs = versionStrength(b.features.versionMatch);
  if (as === bs) return 0;
  if (as >= 2 && bs <= 1) return -1;
  if (bs >= 2 && as <= 1) return 1;
  return 0;
}

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function literalNumericOverWeakVersionConstraint(a, b) {
  const aLiteral = a.features.exactTitleTokenMatch && versionStrength(a.features.versionMatch) === 0;
  const bLiteral = b.features.exactTitleTokenMatch && versionStrength(b.features.versionMatch) === 0;
  const aWeak = versionStrength(a.features.versionMatch) === 1;
  const bWeak = versionStrength(b.features.versionMatch) === 1;
  if (aLiteral && bWeak) return -1;
  if (bLiteral && aWeak) return 1;
  return 0;
}

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function shortLiteralConstraint(a, b) {
  if (a.features.shortLiteralLeadMatch === b.features.shortLiteralLeadMatch) return 0;
  if (a.features.shortLiteralLeadMatch && !b.features.shortLiteralLeadMatch) return -1;
  if (b.features.shortLiteralLeadMatch && !a.features.shortLiteralLeadMatch) return 1;
  return 0;
}

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function tighterTitleConstraint(a, b) {
  const aExactish = a.features.queryCoverage >= 0.999 && a.features.titleCoverage >= 0.8;
  const bExactish = b.features.queryCoverage >= 0.999 && b.features.titleCoverage >= 0.8;
  if (aExactish && bExactish) {
    if (a.features.titleTokenCount < b.features.titleTokenCount) return -1;
    if (b.features.titleTokenCount < a.features.titleTokenCount) return 1;
    return 0;
  }
  if (aExactish && !bExactish) return -1;
  if (bExactish && !aExactish) return 1;
  return 0;
}

/**
 * Direct lexical/intent evidence outranks a purely related neighbor.
 * Related documents must not displace a strong primary match (H1).
 * Mixed presentation: any direct with title-ish evidence beats related.
 */
/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function directOverRelatedConstraint(a, b) {
  const aDirect = a.features.relevanceKind !== "related";
  const bDirect = b.features.relevanceKind !== "related";
  if (aDirect === bDirect) return 0;
  const aStrong =
    aDirect &&
    (a.features.exactTitleMatch ||
      a.features.configuredEquivalenceMatch === "key-in-title" ||
      a.features.canonicalKeyTitle ||
      (a.features.queryCoverage || 0) >= 0.999);
  const bStrong =
    bDirect &&
    (b.features.exactTitleMatch ||
      b.features.configuredEquivalenceMatch === "key-in-title" ||
      b.features.canonicalKeyTitle ||
      (b.features.queryCoverage || 0) >= 0.999);
  if (aDirect && !bDirect && (aStrong || (a.features.queryCoverage || 0) > 0 || a.features.exactTitleTokenMatch)) {
    return -1;
  }
  if (bDirect && !aDirect && (bStrong || (b.features.queryCoverage || 0) > 0 || b.features.exactTitleTokenMatch)) {
    return 1;
  }
  return 0;
}

/** @param {Partial<import("./types.js").FeatureVector>} f */
function isStrongOrModerateDirect(f) {
  return f.relevanceKind !== "related" && (f.directClass === "strong" || f.directClass === "moderate");
}

/** @param {Partial<import("./types.js").FeatureVector>} f */
function isWeakDirect(f) {
  return f.relevanceKind !== "related" && (f.directClass === "weak" || f.directClass === "none");
}

/**
 * Hybrid: strong/moderate directs outrank related; related outrank weak body-only directs.
 */
/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function hybridDirectOverRelatedConstraint(a, b) {
  const aRel = a.features.relevanceKind === "related";
  const bRel = b.features.relevanceKind === "related";
  if (aRel === bRel) return 0;
  if (isStrongOrModerateDirect(a.features) && bRel) return -1;
  if (isStrongOrModerateDirect(b.features) && aRel) return 1;
  return 0;
}

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function relatedOverWeakDirectConstraint(a, b) {
  const aRel = a.features.relevanceKind === "related";
  const bRel = b.features.relevanceKind === "related";
  if (aRel && isWeakDirect(b.features)) return -1;
  if (bRel && isWeakDirect(a.features)) return 1;
  return 0;
}

/**
 * When the query is a configured key, a title that also states the expansion
 * outranks a title that only contains the key (canonical vs comparison title).
 */
/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b */
function canonicalKeyConstraint(a, b) {
  if (a.features.canonicalKeyTitle === b.features.canonicalKeyTitle) return 0;
  if (a.features.canonicalKeyTitle && !b.features.canonicalKeyTitle) return -1;
  if (b.features.canonicalKeyTitle && !a.features.canonicalKeyTitle) return 1;
  return 0;
}

/** @type {import("./types.js").ConstraintDef[]} */
export const DEFAULT_CONSTRAINTS = [
  { id: "exact-title-over-non-exact", invariant: "H1", class: "absolute", fn: exactTitleConstraint },
  { id: "direct-over-related", invariant: "H1", class: "absolute", fn: directOverRelatedConstraint },
  { id: "canonical-key-expansion-over-key-only", invariant: "H2", class: "strong", fn: canonicalKeyConstraint },
  { id: "full-coverage-over-partial", invariant: "H8", class: "strong", fn: coverageConstraint },
  { id: "exact-surface-over-lemma-only", invariant: "H3", class: "strong", fn: surfaceOverLemmaConstraint },
  { id: "version-companion-over-weak-numeric", invariant: "H4", class: "strong", fn: versionConstraint },
  { id: "literal-numeric-over-weak-compact", invariant: "H4", class: "strong", fn: literalNumericOverWeakVersionConstraint },
  { id: "tighter-title-over-longer-contains", invariant: "H1", class: "soft", fn: tighterTitleConstraint },
  { id: "short-literal-lead-over-later", invariant: "H5", class: "soft", fn: shortLiteralConstraint },
];

/** @type {import("./types.js").ConstraintDef[]} */
export const HYBRID_CONSTRAINTS = [
  { id: "exact-title-over-non-exact", invariant: "H1", class: "absolute", fn: exactTitleConstraint },
  { id: "strong-moderate-direct-over-related", invariant: "H1", class: "absolute", fn: hybridDirectOverRelatedConstraint },
  { id: "related-over-weak-direct", invariant: "H1", class: "strong", fn: relatedOverWeakDirectConstraint },
  { id: "canonical-key-expansion-over-key-only", invariant: "H2", class: "strong", fn: canonicalKeyConstraint },
  { id: "full-coverage-over-partial", invariant: "H8", class: "strong", fn: coverageConstraint },
  { id: "exact-surface-over-lemma-only", invariant: "H3", class: "strong", fn: surfaceOverLemmaConstraint },
  { id: "version-companion-over-weak-numeric", invariant: "H4", class: "strong", fn: versionConstraint },
  { id: "literal-numeric-over-weak-compact", invariant: "H4", class: "strong", fn: literalNumericOverWeakVersionConstraint },
  { id: "tighter-title-over-longer-contains", invariant: "H1", class: "soft", fn: tighterTitleConstraint },
  { id: "short-literal-lead-over-later", invariant: "H5", class: "soft", fn: shortLiteralConstraint },
];

/** @param {string | import("./types.js").RelationshipStrategy} [strategy] */
export function constraintsForStrategy(strategy) {
  return strategy === "hybrid" ? HYBRID_CONSTRAINTS : DEFAULT_CONSTRAINTS;
}

/** @param {string | import("./types.js").RelationshipStrategy} [presentation] */
export function constraintsForPresentation(presentation) {
  return constraintsForStrategy(presentation);
}

const CLASS_ORDER = ["absolute", "strong", "soft"];

/** @param {import("./types.js").FeaturedHit} a @param {import("./types.js").FeaturedHit} b @param {import("./types.js").ConstraintDef[]} [defs] */
export function compareConstraint(a, b, defs = DEFAULT_CONSTRAINTS) {
  /** @type {Array<{ id: string, invariant: string, class: string, result: string }>} */
  const applied = [];
  /** @type {Record<string, Array<{ id: string, invariant: string, class: string, result: string }>>} */
  const byClass = { absolute: [], strong: [], soft: [] };

  for (const c of defs) {
    const r = c.fn(a, b);
    if (r === 0) continue;
    const row = {
      id: c.id,
      invariant: c.invariant,
      class: c.class || "strong",
      result: r < 0 ? "A>B" : "B>A",
    };
    applied.push(row);
    (byClass[row.class] || byClass.strong).push(row);
  }

  if (!applied.length) {
    return { order: 0, applied, conflict: false, resolution: "unordered" };
  }

  for (const cls of CLASS_ORDER) {
    const rows = byClass[cls];
    if (!rows.length) continue;
    const signs = new Set(rows.map((x) => x.result));
    if (signs.size > 1) {
      return {
        order: 0,
        applied,
        conflict: true,
        decisiveClass: cls,
        resolution: "unordered-same-class-conflict",
      };
    }
    const weakerDisagree = applied.some(
      (x) => CLASS_RANK[x.class] < CLASS_RANK[cls] && x.result !== rows[0].result
    );
    return {
      order: rows[0].result === "A>B" ? -1 : 1,
      applied,
      conflict: weakerDisagree,
      decisiveClass: cls,
      resolution: weakerDisagree ? "stronger-class-wins" : "constraint",
    };
  }

  return { order: 0, applied, conflict: false, resolution: "unordered" };
}

/**
 * Directed graph: edge i→j means i must outrank j.
 * Same-class conflicts add no edge (unordered; score will decide inside an SCC
 * only if other edges create a cycle).
 */
/**
 * @param {import("./types.js").FeaturedHit[]} candidates
 * @param {import("./types.js").ConstraintDef[]} [defs]
 * @param {{ signal?: AbortSignal }} [options]
 */
export function buildConstraintGraph(candidates, defs = DEFAULT_CONSTRAINTS, { signal } = {}) {
  const n = candidates.length;
  /** @type {number[][]} */
  const edges = [];
  /** @type {Array<import("./types.js").ConstraintCompareResult & { i: number, j: number }>} */
  const pairReports = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((k++ & 63) === 0) throwIfAborted(signal);
      const cmp = compareConstraint(candidates[i], candidates[j], defs);
      pairReports.push({ i, j, ...cmp });
      if (cmp.order < 0) edges.push([i, j]);
      else if (cmp.order > 0) edges.push([j, i]);
    }
  }
  return { n, edges, pairReports };
}

/** @param {import("./types.js").FeaturedHit[]} candidates @param {import("./types.js").ConstraintDef[]} [defs] @param {{ signal?: AbortSignal }} [options] */
export async function buildConstraintGraphAsync(candidates, defs = DEFAULT_CONSTRAINTS, { signal } = {}) {
  const n = candidates.length;
  /** @type {number[][]} */
  const edges = [];
  /** @type {Array<import("./types.js").ConstraintCompareResult & { i: number, j: number }>} */
  const pairReports = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((k++ & 63) === 0) {
        throwIfAborted(signal);
        await Promise.resolve();
        throwIfAborted(signal);
      }
      const cmp = compareConstraint(candidates[i], candidates[j], defs);
      pairReports.push({ i, j, ...cmp });
      if (cmp.order < 0) edges.push([i, j]);
      else if (cmp.order > 0) edges.push([j, i]);
    }
  }
  return { n, edges, pairReports };
}

/**
 * @param {number} n
 * @param {number[][]} edges
 */
export function stronglyConnectedComponents(n, edges) {
  /** @type {number[][]} */
  const adj = Array.from({ length: n }, () => /** @type {number[]} */ ([]));
  /** @type {number[][]} */
  const radj = Array.from({ length: n }, () => /** @type {number[]} */ ([]));
  for (const [u, v] of edges) {
    adj[u].push(v);
    radj[v].push(u);
  }
  const seen = new Array(n).fill(false);
  /** @type {number[]} */
  const order = [];
  /** @param {number} u */
  function dfs1(u) {
    seen[u] = true;
    for (const v of adj[u]) if (!seen[v]) dfs1(v);
    order.push(u);
  }
  for (let i = 0; i < n; i++) if (!seen[i]) dfs1(i);

  const comp = new Array(n).fill(-1);
  let cid = 0;
  /** @param {number} u @param {number} id */
  function dfs2(u, id) {
    comp[u] = id;
    for (const v of radj[u]) if (comp[v] === -1) dfs2(v, id);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const u = order[i];
    if (comp[u] === -1) dfs2(u, cid++);
  }

  /** @type {number[][]} */
  const groups = Array.from({ length: cid }, () => /** @type {number[]} */ ([]));
  for (let i = 0; i < n; i++) groups[comp[i]].push(i);
  const cycles = groups.filter((g) => g.length > 1).map((g) => g.slice());
  return { comp, groups, cycles };
}

/**
 * @param {import("./types.js").FeaturedHit[]} candidates
 * @param {import("./types.js").ConstraintDef[]} [defs]
 * @param {{ signal?: AbortSignal }} [options]
 */
export function detectConstraintCycles(candidates, defs = DEFAULT_CONSTRAINTS, { signal } = {}) {
  const { n, edges, pairReports } = buildConstraintGraph(candidates, defs, { signal });
  const { cycles } = stronglyConnectedComponents(n, edges);
  const conflicts = pairReports.filter((p) => p.conflict);
  return {
    cycles: cycles.map((ids) => ids.map((i) => candidates[i]?.document?.id ?? i)),
    conflicts: conflicts.map((p) => ({
      a: candidates[p.i]?.document?.id,
      b: candidates[p.j]?.document?.id,
      applied: p.applied,
      resolution: p.resolution,
    })),
    pairReports,
  };
}

export function constraintCatalog() {
  return DEFAULT_CONSTRAINTS.map(({ id, invariant, class: cls }) => ({ id, invariant, class: cls }));
}

export { equivalenceStrength, versionStrength, CLASS_RANK, isStrongOrModerateDirect, isWeakDirect };
