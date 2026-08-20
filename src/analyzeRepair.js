/**
 * General query-token repair. Surface strings are preserved; alternatives
 * carry provenance. No query-specific hard-coded maps.
 */

import { levenshtein } from "./text.js";
import { throwIfAborted } from "./cancel.js";

/** Bound expensive compound repair of a user-controlled token. Same ceiling as exact segmentation. */
export const MAX_COMPOUND_REPAIR_TOKEN_LENGTH = 64;

/** @type {Record<string, string>} */
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t" };

/** @param {unknown} token @returns {string | null} */
export function decodeLeet(token) {
  const t = String(token || "");
  // Protect short literals: s3, h2, k8, k8s.
  if (t.length < 6) return null;
  if (!/\d/.test(t) || /^\d+$/.test(t)) return null;
  let out = "";
  let changed = false;
  for (const ch of t) {
    if (LEET[ch] != null) {
      out += LEET[ch];
      changed = true;
    } else {
      out += ch;
    }
  }
  return changed ? out : null;
}

/** @param {Iterable<string> | Set<string>} lexicon @param {{ min?: number, max?: number, cap?: number }} [opts] */
function lexiconWords(lexicon, { min = 5, max = 18, cap = 400 } = {}) {
  const out = [];
  for (const w of lexicon) {
    if (typeof w !== "string") continue;
    if (w.length >= min && w.length <= max && !/^\d+$/.test(w)) out.push(w);
  }
  out.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return cap > 0 ? out.slice(0, cap) : out;
}

/** @param {unknown} token @param {Iterable<string> | Set<string>} lexicon */
function isNearSingleLexiconWord(token, lexicon) {
  const t = String(token || "");
  if (t.length < 6) return false;
  for (const w of lexicon) {
    if (typeof w !== "string" || w.length < 6) continue;
    if (w.startsWith(t) || (t.startsWith(w) && t.length - w.length <= 3)) return true;
    const longer = Math.max(w.length, t.length);
    const shorter = Math.min(w.length, t.length);
    if (longer - shorter <= 3 && shorter / longer >= 0.7 && levenshtein(t, w) <= 3) return true;
  }
  return false;
}

/**
 * Split a long glued typo into lexicon words using edit distance ≤ 2 per part.
 * Exact glued compounds are handled by segmentExactCompound; this is the typo path.
 * Skip when the token is already a single known/near-known word (morphology).
 */
/**
 * @param {unknown} token
 * @param {Iterable<string> | Set<string>} lexicon
 * @param {{ signal?: AbortSignal }} [options]
 */
export function compoundSpellSegment(token, lexicon, { signal } = {}) {
  throwIfAborted(signal);
  const t = String(token || "");
  if (t.length < 12) return null;
  if (t.length > MAX_COMPOUND_REPAIR_TOKEN_LENGTH) return null;
  if (isNearSingleLexiconWord(t, lexicon)) return null;
  const words = lexiconWords(lexicon);
  if (!words.length) return null;

  const inf = 1e6;
  /** @type {number[]} */
  const cost = new Array(t.length + 1).fill(inf);
  /** @type {Array<{ from: number, word: string, distance: number } | null>} */
  const prev = new Array(t.length + 1).fill(null);
  cost[0] = 0;

  for (let i = 0; i < t.length; i++) {
    if (cost[i] >= inf) continue;
    if (i % 4 === 0) throwIfAborted(signal);
    for (const w of words) {
      const lo = Math.max(5, w.length - 2);
      const hi = Math.min(t.length - i, w.length + 2);
      for (let len = lo; len <= hi; len++) {
        const slice = t.slice(i, i + len);
        const d = levenshtein(slice, w);
        if (d > 2) continue;
        const next = i + len;
        const c = cost[i] + d;
        if (c < cost[next]) {
          cost[next] = c;
          prev[next] = { from: i, word: w, distance: d };
        }
      }
    }
  }

  if (cost[t.length] >= inf) return null;
  /** @type {Array<{ from: number, word: string, distance: number }>} */
  const parts = [];
  let i = t.length;
  while (i > 0) {
    const step = prev[i];
    if (!step) break;
    parts.push(step);
    i = step.from;
  }
  if (i !== 0 || parts.length < 2) return null;
  parts.reverse();
  return {
    tokens: parts.map((p) => p.word),
    distances: parts.map((p) => p.distance),
    source: "compound-spell-segmentation",
  };
}

/**
 * Leftover wrapper around a salvaged term must look like keyboard smash / padding,
 * not a plausible second word. Prevents "testing" matching "test" etc.
 */
/** @param {unknown} s */
export function leftoverLooksLikeJunk(s) {
  const t = String(s || "");
  if (t.length < 4) return false;
  const unique = new Set(t).size;
  if (unique <= 4 && t.length >= 6) return true;
  if (/(.)\1{2,}/.test(t)) return true;
  const vowels = (t.match(/[aeiou]/gi) || []).length;
  if (t.length >= 6 && vowels / t.length < 0.18) return true;
  return false;
}

/**
 * High-confidence salvage of one known term inside a long junk token.
 * Dictionary keys (len≥4, with an expansion) or long lexicon/title terms (len≥7).
 * Requires leftover junk and that the whole token is not itself a lexicon word.
 */
/**
 * @param {unknown} token
 * @param {{ lexicon?: Set<string> | Iterable<string>, dictionaryKeys?: Iterable<string>, signal?: AbortSignal }} [options]
 */
export function salvageContainedTerm(token, { lexicon, dictionaryKeys, signal } = {}) {
  throwIfAborted(signal);
  const t = String(token || "");
  if (t.length < 10) return null;
  if (t.length > MAX_COMPOUND_REPAIR_TOKEN_LENGTH) return null;
  if (lexicon && "has" in lexicon && lexicon.has(t)) return null;

  const keys = [...(dictionaryKeys || [])].filter((k) => k.length >= 4).sort((a, b) => b.length - a.length);
  const long = t.length >= 12 ? lexiconWords(lexicon || [], { min: 7, max: 24 }).sort((a, b) => b.length - a.length) : [];

  /** @param {string} term @param {number} idx */
  function leftoverOk(term, idx) {
    const before = t.slice(0, idx);
    const after = t.slice(idx + term.length);
    if (before.length + after.length < 4) return false;
    const leftover = `${before}${after}`;
    if (!leftoverLooksLikeJunk(leftover)) return false;
    if (lexicon && leftover.length >= 5 && "has" in lexicon && lexicon.has(leftover)) return false;
    for (const w of long) {
      if (w !== term && leftover.includes(w)) return false;
    }
    return true;
  }

  for (const key of keys) {
    const idx = t.indexOf(key);
    if (idx === -1) continue;
    if (!leftoverOk(key, idx)) continue;
    return { tokens: [key], source: "junk-token-salvage", matched: key };
  }
  for (const term of long) {
    const idx = t.indexOf(term);
    if (idx === -1) continue;
    if (!leftoverOk(term, idx)) continue;
    return { tokens: [term], source: "junk-token-salvage", matched: term };
  }
  return null;
}
