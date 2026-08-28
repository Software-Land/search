/**
 * Discrete constraint signatures for builtin compareConstraint.
 *
 * Builtin constraint functions read only candidate-local FeatureVector fields.
 * They never consult score or document.id. Therefore if two candidates share
 * this signature, compareConstraint(a, b).order === 0 for DEFAULT and HYBRID
 * constraint lists, and both compare identically against any third candidate.
 *
 * Bands are exactly the predicates those functions test (coverage floors,
 * phrase-count minimum, version strength, …). Raw score-only features
 * (morphology, typo, BM25 retrievalScore, continuous bodyLexicalMatch, …)
 * are omitted. Multi-concept lexical coverage uses full/not-full bands, and
 * only when coverageConceptCount >= 2, so one-concept queries do not explode B.
 *
 * Scalar-sensitive constraints:
 *   tighter-title        — titleTokenCount only when both hits are exactish
 *   contextual-prefix    — contextualPrefixQuality only when both hits are contextual
 *   multi-concept body   — bodyLexicalMatch / lexicalConceptCoverage full bands
 *                          only when coverageConceptCount >= 2
 * Those scalars are included in the key only when they can fire, so ordinary
 * non-exactish / non-contextual groups do not explode B toward C.
 */

import {
  FULL_QUERY_COVERAGE,
  TWO_THIRDS_QUERY_COVERAGE,
  MODERATE_TITLE_PREFIX_QUALITY,
  REPEATED_BODY_PHRASE_MIN,
} from "./evidencePolicy.js";
import type { FeatureVector } from "./types.js";

function coverageBand(q: number) {
  if (!(q > 0)) return 0;
  if (q < TWO_THIRDS_QUERY_COVERAGE) return 1;
  if (q < FULL_QUERY_COVERAGE) return 2;
  return 3;
}

function titleCoverageBand(t: number) {
  return t >= 0.8 ? 1 : 0;
}

function prefixQualityBand(p: number) {
  if (!(p > 0)) return 0;
  if (p < MODERATE_TITLE_PREFIX_QUALITY) return 1;
  return 2;
}

function phraseCountBand(n: number) {
  if (!(n > 0)) return 0;
  if (n < REPEATED_BODY_PHRASE_MIN) return 1;
  return 2;
}

function queryTokenBand(n: number) {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  return 2;
}

function fullCoverageBand(n: number) {
  return (n || 0) >= FULL_QUERY_COVERAGE ? 1 : 0;
}

function versionBand(v: unknown) {
  if (v === "dotted" || v === "compact-dotted") return 2;
  if (v === "compact-weak" || v === "dotted-weak") return 1;
  return 0;
}

function equivBand(v: unknown) {
  if (v === "key-in-title") return 2;
  if (v === "form") return 1;
  return 0;
}

function bit(v: unknown) {
  return v ? 1 : 0;
}

function isExactish(f: Partial<FeatureVector>) {
  return (f.queryCoverage || 0) >= FULL_QUERY_COVERAGE && (f.titleCoverage || 0) >= 0.8;
}

/**
 * Canonical key for builtin constraint outcomes, including scalar dimensions
 * that can change order or conflictCount.
 */
export function constraintSignature(f: Partial<FeatureVector> | undefined) {
  const feat = f || {};
  const exactish = isExactish(feat);
  const contextual = Boolean(feat.contextualTitlePrefix);
  const titleTokens = exactish ? feat.titleTokenCount || 0 : 0;
  const prefixQ = contextual ? feat.contextualPrefixQuality || 0 : 0;
  const multiConcept = (feat.coverageConceptCount || 0) >= 2;
  return [
    bit(feat.exactTitleMatch),
    bit(feat.exactTitleTokenMatch),
    bit(feat.typedSurfaceTitleMatch),
    coverageBand(feat.queryCoverage || 0),
    titleCoverageBand(feat.titleCoverage || 0),
    prefixQualityBand(feat.titlePrefixQuality || 0),
    bit(contextual),
    equivBand(feat.configuredConceptMatch),
    versionBand(feat.versionMatch),
    bit(feat.shortLiteralLeadMatch),
    bit(feat.dottedSpanComponentTitleMatch),
    bit(feat.canonicalKeyTitle),
    queryTokenBand(feat.queryTokenCount || 0),
    phraseCountBand(feat.bodyPhraseCount || 0),
    bit(feat.ordinaryEquivalenceBodyMatch),
    multiConcept ? 1 : 0,
    multiConcept ? fullCoverageBand(feat.bodyLexicalMatch || 0) : 0,
    multiConcept ? fullCoverageBand(feat.lexicalConceptCoverage || 0) : 0,
    feat.relevanceKind === "related" ? 1 : 0,
    String(feat.directClass || ""),
    bit(feat.standaloneRecallMatch),
    bit(feat.topicalRecallMatch),
    bit(feat.topicalRecallTitleMatch),
    bit(feat.topicalRecallPhraseMatch),
    bit(feat.equivalentRecallMatch),
    bit(feat.equivalentRecallTitleMatch),
    bit(feat.equivalentRecallBodyMatch),
    titleTokens,
    prefixQ,
  ].join("\u001f");
}

export function isExactishFeatures(f: Partial<FeatureVector> | undefined) {
  return isExactish(f || {});
}
