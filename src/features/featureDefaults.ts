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

import type { FeatureVector } from "../types.js";

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
 *
 * Keep immediate literals here: this runs once per packed candidate and
 * table-property reads caused a measurable constant-factor regression.
 * Tests keep these literals aligned with DEFAULT_FEATURE_VALUES.
 */
export function resetReusableFeatureScalar(scalar: FeatureVector): FeatureVector {
  scalar.exactTitleMatch = false;
  scalar.exactTitleTokenMatch = false;
  scalar.typedSurfaceTitleMatch = false;
  scalar.titleCoverage = 0;
  scalar.queryCoverage = 0;
  scalar.titlePrefixQuality = 0;
  scalar.contextualTitlePrefix = false;
  scalar.matchedPrefixTokens = EMPTY_MATCHED_PREFIX_TOKENS;
  scalar.activeFinalPrefix = null;
  scalar.completedTitleToken = null;
  scalar.unmatchedTitleTokensAfter = 0;
  scalar.titleSequenceTightness = 0;
  scalar.contextualPrefixQuality = 0;
  scalar.configuredConceptMatch = false;
  const evidence = scalar.configuredConceptFieldEvidence;
  evidence.title = false;
  evidence.summary = false;
  evidence.body = false;
  scalar.morphologyMatch = false;
  scalar.typoDistance = 0;
  scalar.versionMatch = false;
  scalar.shortLiteralLeadMatch = false;
  scalar.dottedSpanComponentTitleMatch = false;
  scalar.phraseAdjacency = 0;
  scalar.bodyLexicalMatch = 0;
  scalar.lexicalConceptCoverage = 0;
  scalar.coverageConceptCount = 0;
  scalar.ordinaryEquivalenceBodyMatch = false;
  scalar.titleTokenCount = 0;
  scalar.configuredFormEvidence = 0;
  scalar.configuredFormCoverage = 0;
  scalar.configuredFormBodyMatch = false;
  scalar.canonicalKeyTitle = false;
  scalar.queryTokenCount = 0;
  scalar.normalizedQueryPhrase = "";
  scalar.matchingPhraseKey = null;
  scalar.bodyPhraseCount = 0;
  scalar.bodyPhraseFrequency = 0;
  scalar.titlePhraseFrequency = 0;
  scalar.summaryPhraseFrequency = 0;
  scalar.exactTitleOrSummaryPhrase = false;
  scalar.relationshipStrength = 0;
  scalar.relationshipType = null;
  scalar.relationshipSourceId = null;
  scalar.retrievalScore = 0;
  scalar.relevanceKind = "direct";
  scalar.directClass = "none";
  scalar.configuredPrefixRecallScore = 0;
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
