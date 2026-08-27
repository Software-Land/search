/**
 * Within-constraint ordering after score: a weak single-token body-only pack
 * may use compiled body occurrence counts before document id. This is not a
 * score term and not H8. Stronger title/configured/direct classes are excluded.
 */

import type { FeaturedHit, FeatureVector } from "./types.js";

/**
 * Eligible pack: one-token query, weak/none direct class, body-lexical evidence
 * only. Any title, configured, morphology, typo, version, or contextual title
 * evidence removes the candidate from the pack so unigram TF cannot outrank it.
 */
export function isWeakSingleTokenBodyPack(f: Partial<FeatureVector> | undefined) {
  if (!f) return false;
  if ((f.queryTokenCount || 0) !== 1) return false;
  if (f.relevanceKind === "related") return false;
  if (f.directClass !== "weak" && f.directClass !== "none") return false;
  if (f.exactTitleMatch || f.exactTitleTokenMatch || f.typedSurfaceTitleMatch) return false;
  if ((f.queryCoverage || 0) > 0 || (f.titleCoverage || 0) > 0 || (f.titlePrefixQuality || 0) > 0) return false;
  if (f.configuredConceptMatch || f.canonicalKeyTitle || f.contextualTitlePrefix) return false;
  if (f.morphologyMatch || (f.typoDistance || 0) > 0) return false;
  if (f.shortLiteralLeadMatch || f.dottedSpanComponentTitleMatch || f.versionMatch) return false;
  return (f.bodyLexicalMatch || 0) > 0;
}

function idCmp(a: FeaturedHit, b: FeaturedHit) {
  if (a.document.id < b.document.id) return -1;
  if (a.document.id > b.document.id) return 1;
  return 0;
}

/**
 * Sort comparator: higher score first; among the weak single-token body pack,
 * higher bodyPhraseCount first; then document id. Returns negative when `a`
 * should rank above `b`.
 */
export function compareScoreThenWeakBodyThenId(a: FeaturedHit, b: FeaturedHit) {
  const sa = a.score || 0;
  const sb = b.score || 0;
  if (sb !== sa) return sb - sa;
  if (isWeakSingleTokenBodyPack(a.features) && isWeakSingleTokenBodyPack(b.features)) {
    const ca = a.features.bodyPhraseCount || 0;
    const cb = b.features.bodyPhraseCount || 0;
    if (cb !== ca) return cb - ca;
  }
  return idCmp(a, b);
}

export function scoreThenWeakBodyThenIdBetter(a: FeaturedHit, b: FeaturedHit) {
  return compareScoreThenWeakBodyThenId(a, b) < 0;
}
