/**
 * Stable candidate identities. Evidence changes do not change the ID.
 */

import { acronymKey, expansionTokens, phraseKey } from "./text.js";

export function slugTokens(tokens: unknown): string {
  return (Array.isArray(tokens) ? tokens : expansionTokens(tokens || ""))
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean)
    .join("-");
}

export function equivalenceId(key: unknown, expansion?: unknown): string {
  const k = acronymKey(key);
  const slug = slugTokens(expansion);
  if (!slug) return `equivalence:${k}:*`;
  return `equivalence:${k}:${slug}`;
}

export function synonymId(terms?: unknown): string {
  const list = Array.isArray(terms) ? terms : [];
  const sorted = [...list]
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean)
    .sort();
  return `synonym:${sorted.join(":")}`;
}

export function normalizeTerms(terms?: unknown): string[] {
  const list = Array.isArray(terms) ? terms : [];
  return [...list]
    .map((t) => String(t).toLowerCase())
    .filter(Boolean)
    .sort();
}

export function expansionPhraseOf(expansion: unknown): string {
  return phraseKey(Array.isArray(expansion) ? (expansion as string[]) : expansionTokens(expansion || ""));
}
