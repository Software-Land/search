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

export function cleanText(text?: unknown): string {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s)>"'`]+/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text?: unknown): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[''`"]/g, "")
    .replace(/[_\-.\/:]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function acronymKey(surface?: unknown): string {
  let t = String(surface || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t) return "";
  // Plural surfaces only: APIs, SDKs. Never strip TLS, RBAC, OS, etc.
  if (/^[A-Z]{2,5}s$/.test(String(surface || "")) && !/\d/.test(t)) {
    t = t.slice(0, -1);
  }
  return t;
}

export function isPlausibleAcronymKey(key: unknown, { original = "" }: { original?: unknown } = {}): boolean {
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

export function isProtectedLiteral(token: unknown): boolean {
  const t = String(token || "").toLowerCase();
  if (!t) return false;
  if (/^[a-z]\d$/.test(t)) return true; // s3, h2, k8
  if (/^[a-z]\d[a-z]$/.test(t)) return true; // k8s
  if (["grpc", "oauth", "webgl", "webgpu", "openid"].includes(t)) return true;
  return false;
}

export function expansionTokens(phrase: unknown): string[] {
  return tokenize(phrase).filter(Boolean);
}

export function contentTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !FUNCTION_WORDS.has(t));
}

export function initialsOf(tokens: string[], { skipOptional = false }: { skipOptional?: boolean } = {}): string {
  const parts = skipOptional ? tokens.filter((t) => !OPTIONAL_INITIAL_WORDS.has(t)) : tokens;
  return parts.map((t) => t[0] || "").join("");
}

/**
 * Exact initialism only. Prefix matches are rejected (io ↛ internet of things).
 */
export function initialsMatch(
  key: unknown,
  tokens: string[],
  { optionalWords = OPTIONAL_INITIAL_WORDS }: { optionalWords?: Set<string> } = {}
): boolean {
  const k = String(key || "").toLowerCase();
  if (!k || !tokens.length) return false;
  const strict = tokens.map((t) => t[0] || "").join("");
  const skipped = tokens.filter((t) => !optionalWords.has(t)).map((t) => t[0] || "").join("");
  if (k === strict || k === skipped) return true;
  return false;
}

/** Co-occurrence mining only skips of/and — not arbitrary "the" in a sentence. */
export const COOCCURRENCE_OPTIONAL = new Set(["of", "and"]);

export function initialsMatchCooccurrence(key: unknown, tokens: string[]): boolean {
  return initialsMatch(key, tokens, { optionalWords: COOCCURRENCE_OPTIONAL });
}

export function phraseKey(tokens: string[]): string {
  return tokens.join(" ");
}

export function normalizeExpansion(tokens?: unknown): string[] {
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
export function looksLikeTermPhrase(tokens?: unknown): boolean {
  const list = Array.isArray(tokens) ? tokens.map((t) => String(t)) : [];
  const content = contentTokens(list);
  if (content.length < 2 || list.length > 8) return false;
  if (content.some((t) => t.length < 3)) return false;
  if (content.some((t) => UNLIKELY_EXPANSION_WORDS.has(t))) return false;
  return true;
}

export function stableSort<T>(arr: T[], keyFn: (item: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}
