/**
 * Read-only internal projection of AnalyzedQuery semantic fields.
 *
 * Facts only. Packed eligibility, collector suppression, relationship
 * primary selection, retrieval field-scope, ranking coefficients, and
 * prefix-walk policy stay in their owning modules.
 */

import type { AnalyzedQuery, ConfiguredPrefixRecall } from "../types.js";

export type WeakConfiguredRecallAmbiguity = "unique" | "group";

export type WeakConfiguredRecall = {
  ambiguity: WeakConfiguredRecallAmbiguity;
  candidates: ConfiguredPrefixRecall[];
};

export type QuerySemanticFacts = {
  configured: {
    occupiedKey: string | null;
    contentIdentityKey: string | null;
    /**
     * Occupancy or configured-content identity. Ranking may evaluate the
     * configured concept and authored peer forms. Occupancy and identity stay
     * distinct keys; this is their ranking-evidence union only.
     */
    hasRankingIdentity: boolean;
    weakRecall: WeakConfiguredRecall | null;
  };
  completion: {
    vocabularyPrefix: boolean;
    boundTrailing: boolean;
  };
  relatedRecall: {
    standalone: boolean;
    topical: boolean;
    equivalent: boolean;
  };
};

const EMPTY_FACTS: QuerySemanticFacts = {
  configured: {
    occupiedKey: null,
    contentIdentityKey: null,
    hasRankingIdentity: false,
    weakRecall: null,
  },
  completion: {
    vocabularyPrefix: false,
    boundTrailing: false,
  },
  relatedRecall: {
    standalone: false,
    topical: false,
    equivalent: false,
  },
};

const factsByQuery = new WeakMap<AnalyzedQuery, QuerySemanticFacts>();

function occupiedKeyOf(query: AnalyzedQuery): string | null {
  return query.configuredSequenceIntent?.key || null;
}

function contentIdentityKeyOf(query: AnalyzedQuery): string | null {
  return query.configuredContentIdentity?.key || null;
}

function weakConfiguredRecallOf(query: AnalyzedQuery): WeakConfiguredRecall | null {
  if (occupiedKeyOf(query)) return null;
  const unique = query.configuredPrefixRecall;
  if (unique?.key) {
    return { ambiguity: "unique", candidates: [unique] };
  }
  const group = query.configuredPrefixRecallGroup || [];
  const candidates: ConfiguredPrefixRecall[] = [];
  for (const row of group) {
    if (row?.key) candidates.push(row);
  }
  if (!candidates.length) return null;
  return { ambiguity: "group", candidates };
}

function projectQuerySemanticFacts(query: AnalyzedQuery): QuerySemanticFacts {
  const prefix = query.prefixCompletion;
  const occupiedKey = occupiedKeyOf(query);
  const contentIdentityKey = contentIdentityKeyOf(query);
  return {
    configured: {
      occupiedKey,
      contentIdentityKey,
      hasRankingIdentity: Boolean(occupiedKey || contentIdentityKey),
      weakRecall: weakConfiguredRecallOf(query),
    },
    completion: {
      vocabularyPrefix: Boolean(prefix?.completedToken || prefix?.canonicalToken),
      boundTrailing: Boolean(query.contextualCompletion?.completedToken),
    },
    relatedRecall: {
      standalone: Boolean(query.standaloneRecall?.key),
      topical: Boolean((query.topicalRecall?.forms || []).length),
      equivalent: Array.isArray(query.equivalentRecall) && query.equivalentRecall.length > 0,
    },
  };
}

/** Cached read-only view of query-semantic facts. Does not mutate `query`. */
export function querySemanticFacts(query: AnalyzedQuery | null | undefined): QuerySemanticFacts {
  if (!query) return EMPTY_FACTS;
  const cached = factsByQuery.get(query);
  if (cached) return cached;
  const facts = projectQuerySemanticFacts(query);
  factsByQuery.set(query, facts);
  return facts;
}
