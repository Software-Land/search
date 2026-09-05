/**
 * Public result and search-meta assembly.
 *
 * Ranking, representative selection, and relationship expansion stay in
 * SearchEngine. This module maps already-ranked hits onto SearchResult rows
 * and the detailed result envelope.
 */
import { buildSearchExplanation } from "./explanation.js";
import type {
  AnalyzedQuery,
  FinishTimings,
  RankedHit,
  SearchResultRow,
} from "./types.js";

function serializeSearchHit(
  hit: RankedHit,
  query: AnalyzedQuery,
  explain?: boolean
): SearchResultRow {
  const f = hit.features;
  const row: SearchResultRow = {
    id: hit.document.id,
    title: hit.document.title,
    rank: hit.rank,
    score: hit.score,
    relevanceKind: f.relevanceKind,
    directClass: f.directClass,
  };
  if (hit.relationship) {
    row.relationship = {
      sourceId: hit.relationship.sourceId,
      sourceTitle: hit.relationship.sourceTitle,
      type: hit.relationship.type,
      strength: hit.relationship.strength,
      provenance: hit.relationship.provenance,
      rank: hit.relationship.rank,
      sources: hit.relationship.sources || undefined,
    };
  }
  if (explain) {
    row.retrievalSources = [...(hit.retrievalSources || [])];
    row.features = { ...f };
    row.constraints = hit.constraintVsNext?.applied || [];
    row.explanation = buildSearchExplanation({
      query,
      features: row.features as typeof f,
      retrievalSources: row.retrievalSources,
      relationship: hit.relationship,
      constraintVsNext: hit.constraintVsNext,
      constraintMeta: hit.constraintMeta ?? null,
    });
  }
  return row;
}

function sliceRankedResults(
  ranked: RankedHit[],
  strategy: string,
  { limit, relatedLimit }: { limit: number; relatedLimit: number }
) {
  const relatedRanked = ranked.filter((c) => c.features.relevanceKind === "related");
  const directRanked = ranked.filter((c) => c.features.relevanceKind !== "related");
  const primaryPool = strategy === "separate" || strategy === "none" ? directRanked : ranked;
  return {
    sliced: primaryPool.slice(0, Math.max(0, limit)),
    relatedSliced: relatedRanked.slice(0, Math.max(0, relatedLimit)),
    relatedRanked,
    directRanked,
  };
}

export type AssembleDetailedResultInput = {
  ranked: RankedHit[];
  query: AnalyzedQuery;
  explain: boolean;
  strategy: string;
  timings: FinishTimings;
  retrievalStats: Record<string, any>;
  indexBuildMs: number;
  retrieverName: string;
};

export function assembleDetailedResult({
  ranked,
  query,
  explain,
  strategy,
  timings,
  retrievalStats,
  indexBuildMs,
  retrieverName,
}: AssembleDetailedResultInput) {
  const { sliced, relatedSliced, relatedRanked } = sliceRankedResults(ranked, strategy, {
    limit: timings.limit,
    relatedLimit: timings.relatedLimit,
  });
  const results = sliced.map((c) => serializeSearchHit(c, query, explain));
  const related = relatedSliced.map((c) => serializeSearchHit(c, query, explain));
  const diagnosticRanked = timings.diagnosticRanked || ranked;
  const pruningStats = timings.pruningStats;
  const meta: Record<string, unknown> = {
    candidateCount: timings.diagnosticRanked?.length ?? timings.candidateCount,
    candidateTitles: diagnosticRanked.map((c) => c.document.title),
    retrieveMs: timings.retrieveMs,
    featureMs: timings.featureMs,
    relationshipMs: timings.relationshipMs,
    selectionMs: timings.selectionMs || 0,
    rankMs: timings.rankMs,
    totalMs: timings.totalMs,
    indexBuildMs,
    relationshipExpanded: timings.relationshipExpanded,
    matchCount: timings.matchCount ?? timings.candidateCount,
    representativeSelection: timings.representativeStats || null,
    retrievalStats,
    postingEntriesVisited: retrievalStats.postingEntriesVisited ?? null,
    distinctDocumentsExamined: retrievalStats.distinctDocumentsExamined ?? null,
    rawDocumentScans: retrievalStats.rawDocumentScans ?? null,
    postingBlocksVisited: retrievalStats.postingBlocksVisited ?? pruningStats?.postingBlocksVisited ?? 0,
    postingBlocksSkipped: retrievalStats.postingBlocksSkipped ?? pruningStats?.postingBlocksSkipped ?? 0,
    duplicatePostingBlocksAvoided: retrievalStats.duplicatePostingBlocksAvoided ?? retrievalStats.postingBlocksSkipped ?? 0,
    postingEntriesSkipped:
      (Number(retrievalStats.postingEntriesSkipped) || 0) +
      (pruningStats?.postingEntriesSkipped ?? 0),
    duplicatePostingEntriesAvoided: retrievalStats.duplicatePostingEntriesAvoided ?? 0,
    queryFormsExpanded: retrievalStats.queryFormsExpanded ?? 0,
    termsExpanded: retrievalStats.termsExpanded ?? 0,
    documentBlocksVisited: pruningStats?.documentBlocksVisited ?? 0,
    documentBlocksSkipped: pruningStats?.documentBlocksSkipped ?? 0,
    boundedBlocksSkipped: pruningStats?.boundedBlocksSkipped ?? 0,
    documentsFullyEvaluated: pruningStats?.documentsFullyEvaluated ?? timings.matchCount ?? 0,
    documentsBoundRejected: pruningStats?.documentsBoundRejected ?? 0,
    pruningSignaturesEncountered: pruningStats?.signaturesEncountered ?? 0,
    pruningRepresentativesRetained: pruningStats?.representativesRetained ?? 0,
    pruningFallbackReason: pruningStats?.pruningFallbackReason ?? null,
    postingBlocksTotal: retrievalStats.postingBlocksTotal ?? 0,
    postingBlocksDecoded: retrievalStats.postingBlocksDecoded ?? 0,
    postingBlocksClassifiedFromMasks: retrievalStats.postingBlocksClassifiedFromMasks ?? 0,
    postingBlocksSkippedUnread: retrievalStats.postingBlocksSkippedUnread ?? 0,
    postingEntriesDecoded: retrievalStats.postingEntriesDecoded ?? retrievalStats.postingEntriesVisited ?? 0,
    candidateDocumentsMaterialized: retrievalStats.candidateDocumentsMaterialized ?? timings.matchCount ?? 0,
    provenanceDocumentsScanned: retrievalStats.provenanceDocumentsScanned ?? 0,
    featureVectorsConstructed: timings.featureVectorsConstructed ?? 0,
    signaturesDiscovered: (timings.representativeStats as { signatures?: number } | null)?.signatures ?? 0,
    representativesInserted: (timings.representativeStats as { retained?: number } | null)?.retained ?? 0,
    representativesReplaced: 0,
    stage3A: retrievalStats.stage3A ?? "off",
    stage3AFallbackReason: retrievalStats.stage3AFallbackReason ?? null,
    relatedCount: timings.relatedCount ?? relatedRanked.length,
    primaryId: timings.primaryId,
    primaryIds: timings.primaryIds,
    relationshipStrategy: strategy,
    retriever: retrieverName,
    related,
    constraintCycles: diagnosticRanked[0]?.constraintMeta?.cycles || [],
    constraintConflicts: diagnosticRanked[0]?.constraintMeta?.conflictCount || 0,
    query: {
      raw: query.raw,
      originalSurface: query.originalSurface,
      alternatives: query.alternatives || [],
    },
  };
  return { results, related, meta };
}

export type PackedSearchMetaTimings = {
  rankingEvidenceFallbackReason?: string | null;
  optimizedDirectCandidates?: number;
  directFeatureVectorsConstructed?: number;
  relationshipOnlyFeatureVectorsConstructed?: number;
};

/** Mutates meta in place so lastSearchMeta and the returned envelope share identity. */
export function withPackedSearchMeta(
  meta: Record<string, unknown>,
  timings: PackedSearchMetaTimings
) {
  meta.rankingEvidence = "packed";
  meta.rankingEvidenceFallbackReason = timings.rankingEvidenceFallbackReason ?? null;
  meta.optimizedDirectCandidates = timings.optimizedDirectCandidates ?? 0;
  meta.directFeatureVectorsConstructed = timings.directFeatureVectorsConstructed ?? 0;
  meta.relationshipOnlyFeatureVectorsConstructed =
    timings.relationshipOnlyFeatureVectorsConstructed ?? 0;
  meta.explainOnlyFeatureVectorsConstructed = 0;
  return meta;
}
