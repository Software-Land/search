const DEFAULT_STOP = new Set([
  "what", "whats", "is", "an", "the", "of", "with", "are", "which", "for",
  "a", "and", "in", "to", "as", "vs",
]);

export interface TokenRange {
  token: string;
  /** Inclusive start index in the original (pre-lowercase) string. */
  start: number;
  /** Exclusive end index in the original string. */
  end: number;
}

/**
 * Same tokens as tokenize(), with source ranges in the original string.
 * Quote characters are deleted; other separators become spaces in-place.
 */
export function tokenizeWithRanges(text?: unknown): TokenRange[] {
  const original = String(text || "");
  const lower = original.toLowerCase();
  const chars: Array<{ c: string; origIndex: number }> = [];
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (/[''`"]/.test(ch)) continue;
    if (/[_\-.\/:]/.test(ch) || /[^\w\s*]/.test(ch)) {
      chars.push({ c: " ", origIndex: i });
    } else {
      chars.push({ c: ch, origIndex: i });
    }
  }
  const ranges: TokenRange[] = [];
  let i = 0;
  while (i < chars.length) {
    if (/\s/.test(chars[i].c)) {
      i += 1;
      continue;
    }
    const start = chars[i].origIndex;
    let tok = "";
    let j = i;
    while (j < chars.length && !/\s/.test(chars[j].c)) {
      tok += chars[j].c;
      j += 1;
    }
    ranges.push({ token: tok, start, end: chars[j - 1].origIndex + 1 });
    i = j;
  }
  return ranges;
}

export function tokenize(text?: unknown): string[] {
  return tokenizeWithRanges(text).map((t) => t.token);
}

export function normalizeSurface(text?: unknown): string {
  return tokenize(text).join(" ");
}

export function collapseTrailingRepeats(token?: unknown): string {
  const t = String(token || "");
  if (t.length < 4) return t;
  return t.replace(/(.)\1{2,}$/g, "$1");
}

export function levenshtein(a?: unknown, b?: unknown): number {
  const s = String(a || "");
  const t = String(b || "");
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const prev: number[] = new Array(t.length + 1);
  const curr: number[] = new Array(t.length + 1);
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

export function isNearCompletePrefix(prefix?: unknown, token?: unknown): boolean {
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
export function allowPrefixMatch(queryTok?: unknown, titleTok?: unknown): boolean {
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

export function firstSurfaceToken(title?: unknown): string {
  const tokens = tokenize(title);
  return tokens[0] || "";
}

export { DEFAULT_STOP };
