/**
 * Session/capability facts for optimization gates.
 *
 * Facts only. Packed search, Stage-2A feature-block pruning, Stage 3A, and
 * the complete-interpretation collector each remain separate policies with
 * their own reason strings and precedence.
 */

import { COMPLETE_INTERPRETATION_COLLECTOR } from "./completeInterpretationCollector.js";
import type { SearchOptions, SourcePolicy } from "../types.js";

export type SearchSessionCapabilities = {
  exactDiagnostics: boolean;
  explain: boolean;
  completeInterpretation: boolean;
  exhaustivePruning: boolean;
  retrievalScoreWeighted: boolean;
  allStrongRelationships: boolean;
  rankingEvidenceRetriever: boolean;
};

/**
 * Session-gate reason strings shared by packed search and Stage-2A feature-block
 * pruning. Each policy still chooses which of these it consults and in what
 * order. Packed-only reasons (`explain`, `complete-interpretation`) stay on
 * packed search. Feature-block-only `missing-pruning-extension` stays there.
 */
export type OptimizationSessionReason =
  | "exact-diagnostics"
  | "explicit-exhaustive"
  | "retrieval-score-weight"
  | "all-strong-relationships"
  | "unsupported-retriever";

export type SearchSessionCapabilityInput = {
  exactDiagnostics: boolean;
  pruningMode: "auto" | "exhaustive";
  retrievalScoreWeight: number;
  sourcePolicy?: SourcePolicy | string;
  explain?: boolean;
  resultCollector?: SearchOptions["resultCollector"];
  rankingEvidenceRetriever: boolean;
};

/** Read-only projection of search-option / retriever capability. Does not decide policy. */
export function searchSessionCapabilities(input: SearchSessionCapabilityInput): SearchSessionCapabilities {
  return {
    exactDiagnostics: Boolean(input.exactDiagnostics),
    explain: Boolean(input.explain),
    completeInterpretation: input.resultCollector === COMPLETE_INTERPRETATION_COLLECTOR,
    exhaustivePruning: input.pruningMode === "exhaustive",
    retrievalScoreWeighted: Boolean(input.retrievalScoreWeight),
    allStrongRelationships: input.sourcePolicy === "all-strong",
    rankingEvidenceRetriever: Boolean(input.rankingEvidenceRetriever),
  };
}
