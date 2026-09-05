/**
 * Build-time lexical n-gram frequency compiler.
 *
 * Counts the BODY field only, in the same tokenize → lemma → stop-strip
 * space as Search Core phrase lookup. Title tokens are never concatenated
 * with body tokens. The browser runtime looks up compiled keys; it does
 * not rescan bodies or rebuild vocabularies.
 */

import { canonicalDocumentId } from "../../../dist/documentId.js";
import { saturatingFrequency } from "../../../dist/saturatingFrequency.js";
import {
  canonicalLexicalTokens,
  extractCanonicalNgrams,
} from "../../../dist/text/lexicalNormalize.js";
import type {
  LexicalCompileOptions,
  LexicalFrequencyArtifact,
  LexicalPolicy,
} from "../index.js";

export { saturatingFrequency };

export const COMPILER_VERSION: 1 = 1;
export const LEXICAL_FREQUENCY_FORMAT: "search-v2-lexical-frequency" = "search-v2-lexical-frequency";

export const DEFAULT_LEXICAL_POLICY: {
  readonly minN: 1;
  readonly maxN: 2;
  readonly minCollectionCount: 2;
} = Object.freeze({
  minN: 1,
  maxN: 2,
  minCollectionCount: 2,
});

function documentsFrom(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object" && Array.isArray((input as { documents?: unknown }).documents)) {
    return (input as { documents: unknown[] }).documents;
  }
  return [];
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`lexical policy ${name} must be a finite positive integer (got ${String(value)})`);
  }
  return value;
}

export function resolveLexicalPolicy(policy?: LexicalPolicy | null): {
  minN: number;
  maxN: number;
  minCollectionCount: number;
} {
  const minN = requirePositiveInteger("minN", policy?.minN ?? DEFAULT_LEXICAL_POLICY.minN);
  const maxN = requirePositiveInteger("maxN", policy?.maxN ?? DEFAULT_LEXICAL_POLICY.maxN);
  const minCollectionCount = requirePositiveInteger(
    "minCollectionCount",
    policy?.minCollectionCount ?? DEFAULT_LEXICAL_POLICY.minCollectionCount
  );
  if (maxN < minN) {
    throw new Error(`lexical policy maxN (${maxN}) must be >= minN (${minN})`);
  }
  return { minN, maxN, minCollectionCount };
}

function sortRecord(rec: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(rec).sort()) out[key] = rec[key];
  return out;
}

export function lookupNgramCount(ngrams: Record<string, number> | null | undefined, key: string): number {
  if (!ngrams || !key) return 0;
  const n = ngrams[key];
  return Number.isFinite(n) ? n : 0;
}

/**
 * Duplicate ids: last document wins, matching SearchEngine.index.
 * Collection counts are computed only after that resolution.
 */
export function compileLexicalFrequency(
  input?: unknown,
  { lemma, policy }: LexicalCompileOptions = {}
): LexicalFrequencyArtifact {
  const resolved = resolveLexicalPolicy(policy);
  const lemmaFn = typeof lemma === "function" ? lemma : (t: string) => t;

  const byId = new Map<string, Record<string, number>>();

  for (const raw of documentsFrom(input)) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as { id?: unknown; body?: unknown };
    const id = canonicalDocumentId(rec.id);
    if (!id) continue;
    const tokens = canonicalLexicalTokens(rec.body || "", { lemma: lemmaFn });
    const counts: Record<string, number> = {};
    for (const key of extractCanonicalNgrams(tokens, resolved)) {
      counts[key] = (counts[key] || 0) + 1;
    }
    byId.set(id, counts);
  }

  const collection = new Map<string, number>();
  for (const counts of byId.values()) {
    for (const [key, n] of Object.entries(counts)) {
      collection.set(key, (collection.get(key) || 0) + n);
    }
  }

  const ids = [...byId.keys()].sort();
  const documents: Record<string, { ngrams: Record<string, number> }> = {};
  for (const id of ids) {
    const counts = byId.get(id) || {};
    const kept: Record<string, number> = {};
    for (const [key, count] of Object.entries(counts)) {
      if ((collection.get(key) || 0) >= resolved.minCollectionCount) kept[key] = count;
    }
    documents[id] = { ngrams: sortRecord(kept) };
  }

  return {
    format: LEXICAL_FREQUENCY_FORMAT,
    version: COMPILER_VERSION,
    policy: resolved,
    documents,
  };
}

/**
 * Copy compiled n-gram counts onto documents for SearchEngine.index().
 * Sets `lexicalFrequency` to the canonical flat `Record<string, number>`.
 */
export function attachLexicalFrequency<T extends { id?: unknown }>(
  documents: T[],
  artifact: LexicalFrequencyArtifact | null | undefined
): T[] {
  const byId = artifact?.documents || {};
  return (documents || []).map((doc) => {
    const id = canonicalDocumentId(doc?.id);
    const ngrams = byId[id]?.ngrams;
    if (!ngrams) return doc;
    return { ...doc, lexicalFrequency: ngrams };
  });
}
