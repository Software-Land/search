/**
 * Query-plan clause FACTS. Not result-set policy.
 *
 * Does not call extractFeatures on the corpus. Does not choose the public list.
 */

import { buildTokenGraph, graphHasConfiguredAlternatives, type TokenGraph } from "./configuredFormGraph.js";
import { typedSurfacePhraseTokens } from "./phraseEvidence.js";
import {
  emptyExecutionStats,
  executePhrasePrefixQuery,
  executePhraseQuery,
  executeTokenGraph,
  type ExecutionStats,
  type FieldPhraseHit,
} from "./positionalQueries.js";
import type { AnalyzedQuery, FeatureVector, SearchIndex } from "./types.js";

export interface QueryPlanClauses {
  lexical: boolean;
  exactPhrase: boolean;
  phrasePrefix: boolean;
  configuredFormGraph: boolean;
  structuredIntent: boolean;
  equivalentRecall: boolean;
  topicalRecall: boolean;
  versionIntent: boolean;
  prefixEvidence: boolean;
}

export interface QueryPlan {
  clauses: QueryPlanClauses;
  versionIntent: boolean;
  structuredKey: string | null;
  structuredInterpretation: boolean;
  typedTokens: string[];
  tokenGraph: TokenGraph;
  exactHits: FieldPhraseHit[];
  prefixHits: FieldPhraseHit[];
  executionStats: ExecutionStats;
}

export type PhraseGeometry = {
  titleFrequency: number;
  summaryFrequency: number;
  bodyFrequency: number;
  titlePrefixFrequency: number;
  summaryPrefixFrequency: number;
};

/** Phrase geometry from the search-path execution. Ranking/features reuse this. */
export const queryPhraseGeometry = new WeakMap<AnalyzedQuery, Map<string, PhraseGeometry>>();

function recordGeometry(query: AnalyzedQuery, exact: FieldPhraseHit[], prefix: FieldPhraseHit[]) {
  const map = new Map<string, PhraseGeometry>();
  for (const hit of exact) {
    map.set(hit.document.id, {
      titleFrequency: hit.titleFrequency,
      summaryFrequency: hit.summaryFrequency,
      bodyFrequency: hit.bodyFrequency,
      titlePrefixFrequency: 0,
      summaryPrefixFrequency: 0,
    });
  }
  for (const hit of prefix) {
    const prev = map.get(hit.document.id) || {
      titleFrequency: 0,
      summaryFrequency: 0,
      bodyFrequency: 0,
      titlePrefixFrequency: 0,
      summaryPrefixFrequency: 0,
    };
    prev.titlePrefixFrequency = hit.titleFrequency;
    prev.summaryPrefixFrequency = hit.summaryFrequency;
    map.set(hit.document.id, prev);
  }
  queryPhraseGeometry.set(query, map);
}

export function hasStructuredInterpretation(query: AnalyzedQuery): boolean {
  if (query.configuredSequenceIntent?.key) return true;
  return Array.isArray(query.configuredPrefixSpans) && query.configuredPrefixSpans.length > 0;
}

export type TitleGradeSupportKind =
  | "configured-key-title"
  | "configured-form-title"
  | "equivalent-recall-title"
  | "topical-recall-title"
  | "version-dotted";

/** Feature-vector helper only. Not used to scan the corpus during planning. */
export function titleGradeSupportKinds(features: Partial<FeatureVector>): TitleGradeSupportKind[] {
  const kinds: TitleGradeSupportKind[] = [];
  if (features.configuredConceptMatch === "key-in-title" || features.canonicalKeyTitle) {
    kinds.push("configured-key-title");
  }
  if (features.configuredConceptMatch === "form") kinds.push("configured-form-title");
  if (features.equivalentRecallTitleMatch) kinds.push("equivalent-recall-title");
  if (features.topicalRecallTitleMatch) kinds.push("topical-recall-title");
  if (features.versionMatch === "dotted" || features.versionMatch === "compact-dotted") {
    kinds.push("version-dotted");
  }
  return kinds;
}

export function buildQueryPlan(query: AnalyzedQuery, index: SearchIndex): QueryPlan {
  const typedTokens = typedSurfacePhraseTokens(query);
  const stats = emptyExecutionStats();
  const tokenGraph = buildTokenGraph(query);
  const useGraph = graphHasConfiguredAlternatives(tokenGraph);
  let exactHits: FieldPhraseHit[] = [];
  let prefixHits: FieldPhraseHit[] = [];
  if (useGraph) {
    exactHits = executeTokenGraph(tokenGraph, index, false, stats);
    prefixHits = executeTokenGraph(tokenGraph, index, true, stats);
  } else if (typedTokens.length >= 2) {
    exactHits = executePhraseQuery({ kind: "phrase", tokens: typedTokens }, index, stats);
    prefixHits = executePhrasePrefixQuery(
      { kind: "phrase-prefix", preceding: typedTokens.slice(0, -1), prefix: typedTokens[typedTokens.length - 1] },
      index,
      stats
    );
  }
  recordGeometry(query, exactHits, prefixHits);
  const versionIntent = Array.isArray(query.dottedSpans) && query.dottedSpans.length > 0;
  const structuredKey = query.configuredSequenceIntent?.key || null;
  return {
    clauses: {
      lexical: typedTokens.length > 0,
      exactPhrase: exactHits.length > 0,
      phrasePrefix: prefixHits.length > 0,
      configuredFormGraph: useGraph,
      structuredIntent: Boolean(structuredKey),
      equivalentRecall: Array.isArray(query.equivalentRecall) && query.equivalentRecall.length > 0,
      topicalRecall: Boolean(query.topicalRecall),
      versionIntent,
      prefixEvidence: Boolean(
        query.prefixCompletion || (Array.isArray(query.configuredPrefixSpans) && query.configuredPrefixSpans.length > 0)
      ),
    },
    versionIntent,
    structuredKey,
    structuredInterpretation: hasStructuredInterpretation(query),
    typedTokens,
    tokenGraph,
    exactHits,
    prefixHits,
    executionStats: stats,
  };
}
