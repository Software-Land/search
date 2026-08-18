const DEFAULT_STOP = new Set([
  "what", "whats", "is", "an", "the", "of", "with", "are", "which", "for",
  "a", "and", "in", "to", "as", "vs",
]);

/** @param {unknown} [text] @returns {string[]} */
export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[''`"]/g, "")
    .replace(/[_\-.\/:]+/g, " ")
    .replace(/[^\w\s*]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** @param {unknown} [text] @returns {string} */
export function normalizeSurface(text) {
  return tokenize(text).join(" ");
}

/** @param {unknown} [token] @returns {string} */
export function collapseTrailingRepeats(token) {
  const t = String(token || "");
  if (t.length < 4) return t;
  return t.replace(/(.)\1{2,}$/g, "$1");
}

/** @param {unknown} [a] @param {unknown} [b] @returns {number} */
export function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const prev = new Array(t.length + 1);
  const curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j++) prev[j] = curr[j];
  }
  return prev[t.length];
}

/** @param {unknown} [prefix] @param {unknown} [token] */
export function isNearCompletePrefix(prefix, token) {
  const p = String(prefix || "");
  const t = String(token || "");
  if (!p || !t || !t.startsWith(p)) return false;
  if (p === t) return true;
  if (p.length >= 6 && p.length / t.length >= 0.55) return true;
  return false;
}

/**
 * Title-token prefix evidence. Short alphabetic stubs (io, a, ap) must not
 * prefix-match longer tokens; length >= 4 prefixes are allowed (mono → monotonic).
 */
/** @param {unknown} [queryTok] @param {unknown} [titleTok] */
export function allowPrefixMatch(queryTok, titleTok) {
  const q = String(queryTok || "");
  const t = String(titleTok || "");
  if (!q || !t) return false;
  if (t === q) return true;
  if (/^\d+$/.test(q) || /^\d+$/.test(t)) return false;
  if (!t.startsWith(q)) return false;
  if (q.length >= 4) return true;
  if (q.length >= 3 && q.length / t.length >= 0.55) return true;
  return false;
}

/** @param {unknown} [title] @returns {string} */
export function firstSurfaceToken(title) {
  const tokens = tokenize(title);
  return tokens[0] || "";
}

export { DEFAULT_STOP };
