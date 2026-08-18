/**
 * Stable candidate identities. Evidence changes do not change the ID.
 */

import { acronymKey, expansionTokens, phraseKey } from "./text.js";

/** @param {unknown} tokens */
export function slugTokens(tokens) {
  return (Array.isArray(tokens) ? tokens : expansionTokens(tokens || ""))
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean)
    .join("-");
}

/** @param {unknown} key @param {unknown} expansion */
export function equivalenceId(key, expansion) {
  const k = acronymKey(key);
  const slug = slugTokens(expansion);
  if (!slug) return `equivalence:${k}:*`;
  return `equivalence:${k}:${slug}`;
}

/** @param {unknown} [terms] @returns {string} */
export function synonymId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const sorted = [...list]
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean)
    .sort();
  return `synonym:${sorted.join(":")}`;
}

/** @param {unknown} [terms] @returns {string[]} */
export function normalizeTerms(terms) {
  const list = Array.isArray(terms) ? terms : [];
  return [...list]
    .map((t) => String(t).toLowerCase())
    .filter(Boolean)
    .sort();
}

/** @param {unknown} expansion */
export function expansionPhraseOf(expansion) {
  return phraseKey(Array.isArray(expansion) ? expansion : expansionTokens(expansion || ""));
}
