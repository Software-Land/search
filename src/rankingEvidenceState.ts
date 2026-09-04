/**
 * Per-index immutable metadata and pooled per-query ranking-evidence scratch.
 *
 * Ordinal lookup uses separate generation stamps and slot columns. Nothing is
 * packed into a slot code, so candidate capacity is not limited by bit width.
 */
import {
  asCompactStore,
  compactOrdinal,
  type CompactDocumentStore,
} from "./compactDocuments.js";
import { ensureCompiledLexicalIndex, type CompiledLexicalRuntime } from "./lexicalIndex.js";
import { positionalIndexOf, type PositionalIndex } from "./positionalIndex.js";
import {
  RANKING_ACTION_CONFIGURED_KEY,
  RANKING_ACTION_EXACT_TITLE_TOKEN,
  RANKING_ACTION_TITLE_COVERAGE,
  RANKING_ACTION_TYPED_SURFACE,
  RANKING_EVIDENCE_BODY_FIELD,
  RANKING_EVIDENCE_NO_ACTION,
  RANKING_EVIDENCE_TITLE_FIELD,
  type RankingEvidenceAction,
  type RankingEvidenceFieldCode,
  type RankingEvidencePlan,
} from "./rankingEvidencePlan.js";
import { DEFAULT_STOP } from "./text.js";
import type {
  DirectClass,
  FeatureVector,
  QueryConcept,
  SearchIndex,
} from "./types.js";

type EvidenceTypedArray =
  | Uint8Array
  | Uint32Array
  | Int32Array
  | Float64Array;
type EvidenceTypedArrayConstructor<T extends EvidenceTypedArray> = new (length: number) => T;

function grow<T extends EvidenceTypedArray>(
  old: T,
  Ctor: EvidenceTypedArrayConstructor<T>,
  length: number
) {
  const out = new Ctor(length);
  out.set(old as never);
  return out;
}

function bytes(arrays: readonly EvidenceTypedArray[]) {
  let total = 0;
  for (const array of arrays) total += array.byteLength;
  return total;
}

export type RankingEvidenceStatic = {
  readonly index: SearchIndex;
  readonly compiled: CompiledLexicalRuntime;
  readonly positional: PositionalIndex;
  readonly store: CompactDocumentStore;
  readonly documentCount: number;
  readonly positionTerms: readonly string[];
  readonly positionTermSet: ReadonlySet<string>;
  readonly positionTermsByLemma: ReadonlyMap<string, readonly string[]>;
  readonly positionLemmaKeys: readonly string[];
  readonly nonStopTitleLength: Uint32Array;
  readonly titleLength: Uint32Array;
  readonly dottedTitlePositions: Uint8Array;
  readonly staticBytes: number;
};

const staticCache = new WeakMap<SearchIndex, RankingEvidenceStatic>();

function createRankingEvidenceStatic(index: SearchIndex): RankingEvidenceStatic | null {
  const documents = index.documents || [];
  const first = documents[0];
  const store = first ? asCompactStore(first) : null;
  if (!store || store.n !== documents.length) return null;
  for (let ordinal = 0; ordinal < documents.length; ordinal++) {
    if (
      asCompactStore(documents[ordinal]) !== store ||
      compactOrdinal(documents[ordinal]) !== ordinal
    ) {
      return null;
    }
  }

  const documentCount = documents.length;
  const nonStopTitleLength = new Uint32Array(documentCount);
  const titleLength = new Uint32Array(documentCount);
  const dottedTitlePositions = new Uint8Array(store.titleIds.length);
  for (let ordinal = 0; ordinal < documentCount; ordinal++) {
    const start = store.titleOff[ordinal];
    const end = store.titleOff[ordinal + 1];
    titleLength[ordinal] = end - start;
    let nonStop = 0;
    for (let at = start; at < end; at++) {
      if (!DEFAULT_STOP.has(store.strings[store.titleIds[at]])) nonStop += 1;
    }
    nonStopTitleLength[ordinal] = nonStop;
    const dottedStart = store.dottedOff[ordinal];
    const dottedEnd = store.dottedOff[ordinal + 1];
    for (let at = dottedStart; at < dottedEnd; at++) {
      const position = store.dottedIdx[at];
      if (position < end - start) dottedTitlePositions[start + position] = 1;
    }
  }
  const compiled = ensureCompiledLexicalIndex(index);
  const positional = positionalIndexOf(index);
  const positionTermSet = new Set(compiled.sortedTerms);
  for (const field of ["title", "summary", "body"] as const) {
    for (const term of positional.fields[field].terms.keys()) positionTermSet.add(term);
  }
  const positionTerms = [...positionTermSet].sort();
  const mutableTermsByLemma = new Map<string, string[]>();
  for (const term of positionTerms) {
    const id = store.idOf.get(term);
    const lemma =
      id === undefined ? term : store.strings[store.lemmaOf[id]] || term;
    const row = mutableTermsByLemma.get(lemma);
    if (row) row.push(term);
    else mutableTermsByLemma.set(lemma, [term]);
  }
  const positionTermsByLemma = new Map<string, readonly string[]>();
  for (const [lemma, terms] of mutableTermsByLemma) {
    positionTermsByLemma.set(lemma, Object.freeze(terms));
  }
  const state: RankingEvidenceStatic = {
    index,
    compiled,
    positional,
    store,
    documentCount,
    positionTerms: Object.freeze(positionTerms),
    positionTermSet,
    positionTermsByLemma,
    positionLemmaKeys: Object.freeze([...positionTermsByLemma.keys()].sort()),
    nonStopTitleLength,
    titleLength,
    dottedTitlePositions,
    staticBytes:
      nonStopTitleLength.byteLength +
      titleLength.byteLength +
      dottedTitlePositions.byteLength,
  };
  return Object.freeze(state);
}

export function rankingEvidenceStaticFor(index: SearchIndex): RankingEvidenceStatic | null {
  const cached = staticCache.get(index);
  if (cached) return cached;
  const state = createRankingEvidenceStatic(index);
  if (state) staticCache.set(index, state);
  return state;
}

export type RankingEvidenceCounters = {
  actionTerms: number;
  actions: number;
  atomicActions: number;
  postingListsObserved: number;
  postingListsWithActions: number;
  postingEntriesObserved: number;
  postingEntriesScattered: number;
  postingPositionsObserved: number;
  actionExecutions: number;
  stage3AWrites: number;
  slots: number;
  capacityGrows: number;
  positionalLookups: number;
  positionalComparisons: number;
  candidateTitleLookups: number;
  bodyScanCalls: number;
  bodyTokenCells: number;
  bodyScanMs: number;
  lexicalFrequencyLookups: number;
};

export type RankingEvidenceMemory = {
  staticBytes: number;
  planBytes: number;
  sessionBytes: number;
  evidenceBytes: number;
  finalizedBytes: number;
  retainedBytes: number;
  peakBytes: number;
};

export const RANKING_EVIDENCE_FLAG_EXACT_TITLE = 1 << 0;
export const RANKING_EVIDENCE_FLAG_EXACT_TITLE_TOKEN = 1 << 1;
export const RANKING_EVIDENCE_FLAG_TYPED_SURFACE = 1 << 2;
export const RANKING_EVIDENCE_FLAG_CONFIGURED_TITLE_KEY = 1 << 3;
export const RANKING_EVIDENCE_FLAG_CONFIGURED_BODY_KEY = 1 << 4;

export const RANKING_FINAL_EXACT_TITLE = 1 << 0;
export const RANKING_FINAL_EXACT_TITLE_TOKEN = 1 << 1;
export const RANKING_FINAL_TYPED_SURFACE = 1 << 2;
export const RANKING_FINAL_CONTEXTUAL = 1 << 3;
export const RANKING_FINAL_MORPHOLOGY = 1 << 4;
export const RANKING_FINAL_CONFIGURED_FORM_BODY = 1 << 5;
export const RANKING_FINAL_CANONICAL_KEY_TITLE = 1 << 6;
export const RANKING_FINAL_EXACT_TITLE_OR_SUMMARY_PHRASE = 1 << 7;

function emptyCounters(plan: RankingEvidencePlan): RankingEvidenceCounters {
  return {
    actionTerms: plan.stats.actionTerms,
    actions: plan.stats.actions,
    atomicActions: plan.stats.atomicActions,
    postingListsObserved: 0,
    postingListsWithActions: 0,
    postingEntriesObserved: 0,
    postingEntriesScattered: 0,
    postingPositionsObserved: 0,
    actionExecutions: 0,
    stage3AWrites: 0,
    slots: 0,
    capacityGrows: 0,
    positionalLookups: 0,
    positionalComparisons: 0,
    candidateTitleLookups: 0,
    bodyScanCalls: 0,
    bodyTokenCells: 0,
    bodyScanMs: 0,
    lexicalFrequencyLookups: 0,
  };
}

function createReusableScalar(): FeatureVector {
  return {
    exactTitleMatch: false,
    exactTitleTokenMatch: false,
    typedSurfaceTitleMatch: false,
    titleCoverage: 0,
    queryCoverage: 0,
    titlePrefixQuality: 0,
    contextualTitlePrefix: false,
    matchedPrefixTokens: [],
    activeFinalPrefix: null,
    completedTitleToken: null,
    unmatchedTitleTokensAfter: 0,
    titleSequenceTightness: 0,
    contextualPrefixQuality: 0,
    configuredConceptMatch: false,
    configuredConceptFieldEvidence: {
      title: false,
      summary: false,
      body: false,
    },
    morphologyMatch: false,
    typoDistance: 0,
    versionMatch: false,
    shortLiteralLeadMatch: false,
    dottedSpanComponentTitleMatch: false,
    phraseAdjacency: 0,
    bodyLexicalMatch: 0,
    lexicalConceptCoverage: 0,
    coverageConceptCount: 0,
    ordinaryEquivalenceBodyMatch: false,
    titleTokenCount: 0,
    configuredFormEvidence: 0,
    configuredFormCoverage: 0,
    configuredFormBodyMatch: false,
    canonicalKeyTitle: false,
    queryTokenCount: 0,
    normalizedQueryPhrase: "",
    matchingPhraseKey: null,
    bodyPhraseCount: 0,
    bodyPhraseFrequency: 0,
    titlePhraseFrequency: 0,
    summaryPhraseFrequency: 0,
    exactTitleOrSummaryPhrase: false,
    relationshipStrength: 0,
    relationshipType: null,
    relationshipSourceId: null,
    retrievalScore: 0,
    configuredPrefixRecallScore: 0,
    relevanceKind: "direct",
    directClass: "none",
  };
}

export class RankingEvidenceSession {
  readonly static: RankingEvidenceStatic;
  readonly stampByOrdinal: Uint32Array;
  readonly slotByOrdinal: Uint32Array;
  readonly scalar: FeatureVector;
  configuredTitleSequenceScratch = new Uint8Array(0);
  configuredBodySequenceScratch = new Uint8Array(0);
  configuredContributesScratch = new Uint8Array(0);

  plan: RankingEvidencePlan | null = null;
  generation = 0;
  slots = 0;
  capacity = 0;
  finalizedCount = 0;
  finalizationVersion = 0;
  counters: RankingEvidenceCounters;

  ordinals = new Int32Array(0);
  evidenceFlags = new Uint32Array(0);
  titleConceptMask = new Uint32Array(0);
  bodyConceptMask = new Uint32Array(0);
  titleCoverageCount = new Uint32Array(0);
  ordinaryPrefixMask = new Uint32Array(0);
  typedPrefixMask = new Uint32Array(0);
  morphologySurfaceMask = new Uint32Array(0);
  morphologyLemmaMask = new Uint32Array(0);
  typoTier = new Uint8Array(0);
  titlePhraseFrequency = new Float64Array(0);
  summaryPhraseFrequency = new Float64Array(0);
  configuredTitleFieldMask = new Uint32Array(0);
  configuredTitleIndependentSurfaceMask = new Uint32Array(0);
  configuredBodyFieldMask = new Uint32Array(0);
  configuredTitleCoverageCount = new Uint32Array(0);
  configuredPrefixMask = new Uint32Array(0);

  finalOrdinals = new Int32Array(0);
  finalFlags = new Uint32Array(0);
  finalTitleCoverage = new Float64Array(0);
  finalQueryCoverage = new Float64Array(0);
  finalTitlePrefixQuality = new Float64Array(0);
  finalContextualPrefixQuality = new Float64Array(0);
  finalTitleSequenceTightness = new Float64Array(0);
  finalConfiguredFormEvidence = new Float64Array(0);
  finalConfiguredFormCoverage = new Float64Array(0);
  finalPhraseAdjacency = new Float64Array(0);
  finalBodyLexicalMatch = new Float64Array(0);
  finalLexicalConceptCoverage = new Float64Array(0);
  finalBodyPhraseCount = new Float64Array(0);
  finalBodyPhraseFrequency = new Float64Array(0);
  finalTitlePhraseFrequency = new Float64Array(0);
  finalSummaryPhraseFrequency = new Float64Array(0);
  finalRetrievalScore = new Float64Array(0);
  finalScore = new Float64Array(0);
  finalCoverageConceptCount = new Uint32Array(0);
  finalTitleTokenCount = new Uint32Array(0);
  finalQueryTokenCount = new Uint32Array(0);
  finalUnmatchedTitleTokensAfter = new Uint32Array(0);
  finalTypoDistance = new Uint8Array(0);
  finalConfiguredClass = new Uint8Array(0);
  finalFieldEvidence = new Uint8Array(0);
  finalDirectClass = new Uint8Array(0);
  finalContextualChoice = new Uint32Array(0);
  finalMatchingPhrase = new Uint32Array(0);

  private actionStamp = new Uint32Array(0);
  private actionCapacity = 0;
  private formStride = 0;
  private owner: RankingEvidenceSessionPool | null = null;
  private ownerEpoch = 0;
  private active = false;
  private peakBytesValue = 0;

  constructor(state: RankingEvidenceStatic) {
    this.static = state;
    this.stampByOrdinal = new Uint32Array(state.documentCount);
    this.slotByOrdinal = new Uint32Array(state.documentCount);
    this.scalar = createReusableScalar();
    this.counters = {
      actionTerms: 0,
      actions: 0,
      atomicActions: 0,
      postingListsObserved: 0,
      postingListsWithActions: 0,
      postingEntriesObserved: 0,
      postingEntriesScattered: 0,
      postingPositionsObserved: 0,
      actionExecutions: 0,
      stage3AWrites: 0,
      slots: 0,
      capacityGrows: 0,
      positionalLookups: 0,
      positionalComparisons: 0,
      candidateTitleLookups: 0,
      bodyScanCalls: 0,
      bodyTokenCells: 0,
      bodyScanMs: 0,
      lexicalFrequencyLookups: 0,
    };
  }

  private assertActive() {
    if (!this.active || !this.plan) {
      throw new Error("ranking evidence session is not acquired");
    }
    return this.plan;
  }

  assertQuery(query: object, index: SearchIndex) {
    const plan = this.assertActive();
    if (plan.query !== query || this.static.index !== index) {
      throw new Error("ranking evidence session query/index mismatch");
    }
  }

  private ensureActionCapacity(want: number) {
    if (want <= this.actionCapacity) return;
    let next = this.actionCapacity || 32;
    while (next < want) next *= 2;
    this.actionStamp = grow(this.actionStamp, Uint32Array, next);
    this.actionCapacity = next;
    this.refreshPeak();
  }

  private clearEvidenceSlot(slot: number) {
    this.evidenceFlags[slot] = 0;
    this.titleConceptMask[slot] = 0;
    this.bodyConceptMask[slot] = 0;
    this.titleCoverageCount[slot] = 0;
    this.ordinaryPrefixMask[slot] = 0;
    this.typedPrefixMask[slot] = 0;
    this.morphologySurfaceMask[slot] = 0;
    this.morphologyLemmaMask[slot] = 0;
    this.typoTier[slot] = 0;
    this.titlePhraseFrequency[slot] = 0;
    this.summaryPhraseFrequency[slot] = 0;
    const formCount = this.plan?.forms.length || 0;
    const start = slot * formCount;
    const end = start + formCount;
    this.configuredTitleFieldMask.fill(0, start, end);
    this.configuredTitleIndependentSurfaceMask.fill(0, start, end);
    this.configuredBodyFieldMask.fill(0, start, end);
    this.configuredTitleCoverageCount.fill(0, start, end);
    this.configuredPrefixMask.fill(0, start, end);
  }

  ensureCapacity(want: number) {
    if (want <= this.capacity) return;
    const plan = this.assertActive();
    let next = this.capacity || 64;
    while (next < want) next *= 2;
    const formLength = next * plan.forms.length;

    this.ordinals = grow(this.ordinals, Int32Array, next);
    this.evidenceFlags = grow(this.evidenceFlags, Uint32Array, next);
    this.titleConceptMask = grow(this.titleConceptMask, Uint32Array, next);
    this.bodyConceptMask = grow(this.bodyConceptMask, Uint32Array, next);
    this.titleCoverageCount = grow(this.titleCoverageCount, Uint32Array, next);
    this.ordinaryPrefixMask = grow(this.ordinaryPrefixMask, Uint32Array, next);
    this.typedPrefixMask = grow(this.typedPrefixMask, Uint32Array, next);
    this.morphologySurfaceMask = grow(this.morphologySurfaceMask, Uint32Array, next);
    this.morphologyLemmaMask = grow(this.morphologyLemmaMask, Uint32Array, next);
    this.typoTier = grow(this.typoTier, Uint8Array, next);
    this.titlePhraseFrequency = grow(this.titlePhraseFrequency, Float64Array, next);
    this.summaryPhraseFrequency = grow(this.summaryPhraseFrequency, Float64Array, next);
    this.configuredTitleFieldMask = grow(
      this.configuredTitleFieldMask,
      Uint32Array,
      formLength
    );
    this.configuredTitleIndependentSurfaceMask = grow(
      this.configuredTitleIndependentSurfaceMask,
      Uint32Array,
      formLength
    );
    this.configuredBodyFieldMask = grow(
      this.configuredBodyFieldMask,
      Uint32Array,
      formLength
    );
    this.configuredTitleCoverageCount = grow(
      this.configuredTitleCoverageCount,
      Uint32Array,
      formLength
    );
    this.configuredPrefixMask = grow(
      this.configuredPrefixMask,
      Uint32Array,
      formLength
    );

    this.finalOrdinals = grow(this.finalOrdinals, Int32Array, next);
    this.finalFlags = grow(this.finalFlags, Uint32Array, next);
    this.finalTitleCoverage = grow(this.finalTitleCoverage, Float64Array, next);
    this.finalQueryCoverage = grow(this.finalQueryCoverage, Float64Array, next);
    this.finalTitlePrefixQuality = grow(
      this.finalTitlePrefixQuality,
      Float64Array,
      next
    );
    this.finalContextualPrefixQuality = grow(
      this.finalContextualPrefixQuality,
      Float64Array,
      next
    );
    this.finalTitleSequenceTightness = grow(
      this.finalTitleSequenceTightness,
      Float64Array,
      next
    );
    this.finalConfiguredFormEvidence = grow(
      this.finalConfiguredFormEvidence,
      Float64Array,
      next
    );
    this.finalConfiguredFormCoverage = grow(
      this.finalConfiguredFormCoverage,
      Float64Array,
      next
    );
    this.finalPhraseAdjacency = grow(this.finalPhraseAdjacency, Float64Array, next);
    this.finalBodyLexicalMatch = grow(
      this.finalBodyLexicalMatch,
      Float64Array,
      next
    );
    this.finalLexicalConceptCoverage = grow(
      this.finalLexicalConceptCoverage,
      Float64Array,
      next
    );
    this.finalBodyPhraseCount = grow(
      this.finalBodyPhraseCount,
      Float64Array,
      next
    );
    this.finalBodyPhraseFrequency = grow(
      this.finalBodyPhraseFrequency,
      Float64Array,
      next
    );
    this.finalTitlePhraseFrequency = grow(
      this.finalTitlePhraseFrequency,
      Float64Array,
      next
    );
    this.finalSummaryPhraseFrequency = grow(
      this.finalSummaryPhraseFrequency,
      Float64Array,
      next
    );
    this.finalRetrievalScore = grow(this.finalRetrievalScore, Float64Array, next);
    this.finalScore = grow(this.finalScore, Float64Array, next);
    this.finalCoverageConceptCount = grow(
      this.finalCoverageConceptCount,
      Uint32Array,
      next
    );
    this.finalTitleTokenCount = grow(
      this.finalTitleTokenCount,
      Uint32Array,
      next
    );
    this.finalQueryTokenCount = grow(
      this.finalQueryTokenCount,
      Uint32Array,
      next
    );
    this.finalUnmatchedTitleTokensAfter = grow(
      this.finalUnmatchedTitleTokensAfter,
      Uint32Array,
      next
    );
    this.finalTypoDistance = grow(this.finalTypoDistance, Uint8Array, next);
    this.finalConfiguredClass = grow(this.finalConfiguredClass, Uint8Array, next);
    this.finalFieldEvidence = grow(this.finalFieldEvidence, Uint8Array, next);
    this.finalDirectClass = grow(this.finalDirectClass, Uint8Array, next);
    this.finalContextualChoice = grow(
      this.finalContextualChoice,
      Uint32Array,
      next
    );
    this.finalMatchingPhrase = grow(this.finalMatchingPhrase, Uint32Array, next);

    this.capacity = next;
    this.counters.capacityGrows += 1;
    this.refreshPeak();
  }

  touchOrdinal(ordinal: number) {
    this.assertActive();
    if (
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= this.static.documentCount
    ) {
      throw new RangeError(`invalid ranking evidence ordinal ${ordinal}`);
    }
    if (this.stampByOrdinal[ordinal] === this.generation) {
      return this.slotByOrdinal[ordinal];
    }
    const slot = this.slots;
    this.ensureCapacity(slot + 1);
    this.slots += 1;
    this.stampByOrdinal[ordinal] = this.generation;
    this.slotByOrdinal[ordinal] = slot;
    this.ordinals[slot] = ordinal;
    this.clearEvidenceSlot(slot);
    this.counters.slots = this.slots;
    return slot;
  }

  existingSlot(ordinal: number) {
    if (
      ordinal < 0 ||
      ordinal >= this.static.documentCount ||
      this.stampByOrdinal[ordinal] !== this.generation
    ) {
      return -1;
    }
    return this.slotByOrdinal[ordinal];
  }

  markExactTitle(ordinal: number) {
    const plan = this.assertActive();
    if (!plan.exactTitleNorms.has(this.static.store.normalizedTitles[ordinal] || "")) {
      return;
    }
    const slot = this.touchOrdinal(ordinal);
    this.evidenceFlags[slot] |= RANKING_EVIDENCE_FLAG_EXACT_TITLE;
  }

  admitCandidate(ordinal: number) {
    this.touchOrdinal(ordinal);
  }

  actionIdForPosting(field: RankingEvidenceFieldCode, posting: number[]) {
    const plan = this.assertActive();
    return (
      (field === RANKING_EVIDENCE_TITLE_FIELD
        ? plan.titleActionByPosting.get(posting)
        : plan.bodyActionByPosting.get(posting)) || RANKING_EVIDENCE_NO_ACTION
    );
  }

  /**
   * Called once after retrieval duplicate suppression. Returns zero when the
   * list has no semantic action or this exact identity was already scattered.
   */
  beginPostingList(
    field: RankingEvidenceFieldCode,
    posting: number[],
    df: number
  ) {
    this.counters.postingListsObserved += 1;
    this.counters.postingEntriesObserved += Math.max(0, df || 0);
    const actionId = this.actionIdForPosting(field, posting);
    if (!actionId) return RANKING_EVIDENCE_NO_ACTION;
    if (this.actionStamp[actionId] === this.generation) {
      return RANKING_EVIDENCE_NO_ACTION;
    }
    this.actionStamp[actionId] = this.generation;
    this.counters.postingListsWithActions += 1;
    return actionId;
  }

  isTitleActionWalked(actionId: number) {
    return this.actionStamp[actionId] === this.generation;
  }

  conceptMaskFor(concept: QueryConcept) {
    return this.assertActive().conceptBitByConcept.get(concept) || 0;
  }

  writeStage3AConceptMask(ordinal: number, conceptMask: number) {
    if (!conceptMask) return;
    const slot = this.touchOrdinal(ordinal);
    this.bodyConceptMask[slot] |= conceptMask;
    this.counters.stage3AWrites += 1;
    this.counters.actionExecutions += 1;
  }

  private action(actionId: number, field: RankingEvidenceFieldCode) {
    const action = this.assertActive().actions[actionId];
    if (!action || action.field !== field || !actionId) {
      throw new Error(`invalid ranking evidence action ${actionId}`);
    }
    return action;
  }

  private applyTitlePosition(
    slot: number,
    ordinal: number,
    position: number,
    action: RankingEvidenceAction
  ) {
    const global = this.static.store.titleOff[ordinal] + position;
    const independent = this.static.dottedTitlePositions[global] === 0;
    this.titleConceptMask[slot] |= action.conceptMask;
    this.morphologySurfaceMask[slot] |= action.morphologySurfaceMask;
    this.morphologyLemmaMask[slot] |= action.morphologyLemmaMask;
    if (action.typoTier > this.typoTier[slot]) this.typoTier[slot] = action.typoTier;
    if (action.flags & RANKING_ACTION_CONFIGURED_KEY) {
      this.evidenceFlags[slot] |= RANKING_EVIDENCE_FLAG_CONFIGURED_TITLE_KEY;
    }
    const formCount = this.plan?.forms.length || 0;
    for (let formIndex = 0; formIndex < formCount; formIndex++) {
      const at = slot * formCount + formIndex;
      this.configuredTitleFieldMask[at] |=
        action.configuredFieldMask[formIndex] || 0;
      if (independent) {
        this.configuredTitleIndependentSurfaceMask[at] |=
          action.configuredIndependentSurfaceMask[formIndex] || 0;
        this.configuredPrefixMask[at] |=
          action.configuredPrefixMask[formIndex] || 0;
        if (action.configuredCoverageForms & (1 << formIndex)) {
          this.configuredTitleCoverageCount[at] += 1;
        }
      }
    }
    if (independent) {
      this.titleConceptMask[slot] |= action.independentConceptMask;
      if (action.flags & RANKING_ACTION_EXACT_TITLE_TOKEN) {
        this.evidenceFlags[slot] |= RANKING_EVIDENCE_FLAG_EXACT_TITLE_TOKEN;
      }
      if (action.flags & RANKING_ACTION_TYPED_SURFACE) {
        this.evidenceFlags[slot] |= RANKING_EVIDENCE_FLAG_TYPED_SURFACE;
      }
      if (action.flags & RANKING_ACTION_TITLE_COVERAGE) {
        this.titleCoverageCount[slot] += 1;
      }
      this.ordinaryPrefixMask[slot] |= action.ordinaryPrefixMask;
      this.typedPrefixMask[slot] |= action.typedPrefixMask;
    }
    this.counters.actionExecutions += action.atomicActions;
  }

  writeTitlePosting(
    actionId: number,
    ordinal: number,
    tf: number,
    flat: number[],
    positionsOffset: number
  ) {
    const action = this.action(actionId, RANKING_EVIDENCE_TITLE_FIELD);
    const slot = this.touchOrdinal(ordinal);
    this.counters.postingEntriesScattered += 1;
    this.counters.postingPositionsObserved += tf;
    for (let i = 0; i < tf; i++) {
      this.applyTitlePosition(slot, ordinal, flat[positionsOffset + i], action);
    }
  }

  writeTitlePosition(actionId: number, ordinal: number, position: number) {
    const action = this.action(actionId, RANKING_EVIDENCE_TITLE_FIELD);
    const slot = this.touchOrdinal(ordinal);
    this.applyTitlePosition(slot, ordinal, position, action);
  }

  writeBodyPosting(actionId: number, ordinal: number) {
    const action = this.action(actionId, RANKING_EVIDENCE_BODY_FIELD);
    const slot = this.touchOrdinal(ordinal);
    this.counters.postingEntriesScattered += 1;
    this.bodyConceptMask[slot] |= action.conceptMask;
    if (action.flags & RANKING_ACTION_CONFIGURED_KEY) {
      this.evidenceFlags[slot] |= RANKING_EVIDENCE_FLAG_CONFIGURED_BODY_KEY;
    }
    const formCount = this.plan?.forms.length || 0;
    for (let formIndex = 0; formIndex < formCount; formIndex++) {
      this.configuredBodyFieldMask[slot * formCount + formIndex] |=
        action.configuredFieldMask[formIndex] || 0;
    }
    this.counters.actionExecutions += action.atomicActions;
  }

  beginFinalization(candidateCount: number) {
    this.assertActive();
    this.ensureCapacity(candidateCount);
    this.finalizationVersion += 1;
    if (!Number.isSafeInteger(this.finalizationVersion)) {
      throw new Error("ranking evidence finalization version exhausted");
    }
    this.finalizedCount = candidateCount;
  }

  directClassCode(value: DirectClass) {
    if (value === "strong") return 3;
    if (value === "moderate") return 2;
    if (value === "weak") return 1;
    return 0;
  }

  memory(): RankingEvidenceMemory {
    const sessionBytes = bytes([
      this.stampByOrdinal,
      this.slotByOrdinal,
      this.actionStamp,
      this.configuredTitleSequenceScratch,
      this.configuredBodySequenceScratch,
      this.configuredContributesScratch,
    ]);
    const evidenceBytes = bytes([
      this.ordinals,
      this.evidenceFlags,
      this.titleConceptMask,
      this.bodyConceptMask,
      this.titleCoverageCount,
      this.ordinaryPrefixMask,
      this.typedPrefixMask,
      this.morphologySurfaceMask,
      this.morphologyLemmaMask,
      this.typoTier,
      this.titlePhraseFrequency,
      this.summaryPhraseFrequency,
      this.configuredTitleFieldMask,
      this.configuredTitleIndependentSurfaceMask,
      this.configuredBodyFieldMask,
      this.configuredTitleCoverageCount,
      this.configuredPrefixMask,
    ]);
    const finalizedBytes = bytes([
      this.finalOrdinals,
      this.finalFlags,
      this.finalTitleCoverage,
      this.finalQueryCoverage,
      this.finalTitlePrefixQuality,
      this.finalContextualPrefixQuality,
      this.finalTitleSequenceTightness,
      this.finalConfiguredFormEvidence,
      this.finalConfiguredFormCoverage,
      this.finalPhraseAdjacency,
      this.finalBodyLexicalMatch,
      this.finalLexicalConceptCoverage,
      this.finalBodyPhraseCount,
      this.finalBodyPhraseFrequency,
      this.finalTitlePhraseFrequency,
      this.finalSummaryPhraseFrequency,
      this.finalRetrievalScore,
      this.finalScore,
      this.finalCoverageConceptCount,
      this.finalTitleTokenCount,
      this.finalQueryTokenCount,
      this.finalUnmatchedTitleTokensAfter,
      this.finalTypoDistance,
      this.finalConfiguredClass,
      this.finalFieldEvidence,
      this.finalDirectClass,
      this.finalContextualChoice,
      this.finalMatchingPhrase,
    ]);
    const planBytes = this.plan?.actionBytes || 0;
    return {
      staticBytes: this.static.staticBytes,
      planBytes,
      sessionBytes,
      evidenceBytes,
      finalizedBytes,
      retainedBytes: this.owner?.retainedBytes() || 0,
      peakBytes: Math.max(
        this.peakBytesValue,
        this.static.staticBytes + planBytes + sessionBytes + evidenceBytes + finalizedBytes
      ),
    };
  }

  allocatedBytes() {
    const memory = this.memory();
    return memory.sessionBytes + memory.evidenceBytes + memory.finalizedBytes;
  }

  private refreshPeak() {
    const memory = this.memory();
    const current =
      memory.staticBytes +
      memory.planBytes +
      memory.sessionBytes +
      memory.evidenceBytes +
      memory.finalizedBytes;
    if (current > this.peakBytesValue) this.peakBytesValue = current;
  }

  _activate(
    plan: RankingEvidencePlan,
    owner: RankingEvidenceSessionPool,
    ownerEpoch: number
  ) {
    if (this.active) throw new Error("ranking evidence session already acquired");
    if (plan.static !== this.static) {
      throw new Error("ranking evidence session static metadata mismatch");
    }
    let generation = (this.generation + 1) >>> 0;
    if (generation === 0) {
      this.stampByOrdinal.fill(0);
      this.actionStamp.fill(0);
      generation = 1;
    }
    this.generation = generation;
    this.plan = plan;
    this.owner = owner;
    this.ownerEpoch = ownerEpoch;
    this.active = true;
    this.slots = 0;
    this.finalizedCount = 0;
    this.finalizationVersion = 0;
    this.counters = emptyCounters(plan);
    if (this.formStride !== plan.forms.length) {
      const formLength = this.capacity * plan.forms.length;
      this.configuredTitleFieldMask = new Uint32Array(formLength);
      this.configuredTitleIndependentSurfaceMask = new Uint32Array(formLength);
      this.configuredBodyFieldMask = new Uint32Array(formLength);
      this.configuredTitleCoverageCount = new Uint32Array(formLength);
      this.configuredPrefixMask = new Uint32Array(formLength);
      this.configuredTitleSequenceScratch = new Uint8Array(plan.forms.length);
      this.configuredBodySequenceScratch = new Uint8Array(plan.forms.length);
      this.configuredContributesScratch = new Uint8Array(plan.forms.length);
      this.formStride = plan.forms.length;
      if (this.capacity) this.counters.capacityGrows += 1;
    }
    this.ensureActionCapacity(plan.actions.length);
    this.refreshPeak();
  }

  _deactivate() {
    this.active = false;
    this.plan = null;
    this.owner = null;
    this.ownerEpoch = 0;
    this.slots = 0;
    this.finalizedCount = 0;
  }

  _isOwnedBy(owner: RankingEvidenceSessionPool) {
    return this.owner === owner && this.active;
  }

  _epoch() {
    return this.ownerEpoch;
  }

  release() {
    if (!this.owner) throw new Error("ranking evidence session is not acquired");
    this.owner.release(this);
  }

  abort() {
    if (!this.owner) throw new Error("ranking evidence session is not acquired");
    this.owner.abort(this);
  }

  reset() {
    this.release();
  }
}

export type RankingEvidencePoolMemory = {
  staticBytes: number;
  idleSessionBytes: number;
  retainedBytes: number;
  activeSessions: number;
};

export class RankingEvidenceSessionPool {
  private currentIndex: SearchIndex | null = null;
  private currentStatic: RankingEvidenceStatic | null = null;
  private idle: RankingEvidenceSession | null = null;
  private active = new Set<RankingEvidenceSession>();
  private epoch = 1;

  acquire(plan: RankingEvidencePlan) {
    const state = plan.static;
    if (this.currentIndex !== state.index) {
      this.epoch = (this.epoch + 1) >>> 0 || 1;
      this.idle?._deactivate();
      this.idle = null;
      this.currentIndex = state.index;
      this.currentStatic = state;
    }
    let session = this.idle;
    this.idle = null;
    if (!session || session.static !== state) session = new RankingEvidenceSession(state);
    this.active.add(session);
    session._activate(plan, this, this.epoch);
    return session;
  }

  release(session: RankingEvidenceSession) {
    if (!session._isOwnedBy(this) || !this.active.delete(session)) {
      throw new Error("ranking evidence session does not belong to this pool");
    }
    const retain =
      session._epoch() === this.epoch &&
      session.static === this.currentStatic;
    const releasedBytes = session.allocatedBytes();
    session._deactivate();
    if (!retain) return;
    if (!this.idle || releasedBytes > this.idle.allocatedBytes()) {
      this.idle?._deactivate();
      this.idle = session;
    }
  }

  abort(session: RankingEvidenceSession) {
    if (!session._isOwnedBy(this) || !this.active.delete(session)) {
      throw new Error("ranking evidence session does not belong to this pool");
    }
    session._deactivate();
  }

  reset() {
    this.epoch = (this.epoch + 1) >>> 0 || 1;
    this.idle?._deactivate();
    this.idle = null;
    this.currentIndex = null;
    this.currentStatic = null;
  }

  memory(): RankingEvidencePoolMemory {
    const staticBytes = this.currentStatic?.staticBytes || 0;
    const idleSessionBytes = this.idle?.allocatedBytes() || 0;
    return {
      staticBytes,
      idleSessionBytes,
      retainedBytes: staticBytes + idleSessionBytes,
      activeSessions: this.active.size,
    };
  }

  retainedBytes() {
    return this.memory().retainedBytes;
  }
}
