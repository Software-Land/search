/**
 * Small English morphology plugin. Not intrinsic to SearchEngine.
 * Intentionally tiny: suffix heuristics plus an optional lemma map.
 * Site lemmas augment the built-in table. Explicit DEFAULT_LEMMAS win so a
 * generated spaCy table cannot replace mappings the runtime already relies on.
 */

import { collapseTrailingRepeats } from "./text.js";

/** @type {Record<string, string>} */
const DEFAULT_LEMMAS = {
  libraries: "library",
  recursive: "recursion",
  recursively: "recursion",
  recursing: "recursion",
  recurses: "recursion",
  recursed: "recursion",
  authenticating: "authentication",
  authenticated: "authentication",
  authorizing: "authorization",
  authorized: "authorization",
  authorizes: "authorization",
  sharding: "shard",
  shards: "shard",
  computing: "compute",
  learning: "learn",
  learnings: "learn",
  intercepting: "interceptor",
  intercepted: "interceptor",
  intercept: "interceptor",
};

/** @param {string} token */
function stripSuffix(token) {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 5) {
    const base = token.slice(0, -3);
    return base.endsWith("at") ? `${base}e` : base;
  }
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("ion") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

/** @param {{ lemmas?: Record<string, string> }} [options] */
export function english({ lemmas = {} } = {}) {
  /** @type {Record<string, string>} */
  const table = { ...lemmas, ...DEFAULT_LEMMAS };
  /** @param {string} token @returns {string | null} */
  function explicitLemma(token) {
    const t = String(token || "").toLowerCase();
    if (!t) return null;
    if (table[t]) return table[t];
    const collapsed = collapseTrailingRepeats(t);
    if (table[collapsed]) return table[collapsed];
    const stripped = stripSuffix(collapsed);
    if (table[stripped]) return table[stripped];
    return null;
  }

  return {
    name: "english",
    /** @param {string} token */
    lemma(token) {
      const t = String(token || "").toLowerCase();
      if (!t) return t;
      const explicit = explicitLemma(t);
      if (explicit) return explicit;
      const collapsed = collapseTrailingRepeats(t);
      const stripped = stripSuffix(collapsed);
      return stripped;
    },
    /**
     * Lemma-table identity only. Suffix heuristics are not confident enough
     * to rewrite retrieval tokens (application → applicat, kubernetes → kubernete).
     * @param {string} token
     */
    canonicalLemma(token) {
      return explicitLemma(token);
    },
    collapseRepeats: collapseTrailingRepeats,
  };
}
