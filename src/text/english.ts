/**
 * English morphology mechanics. Not intrinsic to SearchEngine.
 * Suffix heuristics, repeat collapse, and an optional caller-owned lemma table.
 * There is no built-in word list. Supplied entries are the whole explicit table
 * and take precedence over heuristic fallback. `canonicalLemma` reads that
 * table only; heuristic stems are not authoritative mappings.
 */

import { collapseTrailingRepeats } from "./text.js";
import { stableFingerprint } from "../stableHash.js";

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
  /**
   * Inflected lemma-table keys for query-time typo candidate generation.
   * Internal duck-typed hook; not part of the public `EnglishPlugin` contract.
   */
  lemmaTableKeys(): Iterable<string>;
  collapseRepeats: typeof collapseTrailingRepeats;
}

export function createEnglishPlugin({ lemmas = {} }: { lemmas?: Record<string, string> } = {}): EnglishPlugin {
  const table: Record<string, string> = { ...lemmas };
  const indexIdentity = `english-v1:${stableFingerprint(table)}`;
  function exactTableLemma(token: string): string | null {
    const t = String(token || "").toLowerCase();
    if (!t) return null;
    if (table[t]) return table[t];
    const collapsed = collapseTrailingRepeats(t);
    if (collapsed !== t && table[collapsed]) return table[collapsed];
    return null;
  }

  function explicitLemma(token: string): string | null {
    const exact = exactTableLemma(token);
    if (exact) return exact;
    const t = String(token || "").toLowerCase();
    if (!t) return null;
    const stripped = stripSuffix(collapseTrailingRepeats(t));
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
      return exactTableLemma(token);
    },
    lemmaTableKeys() {
      return Object.keys(table);
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
