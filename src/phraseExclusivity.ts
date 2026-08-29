/**
 * Long-phrase exclusivity: when the typed lexical sequence is long enough and
 * occurs as an exact contiguous phrase in only a small number of documents,
 * those documents are the entire public result set. Otherwise search is unchanged.
 *
 * Phrase identity is the user's typed surface after the existing tokenizer
 * (lowercase + punctuation folding). It does not use typo correction, synonyms,
 * configured aliases, equivalent recall, prefix completion, lemmas, or
 * phraseAdjacency. A long configured alias/form may therefore exclusive-collapse
 * while its short configured key does not: an explicit exception to ordinary
 * configured key/form result parity, not an accidental identity regression.
 */

import { sequencePresent } from "./retrieve.js";
import type { AnalyzedQuery, FeaturedHit, IndexedDocument, SearchIndex } from "./types.js";

/** Smallest distinctive typed phrase length; 3-token sequences are ordinary topical English. */
export const MIN_PHRASE_TOKENS = 4;

/**
 * Exclusive collapse only when the phrase is rare. DF ≥ 3 on this corpus is
 * dominated by shared template/boilerplate 6-grams.
 */
export const MAX_PHRASE_DOCUMENT_FREQUENCY = 2;

export function typedPhraseTokens(query: AnalyzedQuery): string[] {
  return (query.originalSurface || []).filter(Boolean);
}

export function documentHasExactTypedPhrase(tokens: string[], doc: IndexedDocument): boolean {
  if (!tokens.length) return false;
  return sequencePresent(tokens, doc.titleTokens) || sequencePresent(tokens, doc.bodyTokens);
}

/**
 * Phrase-matching documents when exclusivity should replace public results.
 * `null` means keep existing 0.5.0 behavior (short query, DF 0, or DF too large).
 */
export function exclusivePhraseDocuments(query: AnalyzedQuery, index: SearchIndex): IndexedDocument[] | null {
  const tokens = typedPhraseTokens(query);
  if (tokens.length < MIN_PHRASE_TOKENS) return null;
  const hits: IndexedDocument[] = [];
  for (const doc of index.documents) {
    if (documentHasExactTypedPhrase(tokens, doc)) hits.push(doc);
  }
  if (hits.length >= 1 && hits.length <= MAX_PHRASE_DOCUMENT_FREQUENCY) return hits;
  return null;
}

export function applyLongPhraseExclusivity(
  featured: FeaturedHit[],
  query: AnalyzedQuery,
  index: SearchIndex,
  featureMissing: (doc: IndexedDocument) => FeaturedHit
): FeaturedHit[] {
  const hits = exclusivePhraseDocuments(query, index);
  if (!hits) return featured;
  const byId = new Map(featured.map((hit) => [hit.document.id, hit]));
  return hits.map((doc) => byId.get(doc.id) || featureMissing(doc));
}
