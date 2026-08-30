/**
 * Partial-order constraints with explicit composition.
 *
 * Each constraint has a class:
 *   absolute — must not be overturned by weaker evidence (H1 exact title, direct vs related)
 *   strong   — genuine relevance relationships (version, coverage, canonical key)
 *   soft     — preferences that yield when they conflict with a stronger class
 *
 * Pairwise aggregation:
 *   1. Evaluate all constraints.
 *   2. The strongest class that produces a unanimous direction decides the pair.
 *   3. Same-class contradiction → unordered (NOT silent "use score" without a flag).
 *   4. Weaker classes that disagree are recorded but do not override.
 *
 * Set ranking uses a constraint graph + SCCs. Cycles become unordered
 * components scored deterministically. Conflicts/cycles are always observable.
 */

import { throwIfAborted } from "./cancel.js";
import {
  FULL_QUERY_COVERAGE,
  TWO_THIRDS_QUERY_COVERAGE,
  MODERATE_TITLE_PREFIX_QUALITY,
  REPEATED_BODY_PHRASE_MIN,
} from "./evidencePolicy.js";
import type {
  ConstraintCompareResult,
  ConstraintCsr,
  ConstraintDef,
  ConstraintGraph,
  ConstraintScc,
  PackedConstraintEdges as PackedConstraintEdgesApi,
  FeaturedHit,
  FeatureVector,
  RelationshipStrategy,
} from "./types.js";

type AppliedRow = { id: string; invariant: string; class: string; result: string };

function versionStrength(v: unknown) {
  if (v === "dotted" || v === "compact-dotted") return 2;
  if (v === "compact-weak" || v === "dotted-weak") return 1;
  return 0;
}

const CLASS_RANK: Record<string, number> = { absolute: 3, strong: 2, soft: 1 };

function exactTitleConstraint(a: FeaturedHit, b: FeaturedHit) {
  if (a.features.exactTitleMatch && !b.features.exactTitleMatch) return -1;
  if (b.features.exactTitleMatch && !a.features.exactTitleMatch) return 1;
  return 0;
}

function coverageConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aFull =
    a.features.queryCoverage >= FULL_QUERY_COVERAGE &&
    a.features.titlePrefixQuality >= MODERATE_TITLE_PREFIX_QUALITY;
  const bFull =
    b.features.queryCoverage >= FULL_QUERY_COVERAGE &&
    b.features.titlePrefixQuality >= MODERATE_TITLE_PREFIX_QUALITY;
  const aWeak = a.features.queryCoverage > 0 && a.features.queryCoverage < TWO_THIRDS_QUERY_COVERAGE && !a.features.exactTitleMatch;
  const bWeak = b.features.queryCoverage > 0 && b.features.queryCoverage < TWO_THIRDS_QUERY_COVERAGE && !b.features.exactTitleMatch;
  if (aFull && bWeak) return -1;
  if (bFull && aWeak) return 1;
  return 0;
}

/**
 * Typed surface-title agreement outranks a title that only matches through
 * the canonical lemma. Applies to single-token queries so morphological
 * variants of a multi-token phrase keep ranking identity.
 */
function surfaceOverLemmaConstraint(a: FeaturedHit, b: FeaturedHit) {
  if ((a.features.queryTokenCount || 0) !== 1) return 0;
  if (a.features.configuredConceptMatch || b.features.configuredConceptMatch) return 0;
  const aSurf = Boolean(a.features.typedSurfaceTitleMatch);
  const bSurf = Boolean(b.features.typedSurfaceTitleMatch);
  if (aSurf === bSurf) return 0;
  if (aSurf && !bSurf) return -1;
  if (bSurf && !aSurf) return 1;
  return 0;
}

function versionConstraint(a: FeaturedHit, b: FeaturedHit) {
  const as = versionStrength(a.features.versionMatch);
  const bs = versionStrength(b.features.versionMatch);
  if (as === bs) return 0;
  if (as >= 2 && bs <= 1) return -1;
  if (bs >= 2 && as <= 1) return 1;
  return 0;
}

function literalNumericOverWeakVersionConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aLiteral = a.features.exactTitleTokenMatch && versionStrength(a.features.versionMatch) === 0;
  const bLiteral = b.features.exactTitleTokenMatch && versionStrength(b.features.versionMatch) === 0;
  const aWeak = versionStrength(a.features.versionMatch) === 1;
  const bWeak = versionStrength(b.features.versionMatch) === 1;
  if (aLiteral && bWeak) return -1;
  if (bLiteral && aWeak) return 1;
  return 0;
}

function shortLiteralConstraint(a: FeaturedHit, b: FeaturedHit) {
  if (a.features.shortLiteralLeadMatch === b.features.shortLiteralLeadMatch) return 0;
  // Completing the typed title sequence outranks a stop-wrapped lead-token stub.
  if (a.features.shortLiteralLeadMatch && !b.features.shortLiteralLeadMatch) {
    if (b.features.contextualTitlePrefix) return 1;
    return -1;
  }
  if (b.features.shortLiteralLeadMatch && !a.features.shortLiteralLeadMatch) {
    if (a.features.contextualTitlePrefix) return -1;
    return 1;
  }
  return 0;
}

/**
 * A dotted-span title component (the "2" in "1.2") is title-local structured
 * evidence. It outranks weak/body-only directs. It does not outrank lead
 * short-literals, independent exact tokens, or genuine version queries.
 */
function dottedSpanComponentOverWeakDirectConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aDot = Boolean(a.features.dottedSpanComponentTitleMatch);
  const bDot = Boolean(b.features.dottedSpanComponentTitleMatch);
  if (aDot === bDot) return 0;
  if (aDot && isWeakDirect(b.features) && !bDot) return -1;
  if (bDot && isWeakDirect(a.features) && !aDot) return 1;
  return 0;
}

/**
 * Aligned title-sequence + final-token completion outranks candidates whose
 * competing direct evidence is only weak or incidental (letter/body overlap).
 * It does not outrank exact title, configured concept, full coverage, or
 * other strong/moderate non-contextual evidence.
 * Among two contextual hits, tighter contextualPrefixQuality wins.
 */
function isWeakIncidentalCompetitor(f: Partial<FeatureVector>) {
  if (f.contextualTitlePrefix) return false;
  if (f.exactTitleMatch) return false;
  if (f.configuredConceptMatch === "key-in-title" || f.canonicalKeyTitle) return false;
  if (f.versionMatch === "dotted" || f.versionMatch === "compact-dotted") return false;
  if ((f.queryCoverage || 0) >= FULL_QUERY_COVERAGE) return false;
  if (f.directClass === "strong" || f.directClass === "moderate") return false;
  return f.directClass === "weak" || f.directClass === "none" || isIncidentalTitleToken(f);
}

function contextualTitlePrefixConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aHit = Boolean(a.features.contextualTitlePrefix);
  const bHit = Boolean(b.features.contextualTitlePrefix);
  const aQ = a.features.contextualPrefixQuality || 0;
  const bQ = b.features.contextualPrefixQuality || 0;
  if (aHit && !bHit && isWeakIncidentalCompetitor(b.features)) return -1;
  if (bHit && !aHit && isWeakIncidentalCompetitor(a.features)) return 1;
  if (aHit && bHit && aQ !== bQ) return aQ > bQ ? -1 : 1;
  return 0;
}

function tighterTitleConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aExactish = a.features.queryCoverage >= FULL_QUERY_COVERAGE && a.features.titleCoverage >= 0.8;
  const bExactish = b.features.queryCoverage >= FULL_QUERY_COVERAGE && b.features.titleCoverage >= 0.8;
  if (aExactish && bExactish) {
    if (a.features.titleTokenCount < b.features.titleTokenCount) return -1;
    if (b.features.titleTokenCount < a.features.titleTokenCount) return 1;
    return 0;
  }
  if (aExactish && !bExactish) return -1;
  if (bExactish && !aExactish) return 1;
  return 0;
}

/**
 * Direct lexical/intent evidence outranks a purely related neighbor.
 * Related documents must not displace a strong primary match (H1).
 * Mixed presentation: any direct with title-ish evidence beats related.
 */
function directOverRelatedConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aDirect = a.features.relevanceKind !== "related";
  const bDirect = b.features.relevanceKind !== "related";
  if (aDirect === bDirect) return 0;
  const aStrong =
    aDirect &&
    (a.features.exactTitleMatch ||
      a.features.configuredConceptMatch === "key-in-title" ||
      a.features.canonicalKeyTitle ||
      (a.features.queryCoverage || 0) >= FULL_QUERY_COVERAGE);
  const bStrong =
    bDirect &&
    (b.features.exactTitleMatch ||
      b.features.configuredConceptMatch === "key-in-title" ||
      b.features.canonicalKeyTitle ||
      (b.features.queryCoverage || 0) >= FULL_QUERY_COVERAGE);
  if (aDirect && !bDirect && (aStrong || (a.features.queryCoverage || 0) > 0 || a.features.exactTitleTokenMatch)) {
    return -1;
  }
  if (bDirect && !aDirect && (bStrong || (b.features.queryCoverage || 0) > 0 || b.features.exactTitleTokenMatch)) {
    return 1;
  }
  return 0;
}

function isStrongOrModerateDirect(f: Partial<FeatureVector>) {
  return f.relevanceKind !== "related" && (f.directClass === "strong" || f.directClass === "moderate");
}

function isWeakDirect(f: Partial<FeatureVector>) {
  return f.relevanceKind !== "related" && (f.directClass === "weak" || f.directClass === "none");
}

/**
 * Hybrid: strong/moderate directs outrank related. Related outrank weak
 * directs that lack repeated compiled body-phrase evidence.
 */
function hybridDirectOverRelatedConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aRel = a.features.relevanceKind === "related";
  const bRel = b.features.relevanceKind === "related";
  if (aRel === bRel) return 0;
  if (isStrongOrModerateDirect(a.features) && bRel) return -1;
  if (isStrongOrModerateDirect(b.features) && aRel) return 1;
  return 0;
}

/**
 * Related neighbors outrank weak/incidental directs. Exemptions stay unordered:
 * - repeated compiled body-phrase evidence that is not a unigram configured mention
 * - ordinary equivalence-backed body match
 * - weak-direct whose query-anchored relationshipStrength is at least as strong
 *   as the related candidate (orthogonal hybrid neighborhood)
 * Neither exemption promotes the weak-direct to moderate.
 */
function hasConfiguredMention(f: Partial<FeatureVector>) {
  const evid = f.configuredConceptFieldEvidence;
  return Boolean(evid?.summary || evid?.body);
}

function hasRepeatedBodyPhraseCount(f: Partial<FeatureVector>) {
  if ((f.bodyPhraseCount || 0) < REPEATED_BODY_PHRASE_MIN) return false;
  if ((f.queryTokenCount || 0) < 2 && hasConfiguredMention(f)) return false;
  return true;
}

function hasEquivalenceBodyMatch(f: Partial<FeatureVector>) {
  return Boolean(f.ordinaryEquivalenceBodyMatch);
}

function relatedOverWeakDirectConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aRel = a.features.relevanceKind === "related";
  const bRel = b.features.relevanceKind === "related";
  if (
    aRel &&
    isWeakDirect(b.features) &&
    !hasRepeatedBodyPhraseCount(b.features) &&
    !hasEquivalenceBodyMatch(b.features)
  ) {
    const weakRel = b.features.relationshipStrength || 0;
    const relatedRel = a.features.relationshipStrength || 0;
    if (weakRel > 0 && weakRel >= relatedRel) return 0;
    return -1;
  }
  if (
    bRel &&
    isWeakDirect(a.features) &&
    !hasRepeatedBodyPhraseCount(a.features) &&
    !hasEquivalenceBodyMatch(a.features)
  ) {
    const weakRel = a.features.relationshipStrength || 0;
    const relatedRel = b.features.relationshipStrength || 0;
    if (weakRel > 0 && weakRel >= relatedRel) return 0;
    return 1;
  }
  return 0;
}

/**
 * Multi-token queries: repeated compiled full-phrase body evidence (or a
 * configured peer form) outranks weak/incidental direct evidence. It does not
 * outrank strong or moderate direct evidence, exact title, configured
 * key-in-title, canonical key title, full query/title coverage, or contextual
 * aligned prefix. It is not a universal bodyPhraseCount comparison.
 */
function hasStrongLexicalFieldPhrase(f: Partial<FeatureVector>) {
  return Boolean(f.exactTitleOrSummaryPhrase);
}

function hasRepeatedPhraseEvidence(f: Partial<FeatureVector>) {
  if ((f.bodyPhraseCount || 0) < REPEATED_BODY_PHRASE_MIN) return false;
  // Multi-token compiled phrase only. Occupied queryTokenCount is the max
  // non-stop length of one peer form, not alias-cardinality. Query-side
  // formCoverage is not a substitute for a multi-token phrase.
  return (f.queryTokenCount || 0) >= 2;
}

function hasConfiguredExpansionEvidence(f: Partial<FeatureVector>) {
  if (f.configuredConceptMatch !== "form" && f.configuredConceptMatch !== "key-in-title") return false;
  if ((f.configuredFormCoverage || 0) > 0) return true;
  return (f.queryTokenCount || 0) >= 2;
}

function isIncidentalTitleToken(f: Partial<FeatureVector>) {
  const lowCoverage = (f.queryCoverage || 0) < TWO_THIRDS_QUERY_COVERAGE;
  const titleOverlap = Boolean(f.exactTitleTokenMatch) || (f.titlePrefixQuality || 0) > 0;
  return (
    titleOverlap &&
    lowCoverage &&
    (f.bodyPhraseCount || 0) === 0 &&
    !f.exactTitleMatch &&
    !f.exactTitleOrSummaryPhrase &&
    f.configuredConceptMatch !== "key-in-title" &&
    f.configuredConceptMatch !== "form" &&
    !f.contextualTitlePrefix
  );
}

/**
 * Repeated full-phrase body evidence (or configured peer-form evidence) outranks
 * weak/incidental direct evidence, including incidental title-token overlap
 * and weak body-only hits. It is not a universal ordering over every lower
 * bodyPhraseCount.
 *
 * classifyDirect may label a low-coverage exact title token as moderate.
 * That incidental overlap remains beatable. Genuine moderate evidence
 * (coverage ≥ 2/3, contextual prefix, etc.) is not.
 */
function isWeakIncidentalPhraseCompetitor(f: Partial<FeatureVector>) {
  if (hasRepeatedPhraseEvidence(f) || hasConfiguredExpansionEvidence(f) || hasStrongLexicalFieldPhrase(f)) return false;
  if (f.exactTitleMatch || f.canonicalKeyTitle || f.configuredConceptMatch === "key-in-title") return false;
  if ((f.queryCoverage || 0) >= FULL_QUERY_COVERAGE) return false;
  if (f.directClass === "strong") return false;
  if (f.contextualTitlePrefix) return false;
  if (isIncidentalTitleToken(f)) return true;
  if (f.directClass === "moderate") return false;
  return f.directClass === "weak" || f.directClass === "none";
}

function repeatedPhraseOverWeakDirectConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aPhrase =
    hasRepeatedPhraseEvidence(a.features) ||
    hasConfiguredExpansionEvidence(a.features) ||
    hasStrongLexicalFieldPhrase(a.features);
  const bPhrase =
    hasRepeatedPhraseEvidence(b.features) ||
    hasConfiguredExpansionEvidence(b.features) ||
    hasStrongLexicalFieldPhrase(b.features);
  if (aPhrase && isWeakIncidentalPhraseCompetitor(b.features)) return -1;
  if (bPhrase && isWeakIncidentalPhraseCompetitor(a.features)) return 1;
  return 0;
}

function isMultiConceptQuery(f: Partial<FeatureVector>) {
  return (f.coverageConceptCount || 0) >= 2;
}

function hasFullBodyMultiConceptCoverage(f: Partial<FeatureVector>) {
  return (
    isMultiConceptQuery(f) &&
    (f.bodyLexicalMatch || 0) >= FULL_QUERY_COVERAGE &&
    (f.lexicalConceptCoverage || 0) >= FULL_QUERY_COVERAGE
  );
}

/**
 * Weak/none direct whose title∪body lexical evidence covers only a strict
 * subset of coverage concepts. Related neighbors are not competitors.
 * Moderate and strong directs are not competitors.
 */
function isWeakLexicalSubsetCompetitor(f: Partial<FeatureVector>) {
  if (!isMultiConceptQuery(f)) return false;
  if (f.relevanceKind === "related") return false;
  if (f.directClass !== "weak" && f.directClass !== "none") return false;
  return (f.lexicalConceptCoverage || 0) < FULL_QUERY_COVERAGE;
}

/**
 * A document whose body lexically evidences every coverage concept outranks a
 * weak/none document whose title∪body lexical evidence covers only a strict
 * subset. Gated on coverageConceptCount, not queryTokenCount. Preferred side
 * requires full BODY coverage; full union only excludes the competitor.
 */
function fullBodyMultiConceptOverWeakSubsetConstraint(a: FeaturedHit, b: FeaturedHit) {
  const aPref = hasFullBodyMultiConceptCoverage(a.features);
  const bPref = hasFullBodyMultiConceptCoverage(b.features);
  const aSub = isWeakLexicalSubsetCompetitor(a.features);
  const bSub = isWeakLexicalSubsetCompetitor(b.features);
  if (aPref && bSub) return -1;
  if (bPref && aSub) return 1;
  return 0;
}

/**
 * When the query is a configured key, a title that also states a peer form
 * outranks a title that only contains the key (canonical vs comparison title).
 */
function canonicalKeyConstraint(a: FeaturedHit, b: FeaturedHit) {
  if (a.features.canonicalKeyTitle === b.features.canonicalKeyTitle) return 0;
  if (a.features.canonicalKeyTitle && !b.features.canonicalKeyTitle) return -1;
  if (b.features.canonicalKeyTitle && !a.features.canonicalKeyTitle) return 1;
  return 0;
}

function standaloneRecallBand(f: Partial<FeatureVector>) {
  if (
    f.exactTitleMatch ||
    f.exactTitleTokenMatch ||
    f.typedSurfaceTitleMatch ||
    (f.queryCoverage || 0) > 0 ||
    (f.titleCoverage || 0) > 0 ||
    (f.titlePrefixQuality || 0) > 0 ||
    f.contextualTitlePrefix ||
    f.configuredConceptMatch ||
    f.canonicalKeyTitle ||
    f.morphologyMatch ||
    (f.typoDistance || 0) > 0 ||
    f.versionMatch ||
    f.shortLiteralLeadMatch ||
    f.dottedSpanComponentTitleMatch ||
    (f.bodyLexicalMatch || 0) > 0 ||
    (f.bodyPhraseCount || 0) > 0 ||
    (f.phraseAdjacency || 0) > 0
  ) {
    return 2;
  }
  if (f.standaloneRecallMatch) return 1;
  return 0;
}

/**
 * Literal/direct evidence outranks standalone-recall-only hits, which outrank
 * true none. No-ops when neither candidate has standalone-recall evidence.
 */
function standaloneRecallBandConstraint(a: FeaturedHit, b: FeaturedHit) {
  if (!a.features.standaloneRecallMatch && !b.features.standaloneRecallMatch) return 0;
  const aBand = standaloneRecallBand(a.features);
  const bBand = standaloneRecallBand(b.features);
  if (aBand === bBand) return 0;
  return aBand > bBand ? -1 : 1;
}

function topicalRecallBand(f: Partial<FeatureVector>) {
  if (
    f.exactTitleMatch ||
    f.exactTitleTokenMatch ||
    f.typedSurfaceTitleMatch ||
    (f.queryCoverage || 0) > 0 ||
    (f.titleCoverage || 0) > 0 ||
    (f.titlePrefixQuality || 0) > 0 ||
    f.contextualTitlePrefix ||
    f.configuredConceptMatch ||
    f.canonicalKeyTitle ||
    f.morphologyMatch ||
    (f.typoDistance || 0) > 0 ||
    f.versionMatch ||
    f.shortLiteralLeadMatch ||
    f.dottedSpanComponentTitleMatch ||
    (f.bodyLexicalMatch || 0) > 0 ||
    (f.bodyPhraseCount || 0) > 0 ||
    (f.phraseAdjacency || 0) > 0
  ) {
    return 2;
  }
  if (f.topicalRecallMatch) return 1;
  return 0;
}

/**
 * Direct/configured/strong literal evidence outranks topical-recall-only hits,
 * which outrank true none. No-ops when neither candidate has topical recall.
 */
function topicalRecallBandConstraint(a: FeaturedHit, b: FeaturedHit) {
  if (!a.features.topicalRecallMatch && !b.features.topicalRecallMatch) return 0;
  const aBand = topicalRecallBand(a.features);
  const bBand = topicalRecallBand(b.features);
  if (aBand === bBand) return 0;
  return aBand > bBand ? -1 : 1;
}

function topicalRecallOnly(f: Partial<FeatureVector>) {
  return Boolean(f.topicalRecallMatch) && topicalRecallBand(f) === 1;
}

function topicalQualityBand(f: Partial<FeatureVector>) {
  if (f.topicalRecallTitleMatch) return 2;
  if (f.topicalRecallPhraseMatch) return 1;
  return 0;
}

/**
 * Inside the topical-only band, title topical matches outrank phrase-body,
 * which outrank unigram-body. No-ops unless both hits are topical-only.
 */
function topicalRecallQualityConstraint(a: FeaturedHit, b: FeaturedHit) {
  if (!topicalRecallOnly(a.features) || !topicalRecallOnly(b.features)) return 0;
  const aBand = topicalQualityBand(a.features);
  const bBand = topicalQualityBand(b.features);
  if (aBand === bBand) return 0;
  return aBand > bBand ? -1 : 1;
}

function synonymRecallBand(f: Partial<FeatureVector>) {
  if (
    f.exactTitleMatch ||
    f.exactTitleTokenMatch ||
    f.typedSurfaceTitleMatch ||
    (f.queryCoverage || 0) > 0 ||
    (f.titleCoverage || 0) > 0 ||
    (f.titlePrefixQuality || 0) > 0 ||
    f.contextualTitlePrefix ||
    f.configuredConceptMatch ||
    f.canonicalKeyTitle ||
    f.morphologyMatch ||
    (f.typoDistance || 0) > 0 ||
    f.versionMatch ||
    f.shortLiteralLeadMatch ||
    f.dottedSpanComponentTitleMatch ||
    (f.bodyLexicalMatch || 0) > 0 ||
    (f.bodyPhraseCount || 0) > 0 ||
    (f.phraseAdjacency || 0) > 0
  ) {
    return 2;
  }
  if (f.equivalentRecallMatch) return 1;
  return 0;
}

/**
 * Literal/configured/direct evidence outranks extra equivalent-recall-only hits,
 * which outrank true none. No-ops when neither candidate has equivalent recall.
 * Extra search-equivalence concepts are not typed query coverage; this band
 * uses the remaining identity features after those concepts are excluded.
 */
function synonymRecallBandConstraint(a: FeaturedHit, b: FeaturedHit) {
  if (!a.features.equivalentRecallMatch && !b.features.equivalentRecallMatch) return 0;
  const aBand = synonymRecallBand(a.features);
  const bBand = synonymRecallBand(b.features);
  if (aBand === bBand) return 0;
  return aBand > bBand ? -1 : 1;
}

function synonymRecallOnly(f: Partial<FeatureVector>) {
  return Boolean(f.equivalentRecallMatch) && synonymRecallBand(f) === 1;
}

function synonymQualityBand(f: Partial<FeatureVector>) {
  if (f.equivalentRecallTitleMatch) return 2;
  if (f.equivalentRecallBodyMatch) return 1;
  return 0;
}

/**
 * Inside the equivalent-recall-only band, title matches outrank body-only.
 * No-ops unless both hits are equivalent-recall-only.
 */
function synonymRecallQualityConstraint(a: FeaturedHit, b: FeaturedHit) {
  if (!synonymRecallOnly(a.features) || !synonymRecallOnly(b.features)) return 0;
  const aBand = synonymQualityBand(a.features);
  const bBand = synonymQualityBand(b.features);
  if (aBand === bBand) return 0;
  return aBand > bBand ? -1 : 1;
}

export const DEFAULT_CONSTRAINTS: ConstraintDef[] = [
  { id: "exact-title-over-non-exact", invariant: "H1", class: "absolute", fn: exactTitleConstraint },
  { id: "direct-over-related", invariant: "H1", class: "absolute", fn: directOverRelatedConstraint },
  { id: "literal-over-standalone-recall", invariant: "H8", class: "strong", fn: standaloneRecallBandConstraint },
  { id: "literal-over-topical-recall", invariant: "H8", class: "strong", fn: topicalRecallBandConstraint },
  { id: "topical-title-over-topical-body", invariant: "H8", class: "strong", fn: topicalRecallQualityConstraint },
  { id: "literal-over-equivalent-recall", invariant: "H8", class: "strong", fn: synonymRecallBandConstraint },
  { id: "equivalent-title-over-equivalent-body", invariant: "H8", class: "strong", fn: synonymRecallQualityConstraint },
  { id: "canonical-key-expansion-over-key-only", invariant: "H2", class: "strong", fn: canonicalKeyConstraint },
  { id: "repeated-phrase-over-weak-direct", invariant: "H8", class: "strong", fn: repeatedPhraseOverWeakDirectConstraint },
  { id: "contextual-title-prefix-over-unaligned", invariant: "H8", class: "absolute", fn: contextualTitlePrefixConstraint },
  { id: "full-coverage-over-partial", invariant: "H8", class: "strong", fn: coverageConstraint },
  { id: "exact-surface-over-lemma-only", invariant: "H3", class: "strong", fn: surfaceOverLemmaConstraint },
  { id: "version-companion-over-weak-numeric", invariant: "H4", class: "strong", fn: versionConstraint },
  { id: "literal-numeric-over-weak-compact", invariant: "H4", class: "strong", fn: literalNumericOverWeakVersionConstraint },
  { id: "dotted-span-component-over-weak-direct", invariant: "H9", class: "strong", fn: dottedSpanComponentOverWeakDirectConstraint },
  { id: "tighter-title-over-longer-contains", invariant: "H1", class: "soft", fn: tighterTitleConstraint },
  { id: "short-literal-lead-over-later", invariant: "H5", class: "soft", fn: shortLiteralConstraint },
];

export const HYBRID_CONSTRAINTS: ConstraintDef[] = [
  { id: "exact-title-over-non-exact", invariant: "H1", class: "absolute", fn: exactTitleConstraint },
  { id: "strong-moderate-direct-over-related", invariant: "H1", class: "absolute", fn: hybridDirectOverRelatedConstraint },
  { id: "related-over-weak-direct", invariant: "H1", class: "strong", fn: relatedOverWeakDirectConstraint },
  { id: "literal-over-standalone-recall", invariant: "H8", class: "strong", fn: standaloneRecallBandConstraint },
  { id: "literal-over-topical-recall", invariant: "H8", class: "strong", fn: topicalRecallBandConstraint },
  { id: "topical-title-over-topical-body", invariant: "H8", class: "strong", fn: topicalRecallQualityConstraint },
  { id: "literal-over-equivalent-recall", invariant: "H8", class: "strong", fn: synonymRecallBandConstraint },
  { id: "equivalent-title-over-equivalent-body", invariant: "H8", class: "strong", fn: synonymRecallQualityConstraint },
  { id: "canonical-key-expansion-over-key-only", invariant: "H2", class: "strong", fn: canonicalKeyConstraint },
  { id: "repeated-phrase-over-weak-direct", invariant: "H8", class: "strong", fn: repeatedPhraseOverWeakDirectConstraint },
  { id: "full-body-multi-concept-over-weak-subset", invariant: "H8", class: "strong", fn: fullBodyMultiConceptOverWeakSubsetConstraint },
  { id: "contextual-title-prefix-over-unaligned", invariant: "H8", class: "absolute", fn: contextualTitlePrefixConstraint },
  { id: "full-coverage-over-partial", invariant: "H8", class: "strong", fn: coverageConstraint },
  { id: "exact-surface-over-lemma-only", invariant: "H3", class: "strong", fn: surfaceOverLemmaConstraint },
  { id: "version-companion-over-weak-numeric", invariant: "H4", class: "strong", fn: versionConstraint },
  { id: "literal-numeric-over-weak-compact", invariant: "H4", class: "strong", fn: literalNumericOverWeakVersionConstraint },
  { id: "dotted-span-component-over-weak-direct", invariant: "H9", class: "strong", fn: dottedSpanComponentOverWeakDirectConstraint },
  { id: "tighter-title-over-longer-contains", invariant: "H1", class: "soft", fn: tighterTitleConstraint },
  { id: "short-literal-lead-over-later", invariant: "H5", class: "soft", fn: shortLiteralConstraint },
];

export function constraintsForStrategy(strategy?: string | RelationshipStrategy) {
  return strategy === "hybrid" ? HYBRID_CONSTRAINTS : DEFAULT_CONSTRAINTS;
}

export function constraintsForPresentation(presentation?: string | RelationshipStrategy) {
  return constraintsForStrategy(presentation);
}

const CLASS_ORDER = ["absolute", "strong", "soft"];

export function compareConstraint(a: FeaturedHit, b: FeaturedHit, defs: ConstraintDef[] = DEFAULT_CONSTRAINTS): ConstraintCompareResult {
  const applied: AppliedRow[] = [];
  const byClass: Record<string, AppliedRow[]> = { absolute: [], strong: [], soft: [] };

  for (const c of defs) {
    const r = c.fn(a, b);
    if (r === 0) continue;
    const row = {
      id: c.id,
      invariant: c.invariant,
      class: c.class || "strong",
      result: r < 0 ? "A>B" : "B>A",
    };
    applied.push(row);
    (byClass[row.class] || byClass.strong).push(row);
  }

  if (!applied.length) {
    return { order: 0, applied, conflict: false, resolution: "unordered" };
  }

  for (const cls of CLASS_ORDER) {
    const rows = byClass[cls];
    if (!rows.length) continue;
    const signs = new Set(rows.map((x) => x.result));
    if (signs.size > 1) {
      return {
        order: 0,
        applied,
        conflict: true,
        decisiveClass: cls,
        resolution: "unordered-same-class-conflict",
      };
    }
    const weakerDisagree = applied.some(
      (x) => CLASS_RANK[x.class] < CLASS_RANK[cls] && x.result !== rows[0].result
    );
    return {
      order: rows[0].result === "A>B" ? -1 : 1,
      applied,
      conflict: weakerDisagree,
      decisiveClass: cls,
      resolution: weakerDisagree ? "stronger-class-wins" : "constraint",
    };
  }

  return { order: 0, applied, conflict: false, resolution: "unordered" };
}

/**
 * Directed graph: edge i→j means i must outrank j.
 * Same-class conflicts add no edge (unordered; score will decide inside an SCC
 * only if other edges create a cycle).
 *
 * Unordered / no-decision pairs are compared but not retained. pairReports
 * keeps only conflict diagnostics (same-class conflict or weaker-class
 * disagreement). Ranking still evaluates every unordered pair once.
 *
 * Edges are packed uint32 pairs in fixed-capacity chunks so append does not
 * copy a growing monolithic buffer. Chunk size is 65536 edges (512 KiB).
 */
export const PACKED_CONSTRAINT_EDGE_CHUNK_EDGES = 65536;

export class PackedConstraintEdges implements PackedConstraintEdgesApi {
  readonly chunkEdges: number;
  private readonly chunks: Uint32Array[] = [];
  private size = 0;
  private fill = 0;

  constructor(chunkEdges: number = PACKED_CONSTRAINT_EDGE_CHUNK_EDGES) {
    if (!Number.isInteger(chunkEdges) || chunkEdges < 1) {
      throw new Error("PackedConstraintEdges chunkEdges must be a positive integer");
    }
    this.chunkEdges = chunkEdges;
  }

  get length() {
    return this.size;
  }

  allocatedBytes() {
    return this.chunks.length * this.chunkEdges * 8;
  }

  append(from: number, to: number) {
    let cur = this.chunks.length ? this.chunks[this.chunks.length - 1] : null;
    if (!cur || this.fill >= cur.length) {
      cur = new Uint32Array(this.chunkEdges * 2);
      this.chunks.push(cur);
      this.fill = 0;
    }
    cur[this.fill] = from >>> 0;
    cur[this.fill + 1] = to >>> 0;
    this.fill += 2;
    this.size += 1;
  }

  fromAt(i: number) {
    if (i < 0 || i >= this.size) throw new RangeError("edge index out of range");
    const buf = this.chunks[Math.floor(i / this.chunkEdges)];
    return buf[(i % this.chunkEdges) * 2];
  }

  toAt(i: number) {
    if (i < 0 || i >= this.size) throw new RangeError("edge index out of range");
    const buf = this.chunks[Math.floor(i / this.chunkEdges)];
    return buf[(i % this.chunkEdges) * 2 + 1];
  }

  forEachEdge(visit: (u: number, v: number) => void) {
    const { chunks, chunkEdges, size } = this;
    const last = chunks.length - 1;
    for (let c = 0; c < chunks.length; c++) {
      const buf = chunks[c];
      const n = c === last ? size - c * chunkEdges : chunkEdges;
      for (let e = 0, off = 0; e < n; e++, off += 2) visit(buf[off], buf[off + 1]);
    }
  }

  *[Symbol.iterator](): IterableIterator<[number, number]> {
    const { chunks, chunkEdges, size } = this;
    const last = chunks.length - 1;
    for (let c = 0; c < chunks.length; c++) {
      const buf = chunks[c];
      const n = c === last ? size - c * chunkEdges : chunkEdges;
      for (let e = 0, off = 0; e < n; e++, off += 2) yield [buf[off], buf[off + 1]];
    }
  }
}

function recordConstraintPair(
  i: number,
  j: number,
  candidates: FeaturedHit[],
  defs: ConstraintDef[],
  edges: PackedConstraintEdges,
  pairReports: Array<ConstraintCompareResult & { i: number; j: number }>
) {
  const cmp = compareConstraint(candidates[i], candidates[j], defs);
  if (cmp.conflict) pairReports.push({ i, j, ...cmp });
  if (cmp.order < 0) edges.append(i, j);
  else if (cmp.order > 0) edges.append(j, i);
}

export function buildConstraintGraph(
  candidates: FeaturedHit[],
  defs: ConstraintDef[] = DEFAULT_CONSTRAINTS,
  { signal }: { signal?: AbortSignal } = {}
): ConstraintGraph {
  const n = candidates.length;
  const edges = new PackedConstraintEdges();
  const pairReports: Array<ConstraintCompareResult & { i: number; j: number }> = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((k++ & 63) === 0) throwIfAborted(signal);
      recordConstraintPair(i, j, candidates, defs, edges, pairReports);
    }
  }
  return { n, edges, pairReports };
}

export async function buildConstraintGraphAsync(
  candidates: FeaturedHit[],
  defs: ConstraintDef[] = DEFAULT_CONSTRAINTS,
  { signal }: { signal?: AbortSignal } = {}
): Promise<ConstraintGraph> {
  const n = candidates.length;
  const edges = new PackedConstraintEdges();
  const pairReports: Array<ConstraintCompareResult & { i: number; j: number }> = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((k++ & 63) === 0) {
        throwIfAborted(signal);
        await Promise.resolve();
        throwIfAborted(signal);
      }
      recordConstraintPair(i, j, candidates, defs, edges, pairReports);
    }
  }
  return { n, edges, pairReports };
}

export function constraintCsrBytes(csr: ConstraintCsr) {
  return csr.offsets.byteLength + csr.neighbors.byteLength;
}

/**
 * Exact CSR adjacency. Neighbors of u are packed-edge insertion order for
 * edges whose source (forward) or target (reverse) is u.
 */
export function buildConstraintCsr(n: number, edges: PackedConstraintEdgesApi, reverse = false): ConstraintCsr {
  const degree = new Uint32Array(n);
  edges.forEachEdge((u, v) => {
    degree[reverse ? v : u] += 1;
  });
  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + degree[i];
  const neighbors = new Uint32Array(offsets[n]);
  degree.fill(0);
  edges.forEachEdge((u, v) => {
    const from = reverse ? v : u;
    const to = reverse ? u : v;
    neighbors[offsets[from] + degree[from]] = to;
    degree[from] += 1;
  });
  return { offsets, neighbors };
}

function buildConstraintCsrPair(n: number, edges: PackedConstraintEdgesApi): { adj: ConstraintCsr; radj: ConstraintCsr } {
  const outDeg = new Uint32Array(n);
  const inDeg = new Uint32Array(n);
  edges.forEachEdge((u, v) => {
    outDeg[u] += 1;
    inDeg[v] += 1;
  });
  const adjOff = new Uint32Array(n + 1);
  const radjOff = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    adjOff[i + 1] = adjOff[i] + outDeg[i];
    radjOff[i + 1] = radjOff[i] + inDeg[i];
  }
  const adjN = new Uint32Array(adjOff[n]);
  const radjN = new Uint32Array(radjOff[n]);
  outDeg.fill(0);
  inDeg.fill(0);
  edges.forEachEdge((u, v) => {
    adjN[adjOff[u] + outDeg[u]] = v;
    outDeg[u] += 1;
    radjN[radjOff[v] + inDeg[v]] = u;
    inDeg[v] += 1;
  });
  return {
    adj: { offsets: adjOff, neighbors: adjN },
    radj: { offsets: radjOff, neighbors: radjN },
  };
}

export function csrNeighborList(csr: ConstraintCsr, u: number): number[] {
  return Array.from(csr.neighbors.subarray(csr.offsets[u], csr.offsets[u + 1]));
}

/**
 * Iterative Kosaraju. Frames `{ u, k }` resume at CSR index `k` so first-pass
 * finish order matches the previous recursive postorder: mark on entry,
 * neighbors left-to-right, append only after descendants complete.
 */
function kosaraju(n: number, adj: ConstraintCsr, radj: ConstraintCsr) {
  const seen = new Array(n).fill(false);
  const order: number[] = [];
  const stackU: number[] = [];
  const stackK: number[] = [];
  const adjOff = adj.offsets;
  const adjN = adj.neighbors;
  const radjOff = radj.offsets;
  const radjN = radj.neighbors;

  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    seen[i] = true;
    stackU.push(i);
    stackK.push(adjOff[i]);
    while (stackU.length) {
      const u = stackU[stackU.length - 1];
      const k = stackK[stackK.length - 1];
      const end = adjOff[u + 1];
      if (k < end) {
        const v = adjN[k];
        stackK[stackK.length - 1] = k + 1;
        if (!seen[v]) {
          seen[v] = true;
          stackU.push(v);
          stackK.push(adjOff[v]);
        }
      } else {
        stackU.pop();
        stackK.pop();
        order.push(u);
      }
    }
  }

  const comp = new Array(n).fill(-1);
  let cid = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i];
    if (comp[root] !== -1) continue;
    const id = cid++;
    comp[root] = id;
    stackU.push(root);
    stackK.push(radjOff[root]);
    while (stackU.length) {
      const u = stackU[stackU.length - 1];
      const k = stackK[stackK.length - 1];
      const end = radjOff[u + 1];
      if (k < end) {
        const v = radjN[k];
        stackK[stackK.length - 1] = k + 1;
        if (comp[v] === -1) {
          comp[v] = id;
          stackU.push(v);
          stackK.push(radjOff[v]);
        }
      } else {
        stackU.pop();
        stackK.pop();
      }
    }
  }

  const groups: number[][] = Array.from({ length: cid }, () => []);
  for (let i = 0; i < n; i++) groups[comp[i]].push(i);
  // Copies so later Kahn/group walks cannot mutate diagnostic cycle rows.
  const cycles = groups.filter((g) => g.length > 1).map((g) => g.slice());
  return { comp, groups, cycles };
}

function releaseConstraintCsrBuffers(csr: ConstraintCsr | undefined) {
  if (!csr) return;
  csr.offsets = new Uint32Array(0);
  csr.neighbors = new Uint32Array(0);
}

/**
 * Kosaraju over exact CSR. Reverse CSR buffers are released before return
 * so they are not reachable from the SCC result, closures, or later ordering.
 */
export function stronglyConnectedComponents(n: number, edges: PackedConstraintEdgesApi): ConstraintScc {
  const pair: { adj: ConstraintCsr; radj: ConstraintCsr | undefined } = buildConstraintCsrPair(n, edges);
  const adj = pair.adj;
  const { comp, groups, cycles } = kosaraju(n, adj, pair.radj as ConstraintCsr);
  releaseConstraintCsrBuffers(pair.radj);
  pair.radj = undefined;
  return { comp, groups, cycles, adj };
}

export const CONSTRAINT_STAMP_MAX = 0xffffffff;

export function advanceConstraintStamp(marks: Uint32Array, generation: number): number {
  if (generation >= CONSTRAINT_STAMP_MAX) {
    marks.fill(0);
    return 1;
  }
  return generation + 1;
}

export function forEachOutgoingComponent(
  g: number,
  comp: number[],
  groups: number[][],
  adj: ConstraintCsr,
  marks: Uint32Array,
  generation: number,
  visit: (b: number) => void
) {
  const members = groups[g];
  const neighbors = adj.neighbors;
  const offsets = adj.offsets;
  for (let i = 0; i < members.length; i++) {
    const u = members[i];
    const start = offsets[u];
    const end = offsets[u + 1];
    for (let k = start; k < end; k++) {
      const b = comp[neighbors[k]];
      if (b === g) continue;
      if (marks[b] !== generation) {
        marks[b] = generation;
        visit(b);
      }
    }
  }
}

export function computeComponentIndegrees(comp: number[], groups: number[][], adj: ConstraintCsr): Uint32Array {
  const nComp = groups.length;
  const indeg = new Uint32Array(nComp);
  const marks = new Uint32Array(nComp);
  let generation = 0;
  for (let g = 0; g < nComp; g++) {
    generation = advanceConstraintStamp(marks, generation);
    forEachOutgoingComponent(g, comp, groups, adj, marks, generation, (b) => {
      indeg[b] += 1;
    });
  }
  return indeg;
}

/**
 * Cycle/conflict diagnosis from an already-built constraint graph.
 * Ranking reuses the pairwise graph and may pass a precomputed SCC so
 * Kosaraju does not run twice. Standalone detectConstraintCycles still
 * computes SCC itself.
 *
 * graph.pairReports contains conflict diagnostics only.
 */
export function diagnoseConstraintGraph(
  graph: ConstraintGraph,
  candidates: FeaturedHit[],
  precomputed?: Pick<ConstraintScc, "cycles">
) {
  const { pairReports } = graph;
  const cycles = precomputed?.cycles ?? stronglyConnectedComponents(graph.n, graph.edges).cycles;
  const conflicts = pairReports.filter((p) => p.conflict);
  return {
    cycles: cycles.map((ids) => ids.map((i) => candidates[i]?.document?.id ?? i)),
    conflicts: conflicts.map((p) => ({
      a: candidates[p.i]?.document?.id,
      b: candidates[p.j]?.document?.id,
      applied: p.applied,
      resolution: p.resolution,
    })),
    pairReports,
  };
}

export function detectConstraintCycles(
  candidates: FeaturedHit[],
  defs: ConstraintDef[] = DEFAULT_CONSTRAINTS,
  { signal }: { signal?: AbortSignal } = {}
) {
  return diagnoseConstraintGraph(buildConstraintGraph(candidates, defs, { signal }), candidates);
}

export function constraintCatalog() {
  return DEFAULT_CONSTRAINTS.map(({ id, invariant, class: cls }) => ({ id, invariant, class: cls }));
}

export { versionStrength, CLASS_RANK, isStrongOrModerateDirect, isWeakDirect };
