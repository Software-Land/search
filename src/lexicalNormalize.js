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

/**
 * @param {string[]} tokens
 * @param {(token: string) => string} [lemma]
 */
export function lemmatizeTokens(tokens, lemma) {
  const fn = typeof lemma === "function" ? lemma : (/** @type {string} */ t) => t;
  return (tokens || []).map((t) => fn(t) || t).filter(Boolean);
}

/**
 * @param {string[]} tokens
 * @param {Set<string>} [stop]
 */
export function stripStopTokens(tokens, stop = DEFAULT_STOP) {
  return (tokens || []).filter((t) => t && !stop.has(t));
}

/**
 * Body/query token stream used for compiled n-grams and phrase lookup.
 * @param {unknown} text
 * @param {{ lemma?: (token: string) => string, stop?: Set<string> }} [opts]
 */
export function canonicalLexicalTokens(text, { lemma, stop = DEFAULT_STOP } = {}) {
  return stripStopTokens(lemmatizeTokens(tokenize(text), lemma), stop);
}

/**
 * Same stream from an already-analyzed query (lemmas already applied).
 * @param {Array<{ lemma?: string, normalized?: string }>} queryTokens
 * @param {Set<string>} [stop]
 */
export function canonicalLexicalTokensFromQuery(queryTokens, stop = DEFAULT_STOP) {
  const lemmatized = (queryTokens || []).map((t) => t.lemma || t.normalized || "").filter(Boolean);
  return stripStopTokens(lemmatized, stop);
}

/**
 * Contiguous n-grams over an already-canonical (lemmatized, stop-stripped) stream.
 * @param {string[]} tokens
 * @param {{ minN: number, maxN: number }} policy
 * @returns {string[]}
 */
export function extractCanonicalNgrams(tokens, policy) {
  const out = [];
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
 * @param {Array<{ lemma?: string, normalized?: string }>} queryTokens
 * @param {Set<string>} [stop]
 */
export function lexicalPhraseKeyFromQuery(queryTokens, stop = DEFAULT_STOP) {
  return canonicalLexicalTokensFromQuery(queryTokens, stop).join(" ");
}
