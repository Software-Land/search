/**
 * Small English morphology plugin. Not intrinsic to SearchEngine.
 * Intentionally tiny: suffix heuristics plus an optional lemma map.
 * Site lemmas augment the built-in table. Explicit DEFAULT_LEMMAS win so a
 * generated spaCy table cannot replace mappings the runtime already relies on.
 */

import { collapseTrailingRepeats } from "./text.js";
import { stableFingerprint } from "./stableHash.js";

const DEFAULT_LEMMAS: Record<string, string> = {
  libraries: "library",
  recursive: "recursion",
  recursively: "recursion",
  recursing: "recursion",
  recurses: "recursion",
  recursed: "recursion",
  recurse: "recursion",
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

function stripSuffix(token: string): string {
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

export interface EnglishPlugin {
  name: "english";
  indexIdentity: string;
  lemma(token: string): string;
  /**
   * Lemma-table identity only. Suffix heuristics are not confident enough
   * to rewrite retrieval tokens (application → applicat, kubernetes → kubernete).
   */
  canonicalLemma(token: string): string | null;
  collapseRepeats: typeof collapseTrailingRepeats;
}

export function createEnglishPlugin({ lemmas = {} }: { lemmas?: Record<string, string> } = {}): EnglishPlugin {
  const table: Record<string, string> = { ...lemmas, ...DEFAULT_LEMMAS };
  const indexIdentity = `english-v1:${stableFingerprint(table)}`;
  function explicitLemma(token: string): string | null {
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
    indexIdentity,
    lemma(token) {
      const t = String(token || "").toLowerCase();
      if (!t) return t;
      const explicit = explicitLemma(t);
      if (explicit) return explicit;
      const collapsed = collapseTrailingRepeats(t);
      const stripped = stripSuffix(collapsed);
      return stripped;
    },
    canonicalLemma(token) {
      return explicitLemma(token);
    },
    collapseRepeats: collapseTrailingRepeats,
  };
}

/**
 * @deprecated Use `morphology()` instead.
 */
export function english({ lemmas = {} }: { lemmas?: Record<string, string> } = {}): EnglishPlugin {
  return createEnglishPlugin({ lemmas });
}
