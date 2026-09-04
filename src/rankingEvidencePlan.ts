/**
 * Query-only compilation for retrieval-fused ranking evidence.
 *
 * This module deliberately compiles semantic posting actions before retrieval:
 * the posting hot path receives only a field code and numeric action id.
 */
import { rankingQueryFacts, type RankingQueryFacts } from "./features.js";
import type { CompiledTermRuntime } from "./lexicalIndex.js";
import {
  evidenceTokens,
  formContentTokens,
  isBoundTrailingTypedToken,
  isSearchEquivalenceRecallConcept,
  rankingCoverageConcepts,
  shortTitleTokenPrefixStub,
} from "./retrieve.js";
import { querySemanticFacts } from "./querySemantics.js";
import { allowPrefixMatch, DEFAULT_STOP, isNearCompletePrefix, levenshteinAtMost } from "./text.js";
import type { AnalyzedQuery, QueryConcept } from "./types.js";
import type { RankingEvidenceStatic } from "./rankingEvidenceState.js";

export const RANKING_EVIDENCE_TITLE_FIELD = 0 as const;
export const RANKING_EVIDENCE_BODY_FIELD = 1 as const;
export type RankingEvidenceFieldCode =
  | typeof RANKING_EVIDENCE_TITLE_FIELD
  | typeof RANKING_EVIDENCE_BODY_FIELD;

export const RANKING_EVIDENCE_NO_ACTION = 0;

export const RANKING_ACTION_EXACT_TITLE_TOKEN = 1 << 0;
export const RANKING_ACTION_TYPED_SURFACE = 1 << 1;
export const RANKING_ACTION_CONFIGURED_KEY = 1 << 2;
export const RANKING_ACTION_TITLE_COVERAGE = 1 << 3;

export type RankingEvidenceSequencePlan = {
  /** One positional-index surface-term choice row per query token. */
  readonly rows: readonly (readonly string[])[];
  /**
   * Exact lemma rows for the separately hydrated summary lemma stream.
   * Title/body lemmas share the compact term dictionary; summary lemmas do not.
   */
  readonly summaryLemmaRows: readonly (readonly string[])[] | null;
};

export type RankingEvidenceFormPlan = {
  readonly tokens: readonly string[];
  readonly join: string;
  readonly content: readonly string[];
  readonly contentMask: number;
  readonly singleMemberOfLonger: boolean;
  readonly exactSurface: RankingEvidenceSequencePlan;
  readonly exactLemma: RankingEvidenceSequencePlan;
  readonly adjacentSurface: RankingEvidenceSequencePlan;
  readonly adjacentLemma: RankingEvidenceSequencePlan;
};

export type RankingEvidenceContextualChoice = {
  readonly term: string;
  readonly aligned: string;
};

export type RankingEvidenceContextualPlan = {
  readonly preceding: readonly (readonly string[])[];
  readonly final: readonly RankingEvidenceContextualChoice[];
  readonly matchedPrefixTokens: readonly string[];
  readonly activeFinalPrefix: string;
};

export type RankingEvidenceAction = {
  readonly id: number;
  readonly field: RankingEvidenceFieldCode;
  readonly posting: number[] | null;
  readonly representativeTerm: string;
  /** Title matches valid at every position (lemma/prefix), or all body matches. */
  readonly conceptMask: number;
  /** Title exact/lemma matches that require a non-dotted independent position. */
  readonly independentConceptMask: number;
  readonly flags: number;
  readonly ordinaryPrefixMask: number;
  readonly typedPrefixMask: number;
  readonly morphologySurfaceMask: number;
  readonly morphologyLemmaMask: number;
  readonly typoTier: number;
  /** Surface-or-lemma token evidence, indexed by configured form. */
  readonly configuredFieldMask: Uint32Array;
  /** Independent surface-only title evidence, indexed by configured form. */
  readonly configuredIndependentSurfaceMask: Uint32Array;
  /** Forms for which this surface term contributes occupied title coverage. */
  readonly configuredCoverageForms: number;
  /** Surface prefix evidence bits, indexed by configured form. */
  readonly configuredPrefixMask: Uint32Array;
  readonly atomicActions: number;
};

export type RankingEvidencePlanStats = {
  actionTerms: number;
  actions: number;
  atomicActions: number;
  typoTerms: number;
};

export type RankingEvidenceQueryFacts = {
  readonly feature: RankingQueryFacts;
  readonly typedLiterals: readonly string[];
  readonly occupied: boolean;
  readonly configuredContentIdentity: boolean;
  readonly occupancyUnionsTyped: boolean;
  readonly configuredFormCoverage: number;
  readonly originalSurfaceTokens: readonly string[];
};

export type RankingEvidencePlan = {
  readonly static: RankingEvidenceStatic;
  readonly query: AnalyzedQuery;
  readonly facts: RankingEvidenceQueryFacts;
  readonly rankingConcepts: readonly QueryConcept[];
  readonly conceptBitByConcept: ReadonlyMap<QueryConcept, number>;
  readonly forms: readonly RankingEvidenceFormPlan[];
  readonly exactTitleNorms: ReadonlySet<string>;
  readonly actions: readonly RankingEvidenceAction[];
  readonly titleActionByPosting: WeakMap<number[], number>;
  readonly bodyActionByPosting: WeakMap<number[], number>;
  readonly titleActionIds: readonly number[];
  readonly ordinaryTitleAdjacencySurface: RankingEvidenceSequencePlan | null;
  readonly ordinaryTitleAdjacencyLemma: RankingEvidenceSequencePlan | null;
  readonly typedPhraseSurface: RankingEvidenceSequencePlan | null;
  readonly configuredKeySurface: RankingEvidenceSequencePlan | null;
  readonly configuredKeyLemma: RankingEvidenceSequencePlan | null;
  readonly contextual: RankingEvidenceContextualPlan | null;
  readonly stats: RankingEvidencePlanStats;
  /** Bytes in typed action payloads; JS map/object overhead is intentionally excluded. */
  readonly actionBytes: number;
};

export type RankingEvidencePlanResult =
  | { eligible: true; reason: null; plan: RankingEvidencePlan }
  | { eligible: false; reason: string; plan: null };

type MutableAction = {
  field: RankingEvidenceFieldCode;
  posting: number[];
  representativeTerm: string;
  conceptMask: number;
  independentConceptMask: number;
  flags: number;
  ordinaryPrefixMask: number;
  typedPrefixMask: number;
  morphologySurfaceMask: number;
  morphologyLemmaMask: number;
  typoTier: number;
  configuredFieldMask: number[];
  configuredIndependentSurfaceMask: number[];
  configuredCoverageForms: number;
  configuredPrefixMask: number[];
  atomicActions: number;
};

function popcount32(value: number) {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function uniqueForms(concept: QueryConcept) {
  return [...new Set((concept.forms || []).filter(Boolean))];
}

function titlePrefixableForms(forms: readonly string[]) {
  return forms.filter((form) => {
    if (!form || /^\d+$/.test(form) || /\s/.test(form)) return false;
    return !forms.some(
      (other) => other !== form && other.startsWith(form) && other.length > form.length
    );
  });
}

function titleConceptTermMasks(concept: QueryConcept, term: CompiledTermRuntime) {
  const forms = uniqueForms(concept);
  let anyPosition = false;
  let independent = false;
  for (const form of forms) {
    if (/\s/.test(form)) continue;
    if (term.term === form || term.lemma === form) independent = true;
    // conceptMatchesTitle's lemma-set branch is not restricted by dotted-span
    // independence.
    if (term.lemma === form) anyPosition = true;
  }
  for (const form of titlePrefixableForms(forms)) {
    // Prefix matching scans all title positions, including dotted components.
    if (allowPrefixMatch(form, term.term)) anyPosition = true;
  }
  return { anyPosition, independent };
}

function bodyConceptTermMatch(concept: QueryConcept, term: CompiledTermRuntime) {
  for (const form of uniqueForms(concept)) {
    if (/\s/.test(form)) continue;
    if (term.term === form || term.lemma === form) return true;
    if (
      !/^\d+$/.test(form) &&
      !/^\d+$/.test(term.term) &&
      form.length >= 3 &&
      term.term.startsWith(form)
    ) {
      return true;
    }
  }
  return false;
}

function typedContentLiterals(query: AnalyzedQuery) {
  const stream = query.tokens || [];
  if (!stream.length) return [];
  const last = stream[stream.length - 1];
  const skipLast = querySemanticFacts(query).completion.boundTrailing;
  const out: string[] = [];
  for (const token of stream) {
    if (skipLast && token === last) continue;
    const literal = String(token.surfaceNormalized || token.surface || "").toLowerCase();
    if (!literal || DEFAULT_STOP.has(literal)) continue;
    out.push(literal);
  }
  return out;
}

function occupancyUnionsTypedTitleEvidence(query: AnalyzedQuery) {
  const key = querySemanticFacts(query).configured.occupiedKey;
  if (!key) return false;
  if ((query.tokens || []).length !== 1) return false;
  const concept = (query.concepts || []).find(
    (candidate) => candidate.kind === "configured-concept" && candidate.id === key
  );
  const coverage = concept?.formCoverage;
  return typeof coverage === "number" && coverage > 0 && coverage < 1;
}

function configuredFormCoverage(query: AnalyzedQuery, facts: RankingQueryFacts) {
  if (!querySemanticFacts(query).configured.occupiedKey) return 0;
  const coverage = facts.acronym?.formCoverage;
  return typeof coverage === "number" && Number.isFinite(coverage) ? coverage : 0;
}

function termLemma(state: RankingEvidenceStatic, term: string) {
  const id = state.store.idOf.get(term);
  if (id === undefined) return term;
  return state.store.strings[state.store.lemmaOf[id]] || term;
}

type SequenceMode = "exact-surface" | "exact-lemma" | "prefix-surface" | "prefix-lemma";

function fieldTokenMatch(queryToken: string, term: string) {
  if (!queryToken || !term) return false;
  if (/^\d+$/.test(queryToken) || /^\d+$/.test(term)) return queryToken === term;
  return term === queryToken || term.startsWith(queryToken);
}

function lowerBoundString(values: readonly string[], key: string) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function surfacePrefixTerms(
  state: RankingEvidenceStatic,
  token: string
) {
  if (/^\d+$/.test(token)) {
    return state.positionTermSet.has(token) ? [token] : [];
  }
  const out: string[] = [];
  let at = lowerBoundString(state.positionTerms, token);
  while (at < state.positionTerms.length) {
    const term = state.positionTerms[at++];
    if (!term.startsWith(token)) break;
    if (fieldTokenMatch(token, term)) out.push(term);
  }
  return out;
}

function lemmaPrefixTerms(
  state: RankingEvidenceStatic,
  token: string
) {
  if (/^\d+$/.test(token)) {
    return [...(state.positionTermsByLemma.get(token) || [])];
  }
  const out: string[] = [];
  let at = lowerBoundString(state.positionLemmaKeys, token);
  while (at < state.positionLemmaKeys.length) {
    const lemma = state.positionLemmaKeys[at++];
    if (!lemma.startsWith(token)) break;
    if (!fieldTokenMatch(token, lemma)) continue;
    for (const term of state.positionTermsByLemma.get(lemma) || []) out.push(term);
  }
  return out;
}

function compileSequence(
  state: RankingEvidenceStatic,
  tokens: readonly string[],
  mode: SequenceMode
): RankingEvidenceSequencePlan {
  const rows: string[][] = [];
  const summaryLemmaRows: string[][] | null =
    mode === "exact-lemma" ? [] : null;
  for (const token of tokens) {
    if (mode === "exact-surface") {
      rows.push(state.positionTermSet.has(token) ? [token] : []);
    } else if (mode === "exact-lemma") {
      rows.push([...(state.positionTermsByLemma.get(token) || [])]);
    } else if (mode === "prefix-surface") {
      rows.push(surfacePrefixTerms(state, token));
    } else {
      rows.push(lemmaPrefixTerms(state, token));
    }
    summaryLemmaRows?.push(token ? [token] : []);
  }
  return { rows, summaryLemmaRows };
}

function compileContextual(
  state: RankingEvidenceStatic,
  query: AnalyzedQuery
): RankingEvidenceContextualPlan | null {
  if (querySemanticFacts(query).configured.occupiedKey) return null;
  const tokens = query.tokens || [];
  if (tokens.length < 2) return null;
  const preceding: string[][] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    const choices = new Set<string>();
    for (const value of [token.normalized, token.lemma]) {
      if (!value) continue;
      if (state.positionTermSet.has(value)) choices.add(value);
      for (const term of state.positionTermsByLemma.get(value) || []) {
        choices.add(term);
      }
    }
    preceding.push([...choices].sort());
  }
  const last = tokens[tokens.length - 1];
  const prefix = last.normalized;
  if (!prefix || /^\d+$/.test(prefix)) return null;
  const final: RankingEvidenceContextualChoice[] = [];
  const finalTerms = new Set([
    ...surfacePrefixTerms(state, prefix),
    ...lemmaPrefixTerms(state, prefix),
  ]);
  for (const term of [...finalTerms].sort()) {
    if (/^\d+$/.test(term)) continue;
    const lemma = termLemma(state, term);
    const aligned = term.startsWith(prefix) ? term : lemma.startsWith(prefix) ? lemma : "";
    if (aligned && aligned !== prefix) final.push({ term, aligned });
  }
  if (!final.length) return null;
  return {
    preceding,
    final,
    matchedPrefixTokens: tokens.slice(0, -1).map((token) => token.normalized),
    activeFinalPrefix: prefix,
  };
}

function formPlans(
  state: RankingEvidenceStatic,
  facts: RankingQueryFacts
) {
  return facts.peerForms.map((tokens): RankingEvidenceFormPlan => {
    const content = formContentTokens(tokens);
    const singleMemberOfLonger =
      tokens.length === 1 &&
      facts.peerForms.some(
        (other) => other.length > 1 && other.includes(tokens[0])
      );
    return {
      tokens,
      join: tokens.join(" "),
      content,
      contentMask: content.length ? ((1 << content.length) - 1) >>> 0 : 0,
      singleMemberOfLonger,
      exactSurface: compileSequence(state, tokens, "exact-surface"),
      exactLemma: compileSequence(state, tokens, "exact-lemma"),
      adjacentSurface: compileSequence(state, tokens, "prefix-surface"),
      adjacentLemma: compileSequence(state, tokens, "prefix-lemma"),
    };
  });
}

function exactTitleNorms(query: AnalyzedQuery, facts: RankingQueryFacts) {
  const semantics = querySemanticFacts(query);
  const out = new Set<string>();
  if (semantics.configured.occupiedKey && facts.peerFormJoins.length) {
    for (const join of facts.peerFormJoins) if (join) out.add(join);
    return out;
  }
  if (facts.joinedNorm) out.add(facts.joinedNorm);
  if (semantics.configured.occupiedKey || semantics.configured.contentIdentityKey) {
    for (const join of facts.peerFormJoins) if (join) out.add(join);
  }
  return out;
}

function emptyMutableAction(
  field: RankingEvidenceFieldCode,
  posting: number[],
  term: string,
  formCount: number
): MutableAction {
  return {
    field,
    posting,
    representativeTerm: term,
    conceptMask: 0,
    independentConceptMask: 0,
    flags: 0,
    ordinaryPrefixMask: 0,
    typedPrefixMask: 0,
    morphologySurfaceMask: 0,
    morphologyLemmaMask: 0,
    typoTier: 0,
    configuredFieldMask: new Array(formCount).fill(0),
    configuredIndependentSurfaceMask: new Array(formCount).fill(0),
    configuredCoverageForms: 0,
    configuredPrefixMask: new Array(formCount).fill(0),
    atomicActions: 0,
  };
}

function mergeAction(into: MutableAction, from: MutableAction) {
  into.conceptMask |= from.conceptMask;
  into.independentConceptMask |= from.independentConceptMask;
  into.flags |= from.flags;
  into.ordinaryPrefixMask |= from.ordinaryPrefixMask;
  into.typedPrefixMask |= from.typedPrefixMask;
  into.morphologySurfaceMask |= from.morphologySurfaceMask;
  into.morphologyLemmaMask |= from.morphologyLemmaMask;
  if (from.typoTier > into.typoTier) into.typoTier = from.typoTier;
  into.configuredCoverageForms |= from.configuredCoverageForms;
  for (let i = 0; i < into.configuredFieldMask.length; i++) {
    into.configuredFieldMask[i] |= from.configuredFieldMask[i] || 0;
    into.configuredIndependentSurfaceMask[i] |=
      from.configuredIndependentSurfaceMask[i] || 0;
    into.configuredPrefixMask[i] |= from.configuredPrefixMask[i] || 0;
  }
  into.atomicActions += from.atomicActions;
}

function hasSemanticAction(action: MutableAction) {
  if (
    action.conceptMask ||
    action.independentConceptMask ||
    action.flags ||
    action.ordinaryPrefixMask ||
    action.typedPrefixMask ||
    action.morphologySurfaceMask ||
    action.morphologyLemmaMask ||
    action.typoTier ||
    action.configuredCoverageForms
  ) {
    return true;
  }
  for (let i = 0; i < action.configuredFieldMask.length; i++) {
    if (
      action.configuredFieldMask[i] ||
      action.configuredIndependentSurfaceMask[i] ||
      action.configuredPrefixMask[i]
    ) {
      return true;
    }
  }
  return false;
}

function countAtomic(action: MutableAction) {
  let count =
    popcount32(action.conceptMask) +
    popcount32(action.independentConceptMask) +
    popcount32(action.ordinaryPrefixMask) +
    popcount32(action.typedPrefixMask) +
    popcount32(action.morphologySurfaceMask) +
    popcount32(action.morphologyLemmaMask) +
    popcount32(action.configuredCoverageForms) +
    Number(Boolean(action.flags & RANKING_ACTION_EXACT_TITLE_TOKEN)) +
    Number(Boolean(action.flags & RANKING_ACTION_TYPED_SURFACE)) +
    Number(Boolean(action.flags & RANKING_ACTION_CONFIGURED_KEY)) +
    Number(Boolean(action.flags & RANKING_ACTION_TITLE_COVERAGE)) +
    Number(action.typoTier > 0);
  for (let i = 0; i < action.configuredFieldMask.length; i++) {
    count +=
      popcount32(action.configuredFieldMask[i]) +
      popcount32(action.configuredIndependentSurfaceMask[i]) +
      popcount32(action.configuredPrefixMask[i]);
  }
  return count;
}

function semanticActions(
  state: RankingEvidenceStatic,
  query: AnalyzedQuery,
  facts: RankingEvidenceQueryFacts,
  rankingConcepts: readonly QueryConcept[],
  conceptBits: ReadonlyMap<QueryConcept, number>,
  forms: readonly RankingEvidenceFormPlan[]
) {
  const ordinary = !facts.occupied;
  const evidence = evidenceTokens(query);
  const ordinaryNorms = ordinary
    ? facts.feature.nonStop
        .filter((token) => !isBoundTrailingTypedToken(query, token))
        .map((token) => token.normalized)
    : [];
  const typoTokens = facts.feature.typoTokens.filter(
    (token) => !isBoundTrailingTypedToken(query, token)
  );
  const morphologyTokens: Array<{ surface: string; lemma: string }> = facts.occupied
    ? forms
        .filter((form) => form.tokens.length === 1 && !DEFAULT_STOP.has(form.tokens[0]))
        .map((form) => ({ surface: form.tokens[0], lemma: form.tokens[0] }))
    : evidence.map((token) => ({
        surface: token.normalized,
        lemma: token.lemma || token.normalized,
      }));
  const ordinaryConcepts = rankingConcepts.filter(
    (concept) => concept.kind !== "configured-concept"
  );
  const titleGroups = new Map<number[], MutableAction>();
  const bodyGroups = new Map<number[], MutableAction>();
  let actionTerms = 0;
  let typoTerms = 0;

  for (const term of state.compiled.terms) {
    const title = emptyMutableAction(
      RANKING_EVIDENCE_TITLE_FIELD,
      term.title,
      term.term,
      forms.length
    );
    const body = emptyMutableAction(
      RANKING_EVIDENCE_BODY_FIELD,
      term.body,
      term.term,
      forms.length
    );

    for (const concept of ordinaryConcepts) {
      const bit = conceptBits.get(concept) || 0;
      const titleMasks = titleConceptTermMasks(concept, term);
      if (titleMasks.anyPosition) title.conceptMask |= bit;
      if (titleMasks.independent) title.independentConceptMask |= bit;
      if (bodyConceptTermMatch(concept, term)) body.conceptMask |= bit;
    }

    if (ordinary) {
      if (
        !DEFAULT_STOP.has(term.term) &&
        evidence.some(
          (token) =>
            token.normalized === term.term ||
            token.lemma === term.term ||
            allowPrefixMatch(token.normalized, term.term) ||
            isNearCompletePrefix(token.normalized, term.term) ||
            facts.feature.formSet.has(term.term)
        )
      ) {
        title.flags |= RANKING_ACTION_TITLE_COVERAGE;
      }
      if (
        evidence.some(
          (token) =>
            !DEFAULT_STOP.has(token.normalized) && token.normalized === term.term
        )
      ) {
        title.flags |= RANKING_ACTION_EXACT_TITLE_TOKEN;
      }
      if (
        facts.typedLiterals.some(
          (literal) =>
            literal === term.term ||
            allowPrefixMatch(literal, term.term) ||
            isNearCompletePrefix(literal, term.term)
        )
      ) {
        title.flags |= RANKING_ACTION_TYPED_SURFACE;
      }
      for (let i = 0; i < ordinaryNorms.length; i++) {
        if (
          allowPrefixMatch(ordinaryNorms[i], term.term) ||
          isNearCompletePrefix(ordinaryNorms[i], term.term)
        ) {
          title.ordinaryPrefixMask |= 1 << i;
        }
      }
    }

    for (let i = 0; i < facts.typedLiterals.length; i++) {
      const literal = facts.typedLiterals[i];
      if (
        allowPrefixMatch(literal, term.term) ||
        isNearCompletePrefix(literal, term.term)
      ) {
        title.typedPrefixMask |= 1 << i;
      }
    }

    for (let i = 0; i < morphologyTokens.length && i < 30; i++) {
      const token = morphologyTokens[i];
      if (term.term === token.surface) title.morphologySurfaceMask |= 1 << i;
      if (term.term === token.lemma || term.lemma === token.lemma) {
        title.morphologyLemmaMask |= 1 << i;
      }
    }

    for (const token of typoTokens) {
      const normalized = token.normalized;
      if (token.sources.includes("repeat-collapse") && term.term === normalized) {
        title.typoTier = Math.max(title.typoTier, 1);
        continue;
      }
      if (term.term === normalized || Math.abs(term.term.length - normalized.length) > 2) {
        continue;
      }
      const distance = levenshteinAtMost(normalized, term.term, 2);
      if (distance > 0 && distance <= 2) {
        title.typoTier = Math.max(title.typoTier, 3 - distance);
      }
    }

    const acronym = facts.feature.acronym;
    if (
      acronym &&
      (term.term === acronym.id || term.lemma === acronym.id)
    ) {
      title.flags |= RANKING_ACTION_CONFIGURED_KEY;
      body.flags |= RANKING_ACTION_CONFIGURED_KEY;
    }
    for (let formIndex = 0; formIndex < forms.length; formIndex++) {
      const form = forms[formIndex];
      for (let contentIndex = 0; contentIndex < form.content.length; contentIndex++) {
        const token = form.content[contentIndex];
        if (term.term === token || term.lemma === token) {
          title.configuredFieldMask[formIndex] |= 1 << contentIndex;
          body.configuredFieldMask[formIndex] |= 1 << contentIndex;
        }
        if (term.term === token) {
          title.configuredIndependentSurfaceMask[formIndex] |= 1 << contentIndex;
        }
        if (
          term.term === token ||
          allowPrefixMatch(token, term.term) ||
          isNearCompletePrefix(token, term.term)
        ) {
          title.configuredCoverageForms |= 1 << formIndex;
          title.configuredPrefixMask[formIndex] |= 1 << contentIndex;
        }
      }
    }

    title.atomicActions = countAtomic(title);
    body.atomicActions = countAtomic(body);
    const hasTitle = term.title.length > 0 && hasSemanticAction(title);
    const hasBody = term.body.length > 0 && hasSemanticAction(body);
    if (!hasTitle && !hasBody) continue;
    actionTerms += 1;
    if (title.typoTier) typoTerms += 1;
    if (hasTitle) {
      const existing = titleGroups.get(term.title);
      if (existing) mergeAction(existing, title);
      else titleGroups.set(term.title, title);
    }
    if (hasBody) {
      const existing = bodyGroups.get(term.body);
      if (existing) mergeAction(existing, body);
      else bodyGroups.set(term.body, body);
    }
  }

  const noAction: RankingEvidenceAction = {
    id: RANKING_EVIDENCE_NO_ACTION,
    field: RANKING_EVIDENCE_TITLE_FIELD,
    posting: null,
    representativeTerm: "",
    conceptMask: 0,
    independentConceptMask: 0,
    flags: 0,
    ordinaryPrefixMask: 0,
    typedPrefixMask: 0,
    morphologySurfaceMask: 0,
    morphologyLemmaMask: 0,
    typoTier: 0,
    configuredFieldMask: new Uint32Array(0),
    configuredIndependentSurfaceMask: new Uint32Array(0),
    configuredCoverageForms: 0,
    configuredPrefixMask: new Uint32Array(0),
    atomicActions: 0,
  };
  const actions: RankingEvidenceAction[] = [noAction];
  const titleActionByPosting = new WeakMap<number[], number>();
  const bodyActionByPosting = new WeakMap<number[], number>();
  const titleActionIds: number[] = [];
  let actionBytes = 0;
  let atomicActions = 0;

  function append(
    mutable: MutableAction,
    target: WeakMap<number[], number>,
    titleAction: boolean
  ) {
    const id = actions.length;
    const actionAtomicCount = countAtomic(mutable);
    const configuredFieldMask = Uint32Array.from(mutable.configuredFieldMask);
    const configuredIndependentSurfaceMask = Uint32Array.from(
      mutable.configuredIndependentSurfaceMask
    );
    const configuredPrefixMask = Uint32Array.from(mutable.configuredPrefixMask);
    const action: RankingEvidenceAction = {
      id,
      field: mutable.field,
      posting: mutable.posting,
      representativeTerm: mutable.representativeTerm,
      conceptMask: mutable.conceptMask >>> 0,
      independentConceptMask: mutable.independentConceptMask >>> 0,
      flags: mutable.flags >>> 0,
      ordinaryPrefixMask: mutable.ordinaryPrefixMask >>> 0,
      typedPrefixMask: mutable.typedPrefixMask >>> 0,
      morphologySurfaceMask: mutable.morphologySurfaceMask >>> 0,
      morphologyLemmaMask: mutable.morphologyLemmaMask >>> 0,
      typoTier: mutable.typoTier,
      configuredFieldMask,
      configuredIndependentSurfaceMask,
      configuredCoverageForms: mutable.configuredCoverageForms >>> 0,
      configuredPrefixMask,
      atomicActions: actionAtomicCount,
    };
    actions.push(action);
    target.set(mutable.posting, id);
    if (titleAction) titleActionIds.push(id);
    actionBytes +=
      configuredFieldMask.byteLength +
      configuredIndependentSurfaceMask.byteLength +
      configuredPrefixMask.byteLength;
    atomicActions += actionAtomicCount;
  }

  for (const action of titleGroups.values()) append(action, titleActionByPosting, true);
  for (const action of bodyGroups.values()) append(action, bodyActionByPosting, false);
  return {
    actions,
    titleActionByPosting,
    bodyActionByPosting,
    titleActionIds,
    actionBytes,
    stats: {
      actionTerms,
      actions: actions.length - 1,
      atomicActions,
      typoTerms,
    },
  };
}

export function rankingEvidenceEligibilityReason(
  query: AnalyzedQuery,
  state: RankingEvidenceStatic | null
): string | null {
  if (!state) return "compact-index-required";
  const semantics = querySemanticFacts(query);
  if (semantics.relatedRecall.standalone) return "standalone-recall";
  if (semantics.relatedRecall.topical) return "topical-recall";
  if (semantics.relatedRecall.equivalent) return "equivalent-recall";
  if (semantics.configured.weakRecall) return "configured-prefix-recall";
  if (
    (query.dottedSpans || []).length ||
    (query.concepts || []).some((concept) => concept.kind === "number")
  ) {
    return "version-number-dotted";
  }
  if (semantics.completion.boundTrailing) {
    return "bound-contextual-completion";
  }
  const ranking = rankingCoverageConcepts(query, query.concepts || []).filter(
    (concept) => !isSearchEquivalenceRecallConcept(query, concept)
  );
  if (!ranking.length || ranking.length > 30) return "concept-count";
  const configured = ranking.filter(
    (concept) => concept.kind === "configured-concept"
  );
  if (configured.length > 1) return "multiple-configured-concepts";
  for (const concept of ranking) {
    if (concept.kind === "configured-concept") continue;
    if (
      /\s/.test(concept.id || "") ||
      (concept.forms || []).some((form) => /\s/.test(form))
    ) {
      return "ordinary-phrase-concept";
    }
  }
  const feature = rankingQueryFacts(query);
  const typed = typedContentLiterals(query);
  if (feature.shortLiteralTok || shortTitleTokenPrefixStub(query)) {
    return "short-literal";
  }
  if (
    (query.tokens || []).length > 30 ||
    feature.nonStopNorm.length > 30 ||
    typed.length > 30 ||
    (query.originalSurface || []).length > 30
  ) {
    return "token-shape";
  }
  if (
    feature.peerForms.length > 8 ||
    feature.peerForms.some(
      (form) => form.length > 30 || formContentTokens(form).length > 30
    )
  ) {
    return "configured-form-shape";
  }
  return null;
}

export function compileRankingEvidencePlan(
  state: RankingEvidenceStatic | null,
  query: AnalyzedQuery
): RankingEvidencePlanResult {
  const reason = rankingEvidenceEligibilityReason(query, state);
  if (reason || !state) return { eligible: false, reason: reason || "ineligible", plan: null };

  const feature = rankingQueryFacts(query);
  const semantics = querySemanticFacts(query);
  const facts: RankingEvidenceQueryFacts = {
    feature,
    typedLiterals: typedContentLiterals(query),
    occupied: Boolean(semantics.configured.occupiedKey),
    configuredContentIdentity: Boolean(semantics.configured.contentIdentityKey),
    occupancyUnionsTyped: occupancyUnionsTypedTitleEvidence(query),
    configuredFormCoverage: configuredFormCoverage(query, feature),
    originalSurfaceTokens: (query.originalSurface || []).filter(Boolean),
  };
  const rankingConcepts = rankingCoverageConcepts(query, query.concepts || []).filter(
    (concept) => !isSearchEquivalenceRecallConcept(query, concept)
  );
  const conceptBitByConcept = new Map<QueryConcept, number>();
  for (let i = 0; i < rankingConcepts.length; i++) {
    conceptBitByConcept.set(rankingConcepts[i], (1 << i) >>> 0);
  }
  const forms = formPlans(state, feature);
  const compiledActions = semanticActions(
    state,
    query,
    facts,
    rankingConcepts,
    conceptBitByConcept,
    forms
  );
  const qTokens = feature.nonStopNorm;
  const qLemmas = feature.nonStopLemma;
  const plan: RankingEvidencePlan = {
    static: state,
    query,
    facts,
    rankingConcepts,
    conceptBitByConcept,
    forms,
    exactTitleNorms: exactTitleNorms(query, feature),
    actions: compiledActions.actions,
    titleActionByPosting: compiledActions.titleActionByPosting,
    bodyActionByPosting: compiledActions.bodyActionByPosting,
    titleActionIds: compiledActions.titleActionIds,
    ordinaryTitleAdjacencySurface:
      qTokens.length >= 2
        ? compileSequence(state, qTokens, "prefix-surface")
        : null,
    ordinaryTitleAdjacencyLemma:
      qLemmas.length >= 2
        ? compileSequence(state, qLemmas, "prefix-lemma")
        : null,
    typedPhraseSurface:
      facts.originalSurfaceTokens.length >= 2
        ? compileSequence(
            state,
            facts.originalSurfaceTokens,
            "exact-surface"
          )
        : null,
    configuredKeySurface: feature.acronym?.id
      ? compileSequence(
          state,
          [feature.acronym.id],
          "exact-surface"
        )
      : null,
    configuredKeyLemma: feature.acronym?.id
      ? compileSequence(
          state,
          [feature.acronym.id],
          "exact-lemma"
        )
      : null,
    contextual: compileContextual(state, query),
    stats: compiledActions.stats,
    actionBytes: compiledActions.actionBytes,
  };
  return { eligible: true, reason: null, plan };
}
