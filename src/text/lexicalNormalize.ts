/**
 * Canonical lexical-frequency normalization.
 *
 * Compiler (body field) and query phrase lookup must produce the same key
 * for the same normalized phrase:
 *
 *   tokenize → lemma → remove stop words → contiguous 1–2 grams
 *
 * Fields are never concatenated. Title n-grams are not compiled into
 * bodyPhraseCount evidence.
 */

import { tokenize, DEFAULT_STOP } from "./text.js";

/** Unigrams shorter than this are not compiled or used as phrase keys. */
export const MIN_UNIGRAM_LENGTH = 2;

export function lemmatizeTokens(
  tokens?: string[] | null,
  lemma?: (token: string) => string
): string[] {
  const fn = typeof lemma === "function" ? lemma : (t: string) => t;
  return (tokens || []).map((t) => fn(t) || t).filter(Boolean);
}

export function stripStopTokens(tokens?: string[] | null, stop: Set<string> = DEFAULT_STOP): string[] {
  return (tokens || []).filter((t) => t && !stop.has(t));
}

/**
 * Body/query token stream used for compiled n-grams and phrase lookup.
 */
export function canonicalLexicalTokens(
  text: unknown,
  { lemma, stop = DEFAULT_STOP }: { lemma?: (token: string) => string; stop?: Set<string> } = {}
): string[] {
  return stripStopTokens(lemmatizeTokens(tokenize(text), lemma), stop);
}

/**
 * Same stream from an already-analyzed query (lemmas already applied).
 */
export function canonicalLexicalTokensFromQuery(
  queryTokens?: Array<{ lemma?: string; normalized?: string }> | null,
  stop: Set<string> = DEFAULT_STOP
): string[] {
  const lemmatized = (queryTokens || []).map((t) => t.lemma || t.normalized || "").filter(Boolean);
  return stripStopTokens(lemmatized, stop);
}

/**
 * Contiguous n-grams over an already-canonical (lemmatized, stop-stripped) stream.
 */
export function extractCanonicalNgrams(
  tokens: string[] | null | undefined,
  policy: { minN: number; maxN: number }
): string[] {
  const out: string[] = [];
  const minN = policy.minN;
  const maxN = policy.maxN;
  const list = tokens || [];
  for (let i = 0; i < list.length; i++) {
    for (let n = minN; n <= maxN && i + n <= list.length; n++) {
      const slice = list.slice(i, i + n);
      if (slice.some((t) => !t)) continue;
      if (n === 1 && slice[0].length < MIN_UNIGRAM_LENGTH) continue;
      out.push(slice.join(" "));
    }
  }
  return out;
}

/**
 * Primary compiled-phrase lookup key for a query token list.
 */
export function lexicalPhraseKeyFromQuery(
  queryTokens?: Array<{ lemma?: string; normalized?: string }> | null,
  stop: Set<string> = DEFAULT_STOP
): string {
  return canonicalLexicalTokensFromQuery(queryTokens, stop).join(" ");
}
