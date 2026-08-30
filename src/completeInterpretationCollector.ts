/**
 * Optional complete-interpretation result collector.
 *
 * Not QueryPlan. Not ranking. Not default search. Consumes already-executed
 * clause hits plus occupancy/version facts recorded on the plan.
 *
 * Does not tokenize, parse, scan the corpus, call analyzer rewrite, infer
 * semantic identity, or inspect ranking. Product enablement (whether to pass
 * `resultCollector: "complete-interpretation"`) is the caller's decision.
 *
 * Completion consistency: when the typed phrase has no exact PhraseQuery hit,
 * every PhrasePrefix hit participates (title, summary, and body). Authored
 * title/summary preference on prefix-only expansions applies only when an
 * exact typed phrase hit already exists.
 */

import type { FeaturedHit, IndexedDocument, SearchIndex } from "./types.js";
import type { QueryPlan } from "./queryPlan.js";
import type { FieldPhraseHit } from "./positionalQueries.js";

export const COMPLETE_INTERPRETATION_COLLECTOR = "complete-interpretation" as const;
export type ResultCollectorName = typeof COMPLETE_INTERPRETATION_COLLECTOR;

export type CollectorDecision = "occupancy" | "version" | "no-complete-hit" | "apply-complete-union";

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

export function collectCompleteInterpretations(args: {
  occupancy: boolean;
  version: boolean;
  exactHits: FieldPhraseHit[];
  prefixHits: FieldPhraseHit[];
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
  if (exact.length === 0) {
    for (const hit of bodyPrefixOnly) kept.set(hit.document.id, hit.document);
  }
  if (!kept.size) {
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

export function applyCompleteInterpretationCollector(
  featured: FeaturedHit[],
  plan: QueryPlan,
  index: SearchIndex,
  featureMissing: (doc: IndexedDocument) => FeaturedHit
): { featured: FeaturedHit[]; collector: CompleteInterpretationResult } {
  const collector = collectCompleteInterpretations({
    occupancy: Boolean(plan.structuredKey),
    version: plan.versionIntent,
    exactHits: plan.exactHits,
    prefixHits: plan.prefixHits,
  });
  if (!collector.apply) return { featured, collector };
  const byId = new Map(featured.map((hit) => [hit.document.id, hit]));
  const next: FeaturedHit[] = [];
  for (const id of collector.documentIds) {
    const existing = byId.get(id);
    if (existing) {
      next.push(existing);
      continue;
    }
    const doc = index.byId.get(id);
    if (doc) next.push(featureMissing(doc));
  }
  return { featured: next, collector };
}
