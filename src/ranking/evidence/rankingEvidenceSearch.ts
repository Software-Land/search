/**
 * Fail-closed production gate for retrieval-fused ranking evidence.
 *
 * Unsupported query, retriever, diagnostic, or plugin shapes keep the current
 * FeatureVector path. A fallback is success.
 *
 * Session capability facts come from executionSession. Query-semantic
 * ineligibility stays in rankingEvidenceEligibilityReason. This function is
 * packed-search policy, not a global eligibility oracle.
 */
import {
  searchSessionCapabilities,
  type OptimizationSessionReason,
} from "../../execution/executionSession.js";
import {
  rankingEvidenceEligibilityReason,
  type RankingEvidenceEligibilityReason,
} from "./rankingEvidencePlan.js";
import { rankingEvidenceStaticFor } from "./rankingEvidenceState.js";
import { hasRankingEvidenceRetrieverCapability } from "../../retrieval/retrievers.js";
import type { AnalyzedQuery, Retriever, SearchIndex, SearchOptions, SourcePolicy } from "../../types.js";

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

export type PackedSearchFallbackReason =
  | OptimizationSessionReason
  | "explain"
  | "complete-interpretation"
  | RankingEvidenceEligibilityReason;

export function packedSearchFallbackReason({
  exactDiagnostics,
  pruningMode,
  retrievalScoreWeight,
  sourcePolicy,
  retriever,
  opts,
  query,
  index,
}: PackedSearchGateInput): PackedSearchFallbackReason | null {
  const session = searchSessionCapabilities({
    exactDiagnostics,
    pruningMode,
    retrievalScoreWeight,
    sourcePolicy,
    explain: opts.explain,
    resultCollector: opts.resultCollector,
    rankingEvidenceRetriever: hasRankingEvidenceRetrieverCapability(retriever as Retriever),
  });
  if (session.exactDiagnostics) return "exact-diagnostics";
  if (session.explain) return "explain";
  if (session.completeInterpretation) return "complete-interpretation";
  if (session.exhaustivePruning) return "explicit-exhaustive";
  if (session.retrievalScoreWeighted) return "retrieval-score-weight";
  if (session.allStrongRelationships) return "all-strong-relationships";
  if (!session.rankingEvidenceRetriever) return "unsupported-retriever";
  return rankingEvidenceEligibilityReason(query, rankingEvidenceStaticFor(index));
}
