/**
 * Optional complete-interpretation result collector.
 *
 * Not QueryPlan. Not ranking. Not default search. Consumes already-executed
 * clause hits plus occupancy, configured-content identity, and version facts
 * recorded on the plan, and already featured independent authored-title evidence.
 *
 * Does not tokenize, parse, scan the corpus, call analyzer rewrite, infer
 * semantic identity, or inspect ranking scores. Product enablement (whether
 * to pass `resultCollector: "complete-interpretation"`) is the caller's decision.
 *
 * Completion consistency: when the typed phrase has no exact PhraseQuery hit,
 * every PhrasePrefix hit participates (title, summary, and body) unless the
 * query is an ambiguous one-content-token prefix. That stub is not a complete
 * phrase interpretation; body-only prefix expansions stay out so independently
 * retrieved configured-prefix-recall keys can rank. Authored title/summary
 * preference on prefix-only expansions applies only when an exact typed phrase
 * hit already exists.
 *
 * A complete phrase interpretation is a high-confidence cohort, not an
 * exclusive public set. Independently executed authored-title evidence already
 * featured for the query (short title-token prefix, configured title identity,
 * exact title, contextual title prefix, configured-prefix-recall) stays
 * alongside the phrase cohort. For an ambiguous one-content-token prefix,
 * relationship neighbors of those prefix-recall primaries also stay; a
 * single typed token may keep ordinary title-prefix hits. If the group does
 * not retrieve any title-key document, the collector does not apply an empty
 * cohort. Generic body-only lexical neighbors are not re-admitted when
 * prefix-recall keys did retrieve.
 */

import type { AnalyzedQuery, FeaturedHit, IndexedDocument, SearchIndex } from "../types.js";
import type { QueryPlan } from "../query/queryPlan.js";
import type { FieldPhraseHit } from "../retrieval/positionalQueries.js";
import { documentHasShortTitleTokenPrefix } from "../retrieval/retrieve.js";
import { querySemanticFacts } from "../query/querySemantics.js";
import { DEFAULT_STOP } from "../text/text.js";

export const COMPLETE_INTERPRETATION_COLLECTOR = "complete-interpretation" as const;
export type ResultCollectorName = typeof COMPLETE_INTERPRETATION_COLLECTOR;

export type CollectorDecision =
  | "occupancy"
  | "configured-content-identity"
  | "version"
  | "no-complete-hit"
  | "apply-complete-union";

export interface CompleteInterpretationResult {
  apply: boolean;
  reason: CollectorDecision;
  documentIds: string[];
  exactIds: string[];
  authoredPrefixIds: string[];
  bodyPrefixOnlyIds: string[];
}

function authored(hit: FieldPhraseHit): boolean {
  return hit.titleFrequency > 0 || hit.summaryFrequency > 0;
}

function anyField(hit: FieldPhraseHit): boolean {
  return hit.titleFrequency + hit.summaryFrequency + hit.bodyFrequency > 0;
}

function hasIndependentAuthoredTitleEvidence(hit: FeaturedHit, query: AnalyzedQuery): boolean {
  const f = hit.features;
  if (f.exactTitleMatch || f.canonicalKeyTitle || f.contextualTitlePrefix) return true;
  if (f.configuredConceptMatch === "key-in-title" || f.configuredConceptMatch === "form") return true;
  return documentHasShortTitleTokenPrefix(query, hit.document);
}

function hasTitlePrefixRetrievalEvidence(hit: FeaturedHit): boolean {
  const sources = hit.retrievalSources || [];
  return sources.includes("title-prefix") || sources.includes("title-token-prefix");
}

function hasRelationshipRetrievalEvidence(hit: FeaturedHit): boolean {
  return (hit.retrievalSources || []).includes("relationship");
}

function hasConfiguredPrefixRecallEvidence(hit: FeaturedHit): boolean {
  return (hit.retrievalSources || []).includes("configured-prefix-recall");
}

export function collectCompleteInterpretations(args: {
  occupancy: boolean;
  version: boolean;
  exactHits: FieldPhraseHit[];
  prefixHits: FieldPhraseHit[];
  configuredContentIdentity?: boolean;
  suppressBodyPrefix?: boolean;
}): CompleteInterpretationResult {
  const empty = (reason: CollectorDecision): CompleteInterpretationResult => ({
    apply: false,
    reason,
    documentIds: [],
    exactIds: [],
    authoredPrefixIds: [],
    bodyPrefixOnlyIds: [],
  });
  if (args.occupancy) return empty("occupancy");
  if (args.configuredContentIdentity) return empty("configured-content-identity");
  if (args.version) return empty("version");

  const exact = args.exactHits.filter(anyField);
  const prefix = args.prefixHits.filter(anyField);
  const exactIds = exact.map((h) => h.document.id);
  const authoredPrefix = prefix.filter(authored);
  const bodyPrefixOnly = prefix.filter((h) => !authored(h) && h.bodyFrequency > 0);
  const kept = new Map<string, IndexedDocument>();
  for (const hit of exact) kept.set(hit.document.id, hit.document);
  for (const hit of authoredPrefix) kept.set(hit.document.id, hit.document);
  // CASE A: no exact typed phrase → PhrasePrefix is the interpretation; all fields.
  // CASE B: exact typed phrase exists → body-only prefix expansions stay out.
  // Ambiguous unigram prefixes are not a complete interpretation.
  if (exact.length === 0 && !args.suppressBodyPrefix) {
    for (const hit of bodyPrefixOnly) kept.set(hit.document.id, hit.document);
  }
  if (!kept.size) {
    if (args.suppressBodyPrefix) {
      return {
        apply: true,
        reason: "apply-complete-union",
        documentIds: [],
        exactIds,
        authoredPrefixIds: [],
        bodyPrefixOnlyIds: bodyPrefixOnly.map((h) => h.document.id),
      };
    }
    return {
      apply: false,
      reason: "no-complete-hit",
      documentIds: [],
      exactIds,
      authoredPrefixIds: authoredPrefix.map((h) => h.document.id),
      bodyPrefixOnlyIds: bodyPrefixOnly.map((h) => h.document.id),
    };
  }
  return {
    apply: true,
    reason: "apply-complete-union",
    documentIds: [...kept.keys()],
    exactIds,
    authoredPrefixIds: authoredPrefix.map((h) => h.document.id),
    bodyPrefixOnlyIds: bodyPrefixOnly.map((h) => h.document.id),
  };
}

function suppressAmbiguousUnigramBodyPrefix(query?: AnalyzedQuery): boolean {
  if (!query) return false;
  const configured = querySemanticFacts(query).configured;
  if (configured.occupiedKey) return false;
  if (configured.weakRecall?.ambiguity === "unique") return false;
  const tokens = query.tokens || [];
  let content = 0;
  for (const tok of tokens) {
    if (!DEFAULT_STOP.has(String(tok.normalized || ""))) content += 1;
  }
  if (content !== 1) return false;
  return configured.weakRecall?.ambiguity === "group";
}

export function applyCompleteInterpretationCollector(
  featured: FeaturedHit[],
  plan: QueryPlan,
  index: SearchIndex,
  featureMissing: (doc: IndexedDocument) => FeaturedHit,
  query?: AnalyzedQuery
): { featured: FeaturedHit[]; collector: CompleteInterpretationResult } {
  const collector = collectCompleteInterpretations({
    occupancy: Boolean(plan.structuredKey),
    configuredContentIdentity: Boolean(plan.configuredContentIdentity),
    version: plan.versionIntent,
    exactHits: plan.exactHits,
    prefixHits: plan.prefixHits,
    suppressBodyPrefix: suppressAmbiguousUnigramBodyPrefix(query),
  });
  const suppress = suppressAmbiguousUnigramBodyPrefix(query);
  const keepTitlePrefix = Boolean(suppress && query && (query.tokens || []).length === 1);
  if (
    collector.apply &&
    collector.documentIds.length === 0 &&
    suppress &&
    !featured.some(
      (hit) =>
        hasConfiguredPrefixRecallEvidence(hit) ||
        (keepTitlePrefix && hasTitlePrefixRetrievalEvidence(hit))
    )
  ) {
    return {
      featured,
      collector: {
        ...collector,
        apply: false,
        reason: "no-complete-hit",
      },
    };
  }
  if (!collector.apply) return { featured, collector };
  const byId = new Map(featured.map((hit) => [hit.document.id, hit]));
  const next: FeaturedHit[] = [];
  const seen = new Set<string>();
  for (const id of collector.documentIds) {
    const existing = byId.get(id);
    if (existing) {
      next.push(existing);
      seen.add(id);
      continue;
    }
    const doc = index.byId.get(id);
    if (doc) {
      next.push(featureMissing(doc));
      seen.add(id);
    }
  }
  if (query) {
    const suppress = suppressAmbiguousUnigramBodyPrefix(query);
    const keepTitlePrefix = suppress && (query.tokens || []).length === 1;
    for (const hit of featured) {
      if (seen.has(hit.document.id)) continue;
      if (
        !hasIndependentAuthoredTitleEvidence(hit, query) &&
        !hasConfiguredPrefixRecallEvidence(hit) &&
        !(keepTitlePrefix && hasTitlePrefixRetrievalEvidence(hit)) &&
        !(suppress && hasRelationshipRetrievalEvidence(hit))
      ) {
        continue;
      }
      next.push(hit);
      seen.add(hit.document.id);
    }
  }
  return { featured: next, collector };
}
