/**
 * Local text helpers. search-corpus does not import Search Core.
 */

export const OPTIONAL_INITIAL_WORDS = new Set([
  "of", "the", "a", "an", "and", "for", "as", "to", "in", "or", "vs", "via",
]);

export const FUNCTION_WORDS = new Set([
  "what", "whats", "is", "an", "the", "of", "with", "are", "which", "for",
  "a", "and", "in", "to", "as", "vs", "or", "on", "by", "from", "at", "be",
  "this", "that", "it", "its", "if", "not", "can", "we", "you", "your",
]);

const COMMON_FALSE_KEYS = new Set([
  "ok", "us", "it", "me", "we", "or", "if", "to", "in", "on", "no", "so",
  "id", "pm", "am", "be", "do", "re", "my", "up", "out", "all", "any",
  "new", "old", "one", "two", "see", "may", "use", "used", "using",
]);

/** @param {unknown} [text] */
export function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s)>"'`]+/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {unknown} [text] @returns {string[]} */
export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[''`"]/g, "")
    .replace(/[_\-.\/:]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** @param {unknown} [surface] */
export function acronymKey(surface) {
  let t = String(surface || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t) return "";
  // Plural surfaces only: APIs, SDKs. Never strip TLS, RBAC, OS, etc.
  if (/^[A-Z]{2,5}s$/.test(String(surface || "")) && !/\d/.test(t)) {
    t = t.slice(0, -1);
  }
  return t;
}

/** @param {unknown} key @param {{ original?: unknown }} [opts] */
export function isPlausibleAcronymKey(key, { original = "" } = {}) {
  const k = String(key || "");
  if (k.length < 2 || k.length > 12) return false;
  if (COMMON_FALSE_KEYS.has(k) || FUNCTION_WORDS.has(k)) return false;
  if (!/^[a-z0-9]+$/.test(k)) return false;
  if (/^\d+$/.test(k)) return false;
  if (k.length === 2 && /\d/.test(k)) return true; // s3, h2, k8 as literals, not expansions
  const orig = String(original || "");
  const letters = orig.replace(/[^A-Za-z]/g, "");
  const upper = (letters.match(/[A-Z]/g) || []).length;
  if (k.length === 2 && letters.length >= 2 && upper < 2 && !/^[A-Z0-9+.-]+$/.test(orig.trim())) {
    return false;
  }
  return true;
}

/** @param {unknown} token */
export function isProtectedLiteral(token) {
  const t = String(token || "").toLowerCase();
  if (!t) return false;
  if (/^[a-z]\d$/.test(t)) return true; // s3, h2, k8
  if (/^[a-z]\d[a-z]$/.test(t)) return true; // k8s
  if (["grpc", "oauth", "webgl", "webgpu", "openid"].includes(t)) return true;
  return false;
}

/** @param {unknown} phrase @returns {string[]} */
export function expansionTokens(phrase) {
  return tokenize(phrase).filter(Boolean);
}

/** @param {string[]} tokens @returns {string[]} */
export function contentTokens(tokens) {
  return tokens.filter((t) => !FUNCTION_WORDS.has(t));
}

/** @param {string[]} tokens @param {{ skipOptional?: boolean }} [opts] */
export function initialsOf(tokens, { skipOptional = false } = {}) {
  const parts = skipOptional ? tokens.filter((t) => !OPTIONAL_INITIAL_WORDS.has(t)) : tokens;
  return parts.map((t) => t[0] || "").join("");
}

/**
 * Exact initialism only. Prefix matches are rejected (io ↛ internet of things).
 */
/** @param {unknown} key @param {string[]} tokens @param {{ optionalWords?: Set<string> }} [opts] */
export function initialsMatch(key, tokens, { optionalWords = OPTIONAL_INITIAL_WORDS } = {}) {
  const k = String(key || "").toLowerCase();
  if (!k || !tokens.length) return false;
  const strict = tokens.map((t) => t[0] || "").join("");
  const skipped = tokens.filter((t) => !optionalWords.has(t)).map((t) => t[0] || "").join("");
  if (k === strict || k === skipped) return true;
  return false;
}

/** Co-occurrence mining only skips of/and — not arbitrary "the" in a sentence. */
export const COOCCURRENCE_OPTIONAL = new Set(["of", "and"]);

/** @param {unknown} key @param {string[]} tokens */
export function initialsMatchCooccurrence(key, tokens) {
  return initialsMatch(key, tokens, { optionalWords: COOCCURRENCE_OPTIONAL });
}

/** @param {string[]} tokens */
export function phraseKey(tokens) {
  return tokens.join(" ");
}

/** @param {unknown} [tokens] @returns {string[]} */
export function normalizeExpansion(tokens) {
  const list = Array.isArray(tokens) ? tokens.map((t) => String(t)) : [];
  let t = [...list];
  while (t.length && FUNCTION_WORDS.has(t[0])) t.shift();
  while (t.length && FUNCTION_WORDS.has(t[t.length - 1])) t.pop();
  return t;
}

const UNLIKELY_EXPANSION_WORDS = new Set([
  "relatively", "easier", "simply", "really", "using", "used", "make", "makes",
  "more", "most", "such", "these", "those", "other", "another", "same",
  "able", "into", "over", "than", "then", "when", "what", "which",
  "have", "been", "will", "also", "just", "very", "many", "some",
]);

/**
 * Conservative noun-phrase check for co-occurrence mining.
 * Explicit parenthetical definitions may be slightly looser.
 */
/** @param {unknown} [tokens] */
export function looksLikeTermPhrase(tokens) {
  const list = Array.isArray(tokens) ? tokens.map((t) => String(t)) : [];
  const content = contentTokens(list);
  if (content.length < 2 || list.length > 8) return false;
  if (content.some((t) => t.length < 3)) return false;
  if (content.some((t) => UNLIKELY_EXPANSION_WORDS.has(t))) return false;
  return true;
}

/**
 * @template T
 * @param {T[]} arr
 * @param {(item: T) => string} keyFn
 * @returns {T[]}
 */
export function stableSort(arr, keyFn) {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}
