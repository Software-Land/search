/**
 * Diagnostic serialization for public explain output.
 *
 * Execution consumes querySemanticFacts. This module may expose raw
 * AnalyzedQuery representation so diagnostics keep analyzer payloads.
 */
import type { AnalyzedQuery, FeatureVector, RankedHit } from "../types.js";

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      if (typeof v === "function") return undefined;
      return v;
    })
  );
}

function explainLexical(f: FeatureVector) {
  if ((f.queryTokenCount ?? 0) < 2 && (f.bodyPhraseCount ?? 0) <= 0) return undefined;
  return {
    normalizedQueryPhrase: f.normalizedQueryPhrase ?? "",
    matchingPhraseKey: f.matchingPhraseKey ?? null,
    bodyPhraseCount: f.bodyPhraseCount ?? 0,
    bodyPhraseFrequency: f.bodyPhraseFrequency ?? 0,
  };
}

function explainContextualPrefix(f: FeatureVector) {
  if (!f.contextualTitlePrefix) return undefined;
  return {
    matchedPrefixTokens: f.matchedPrefixTokens ?? [],
    activeFinalPrefix: f.activeFinalPrefix ?? null,
    completedTitleToken: f.completedTitleToken ?? null,
    unmatchedTitleTokensAfter: f.unmatchedTitleTokensAfter ?? 0,
    titleSequenceTightness: f.titleSequenceTightness ?? 0,
    contextualPrefixQuality: f.contextualPrefixQuality ?? 0,
  };
}

function serializeExplanationQuery(query: AnalyzedQuery, features: FeatureVector) {
  return {
    raw: query.raw,
    originalSurface: query.originalSurface,
    tokens: query.tokens,
    concepts: (query.concepts || []).map((concept) =>
      concept && concept.provenance === "synonym"
        ? { ...concept, provenance: "equivalent-recall" }
        : concept
    ),
    alternatives: query.alternatives || [],
    prefixCompletion: query.prefixCompletion ?? null,
    contextualCompletion: query.contextualCompletion ?? null,
    configuredSequenceIntent: query.configuredSequenceIntent ?? null,
    configuredContentIdentity: query.configuredContentIdentity ?? null,
    configuredSpans: (query.configuredSpans || []).map((span) => ({
      key: span.key,
      start: span.start,
      end: span.end,
      matchedKinds: [...(span.matchedKinds || [])],
    })),
    configuredPrefixSpans: (query.configuredPrefixSpans || []).map((span) => ({
      key: span.key,
      start: span.start,
      end: span.end,
      matchedKinds: [...(span.matchedKinds || [])],
      usedPrefix: true as const,
    })),
    standaloneRecall: query.standaloneRecall
      ? { key: query.standaloneRecall.key, sourceToken: query.standaloneRecall.sourceToken }
      : null,
    topicalRecall: query.topicalRecall
      ? { key: query.topicalRecall.key, forms: query.topicalRecall.forms.map((form) => [...form]) }
      : null,
    equivalentRecall: query.equivalentRecall?.length
      ? query.equivalentRecall.map((pair) => ({ source: pair.source, target: pair.target }))
      : undefined,
    configuredPrefixRecall: query.configuredPrefixRecall
      ? {
          key: query.configuredPrefixRecall.key,
          form: [...query.configuredPrefixRecall.form],
          exactCount: query.configuredPrefixRecall.exactCount,
          formLength: query.configuredPrefixRecall.formLength,
          coverage: query.configuredPrefixRecall.coverage,
          lastExact: query.configuredPrefixRecall.lastExact,
          partialCompleteness: query.configuredPrefixRecall.partialCompleteness,
        }
      : null,
    configuredPrefixRecallGroup: (query.configuredPrefixRecallGroup || []).map((row) => ({
      key: row.key,
      form: [...row.form],
      exactCount: row.exactCount,
      formLength: row.formLength,
      coverage: row.coverage,
      lastExact: row.lastExact,
      partialCompleteness: row.partialCompleteness,
    })),
    lexicalTokens: query.lexicalTokens,
    lexicalPhraseKey: query.lexicalPhraseKey,
    normalizedQueryPhrase: features.normalizedQueryPhrase ?? "",
  };
}

export function buildSearchExplanation({
  query,
  features,
  retrievalSources,
  relationship,
  constraintVsNext,
  constraintMeta,
}: {
  query: AnalyzedQuery;
  features: FeatureVector;
  retrievalSources: string[];
  relationship: RankedHit["relationship"];
  constraintVsNext: RankedHit["constraintVsNext"];
  constraintMeta: RankedHit["constraintMeta"] | null;
}) {
  return jsonSafe({
    query: serializeExplanationQuery(query, features),
    retrievalSources,
    relevanceKind: features.relevanceKind,
    directClass: features.directClass,
    features,
    lexical: explainLexical(features),
    contextualPrefix: explainContextualPrefix(features),
    relationship: relationship ?? null,
    constraintsVsNext: constraintVsNext,
    constraintMeta: constraintMeta ?? null,
  });
}
