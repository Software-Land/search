/**
 * Canonical empty semantics for FeatureVector-compatible properties.
 *
 * Primitive/enum zeros only. Packed execution still stores those values in
 * numeric columns; this table is the semantic meaning of "no evidence", not a
 * FeatureVector factory for the packed hot path.
 *
 * Optional recall fields (standalone / topical / equivalent) stay absent until
 * the diagnostic extractor evaluates them. Do not force those keys to false.
 *
 * Nested objects and arrays are documented here for value identity. Callers
 * that allocate a FeatureVector must copy them; the reusable packed scalar
 * mutates one nested field-evidence object in place and reuses the shared
 * empty prefix-token array.
 */

import type { FeatureVector } from "./types.js";

export const DEFAULT_CONFIGURED_FIELD_EVIDENCE = {
  title: false as const,
  summary: false as const,
  body: false as const,
};

/** Shared empty prefix-token array for reusable packed state. Do not mutate. */
export const EMPTY_MATCHED_PREFIX_TOKENS: string[] = [];

export const DEFAULT_FEATURE_VALUES = {
  exactTitleMatch: false,
  exactTitleTokenMatch: false,
  typedSurfaceTitleMatch: false,
  titleCoverage: 0,
  queryCoverage: 0,
  titlePrefixQuality: 0,
  contextualTitlePrefix: false,
  activeFinalPrefix: null,
  completedTitleToken: null,
  unmatchedTitleTokensAfter: 0,
  titleSequenceTightness: 0,
  contextualPrefixQuality: 0,
  configuredConceptMatch: false as const,
  morphologyMatch: false,
  typoDistance: 0,
  versionMatch: false as const,
  shortLiteralLeadMatch: false,
  dottedSpanComponentTitleMatch: false,
  phraseAdjacency: 0,
  bodyLexicalMatch: 0,
  lexicalConceptCoverage: 0,
  coverageConceptCount: 0,
  ordinaryEquivalenceBodyMatch: false,
  titleTokenCount: 0,
  configuredFormEvidence: 0,
  configuredFormCoverage: 0,
  configuredFormBodyMatch: false,
  canonicalKeyTitle: false,
  queryTokenCount: 0,
  normalizedQueryPhrase: "",
  matchingPhraseKey: null,
  bodyPhraseCount: 0,
  bodyPhraseFrequency: 0,
  titlePhraseFrequency: 0,
  summaryPhraseFrequency: 0,
  exactTitleOrSummaryPhrase: false,
  relationshipStrength: 0,
  relationshipType: null,
  relationshipSourceId: null,
  retrievalScore: 0,
  configuredPrefixRecallScore: 0,
  relevanceKind: "direct" as const,
  directClass: "none" as const,
};

/**
 * Restore reusable packed scalar state to canonical empty semantics.
 * Mutates the existing nested field-evidence object so held references stay
 * valid. Replaces matchedPrefixTokens with the shared empty array.
 */
export function resetReusableFeatureScalar(scalar: FeatureVector): FeatureVector {
  const d = DEFAULT_FEATURE_VALUES;
  scalar.exactTitleMatch = d.exactTitleMatch;
  scalar.exactTitleTokenMatch = d.exactTitleTokenMatch;
  scalar.typedSurfaceTitleMatch = d.typedSurfaceTitleMatch;
  scalar.titleCoverage = d.titleCoverage;
  scalar.queryCoverage = d.queryCoverage;
  scalar.titlePrefixQuality = d.titlePrefixQuality;
  scalar.contextualTitlePrefix = d.contextualTitlePrefix;
  scalar.matchedPrefixTokens = EMPTY_MATCHED_PREFIX_TOKENS;
  scalar.activeFinalPrefix = d.activeFinalPrefix;
  scalar.completedTitleToken = d.completedTitleToken;
  scalar.unmatchedTitleTokensAfter = d.unmatchedTitleTokensAfter;
  scalar.titleSequenceTightness = d.titleSequenceTightness;
  scalar.contextualPrefixQuality = d.contextualPrefixQuality;
  scalar.configuredConceptMatch = d.configuredConceptMatch;
  const evidence = scalar.configuredConceptFieldEvidence;
  evidence.title = DEFAULT_CONFIGURED_FIELD_EVIDENCE.title;
  evidence.summary = DEFAULT_CONFIGURED_FIELD_EVIDENCE.summary;
  evidence.body = DEFAULT_CONFIGURED_FIELD_EVIDENCE.body;
  scalar.morphologyMatch = d.morphologyMatch;
  scalar.typoDistance = d.typoDistance;
  scalar.versionMatch = d.versionMatch;
  scalar.shortLiteralLeadMatch = d.shortLiteralLeadMatch;
  scalar.dottedSpanComponentTitleMatch = d.dottedSpanComponentTitleMatch;
  scalar.phraseAdjacency = d.phraseAdjacency;
  scalar.bodyLexicalMatch = d.bodyLexicalMatch;
  scalar.lexicalConceptCoverage = d.lexicalConceptCoverage;
  scalar.coverageConceptCount = d.coverageConceptCount;
  scalar.ordinaryEquivalenceBodyMatch = d.ordinaryEquivalenceBodyMatch;
  scalar.titleTokenCount = d.titleTokenCount;
  scalar.configuredFormEvidence = d.configuredFormEvidence;
  scalar.configuredFormCoverage = d.configuredFormCoverage;
  scalar.configuredFormBodyMatch = d.configuredFormBodyMatch;
  scalar.canonicalKeyTitle = d.canonicalKeyTitle;
  scalar.queryTokenCount = d.queryTokenCount;
  scalar.normalizedQueryPhrase = d.normalizedQueryPhrase;
  scalar.matchingPhraseKey = d.matchingPhraseKey;
  scalar.bodyPhraseCount = d.bodyPhraseCount;
  scalar.bodyPhraseFrequency = d.bodyPhraseFrequency;
  scalar.titlePhraseFrequency = d.titlePhraseFrequency;
  scalar.summaryPhraseFrequency = d.summaryPhraseFrequency;
  scalar.exactTitleOrSummaryPhrase = d.exactTitleOrSummaryPhrase;
  scalar.relationshipStrength = d.relationshipStrength;
  scalar.relationshipType = d.relationshipType;
  scalar.relationshipSourceId = d.relationshipSourceId;
  scalar.retrievalScore = d.retrievalScore;
  scalar.relevanceKind = d.relevanceKind;
  scalar.directClass = d.directClass;
  scalar.configuredPrefixRecallScore = d.configuredPrefixRecallScore;
  return scalar;
}

/** One reusable FeatureVector for packed finalization. Not a per-candidate factory. */
export function createReusableFeatureScalar(): FeatureVector {
  return {
    ...DEFAULT_FEATURE_VALUES,
    matchedPrefixTokens: [],
    configuredConceptFieldEvidence: {
      title: DEFAULT_CONFIGURED_FIELD_EVIDENCE.title,
      summary: DEFAULT_CONFIGURED_FIELD_EVIDENCE.summary,
      body: DEFAULT_CONFIGURED_FIELD_EVIDENCE.body,
    },
  };
}
