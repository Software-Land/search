/**
 * Numeric finalization for retrieval-fused ranking evidence.
 *
 * Production finalization mutates one reusable scalar view on the session,
 * then delegates direct classification and scoring to the authoritative
 * implementations. It never allocates a FeatureVector per candidate.
 */
import { compactOrdinal } from "./compactDocuments.js";
import { queryHasTypedConfiguredGraph } from "./configuredFormGraph.js";
import { classifyDirect } from "./features.js";
import { scoreFeatures } from "./rank.js";
import {
  type RankingEvidencePlan,
  type RankingEvidenceSequencePlan,
} from "./rankingEvidencePlan.js";
import {
  RANKING_EVIDENCE_FLAG_CONFIGURED_BODY_KEY,
  RANKING_EVIDENCE_FLAG_CONFIGURED_TITLE_KEY,
  RANKING_EVIDENCE_FLAG_EXACT_TITLE,
  RANKING_EVIDENCE_FLAG_EXACT_TITLE_TOKEN,
  RANKING_EVIDENCE_FLAG_TYPED_SURFACE,
  RANKING_FINAL_CANONICAL_KEY_TITLE,
  RANKING_FINAL_CONFIGURED_FORM_BODY,
  RANKING_FINAL_CONTEXTUAL,
  RANKING_FINAL_EXACT_TITLE,
  RANKING_FINAL_EXACT_TITLE_OR_SUMMARY_PHRASE,
  RANKING_FINAL_EXACT_TITLE_TOKEN,
  RANKING_FINAL_MORPHOLOGY,
  RANKING_FINAL_TYPED_SURFACE,
  RankingEvidenceSession,
  type RankingEvidenceCounters,
  type RankingEvidenceMemory,
} from "./rankingEvidenceState.js";
import { saturatingFrequency } from "./saturatingFrequency.js";
import { DEFAULT_STOP } from "./text.js";
import type {
  DirectClass,
  FeatureVector,
  RetrievalHit,
} from "./types.js";
import type { PhraseField } from "./positionalIndex.js";
import type { QueryPlan } from "./queryPlan.js";

const TWO_THIRDS = 2 / 3;
const EMPTY_MATCHED_PREFIX_TOKENS: string[] = [];

function popcount32(value: number) {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function ratioQ4(numerator: number, denominator: number) {
  if (!numerator || !denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function prefixQuality(bits: number, norms: readonly string[], titleTokenCount: number) {
  if (!bits || !norms.length) return 0;
  let matched = 0;
  let prefixChars = 0;
  let titleChars = 0;
  for (let i = 0; i < norms.length; i++) {
    const value = norms[i];
    titleChars += value.length;
    if (bits & (1 << i)) {
      matched += 1;
      prefixChars += value.length;
    }
  }
  const coverage = matched / norms.length;
  const completeness = titleChars ? prefixChars / titleChars : 0;
  const tightness = norms.length / Math.max(titleTokenCount, 1);
  return Number(
    (0.5 * coverage + 0.3 * completeness + 0.2 * Math.min(1, tightness)).toFixed(4)
  );
}

function singletonIsEntireNonStopTitle(
  session: RankingEvidenceSession,
  ordinal: number,
  token: string
) {
  const store = session.static.store;
  const start = store.titleOff[ordinal];
  const end = store.titleOff[ordinal + 1];
  let seen = 0;
  for (let at = start; at < end; at++) {
    const value = store.strings[store.titleIds[at]];
    if (DEFAULT_STOP.has(value)) continue;
    seen += 1;
    if (value !== token) return false;
  }
  return seen > 0;
}

function hasPosition(
  session: RankingEvidenceSession,
  positions: readonly number[],
  want: number
) {
  if (positions.length <= 8) {
    for (let i = 0; i < positions.length; i++) {
      session.counters.positionalComparisons += 1;
      if (positions[i] === want) return true;
    }
    return false;
  }
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    session.counters.positionalComparisons += 1;
    const mid = (lo + hi) >> 1;
    if (positions[mid] < want) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= positions.length) return false;
  session.counters.positionalComparisons += 1;
  return positions[lo] === want;
}

function sequenceFrequency(
  session: RankingEvidenceSession,
  ordinal: number,
  field: PhraseField,
  sequence: RankingEvidenceSequencePlan | null
) {
  const summaryLemmaRows =
    field === "summary" ? sequence?.summaryLemmaRows : null;
  const rows = summaryLemmaRows || sequence?.rows;
  if (!rows?.length || rows.some((row) => row.length === 0)) return 0;
  if (summaryLemmaRows) {
    session.counters.positionalLookups += 1;
    const values = session.static.store.summaryLemmaRows?.[ordinal] || [];
    let count = 0;
    for (let start = 0; start <= values.length - rows.length; start++) {
      let matches = true;
      for (let tokenIndex = 0; tokenIndex < rows.length; tokenIndex++) {
        let found = false;
        for (const term of rows[tokenIndex]) {
          session.counters.positionalComparisons += 1;
          if (values[start + tokenIndex] === term) {
            found = true;
            break;
          }
        }
        if (!found) {
          matches = false;
          break;
        }
      }
      if (matches) count += 1;
    }
    return count;
  }
  const inverted = session.static.positional.fields[field].terms;
  let count = 0;
  for (const firstTerm of rows[0]) {
    session.counters.positionalLookups += 1;
    const starts = inverted.get(firstTerm)?.byDoc.get(ordinal);
    if (!starts) continue;
    for (const start of starts) {
      let matches = true;
      for (let tokenIndex = 1; tokenIndex < rows.length; tokenIndex++) {
        let found = false;
        for (const term of rows[tokenIndex]) {
          session.counters.positionalLookups += 1;
          const positions = inverted.get(term)?.byDoc.get(ordinal);
          if (positions && hasPosition(session, positions, start + tokenIndex)) {
            found = true;
            break;
          }
        }
        if (!found) {
          matches = false;
          break;
        }
      }
      if (matches) count += 1;
    }
  }
  return count;
}

function exactSequence(
  session: RankingEvidenceSession,
  ordinal: number,
  field: PhraseField,
  surface: RankingEvidenceSequencePlan,
  lemma: RankingEvidenceSequencePlan
) {
  return (
    sequenceFrequency(session, ordinal, field, surface) > 0 ||
    sequenceFrequency(session, ordinal, field, lemma) > 0
  );
}

function positionalTermAt(
  session: RankingEvidenceSession,
  ordinal: number,
  field: PhraseField,
  term: string,
  position: number
) {
  session.counters.positionalLookups += 1;
  const positions = session.static.positional.fields[field].terms
    .get(term)
    ?.byDoc.get(ordinal);
  return Boolean(positions && hasPosition(session, positions, position));
}

function fieldTokenMatch(queryToken: string, term: string) {
  if (!queryToken || !term) return false;
  if (/^\d+$/.test(queryToken) || /^\d+$/.test(term)) return queryToken === term;
  return term === queryToken || term.startsWith(queryToken);
}

function scanBodySequence(
  session: RankingEvidenceSession,
  ordinal: number,
  tokens: readonly string[],
  asLemma: boolean
) {
  session.counters.bodyScanCalls += 1;
  const store = session.static.store;
  const start = store.bodyOff[ordinal];
  const end = store.bodyOff[ordinal + 1];
  const last = end - tokens.length;
  for (let at = start; at <= last; at++) {
    let matches = true;
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      session.counters.bodyTokenCells += 1;
      const surface = store.bodyIds[at + tokenIndex];
      const id = asLemma ? store.lemmaOf[surface] : surface;
      if (!fieldTokenMatch(tokens[tokenIndex], store.strings[id])) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function bodyAdjacent(
  session: RankingEvidenceSession,
  ordinal: number,
  surface: readonly string[],
  lemma: readonly string[]
) {
  const started = performance.now();
  try {
    return (
      scanBodySequence(session, ordinal, surface, false) ||
      scanBodySequence(session, ordinal, lemma, true)
    );
  } finally {
    session.counters.bodyScanMs += performance.now() - started;
  }
}

function ordinalOf(hit: RetrievalHit, fallback: number) {
  if (typeof hit.documentOrdinal === "number") return hit.documentOrdinal;
  const storeOrdinal = compactOrdinal(hit.document);
  return Number.isInteger(storeOrdinal) ? storeOrdinal : fallback;
}

function applyQueryPlan(
  session: RankingEvidenceSession,
  hits: readonly RetrievalHit[],
  queryPlan: QueryPlan | null
) {
  const plan = session.plan as RankingEvidencePlan;
  if (
    !queryPlan ||
    plan.facts.originalSurfaceTokens.length < 2 ||
    queryHasTypedConfiguredGraph(plan.query)
  ) {
    return false;
  }
  for (const hit of queryPlan.exactHits || []) {
    const ordinal = compactOrdinal(hit.document);
    const slot = session.existingSlot(ordinal);
    if (slot < 0) continue;
    session.titlePhraseFrequency[slot] = hit.titleFrequency || 0;
    session.summaryPhraseFrequency[slot] = hit.summaryFrequency || 0;
  }
  // The return value means candidate misses are authoritative zeros; callers
  // need not repeat the typed positional query.
  return true;
}

function applyUnwalkedTitleActions(
  session: RankingEvidenceSession,
  hits: readonly RetrievalHit[]
) {
  // Retrieval does not walk every low-frequency title term that can carry
  // typo/morphology evidence. Refine only retrieved ordinals through the
  // positional by-document map; never iterate the posting payload a second
  // time. Coalesced posting identities have one representative term.
  const plan = session.plan as RankingEvidencePlan;
  const title = session.static.positional.fields.title.terms;
  for (const actionId of plan.titleActionIds) {
    if (session.isTitleActionWalked(actionId)) continue;
    const action = plan.actions[actionId];
    const byDoc = title.get(action.representativeTerm)?.byDoc;
    if (!byDoc) continue;
    for (let candidate = 0; candidate < hits.length; candidate++) {
      const ordinal = ordinalOf(hits[candidate], candidate);
      session.counters.candidateTitleLookups += 1;
      session.counters.positionalLookups += 1;
      const positions = byDoc.get(ordinal);
      if (!positions) continue;
      for (const position of positions) {
        session.writeTitlePosition(actionId, ordinal, position);
      }
    }
  }
}

function contextualChoice(session: RankingEvidenceSession, ordinal: number) {
  const plan = session.plan as RankingEvidencePlan;
  const contextual = plan.contextual;
  if (!contextual) return 0;
  const queryTokens = plan.query.tokens || [];
  const titleLength = session.static.titleLength[ordinal];
  if (queryTokens.length > titleLength || titleLength < 2) return 0;
  for (let tokenIndex = 0; tokenIndex < contextual.preceding.length; tokenIndex++) {
    let found = false;
    for (const term of contextual.preceding[tokenIndex]) {
      if (positionalTermAt(session, ordinal, "title", term, tokenIndex)) {
        found = true;
        break;
      }
    }
    if (!found) return 0;
  }
  const finalPosition = queryTokens.length - 1;
  for (let choice = 0; choice < contextual.final.length; choice++) {
    if (
      positionalTermAt(
        session,
        ordinal,
        "title",
        contextual.final[choice].term,
        finalPosition
      )
    ) {
      return choice + 1;
    }
  }
  return 0;
}

function configuredClassCode(value: FeatureVector["configuredConceptMatch"]) {
  if (value === "key-in-title") return 2;
  if (value === "form") return 1;
  return 0;
}

function evidenceCode(value: false | "key" | "form") {
  if (value === "key") return 2;
  if (value === "form") return 1;
  return 0;
}

function packFieldEvidence(
  evidence: FeatureVector["configuredConceptFieldEvidence"]
) {
  return (
    evidenceCode(evidence.title) |
    (evidenceCode(evidence.summary) << 2) |
    (evidenceCode(evidence.body) << 4)
  );
}

function fieldEvidenceFromCode(code: number): false | "key" | "form" {
  if (code === 2) return "key";
  if (code === 1) return "form";
  return false;
}

function directClassFromCode(code: number): DirectClass {
  if (code === 3) return "strong";
  if (code === 2) return "moderate";
  if (code === 1) return "weak";
  return "none";
}

function configuredFields(
  session: RankingEvidenceSession,
  slot: number,
  ordinal: number,
  titleSequences: Uint8Array,
  bodySequences: Uint8Array,
  contributes: Uint8Array
) {
  const plan = session.plan as RankingEvidencePlan;
  const scalar = session.scalar;
  const evidenceFlags = session.evidenceFlags[slot];
  let title: false | "key" | "form" =
    evidenceFlags & RANKING_EVIDENCE_FLAG_CONFIGURED_TITLE_KEY ? "key" : false;
  let summary: false | "key" | "form" = false;
  let body: false | "key" | "form" =
    evidenceFlags & RANKING_EVIDENCE_FLAG_CONFIGURED_BODY_KEY ? "key" : false;
  titleSequences.fill(0);
  bodySequences.fill(0);
  contributes.fill(0);

  if (plan.facts.feature.acronym) {
    const summaryKey =
      sequenceFrequency(session, ordinal, "summary", plan.configuredKeySurface) > 0 ||
      sequenceFrequency(session, ordinal, "summary", plan.configuredKeyLemma) > 0;
    if (summaryKey) summary = "key";
  }

  const formCount = plan.forms.length;
  for (let formIndex = 0; formIndex < formCount; formIndex++) {
    const form = plan.forms[formIndex];
    const at = slot * formCount + formIndex;
    const titleSequence =
      form.tokens.length >= 2 &&
      exactSequence(
        session,
        ordinal,
        "title",
        form.exactSurface,
        form.exactLemma
      );
    const summarySequence =
      form.tokens.length >= 2 &&
      exactSequence(
        session,
        ordinal,
        "summary",
        form.exactSurface,
        form.exactLemma
      );
    const bodySequence =
      form.tokens.length >= 2 &&
      exactSequence(
        session,
        ordinal,
        "body",
        form.exactSurface,
        form.exactLemma
      );
    titleSequences[formIndex] = Number(titleSequence);
    bodySequences[formIndex] = Number(bodySequence);
    const independentSurfaceHits = popcount32(
      session.configuredTitleIndependentSurfaceMask[at]
    );
    const contributesTitle =
      form.tokens.length === 1
        ? independentSurfaceHits > 0
        : titleSequence || independentSurfaceHits >= 2;
    contributes[formIndex] = Number(contributesTitle);

    if (!title) {
      if (form.tokens.length === 1) {
        if (!form.singleMemberOfLonger && session.configuredTitleFieldMask[at]) {
          title = "form";
        }
      } else if (
        titleSequence ||
        (form.contentMask !== 0 &&
          (session.configuredTitleFieldMask[at] & form.contentMask) ===
            form.contentMask)
      ) {
        title = "form";
      }
    }
    if (!summary) {
      if (form.tokens.length === 1) {
        if (
          !form.singleMemberOfLonger &&
          (sequenceFrequency(session, ordinal, "summary", form.exactSurface) > 0 ||
            sequenceFrequency(session, ordinal, "summary", form.exactLemma) > 0)
        ) {
          summary = "form";
        }
      } else if (summarySequence) {
        summary = "form";
      }
    }
    if (!body) {
      if (form.tokens.length === 1) {
        if (!form.singleMemberOfLonger && session.configuredBodyFieldMask[at]) {
          body = "form";
        }
      } else if (bodySequence) {
        body = "form";
      }
    }
  }

  scalar.configuredConceptFieldEvidence.title = title;
  scalar.configuredConceptFieldEvidence.summary = summary;
  scalar.configuredConceptFieldEvidence.body = body;
  scalar.configuredConceptMatch =
    title === "key" ? "key-in-title" : title === "form" ? "form" : false;
}

function phraseAdjacency(
  session: RankingEvidenceSession,
  ordinal: number
) {
  const plan = session.plan as RankingEvidencePlan;
  if (plan.facts.occupied) {
    let bodyMatch = false;
    for (const form of plan.forms) {
      if (form.tokens.length < 2) continue;
      if (
        sequenceFrequency(session, ordinal, "title", form.adjacentSurface) > 0 ||
        sequenceFrequency(session, ordinal, "title", form.adjacentLemma) > 0
      ) {
        return 1;
      }
      if (bodyAdjacent(session, ordinal, form.tokens, form.tokens)) bodyMatch = true;
    }
    return bodyMatch ? 0.5 : 0;
  }
  if (!plan.ordinaryTitleAdjacencySurface) return 0;
  if (
    sequenceFrequency(
      session,
      ordinal,
      "title",
      plan.ordinaryTitleAdjacencySurface
    ) > 0 ||
    sequenceFrequency(
      session,
      ordinal,
      "title",
      plan.ordinaryTitleAdjacencyLemma
    ) > 0
  ) {
    return 1;
  }
  return bodyAdjacent(
    session,
    ordinal,
    plan.facts.feature.nonStopNorm,
    plan.facts.feature.nonStopLemma
  )
    ? 0.5
    : 0;
}

function writeCompiledPhrase(
  session: RankingEvidenceSession,
  ordinal: number
) {
  const plan = session.plan as RankingEvidencePlan;
  const frequencies = session.static.store.lexicalFrequency[ordinal];
  let count = 0;
  let matching = 0;
  const keys = plan.facts.feature.phraseKeys;
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const key = keys[keyIndex];
    session.counters.lexicalFrequencyLookups += 1;
    const value =
      key && frequencies && Number.isFinite(frequencies[key])
        ? Number(frequencies[key])
        : 0;
    if (
      value > count ||
      (value === count &&
        value > 0 &&
        matching !== 0 &&
        key < keys[matching - 1])
    ) {
      count = value;
      matching = keyIndex + 1;
    }
  }
  const scalar = session.scalar;
  scalar.normalizedQueryPhrase = plan.facts.feature.primaryPhrase;
  scalar.matchingPhraseKey =
    matching > 0 ? keys[matching - 1] : null;
  scalar.bodyPhraseCount = count;
  scalar.bodyPhraseFrequency = saturatingFrequency(count);
  return matching;
}

function resetScalarForCandidate(session: RankingEvidenceSession) {
  const scalar = session.scalar;
  scalar.exactTitleMatch = false;
  scalar.exactTitleTokenMatch = false;
  scalar.typedSurfaceTitleMatch = false;
  scalar.titleCoverage = 0;
  scalar.queryCoverage = 0;
  scalar.titlePrefixQuality = 0;
  scalar.contextualTitlePrefix = false;
  scalar.matchedPrefixTokens = EMPTY_MATCHED_PREFIX_TOKENS;
  scalar.activeFinalPrefix = null;
  scalar.completedTitleToken = null;
  scalar.unmatchedTitleTokensAfter = 0;
  scalar.titleSequenceTightness = 0;
  scalar.contextualPrefixQuality = 0;
  scalar.configuredConceptMatch = false;
  scalar.configuredConceptFieldEvidence.title = false;
  scalar.configuredConceptFieldEvidence.summary = false;
  scalar.configuredConceptFieldEvidence.body = false;
  scalar.morphologyMatch = false;
  scalar.typoDistance = 0;
  scalar.versionMatch = false;
  scalar.shortLiteralLeadMatch = false;
  scalar.dottedSpanComponentTitleMatch = false;
  scalar.phraseAdjacency = 0;
  scalar.bodyLexicalMatch = 0;
  scalar.lexicalConceptCoverage = 0;
  scalar.coverageConceptCount = 0;
  scalar.ordinaryEquivalenceBodyMatch = false;
  scalar.titleTokenCount = 0;
  scalar.configuredFormEvidence = 0;
  scalar.configuredFormCoverage = 0;
  scalar.configuredFormBodyMatch = false;
  scalar.canonicalKeyTitle = false;
  scalar.queryTokenCount = 0;
  scalar.normalizedQueryPhrase = "";
  scalar.matchingPhraseKey = null;
  scalar.bodyPhraseCount = 0;
  scalar.bodyPhraseFrequency = 0;
  scalar.titlePhraseFrequency = 0;
  scalar.summaryPhraseFrequency = 0;
  scalar.exactTitleOrSummaryPhrase = false;
  scalar.relationshipStrength = 0;
  scalar.relationshipType = null;
  scalar.relationshipSourceId = null;
  // PROD-1 is the exact zero-retrieval-weight evidence path.
  scalar.retrievalScore = 0;
  scalar.relevanceKind = "direct";
  scalar.directClass = "none";
  scalar.configuredPrefixRecallScore = 0;
  return scalar;
}

function encodeFinal(
  session: RankingEvidenceSession,
  candidate: number,
  ordinal: number,
  contextualCode: number,
  matchingPhraseCode: number,
  score: number
) {
  const scalar = session.scalar;
  let flags = 0;
  if (scalar.exactTitleMatch) flags |= RANKING_FINAL_EXACT_TITLE;
  if (scalar.exactTitleTokenMatch) flags |= RANKING_FINAL_EXACT_TITLE_TOKEN;
  if (scalar.typedSurfaceTitleMatch) flags |= RANKING_FINAL_TYPED_SURFACE;
  if (scalar.contextualTitlePrefix) flags |= RANKING_FINAL_CONTEXTUAL;
  if (scalar.morphologyMatch) flags |= RANKING_FINAL_MORPHOLOGY;
  if (scalar.configuredFormBodyMatch) flags |= RANKING_FINAL_CONFIGURED_FORM_BODY;
  if (scalar.canonicalKeyTitle) flags |= RANKING_FINAL_CANONICAL_KEY_TITLE;
  if (scalar.exactTitleOrSummaryPhrase) {
    flags |= RANKING_FINAL_EXACT_TITLE_OR_SUMMARY_PHRASE;
  }
  session.finalOrdinals[candidate] = ordinal;
  session.finalFlags[candidate] = flags;
  session.finalTitleCoverage[candidate] = scalar.titleCoverage;
  session.finalQueryCoverage[candidate] = scalar.queryCoverage;
  session.finalTitlePrefixQuality[candidate] = scalar.titlePrefixQuality;
  session.finalContextualPrefixQuality[candidate] = scalar.contextualPrefixQuality;
  session.finalTitleSequenceTightness[candidate] = scalar.titleSequenceTightness;
  session.finalConfiguredFormEvidence[candidate] = scalar.configuredFormEvidence;
  session.finalConfiguredFormCoverage[candidate] = scalar.configuredFormCoverage;
  session.finalPhraseAdjacency[candidate] = scalar.phraseAdjacency;
  session.finalBodyLexicalMatch[candidate] = scalar.bodyLexicalMatch;
  session.finalLexicalConceptCoverage[candidate] = scalar.lexicalConceptCoverage;
  session.finalBodyPhraseCount[candidate] = scalar.bodyPhraseCount;
  session.finalBodyPhraseFrequency[candidate] = scalar.bodyPhraseFrequency;
  session.finalTitlePhraseFrequency[candidate] = scalar.titlePhraseFrequency;
  session.finalSummaryPhraseFrequency[candidate] = scalar.summaryPhraseFrequency;
  session.finalRetrievalScore[candidate] = scalar.retrievalScore;
  session.finalScore[candidate] = score;
  session.finalCoverageConceptCount[candidate] = scalar.coverageConceptCount;
  session.finalTitleTokenCount[candidate] = scalar.titleTokenCount;
  session.finalQueryTokenCount[candidate] = scalar.queryTokenCount;
  session.finalUnmatchedTitleTokensAfter[candidate] =
    scalar.unmatchedTitleTokensAfter;
  session.finalTypoDistance[candidate] = scalar.typoDistance;
  session.finalConfiguredClass[candidate] = configuredClassCode(
    scalar.configuredConceptMatch
  );
  session.finalFieldEvidence[candidate] = packFieldEvidence(
    scalar.configuredConceptFieldEvidence
  );
  session.finalDirectClass[candidate] = session.directClassCode(scalar.directClass);
  session.finalContextualChoice[candidate] = contextualCode;
  session.finalMatchingPhrase[candidate] = matchingPhraseCode;
}

function finalizeCandidate(
  session: RankingEvidenceSession,
  hit: RetrievalHit,
  candidate: number,
  ordinal: number,
  planPhraseGeometry: boolean,
  titleSequences: Uint8Array,
  bodySequences: Uint8Array,
  contributes: Uint8Array
) {
  const plan = session.plan as RankingEvidencePlan;
  const slot = session.existingSlot(ordinal);
  if (slot < 0) throw new Error(`ranking evidence missing candidate ordinal ${ordinal}`);
  const scalar = resetScalarForCandidate(session);
  const titleTokenCount = session.static.nonStopTitleLength[ordinal];
  const evidenceFlags = session.evidenceFlags[slot];

  configuredFields(
    session,
    slot,
    ordinal,
    titleSequences,
    bodySequences,
    contributes
  );

  let exactTitleTokenMatch = Boolean(
    evidenceFlags & RANKING_EVIDENCE_FLAG_EXACT_TITLE_TOKEN
  );
  let typedSurfaceTitleMatch = Boolean(
    evidenceFlags & RANKING_EVIDENCE_FLAG_TYPED_SURFACE
  );
  let titleCoverage = ratioQ4(
    session.titleCoverageCount[slot],
    titleTokenCount
  );
  let titlePrefixQuality = prefixQuality(
    session.ordinaryPrefixMask[slot],
    plan.facts.feature.nonStopNorm,
    titleTokenCount
  );
  let configuredFormEvidence = 0;
  const formCount = plan.forms.length;

  for (let formIndex = 0; formIndex < formCount; formIndex++) {
    const form = plan.forms[formIndex];
    const at = slot * formCount + formIndex;
    const fieldHits = popcount32(session.configuredTitleFieldMask[at]);
    if (
      form.content.length &&
      (form.tokens.length === 1 ||
        titleSequences[formIndex] !== 0 ||
        fieldHits >= 2)
    ) {
      configuredFormEvidence = Math.max(
        configuredFormEvidence,
        ratioQ4(fieldHits, form.content.length)
      );
    }
    if (!plan.facts.occupied || !contributes[formIndex]) continue;
    exactTitleTokenMatch = true;
    if (session.configuredPrefixMask[at]) typedSurfaceTitleMatch = true;
    titleCoverage = Math.max(
      titleCoverage,
      ratioQ4(session.configuredTitleCoverageCount[at], titleTokenCount)
    );
    titlePrefixQuality = Math.max(
      titlePrefixQuality,
      prefixQuality(
        session.configuredPrefixMask[at],
        form.content,
        titleTokenCount
      )
    );
  }
  if (!plan.facts.occupied && plan.facts.configuredContentIdentity) {
    const normalizedTitle = session.static.store.normalizedTitles[ordinal] || "";
    for (let formIndex = 0; formIndex < formCount; formIndex++) {
      const form = plan.forms[formIndex];
      if (!form.content.length) continue;
      const at = slot * formCount + formIndex;
      const fullTitle = form.join === normalizedTitle;
      const contiguous =
        form.tokens.length >= 2 && titleSequences[formIndex] !== 0;
      const singletonTitle =
        form.tokens.length === 1 &&
        session.configuredTitleIndependentSurfaceMask[at] !== 0 &&
        singletonIsEntireNonStopTitle(
          session,
          ordinal,
          form.content[0]
        );
      if (!fullTitle && !contiguous && !singletonTitle) continue;
      titlePrefixQuality = Math.max(
        titlePrefixQuality,
        prefixQuality(
          session.configuredPrefixMask[at],
          form.content,
          titleTokenCount
        )
      );
    }
  }
  if (plan.facts.occupied) {
    // Occupied concepts replace ordinary token evidence with contributing
    // peer-form evidence.
    if (!contributes.some(Boolean)) {
      exactTitleTokenMatch = false;
      typedSurfaceTitleMatch = false;
      titleCoverage = 0;
      titlePrefixQuality = 0;
    }
    if (plan.facts.occupancyUnionsTyped) {
      if (session.typedPrefixMask[slot]) typedSurfaceTitleMatch = true;
      titlePrefixQuality = Math.max(
        titlePrefixQuality,
        prefixQuality(
          session.typedPrefixMask[slot],
          plan.facts.typedLiterals,
          titleTokenCount
        )
      );
    }
  }

  let titleConceptMask = session.titleConceptMask[slot];
  let bodyConceptMask = session.bodyConceptMask[slot];
  const acronym = plan.facts.feature.acronym;
  if (acronym) {
    const configuredBit = plan.conceptBitByConcept.get(acronym) || 0;
    if (scalar.configuredConceptFieldEvidence.title) {
      titleConceptMask |= configuredBit;
    }
    if (scalar.configuredConceptFieldEvidence.body) {
      bodyConceptMask |= configuredBit;
    }
  }
  const coverageConceptCount = plan.rankingConcepts.length;

  const contextualCode = contextualChoice(session, ordinal);
  if (contextualCode) {
    const contextual = plan.contextual as NonNullable<RankingEvidencePlan["contextual"]>;
    const aligned = contextual.final[contextualCode - 1].aligned;
    const unmatched = Math.max(
      0,
      session.static.titleLength[ordinal] - (plan.query.tokens || []).length
    );
    const tightness = Number((1 / (1 + unmatched)).toFixed(4));
    scalar.contextualTitlePrefix = true;
    scalar.matchedPrefixTokens = contextual.matchedPrefixTokens as string[];
    scalar.activeFinalPrefix = contextual.activeFinalPrefix;
    scalar.completedTitleToken = aligned;
    scalar.unmatchedTitleTokensAfter = unmatched;
    scalar.titleSequenceTightness = tightness;
    scalar.contextualPrefixQuality = Number(
      (
        (contextual.activeFinalPrefix.length / Math.max(aligned.length, 1)) *
        tightness
      ).toFixed(4)
    );
  }

  const matchingPhrase = writeCompiledPhrase(session, ordinal);
  scalar.exactTitleMatch = Boolean(
    evidenceFlags & RANKING_EVIDENCE_FLAG_EXACT_TITLE
  );
  scalar.exactTitleTokenMatch = exactTitleTokenMatch;
  scalar.typedSurfaceTitleMatch = typedSurfaceTitleMatch;
  scalar.titleCoverage = titleCoverage;
  scalar.queryCoverage = ratioQ4(
    popcount32(titleConceptMask),
    coverageConceptCount
  );
  scalar.titlePrefixQuality = titlePrefixQuality;
  scalar.morphologyMatch = Boolean(
    session.morphologyLemmaMask[slot] & ~session.morphologySurfaceMask[slot]
  );
  scalar.typoDistance = session.typoTier[slot];
  scalar.phraseAdjacency = phraseAdjacency(session, ordinal);
  scalar.bodyLexicalMatch = ratioQ4(
    popcount32(bodyConceptMask),
    coverageConceptCount
  );
  scalar.lexicalConceptCoverage = ratioQ4(
    popcount32(titleConceptMask | bodyConceptMask),
    coverageConceptCount
  );
  scalar.coverageConceptCount = coverageConceptCount;
  scalar.titleTokenCount = titleTokenCount;
  scalar.configuredFormEvidence = configuredFormEvidence;
  scalar.configuredFormCoverage = plan.facts.configuredFormCoverage;
  scalar.configuredFormBodyMatch = false;
  if (
    plan.facts.occupied &&
    (acronym?.matchedFormTokens || 0) >= 2 &&
    plan.facts.configuredFormCoverage >= TWO_THIRDS &&
    plan.facts.configuredFormCoverage < 1
  ) {
    for (let formIndex = 0; formIndex < formCount; formIndex++) {
      if (
        plan.forms[formIndex].tokens.length >= 3 &&
        bodySequences[formIndex] !== 0
      ) {
        scalar.configuredFormBodyMatch = true;
        break;
      }
    }
  }
  scalar.canonicalKeyTitle = Boolean(
    plan.facts.feature.isConfiguredKey &&
      scalar.configuredConceptFieldEvidence.title === "key" &&
      configuredFormEvidence >= 0.5
  );
  scalar.queryTokenCount = plan.facts.feature.lexicalNonStopCount;
  if (plan.facts.originalSurfaceTokens.length >= 2) {
    if (!planPhraseGeometry) {
      scalar.titlePhraseFrequency = sequenceFrequency(
        session,
        ordinal,
        "title",
        plan.typedPhraseSurface
      );
      scalar.summaryPhraseFrequency = sequenceFrequency(
        session,
        ordinal,
        "summary",
        plan.typedPhraseSurface
      );
    } else {
      scalar.titlePhraseFrequency = session.titlePhraseFrequency[slot];
      scalar.summaryPhraseFrequency = session.summaryPhraseFrequency[slot];
    }
  }
  scalar.exactTitleOrSummaryPhrase =
    scalar.titlePhraseFrequency > 0 || scalar.summaryPhraseFrequency > 0;
  scalar.directClass = classifyDirect(scalar);
  const score = Number(scoreFeatures(scalar).toFixed(6));
  encodeFinal(session, candidate, ordinal, contextualCode, matchingPhrase, score);
}

export type RankingEvidenceFinalized = {
  readonly session: RankingEvidenceSession;
  readonly plan: RankingEvidencePlan;
  readonly generation: number;
  readonly finalizationVersion: number;
  readonly length: number;
  readonly counters: Readonly<RankingEvidenceCounters>;
  readonly memory: Readonly<RankingEvidenceMemory>;
};

export function finalizeRankingEvidence(
  session: RankingEvidenceSession,
  hits: readonly RetrievalHit[],
  queryPlan: QueryPlan | null = null
): RankingEvidenceFinalized {
  const plan = session.plan;
  if (!plan) throw new Error("ranking evidence session is not acquired");
  session.beginFinalization(hits.length);
  for (let candidate = 0; candidate < hits.length; candidate++) {
    if (hits[candidate].relationship) {
      throw new Error("ranking evidence supports direct candidates only");
    }
    const ordinal = ordinalOf(hits[candidate], candidate);
    session.admitCandidate(ordinal);
    if (plan.exactTitleNorms.has(session.static.store.normalizedTitles[ordinal] || "")) {
      session.markExactTitle(ordinal);
    }
  }
  applyUnwalkedTitleActions(session, hits);
  const planPhraseGeometry = applyQueryPlan(session, hits, queryPlan);
  const titleSequences = session.configuredTitleSequenceScratch;
  const bodySequences = session.configuredBodySequenceScratch;
  const contributes = session.configuredContributesScratch;
  for (let candidate = 0; candidate < hits.length; candidate++) {
    const ordinal = ordinalOf(hits[candidate], candidate);
    finalizeCandidate(
      session,
      hits[candidate],
      candidate,
      ordinal,
      planPhraseGeometry,
      titleSequences,
      bodySequences,
      contributes
    );
  }
  return {
    session,
    plan,
    generation: session.generation,
    finalizationVersion: session.finalizationVersion,
    length: hits.length,
    counters: Object.freeze({ ...session.counters }),
    memory: Object.freeze(session.memory()),
  };
}

function assertReadable(
  finalized: RankingEvidenceFinalized,
  candidate: number
) {
  if (
    finalized.session.generation !== finalized.generation ||
    finalized.session.plan !== finalized.plan ||
    finalized.session.finalizationVersion !== finalized.finalizationVersion
  ) {
    throw new Error("ranking evidence finalized view is no longer live");
  }
  if (!Number.isInteger(candidate) || candidate < 0 || candidate >= finalized.length) {
    throw new RangeError(`invalid ranking evidence candidate ${candidate}`);
  }
}

/**
 * Test/internal differential reader. Production ranking should consume the
 * numeric columns directly; this intentionally allocates a FeatureVector.
 */
export function readRankingEvidenceFactsForTest(
  finalized: RankingEvidenceFinalized,
  candidate: number
): { ordinal: number; features: FeatureVector; score: number } {
  assertReadable(finalized, candidate);
  const session = finalized.session;
  const plan = finalized.plan;
  const flags = session.finalFlags[candidate];
  const fieldEvidence = session.finalFieldEvidence[candidate];
  const configuredClass = session.finalConfiguredClass[candidate];
  const contextualCode = session.finalContextualChoice[candidate];
  const contextual = contextualCode ? plan.contextual : null;
  const completedTitleToken =
    contextual && contextualCode
      ? contextual.final[contextualCode - 1].aligned
      : null;
  const matchingPhraseCode = session.finalMatchingPhrase[candidate];
  const features: FeatureVector = {
    exactTitleMatch: Boolean(flags & RANKING_FINAL_EXACT_TITLE),
    exactTitleTokenMatch: Boolean(flags & RANKING_FINAL_EXACT_TITLE_TOKEN),
    typedSurfaceTitleMatch: Boolean(flags & RANKING_FINAL_TYPED_SURFACE),
    titleCoverage: session.finalTitleCoverage[candidate],
    queryCoverage: session.finalQueryCoverage[candidate],
    titlePrefixQuality: session.finalTitlePrefixQuality[candidate],
    contextualTitlePrefix: Boolean(flags & RANKING_FINAL_CONTEXTUAL),
    matchedPrefixTokens: contextual
      ? [...contextual.matchedPrefixTokens]
      : [],
    activeFinalPrefix: contextual?.activeFinalPrefix || null,
    completedTitleToken,
    unmatchedTitleTokensAfter:
      session.finalUnmatchedTitleTokensAfter[candidate],
    titleSequenceTightness:
      session.finalTitleSequenceTightness[candidate],
    contextualPrefixQuality:
      session.finalContextualPrefixQuality[candidate],
    configuredConceptMatch:
      configuredClass === 2
        ? "key-in-title"
        : configuredClass === 1
          ? "form"
          : false,
    configuredConceptFieldEvidence: {
      title: fieldEvidenceFromCode(fieldEvidence & 3),
      summary: fieldEvidenceFromCode((fieldEvidence >> 2) & 3),
      body: fieldEvidenceFromCode((fieldEvidence >> 4) & 3),
    },
    morphologyMatch: Boolean(flags & RANKING_FINAL_MORPHOLOGY),
    typoDistance: session.finalTypoDistance[candidate],
    versionMatch: false,
    shortLiteralLeadMatch: false,
    dottedSpanComponentTitleMatch: false,
    phraseAdjacency: session.finalPhraseAdjacency[candidate],
    bodyLexicalMatch: session.finalBodyLexicalMatch[candidate],
    lexicalConceptCoverage:
      session.finalLexicalConceptCoverage[candidate],
    coverageConceptCount:
      session.finalCoverageConceptCount[candidate],
    ordinaryEquivalenceBodyMatch: false,
    titleTokenCount: session.finalTitleTokenCount[candidate],
    configuredFormEvidence:
      session.finalConfiguredFormEvidence[candidate],
    configuredFormCoverage:
      session.finalConfiguredFormCoverage[candidate],
    configuredFormBodyMatch: Boolean(
      flags & RANKING_FINAL_CONFIGURED_FORM_BODY
    ),
    canonicalKeyTitle: Boolean(flags & RANKING_FINAL_CANONICAL_KEY_TITLE),
    queryTokenCount: session.finalQueryTokenCount[candidate],
    normalizedQueryPhrase: plan.facts.feature.primaryPhrase,
    matchingPhraseKey:
      matchingPhraseCode > 0
        ? plan.facts.feature.phraseKeys[matchingPhraseCode - 1]
        : null,
    bodyPhraseCount: session.finalBodyPhraseCount[candidate],
    bodyPhraseFrequency: session.finalBodyPhraseFrequency[candidate],
    titlePhraseFrequency: session.finalTitlePhraseFrequency[candidate],
    summaryPhraseFrequency: session.finalSummaryPhraseFrequency[candidate],
    exactTitleOrSummaryPhrase: Boolean(
      flags & RANKING_FINAL_EXACT_TITLE_OR_SUMMARY_PHRASE
    ),
    relationshipStrength: 0,
    relationshipType: null,
    relationshipSourceId: null,
    retrievalScore: session.finalRetrievalScore[candidate],
    relevanceKind: "direct",
    directClass: directClassFromCode(session.finalDirectClass[candidate]),
  };
  return {
    ordinal: session.finalOrdinals[candidate],
    features,
    score: session.finalScore[candidate],
  };
}
