/**
 * Result-set phrase cohort policy.
 *
 * When independent clause evidence says the typed exact phrase identifies one
 * or two documents (and title-grade support / field gates permit), those
 * documents are the entire public primary list. Ranking still orders that
 * cohort. Token count is not a relevance primitive.
 *
 * Phrase identity is the user's typed surface after the existing tokenizer
 * (lowercase + punctuation folding). It does not use typo correction, synonyms,
 * configured aliases, equivalent recall, prefix completion, lemmas, or
 * phraseAdjacency.
 */

import { sequencePresent } from "./retrieve.js";
import { typedSurfacePhraseTokens } from "./phraseEvidence.js";
import { buildQueryPlan, MAX_EXCLUSIVE_PHRASE_COHORT } from "./queryPlan.js";
import type { AnalyzedQuery, FeaturedHit, IndexedDocument, SearchIndex } from "./types.js";

export { MAX_EXCLUSIVE_PHRASE_COHORT };

export function typedPhraseTokens(query: AnalyzedQuery): string[] {
  return typedSurfacePhraseTokens(query);
}

export function documentHasExactTypedPhrase(tokens: string[], doc: IndexedDocument): boolean {
  if (!tokens.length) return false;
  return (
    sequencePresent(tokens, doc.titleTokens) ||
    sequencePresent(tokens, doc.summaryTokens || []) ||
    sequencePresent(tokens, doc.bodyTokens)
  );
}

/**
 * Phrase-matching documents when the independent clause policy should replace
 * the public result set. `null` means keep ordinary retrieval/ranking.
 */
export function exclusivePhraseDocuments(query: AnalyzedQuery, index: SearchIndex): IndexedDocument[] | null {
  const plan = buildQueryPlan(query, index);
  if (!plan.filterToPhraseCohort || !plan.exactPhrase) return null;
  return plan.exactPhrase.hits.map((hit) => hit.document);
}

export function applyPhraseCohortPolicy(
  featured: FeaturedHit[],
  query: AnalyzedQuery,
  index: SearchIndex,
  featureMissing: (doc: IndexedDocument) => FeaturedHit,
  strategy?: string
): FeaturedHit[] {
  const plan = buildQueryPlan(query, index);
  const byId = new Map(featured.map((hit) => [hit.document.id, hit]));
  if (plan.exactPhrase) {
    for (const hit of plan.exactPhrase.hits) {
      if (!byId.has(hit.document.id)) {
        byId.set(hit.document.id, featureMissing(hit.document));
      }
    }
  }
  if (!plan.filterToPhraseCohort || !plan.exactPhrase) {
    if (byId.size === featured.length) return featured;
    const extra = [...byId.values()].filter((hit) => !featured.some((row) => row.document.id === hit.document.id));
    return extra.length ? featured.concat(extra) : featured;
  }
  const phraseSet = new Set(plan.exactPhrase.hits.map((hit) => hit.document.id));
  const phraseHits = plan.exactPhrase.hits.map((hit) => byId.get(hit.document.id) || featureMissing(hit.document));
  // Exclusive collapse is a public-primary restriction. The related channel
  // stays for separate/mixed. Hybrid's single public list is P only.
  if (strategy === "separate" || strategy === "mixed") {
    const related = [...byId.values()].filter(
      (hit) => hit.features.relevanceKind === "related" && !phraseSet.has(hit.document.id)
    );
    return related.length ? phraseHits.concat(related) : phraseHits;
  }
  return phraseHits;
}

/** @deprecated Use applyPhraseCohortPolicy. */
export const applyLongPhraseExclusivity = applyPhraseCohortPolicy;
