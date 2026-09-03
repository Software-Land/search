/**
 * Fail-closed production gate for retrieval-fused ranking evidence.
 *
 * Unsupported query, retriever, diagnostic, or plugin shapes keep the current
 * FeatureVector path. A fallback is success.
 */
import { COMPLETE_INTERPRETATION_COLLECTOR } from "./completeInterpretationCollector.js";
import { rankingEvidenceEligibilityReason } from "./rankingEvidencePlan.js";
import { rankingEvidenceStaticFor } from "./rankingEvidenceState.js";
import { hasRankingEvidenceRetrieverCapability } from "./retrievers.js";
import type { AnalyzedQuery, Retriever, SearchIndex, SearchOptions, SourcePolicy } from "./types.js";

export type PackedSearchGateInput = {
  exactDiagnostics: boolean;
  pruningMode: "auto" | "exhaustive";
  retrievalScoreWeight: number;
  sourcePolicy: SourcePolicy | string;
  retriever: Retriever | { exactSignatureSelection?: boolean };
  opts: SearchOptions;
  query: AnalyzedQuery;
  index: SearchIndex;
};

export function packedSearchFallbackReason({
  exactDiagnostics,
  pruningMode,
  retrievalScoreWeight,
  sourcePolicy,
  retriever,
  opts,
  query,
  index,
}: PackedSearchGateInput): string | null {
  if (exactDiagnostics) return "exact-diagnostics";
  if (opts.explain) return "explain";
  if (opts.resultCollector === COMPLETE_INTERPRETATION_COLLECTOR) {
    return "complete-interpretation";
  }
  if (pruningMode === "exhaustive") return "explicit-exhaustive";
  if (retrievalScoreWeight) return "retrieval-score-weight";
  if (sourcePolicy === "all-strong") return "all-strong-relationships";
  if (!hasRankingEvidenceRetrieverCapability(retriever as Retriever)) {
    return "unsupported-retriever";
  }
  return rankingEvidenceEligibilityReason(query, rankingEvidenceStaticFor(index));
}
