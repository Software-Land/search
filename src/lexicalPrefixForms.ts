/**
 * Ordinary lexical PREFIX capability (Policy C).
 *
 * Analyze already encodes the morphology split: canonical/table lemmas rewrite
 * `normalized`; suffix-heuristic stems exist only on `lemma`. Exact matching
 * still uses the full form bag. Prefix matching must not treat a heuristic
 * stem as if the user typed it.
 *
 * Internal. Not a public API and not a QueryConcept redesign.
 */

import type { AnalyzedQuery, QueryToken } from "./types.js";

const EMPTY = new Set<string>();
const heuristicOnlyByQuery = new WeakMap<AnalyzedQuery, Set<string>>();

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
export function heuristicLemmaOnlyForms(query: AnalyzedQuery | null | undefined): Set<string> {
  if (!query) return EMPTY;
  const cached = heuristicOnlyByQuery.get(query);
  if (cached) return cached;
  const intent = new Set<string>();
  const heuristic = new Set<string>();
  for (const token of query.tokens || []) {
    const local = new Set(tokenPrefixIntentForms(token));
    for (const form of local) intent.add(form);
    if (token.lemma && !local.has(token.lemma)) heuristic.add(token.lemma);
  }
  for (const form of intent) heuristic.delete(form);
  heuristicOnlyByQuery.set(query, heuristic);
  return heuristic;
}

/** True when `form` may generate ordinary lexical prefix evidence. */
export function formAllowsOrdinaryLexicalPrefix(
  query: AnalyzedQuery | null | undefined,
  form: string
): boolean {
  if (!form) return false;
  return !heuristicLemmaOnlyForms(query).has(form);
}
