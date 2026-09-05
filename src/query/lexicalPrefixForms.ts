/**
 * Ordinary lexical PREFIX capability (Policy C).
 *
 * Analyze already encodes the morphology split: `canonicalLemma()` rewrites
 * `normalized`; a `lemma()` result that is not also that canonical form exists
 * only on `lemma`. Exact matching still uses the full form bag. Prefix matching
 * must not treat a lemma-only form as if the user typed it.
 *
 * Built-in English suffix-heuristic stems are one producer of lemma-only forms.
 * A custom `SearchPlugin.lemma()` that does not also supply `canonicalLemma()`
 * is another.
 *
 * Internal. Not a public API and not a QueryConcept redesign.
 */

import type { AnalyzedQuery, QueryToken } from "../types.js";

const EMPTY = new Set<string>();
const nonCanonicalOnlyByQuery = new WeakMap<AnalyzedQuery, Set<string>>();

function tokenPrefixIntentForms(token: QueryToken): string[] {
  const out: string[] = [];
  for (const value of [token.surface, token.surfaceNormalized, token.normalized, token.completedToken]) {
    if (typeof value === "string" && value) out.push(value);
  }
  return out;
}

/**
 * Lemma strings that are not also a typed/repaired/canonical/completed form.
 * Those may participate in exact lemma equality only.
 */
export function nonCanonicalLemmaOnlyForms(query: AnalyzedQuery | null | undefined): Set<string> {
  if (!query) return EMPTY;
  const cached = nonCanonicalOnlyByQuery.get(query);
  if (cached) return cached;
  const intent = new Set<string>();
  const lemmaOnly = new Set<string>();
  for (const token of query.tokens || []) {
    const local = new Set(tokenPrefixIntentForms(token));
    for (const form of local) intent.add(form);
    if (token.lemma && !local.has(token.lemma)) lemmaOnly.add(token.lemma);
  }
  for (const form of intent) lemmaOnly.delete(form);
  nonCanonicalOnlyByQuery.set(query, lemmaOnly);
  return lemmaOnly;
}

/** True when `form` may generate ordinary lexical prefix evidence. */
export function formAllowsOrdinaryLexicalPrefix(
  query: AnalyzedQuery | null | undefined,
  form: string
): boolean {
  if (!form) return false;
  return !nonCanonicalLemmaOnlyForms(query).has(form);
}
