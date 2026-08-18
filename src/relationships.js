/**
 * Precomputed document-document relationships.
 * Generic: the runtime does not know whether edges came from embeddings,
 * taxonomy, hand authoring, or usage. Vectors do not belong here.
 */

import { parseRelationships } from "./artifacts.js";
import { classifyDirect } from "./features.js";
import { throwIfAborted } from "./cancel.js";

/** @param {unknown} artifact @returns {import("./types.js").RelationshipGraphApi} */
export function RelationshipGraph(artifact) {
  const parsed = parseRelationships(artifact);
  /** @type {Map<string, import("./types.js").RelationshipEdge[]>} */
  const bySource = new Map();
  for (const [source, edges] of Object.entries(parsed.relationships)) {
    bySource.set(source, edges);
  }
  return {
    name: "relationships",
    format: parsed.format,
    version: parsed.version,
    empty: bySource.size === 0,
    neighbors(sourceId) {
      return bySource.get(String(sourceId)) || [];
    },
    has(sourceId) {
      return bySource.has(String(sourceId));
    },
  };
}

/** @param {import("./types.js").FeaturedHit | null | undefined} hit */
export function isStrongPrimary(hit) {
  const f = hit?.features || /** @type {Partial<import("./types.js").FeatureVector>} */ ({});
  if (f.directClass === "strong") return true;
  if (f.exactTitleMatch) return true;
  if (f.configuredEquivalenceMatch === "key-in-title") return true;
  if ((f.queryCoverage || 0) >= 0.999 && (f.titlePrefixQuality || 0) >= 0.4) return true;
  if (f.versionMatch === "compact-dotted" || f.versionMatch === "dotted") return true;
  if (f.canonicalKeyTitle) return true;
  return false;
}

/**
 * Conservative expansion: only from high-confidence primaries, no multi-hop.
 * @param {import("./types.js").FeaturedHit[]} featured
 * @param {{ sourcePolicy?: import("./types.js").SourcePolicy, n?: number }} [opts]
 */
export function pickPrimariesForExpansion(featured, { sourcePolicy = "top1-strong", n = 3 } = {}) {
  const directs = featured.filter((h) => (h.features?.relevanceKind || "direct") !== "related");
  const strong = directs.filter(isStrongPrimary);
  if (!strong.length) return [];
  strong.sort((a, b) => (b.score || 0) - (a.score || 0) || (a.document.id < b.document.id ? -1 : 1));
  if (sourcePolicy === "all-strong") return strong;
  if (sourcePolicy === "top-n-strong") return strong.slice(0, Math.max(1, n));
  return strong.slice(0, 1);
}

/** @param {import("./types.js").FeaturedHit[]} featured */
export function pickPrimaryForExpansion(featured) {
  return pickPrimariesForExpansion(featured, { sourcePolicy: "top1-strong" })[0] || null;
}

/** @param {import("./types.js").RelationshipInfo | null | undefined} prev @param {import("./types.js").RelationshipInfo} next @returns {import("./types.js").RelationshipInfo} */
function mergeRelationship(prev, next) {
  /** @type {import("./types.js").RelationshipInfo[]} */
  const sources = [...(prev?.sources || (prev ? [stripSources(prev)] : [])), stripSources(next)];
  const best = sources.reduce((a, b) => ((b.strength || 0) > (a.strength || 0) ? b : a));
  return {
    ...best,
    sources,
  };
}

/** @param {import("./types.js").RelationshipInfo} rel @returns {import("./types.js").RelationshipInfo} */
function stripSources(rel) {
  const { sources, ...rest } = rel;
  return rest;
}

/**
 * Expand one hop from strong primaries.
 * Rank uses max strength; explanations keep every supporting source.
 * Weak existing directs may be reclassified as related when an edge exists.
 * Strong/moderate directs stay direct and are not converted to related.
 * @param {import("./types.js").RelationshipExpansionArgs} [args]
 * @returns {import("./types.js").ExpansionResult}
 */
export function applyRelationshipExpansion({ featured, query, extractFeatures, scoreFeatures, index, graph, sourcePolicy = "top1-strong", signal } = {}) {
  throwIfAborted(signal);
  if (!graph || graph.empty || !featured || !query || !extractFeatures || !scoreFeatures || !index) {
    return { featured: featured || [], relatedHits: [], primaries: [] };
  }
  const primaries = pickPrimariesForExpansion(featured, { sourcePolicy });
  if (!primaries.length) return { featured, relatedHits: [], primaries: [] };

  const byId = new Map(featured.map((h) => [h.document.id, h]));
  /** @type {Map<string, import("./types.js").RelationshipInfo>} */
  const collected = new Map();

  for (const primary of primaries) {
    const edges = graph.neighbors(primary.document.id);
    edges.forEach((edge, idx) => {
      if (!edge?.target) return;
      /** @type {import("./types.js").RelationshipInfo} */
      const rel = {
        sourceId: primary.document.id,
        sourceTitle: primary.document.title,
        type: edge.type,
        strength: edge.strength,
        provenance: edge.provenance,
        rank: idx + 1,
      };
      const prev = collected.get(edge.target);
      collected.set(edge.target, prev ? mergeRelationship(prev, rel) : { ...rel, sources: [rel] });
    });
  }

  /** @type {import("./types.js").RetrievalHit[]} */
  const relatedHits = [];
  let n = 0;
  for (const [target, relationship] of collected) {
    if ((n++ & 7) === 0) throwIfAborted(signal);
    const existing = byId.get(target);
    if (existing) {
      const cls = existing.features?.directClass || classifyDirect(existing.features || {});
      if (cls === "strong" || cls === "moderate") continue;
      existing.relationship = relationship;
      existing.retrievalSources = [...new Set([...(existing.retrievalSources || []), "relationship"])];
      existing.features = extractFeatures(query, existing.document, { relationship });
      existing.features.relevanceKind = "related";
      existing.score = scoreFeatures(existing.features);
      continue;
    }
    const doc = index.byId.get(target);
    if (!doc) continue;
    relatedHits.push({
      document: doc,
      retrievalSources: ["relationship"],
      relationship,
    });
  }
  return { featured, relatedHits, primaries };
}

/**
 * @param {{
 *   primary?: import("./types.js").FeaturedHit | null,
 *   index?: import("./types.js").SearchIndex,
 *   graph?: import("./types.js").RelationshipGraphApi | null,
 *   existingIds?: Set<string> | Iterable<string> | null
 * }} args
 * @returns {import("./types.js").RetrievalHit[]}
 */
export function expandRelatedCandidates({ primary, index, graph, existingIds }) {
  if (!primary || !graph || graph.empty || !index) return [];
  const seen = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  /** @type {import("./types.js").RetrievalHit[]} */
  const out = [];
  const edges = graph.neighbors(primary.document.id);
  edges.forEach((edge, idx) => {
    if (seen.has(edge.target)) return;
    const doc = index.byId.get(edge.target);
    if (!doc) return;
    seen.add(edge.target);
    out.push({
      document: doc,
      retrievalSources: ["relationship"],
      relationship: {
        sourceId: primary.document.id,
        sourceTitle: primary.document.title,
        type: edge.type,
        strength: edge.strength,
        provenance: edge.provenance,
        rank: idx + 1,
      },
    });
  });
  return out;
}
