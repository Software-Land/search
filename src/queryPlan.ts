/**
 * Internal query-plan clause evidence.
 *
 * Clauses describe ranking-independent support sets, not final ranking or
 * result-set policy. Support is never inferred from the #1 hit.
 *
 * Title-grade corroborating support is one set for the subset relation
 * `supportSet ⊆ phraseCohort`, but provenance is distinct:
 *
 * - configured identity: occupied configured key or peer form in the title
 * - equivalent support: equivalent-recall title
 * - topical support: topical-recall title
 * - version support: dotted / compact-dotted title
 *
 * Topical recall is corroborating support, not concept identity.
 */

import { extractFeatures } from "./features.js";
import { computeExactPhraseEvidence } from "./phraseEvidence.js";
import type {
  AnalyzedQuery,
  ExactPhraseEvidence,
  ExactPhraseHit,
  FeatureVector,
  IndexedDocument,
  SearchIndex,
} from "./types.js";

/** Distinct clause provenance for one title-grade support hit. */
export type TitleGradeSupportProvenance = "configured" | "equivalent" | "topical" | "version";

export type TitleGradeSupportKind =
  | "configured-key-title"
  | "configured-form-title"
  | "equivalent-recall-title"
  | "topical-recall-title"
  | "version-dotted";

export type PhraseCohortFilterReason =
  | "version-clause-present"
  | "no-phrase-evidence"
  | "phrase-cohort-not-rare"
  | "support-outside-phrase-cohort"
  | "support-subset-of-rare-phrase"
  | "unoccupied-title-or-summary-rare-phrase"
  | "body-only-phrase-without-support"
  | "no-dominance";

export interface TitleGradeSupportHit {
  id: string;
  kinds: TitleGradeSupportKind[];
  provenance: TitleGradeSupportProvenance[];
}

/**
 * Independent clause presence. Not a public query DSL and not inferred from
 * the final ranked list. Prefix/lexical flags record existing analyzer
 * evidence; they do not authorize phrase filtering.
 */
export interface QueryPlanClauses {
  lexical: boolean;
  exactPhrase: boolean;
  structuredIntent: boolean;
  equivalentRecall: boolean;
  topicalRecall: boolean;
  versionIntent: boolean;
  prefixEvidence: boolean;
}

export interface QueryPlan {
  clauses: QueryPlanClauses;
  exactPhrase: ExactPhraseEvidence | null;
  versionIntent: boolean;
  structuredKey: string | null;
  /** Ranking-independent title-grade corroborating support document ids. */
  supportIds: string[];
  support: TitleGradeSupportHit[];
  /** Exact typed phrase document ids (P). */
  phraseIds: string[];
  filterToPhraseCohort: boolean;
  filterReason: PhraseCohortFilterReason;
}

function provenanceOfKinds(kinds: TitleGradeSupportKind[]): TitleGradeSupportProvenance[] {
  const seen = new Set<TitleGradeSupportProvenance>();
  const out: TitleGradeSupportProvenance[] = [];
  for (const kind of kinds) {
    const provenance: TitleGradeSupportProvenance =
      kind === "configured-key-title" || kind === "configured-form-title"
        ? "configured"
        : kind === "equivalent-recall-title"
          ? "equivalent"
          : kind === "topical-recall-title"
            ? "topical"
            : "version";
    if (seen.has(provenance)) continue;
    seen.add(provenance);
    out.push(provenance);
  }
  return out;
}

/**
 * Title-grade corroborating support kinds. Configured key/form in title is
 * configured identity. Equivalent-recall title, topical-recall title, and
 * dotted version title are support, not identity. Not body bags and not
 * neighbor edges.
 */
export function titleGradeSupportKinds(features: Partial<FeatureVector>): TitleGradeSupportKind[] {
  const kinds: TitleGradeSupportKind[] = [];
  if (features.configuredConceptMatch === "key-in-title" || features.canonicalKeyTitle) {
    kinds.push("configured-key-title");
  }
  if (features.configuredConceptMatch === "form") kinds.push("configured-form-title");
  if (features.equivalentRecallTitleMatch) kinds.push("equivalent-recall-title");
  if (features.topicalRecallTitleMatch) kinds.push("topical-recall-title");
  if (features.versionMatch === "dotted" || features.versionMatch === "compact-dotted") {
    kinds.push("version-dotted");
  }
  return kinds;
}

export function hasTitleGradeSupport(features: Partial<FeatureVector>): boolean {
  return titleGradeSupportKinds(features).length > 0;
}

export function phraseHitIsTitleOrSummary(hit: ExactPhraseHit): boolean {
  return (hit.titleFrequency || 0) > 0 || (hit.summaryFrequency || 0) > 0;
}

/**
 * Largest exclusive primary list the product will collapse to when the typed
 * phrase independently identifies a small cohort. This is a result-set bound,
 * not a relevance score.
 */
export const MAX_EXCLUSIVE_PHRASE_COHORT = 2;

export function phraseCohortFilterPermission(plan: {
  versionIntent: boolean;
  phraseIds: string[];
  supportIds: string[];
  hits: ExactPhraseHit[];
}): { filter: boolean; reason: PhraseCohortFilterReason } {
  if (plan.versionIntent) return { filter: false, reason: "version-clause-present" };
  const P = plan.phraseIds;
  if (!P.length) return { filter: false, reason: "no-phrase-evidence" };
  if (P.length > MAX_EXCLUSIVE_PHRASE_COHORT) {
    return { filter: false, reason: "phrase-cohort-not-rare" };
  }
  const phraseSet = new Set(P);
  const supportIds = plan.supportIds;
  if (supportIds.length) {
    const supportOutside = supportIds.some((id) => !phraseSet.has(id));
    if (supportOutside) return { filter: false, reason: "support-outside-phrase-cohort" };
    return { filter: true, reason: "support-subset-of-rare-phrase" };
  }
  const hits = plan.hits;
  if (hits.length && hits.every(phraseHitIsTitleOrSummary)) {
    return { filter: true, reason: "unoccupied-title-or-summary-rare-phrase" };
  }
  if (hits.length && hits.every((hit) => !phraseHitIsTitleOrSummary(hit))) {
    return { filter: false, reason: "body-only-phrase-without-support" };
  }
  return { filter: false, reason: "no-dominance" };
}

function collectTitleGradeSupport(query: AnalyzedQuery, documents: IndexedDocument[]): TitleGradeSupportHit[] {
  const out: TitleGradeSupportHit[] = [];
  for (const document of documents) {
    const features = extractFeatures(query, document);
    const kinds = titleGradeSupportKinds(features);
    if (kinds.length) out.push({ id: document.id, kinds, provenance: provenanceOfKinds(kinds) });
  }
  return out;
}

export function buildQueryPlan(query: AnalyzedQuery, index: SearchIndex): QueryPlan {
  const exactPhrase = computeExactPhraseEvidence(query, index);
  const versionIntent = Array.isArray(query.dottedSpans) && query.dottedSpans.length > 0;
  const structuredKey = query.configuredSequenceIntent?.key || null;
  const support = collectTitleGradeSupport(query, index.documents);
  const supportIds = support.map((row) => row.id);
  const phraseIds = exactPhrase ? exactPhrase.hits.map((hit) => hit.document.id) : [];
  const permission = phraseCohortFilterPermission({
    versionIntent,
    phraseIds,
    supportIds,
    hits: exactPhrase ? exactPhrase.hits : [],
  });
  return {
    clauses: {
      lexical: Array.isArray(query.originalSurface) && query.originalSurface.filter(Boolean).length > 0,
      exactPhrase: Boolean(exactPhrase),
      structuredIntent: Boolean(structuredKey),
      equivalentRecall: Array.isArray(query.equivalentRecall) && query.equivalentRecall.length > 0,
      topicalRecall: Boolean(query.topicalRecall),
      versionIntent,
      prefixEvidence: Boolean(
        query.prefixCompletion ||
          (Array.isArray(query.configuredPrefixSpans) && query.configuredPrefixSpans.length > 0)
      ),
    },
    exactPhrase,
    versionIntent,
    structuredKey,
    supportIds,
    support,
    phraseIds,
    filterToPhraseCohort: permission.filter,
    filterReason: permission.reason,
  };
}
