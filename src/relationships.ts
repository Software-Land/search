/**
 * Precomputed document-document relationships.
 * Generic: the runtime does not know whether edges came from embeddings,
 * taxonomy, hand authoring, or usage. Vectors do not belong here.
 */

import { parseRelationships } from "./artifacts.js";
import { classifyDirect } from "./features.js";
import { throwIfAborted } from "./cancel.js";
import { rankCandidates, selectTopPerBuiltinSignature } from "./rank.js";
import type {
  ConstraintDef,
  FeaturedHit,
  FeatureVector,
  RelationshipEdge,
  RelationshipExpansionArgs,
  RelationshipGraphApi,
  RelationshipInfo,
  RetrievalHit,
  SearchIndex,
  SourcePolicy,
  ExpansionResult,
} from "./types.js";

export function RelationshipGraph(artifact: unknown): RelationshipGraphApi {
  const parsed = parseRelationships(artifact);
  const bySource = new Map<string, RelationshipEdge[]>();
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

export function isStrongPrimary(hit: FeaturedHit | null | undefined) {
  const f: Partial<FeatureVector> = hit?.features || {};
  if (f.directClass === "strong") return true;
  if (f.exactTitleMatch) return true;
  if (f.configuredConceptMatch === "key-in-title") return true;
  if ((f.queryCoverage || 0) >= 0.999 && (f.titlePrefixQuality || 0) >= 0.4) return true;
  if (f.versionMatch === "compact-dotted" || f.versionMatch === "dotted") return true;
  if (f.canonicalKeyTitle) return true;
  return false;
}

/**
 * Conservative expansion: only from high-confidence primaries, no multi-hop.
 * Order is Search Core ranking of eligible strong DIRECT candidates, not
 * retrieval order or document-id order.
 */
export function pickPrimariesForExpansion(
  featured: FeaturedHit[],
  {
    sourcePolicy = "top1-strong",
    n = 3,
    constraints,
    signal,
  }: { sourcePolicy?: SourcePolicy; n?: number; constraints?: ConstraintDef[]; signal?: AbortSignal } = {}
) {
  const directs = featured.filter((h) => (h.features?.relevanceKind || "direct") !== "related");
  const strong = directs.filter(isStrongPrimary);
  if (!strong.length) return [];
  const primaryDepth = sourcePolicy === "top-n-strong" ? Math.max(1, n) : 1;
  const primaryPool =
    sourcePolicy === "all-strong"
      ? strong
      : selectTopPerBuiltinSignature(strong, primaryDepth, constraints).candidates;
  const ranked = rankCandidates(primaryPool, { constraints, signal });
  if (sourcePolicy === "all-strong") return ranked;
  if (sourcePolicy === "top-n-strong") return ranked.slice(0, Math.max(1, n));
  return ranked.slice(0, 1);
}

export function pickPrimaryForExpansion(featured: FeaturedHit[]) {
  return pickPrimariesForExpansion(featured, { sourcePolicy: "top1-strong" })[0] || null;
}

function mergeRelationship(prev: RelationshipInfo | null | undefined, next: RelationshipInfo): RelationshipInfo {
  const sources: RelationshipInfo[] = [...(prev?.sources || (prev ? [stripSources(prev)] : [])), stripSources(next)];
  const best = sources.reduce((a, b) => ((b.strength || 0) > (a.strength || 0) ? b : a));
  return {
    ...best,
    sources,
  };
}

function stripSources(rel: RelationshipInfo): RelationshipInfo {
  const { sources, ...rest } = rel;
  return rest;
}

/**
 * Expand one hop from strong primaries.
 * Rank uses max strength; explanations keep every supporting source.
 * Relationship support is orthogonal to directClass: existing lexical
 * candidates keep their class and stay `direct`. Independently retrieved
 * configured-prefix-recall candidates also stay `direct` when an edge is
 * attached. Newly admitted neighbors with no independent prefix-recall
 * source and no lexical/configured class are `related`.
 */
/**
 * Ambiguous configured-prefix groups independently retrieve every matching
 * key. top1-strong would expand only from the tightest title, dropping
 * neighbors of the other matching keys. Unique recall stays top1-strong.
 */
function unionAmbiguousPrefixRecallPrimaries(
  featured: FeaturedHit[],
  query: RelationshipExpansionArgs["query"],
  primaries: FeaturedHit[]
) {
  if (!query?.configuredPrefixRecallGroup?.length) return primaries;
  if (query.configuredPrefixRecall?.key) return primaries;
  const seen = new Set(primaries.map((hit) => hit.document.id));
  const extra: FeaturedHit[] = [];
  for (const hit of featured) {
    if (seen.has(hit.document.id)) continue;
    if (!isStrongPrimary(hit)) continue;
    if (!(hit.retrievalSources || []).includes("configured-prefix-recall")) continue;
    extra.push(hit);
    seen.add(hit.document.id);
  }
  return extra.length ? [...primaries, ...extra] : primaries;
}

export function applyRelationshipExpansion({
  featured,
  query,
  extractFeatures,
  scoreFeatures,
  index,
  graph,
  sourcePolicy = "top1-strong",
  signal,
  constraints,
}: RelationshipExpansionArgs = {}): ExpansionResult {
  throwIfAborted(signal);
  if (!graph || graph.empty || !featured || !query || !extractFeatures || !scoreFeatures || !index) {
    return { featured: featured || [], relatedHits: [], primaries: [] };
  }
  const primaries = unionAmbiguousPrefixRecallPrimaries(
    featured,
    query,
    pickPrimariesForExpansion(featured, { sourcePolicy, constraints, signal })
  );
  if (!primaries.length) return { featured, relatedHits: [], primaries: [] };

  const byId = new Map(featured.map((h) => [h.document.id, h]));
  const collected = new Map<string, RelationshipInfo>();

  for (const primary of primaries) {
    const edges = graph.neighbors(primary.document.id);
    edges.forEach((edge, idx) => {
      if (!edge?.target) return;
      const rel: RelationshipInfo = {
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

  const relatedHits: RetrievalHit[] = [];
  let n = 0;
  for (const [target, relationship] of collected) {
    if ((n++ & 7) === 0) throwIfAborted(signal);
    const existing = byId.get(target);
    if (existing) {
      const cls = existing.features?.directClass || classifyDirect(existing.features || {});
      existing.relationship = relationship;
      existing.retrievalSources = [...new Set([...(existing.retrievalSources || []), "relationship"])];
      if (cls === "strong" || cls === "moderate") {
        continue;
      }
      existing.features = extractFeatures(query, existing.document, {
        relationship,
        retrievalSources: existing.retrievalSources,
      });
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

export function expandRelatedCandidates({
  primary,
  index,
  graph,
  existingIds,
}: {
  primary?: FeaturedHit | null;
  index?: SearchIndex;
  graph?: RelationshipGraphApi | null;
  existingIds?: Set<string> | Iterable<string> | null;
}): RetrievalHit[] {
  if (!primary || !graph || graph.empty || !index) return [];
  const seen = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  const out: RetrievalHit[] = [];
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
