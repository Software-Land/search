/**
 * Build-time lexical n-gram frequency compiler.
 *
 * Counts the BODY field only, in the same tokenize → lemma → stop-strip
 * space as Search Core phrase lookup. Title tokens are never concatenated
 * with body tokens. The browser runtime looks up compiled keys; it does
 * not rescan bodies or rebuild vocabularies.
 */

import { canonicalDocumentId } from "../../../src/documentId.js";
import { saturatingFrequency } from "../../../src/saturatingFrequency.js";
import {
  canonicalLexicalTokens,
  extractCanonicalNgrams,
} from "../../../src/lexicalNormalize.js";

export { saturatingFrequency };

export const COMPILER_VERSION = 1;
export const LEXICAL_FREQUENCY_FORMAT = "search-v2-lexical-frequency";

export const DEFAULT_LEXICAL_POLICY = Object.freeze({
  minN: 1,
  maxN: 2,
  minCollectionCount: 2,
});

/** @param {unknown} input */
function documentsFrom(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object" && Array.isArray(/** @type {{ documents?: unknown }} */ (input).documents)) {
    return /** @type {{ documents: unknown[] }} */ (input).documents;
  }
  return [];
}

/**
 * @param {string} name
 * @param {unknown} value
 */
function requirePositiveInteger(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`lexical policy ${name} must be a finite positive integer (got ${String(value)})`);
  }
  return value;
}

/**
 * @param {import("../index.js").LexicalPolicy | null | undefined} policy
 */
export function resolveLexicalPolicy(policy) {
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

/** @param {Record<string, number>} rec */
function sortRecord(rec) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const key of Object.keys(rec).sort()) out[key] = rec[key];
  return out;
}

/** @param {Record<string, number> | null | undefined} ngrams @param {string} key */
export function lookupNgramCount(ngrams, key) {
  if (!ngrams || !key) return 0;
  const n = ngrams[key];
  return Number.isFinite(n) ? n : 0;
}

/**
 * Duplicate ids: last document wins, matching SearchEngine.index.
 * Collection counts are computed only after that resolution.
 *
 * @param {unknown} input
 * @param {import("../index.js").LexicalCompileOptions} [opts]
 */
export function compileLexicalFrequency(input, { lemma, policy } = {}) {
  const resolved = resolveLexicalPolicy(policy);
  const lemmaFn = typeof lemma === "function" ? lemma : (/** @type {string} */ t) => t;

  /** @type {Map<string, Record<string, number>>} */
  const byId = new Map();

  for (const raw of documentsFrom(input)) {
    if (!raw || typeof raw !== "object") continue;
    const rec = /** @type {{ id?: unknown, body?: unknown }} */ (raw);
    const id = canonicalDocumentId(rec.id);
    if (!id) continue;
    const tokens = canonicalLexicalTokens(rec.body || "", { lemma: lemmaFn });
    /** @type {Record<string, number>} */
    const counts = {};
    for (const key of extractCanonicalNgrams(tokens, resolved)) {
      counts[key] = (counts[key] || 0) + 1;
    }
    byId.set(id, counts);
  }

  /** @type {Map<string, number>} */
  const collection = new Map();
  for (const counts of byId.values()) {
    for (const [key, n] of Object.entries(counts)) {
      collection.set(key, (collection.get(key) || 0) + n);
    }
  }

  const ids = [...byId.keys()].sort();
  /** @type {Record<string, { ngrams: Record<string, number> }>} */
  const documents = {};
  for (const id of ids) {
    const counts = byId.get(id) || {};
    /** @type {Record<string, number>} */
    const kept = {};
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
 * @template {{ id?: unknown }} T
 * @param {T[]} documents
 * @param {ReturnType<typeof compileLexicalFrequency> | null | undefined} artifact
 */
export function attachLexicalFrequency(documents, artifact) {
  const byId = artifact?.documents || {};
  return (documents || []).map((doc) => {
    const id = canonicalDocumentId(doc?.id);
    const ngrams = byId[id]?.ngrams;
    if (!ngrams) return doc;
    return { ...doc, lexicalFrequency: ngrams };
  });
}
