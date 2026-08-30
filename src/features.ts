import { sequenceKey } from "./configuredAuthoring.js";
import { isNearCompletePrefix, levenshteinAtMost, DEFAULT_STOP, allowPrefixMatch } from "./text.js";
import { hasIndependentTitleToken, isDottedSpanComponentIndex, queryTokenMatchesDottedSpanComponent } from "./versionForms.js";
import { versionHit, conceptMatchesTitle, conceptMatchesBody, matchContextualTitlePrefix, isBoundTrailingTypedToken, hasBoundContextualCompletion, isBoundTrailingTermConcept, hasConfiguredSequenceIntent, hasConfiguredRankingIntent, hasConfiguredContentIdentity, identityTokens, evidenceTokens, standaloneRecallConcept, documentMatchesStandaloneRecall, topicalRecallHint, topicalFormEvidence, isSearchEquivalenceRecallConcept, searchEquivalenceRecallConcepts, rankingCoverageConcepts, formContentTokens, sequenceCount, shortTitleTokenPrefixStub, configuredConceptFieldMatch } from "./retrieve.js";
import { scoreFeatures } from "./rank.js";
import { saturatingFrequency } from "./saturatingFrequency.js";
import { canonicalLexicalTokensFromQuery, extractCanonicalNgrams } from "./lexicalNormalize.js";
import {
  asCompactStore,
  compactAdjacentTokens,
  compactLemmasDiffer,
  compactOrdinal,
  KIND_BODY,
  KIND_BODY_LEMMA,
  KIND_TITLE,
  KIND_TITLE_LEMMA,
} from "./compactDocuments.js";
import {
  FULL_QUERY_COVERAGE,
  TWO_THIRDS_QUERY_COVERAGE,
  MODERATE_TITLE_PREFIX_QUALITY,
  STRONG_WITH_FULL_COVERAGE_TITLE_PREFIX_QUALITY,
  REPEATED_BODY_PHRASE_MIN,
} from "./evidencePolicy.js";
import type {
  AnalyzedQuery,
  ContextualTitlePrefix,
  DirectClass,
  FeatureVector,
  IndexedDocument,
  QueryConcept,
  QueryToken,
  RelationshipInfo,
} from "./types.js";

export { saturatingFrequency };

type FeatureProfileBucket = { ms: number; calls: number };
let featureProfile: Record<string, FeatureProfileBucket> | null = null;

/** Benchmark/test instrumentation. Not a public API. */
export function startFeatureProfile() {
  featureProfile = Object.create(null) as Record<string, FeatureProfileBucket>;
}

export function lastFeatureProfile() {
  return featureProfile;
}

export function stopFeatureProfile() {
  featureProfile = null;
}

function timeFeat<T>(name: string, fn: () => T): T {
  if (!featureProfile) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const bucket = featureProfile[name] || (featureProfile[name] = { ms: 0, calls: 0 });
    bucket.ms += performance.now() - t0;
    bucket.calls += 1;
  }
}

type QueryFeatPrep = {
  joinedNorm: string;
  nonStop: QueryToken[];
  nonStopNorm: string[];
  nonStopLemma: string[];
  lexicalNonStopCount: number;
  phraseKeys: string[];
  primaryPhrase: string;
  acronym: QueryConcept | null;
  isConfiguredKey: boolean;
  peerForms: string[][];
  peerFormJoins: string[];
  typoTokens: QueryToken[];
  formSet: Set<string>;
  shortLiteralTok: string | null;
};

const queryFeatPrep = new WeakMap<AnalyzedQuery, QueryFeatPrep>();

function peerFormsOf(concept: QueryConcept | null): string[][] {
  if (!concept) return [];
  const raw = Array.isArray(concept.aliases) && concept.aliases.length
    ? concept.aliases
    : concept.matchedForm?.length
      ? [concept.matchedForm]
      : [];
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const alias of raw) {
    const seq = (alias || []).filter((f) => f && !/^\d+$/.test(f));
    if (!seq.length) continue;
    const key = sequenceKey(seq);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seq);
  }
  return out.sort((a, b) => sequenceKey(a).localeCompare(sequenceKey(b)));
}

/** Longest phrase key, then lexical. Serialization/explain only; no ranking privilege. */
function primaryPhraseOf(keys: string[]): string {
  if (!keys.length) return "";
  let best = keys[0];
  let bestN = best.split(/\s+/).length;
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    const n = key.split(/\s+/).length;
    if (n > bestN || (n === bestN && key < best)) {
      best = key;
      bestN = n;
    }
  }
  return best;
}

function occupiedQueryTokenCount(peerForms: string[][]): number {
  let max = 0;
  for (const form of peerForms) {
    const n = formContentTokens(form).length;
    if (n > max) max = n;
  }
  return max;
}

function getQueryFeatPrep(query: AnalyzedQuery): QueryFeatPrep {
  const cached = queryFeatPrep.get(query);
  if (cached) return cached;
  const tokens = query.tokens || [];
  const ranking = identityTokens(query);
  const rankingNonStop = ranking.filter((t) => !DEFAULT_STOP.has(t.normalized) || ranking.length <= 2);
  const nonStopUse = rankingNonStop.length ? rankingNonStop : ranking;
  const lexicalSource = Array.isArray(query.lexicalTokens) && query.lexicalTokens.length ? query.lexicalTokens : tokens;
  const lexicalNonStop = lexicalSource.filter((t) => !DEFAULT_STOP.has(t.normalized) || lexicalSource.length <= 2);
  const lexicalUse = lexicalNonStop.length ? lexicalNonStop : lexicalSource;
  const acronym = query.concepts.find((c) => c.kind === "configured-concept") || null;
  const peerForms = peerFormsOf(acronym);
  const occupied = hasConfiguredSequenceIntent(query);
  const peerFormJoins: string[] = [];
  const joinSeen = new Set<string>();
  if (acronym?.id) {
    joinSeen.add(acronym.id);
    peerFormJoins.push(acronym.id);
  }
  for (const form of peerForms) {
    const join = form.join(" ");
    if (!join || joinSeen.has(join)) continue;
    joinSeen.add(join);
    peerFormJoins.push(join);
  }
  peerFormJoins.sort();
  const formSet = new Set<string>();
  for (const c of query.concepts) {
    if (c.kind === "configured-concept") continue;
    if (isBoundTrailingTermConcept(query, c)) continue;
    if (isSearchEquivalenceRecallConcept(query, c)) continue;
    for (const form of c.forms || []) formSet.add(form);
  }
  const phraseKeys = phraseKeyCandidates(query, peerForms);
  const prep: QueryFeatPrep = {
    joinedNorm: ranking.map((t) => t.normalized).join(" "),
    nonStop: nonStopUse,
    nonStopNorm: nonStopUse.map((t) => t.normalized),
    nonStopLemma: nonStopUse.map((t) => t.lemma || t.normalized),
    lexicalNonStopCount: occupied ? occupiedQueryTokenCount(peerForms) || 1 : lexicalUse.length,
    phraseKeys,
    primaryPhrase: primaryPhraseOf(phraseKeys),
    acronym,
    isConfiguredKey: Boolean(
      acronym &&
        !hasConfiguredSequenceIntent(query) &&
        tokens.length === 1 &&
        tokens[0].normalized === acronym.id
    ),
    peerForms,
    peerFormJoins,
    typoTokens: occupied ? [] : ranking.filter((t) => t.normalized.length >= 5),
    formSet,
    shortLiteralTok:
      hasConfiguredSequenceIntent(query) || tokens.length !== 1 || tokens[0].normalized.length > 3
        ? null
        : tokens[0].normalized,
  };
  queryFeatPrep.set(query, prep);
  return prep;
}

type ConfiguredConceptMatch = false | "key-in-title" | "form";
type VersionMatch = false | "dotted" | "compact-dotted" | "compact-weak" | "dotted-weak";

function independentTitleTokensOf(doc: IndexedDocument): string[] {
  if (doc.independentTitleTokens) return doc.independentTitleTokens;
  const out: string[] = [];
  for (let i = 0; i < doc.titleTokens.length; i++) {
    if (!isDottedSpanComponentIndex(doc, i) && doc.titleTokens[i]) out.push(doc.titleTokens[i]);
  }
  return out;
}

function queryNonStop(query: AnalyzedQuery) {
  return getQueryFeatPrep(query).nonStop;
}

function conceptCoveredInTitle(concept: QueryConcept, doc: IndexedDocument) {
  return conceptMatchesTitle(concept, doc) != null;
}

function exactTitle(query: AnalyzedQuery, doc: IndexedDocument) {
  const prep = getQueryFeatPrep(query);
  if (hasConfiguredSequenceIntent(query) && prep.peerFormJoins.length) {
    return prep.peerFormJoins.includes(doc.normalizedTitle);
  }
  // Identity is not occupancy. Literal original-surface title equality stays
  // available; ranking may additionally accept an authored peer-form title.
  if (hasConfiguredRankingIntent(query) && prep.peerFormJoins.length && prep.peerFormJoins.includes(doc.normalizedTitle)) {
    return true;
  }
  const q = prep.joinedNorm;
  return q.length > 0 && q === doc.normalizedTitle;
}

function tokenLiteral(t: QueryToken) {
  return t.surfaceNormalized || t.surface;
}

function hasIndependentTitleTokenFast(doc: IndexedDocument, tok: string) {
  if (doc.independentTitleTokenSet) return doc.independentTitleTokenSet.has(tok);
  return hasIndependentTitleToken(doc, tok);
}

function formContributesQueryShapedTitle(form: string[], doc: IndexedDocument) {
  const content = formContentTokens(form);
  if (!content.length) return false;
  if (form.length === 1) return hasIndependentTitleTokenFast(doc, content[0]);
  if (exactTokenSequence(form, doc.titleTokens) || exactTokenSequence(form, doc.titleLemmas)) return true;
  const hits = content.filter((t) => hasIndependentTitleTokenFast(doc, t));
  return hits.length >= 2;
}

function maxOverPeerFormsNumber(query: AnalyzedQuery, score: (form: string[]) => number, empty = 0) {
  const forms = getQueryFeatPrep(query).peerForms;
  if (!hasConfiguredSequenceIntent(query) || !forms.length) return empty;
  let best = empty;
  for (const form of forms) {
    const v = score(form);
    if (v > best) best = v;
  }
  return best;
}

function anyOverPeerForms(query: AnalyzedQuery, pred: (form: string[]) => boolean) {
  const forms = getQueryFeatPrep(query).peerForms;
  if (!hasConfiguredSequenceIntent(query) || !forms.length) return false;
  for (const form of forms) {
    if (pred(form)) return true;
  }
  return false;
}

function exactTitleTokenMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  if (hasConfiguredSequenceIntent(query)) {
    return anyOverPeerForms(query, (form) => formContributesQueryShapedTitle(form, doc));
  }
  return evidenceTokens(query).some((t) => {
    if (DEFAULT_STOP.has(t.normalized)) return false;
    return hasIndependentTitleTokenFast(doc, t.normalized);
  });
}

/**
 * Typed/repaired surface (pre-lemma, pre-unique-prefix rewrite) agrees with a
 * title token: exact token, or the typed stub prefixes a title token.
 * Canonical lemmas and completedToken are not typed-surface evidence.
 */
function typedSurfaceTitleMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  const independent = independentTitleTokensOf(doc);
  if (hasConfiguredSequenceIntent(query)) {
    return anyOverPeerForms(query, (form) => {
      if (!formContributesQueryShapedTitle(form, doc)) return false;
      return formContentTokens(form).some((literal) => {
        if (hasIndependentTitleTokenFast(doc, literal)) return true;
        return independent.some(
          (tok) => allowPrefixMatch(literal, tok) || isNearCompletePrefix(literal, tok)
        );
      });
    });
  }
  const stream = query.tokens;
  const last = stream[stream.length - 1];
  const skipLast = hasBoundContextualCompletion(query);
  return stream.some((t) => {
    if (skipLast && t === last) return false;
    const literal = tokenLiteral(t);
    if (!literal || DEFAULT_STOP.has(literal)) return false;
    if (hasIndependentTitleTokenFast(doc, literal)) return true;
    return independent.some(
      (tok) => allowPrefixMatch(literal, tok) || isNearCompletePrefix(literal, tok)
    );
  });
}

function titlePrefixQualityForNorms(qNorms: string[], doc: IndexedDocument) {
  const independent = independentTitleTokensOf(doc);
  if (!qNorms.length || !doc.titleTokens.length) return 0;
  let matched = 0;
  let prefixChars = 0;
  let titleChars = 0;
  for (const qn of qNorms) {
    titleChars += qn.length;
    const hit = independent.find(
      (tok) => allowPrefixMatch(qn, tok) || isNearCompletePrefix(qn, tok)
    );
    if (hit) {
      matched += 1;
      prefixChars += qn.length;
    }
  }
  if (!matched) return 0;
  const coverage = matched / qNorms.length;
  const completeness = titleChars ? prefixChars / Math.max(titleChars, 1) : 0;
  const tightness = qNorms.length / Math.max(doc.nonStopTitle.length, 1);
  return Number((0.5 * coverage + 0.3 * completeness + 0.2 * Math.min(1, tightness)).toFixed(4));
}

function titlePrefixQuality(query: AnalyzedQuery, doc: IndexedDocument) {
  if (hasConfiguredSequenceIntent(query)) {
    return maxOverPeerFormsNumber(query, (form) =>
      formContributesQueryShapedTitle(form, doc)
        ? titlePrefixQualityForNorms(formContentTokens(form), doc)
        : 0
    );
  }
  const last = query.tokens[query.tokens.length - 1];
  const skipLast = hasBoundContextualCompletion(query);
  const qToks = queryNonStop(query).filter((qt) => !(skipLast && qt === last));
  const literal = titlePrefixQualityForNorms(
    qToks.map((qt) => qt.normalized),
    doc
  );
  if (!hasConfiguredContentIdentity(query)) return literal;
  // Identity may evaluate an authored peer form that is the document's title
  // identity: full-title join, contiguous multi-token form, or a one-token
  // form that is the entire non-stop title. Occupancy's looser 2-of-n
  // query-shaped-title reduction is not copied.
  const prep = getQueryFeatPrep(query);
  let best = literal;
  for (const form of prep.peerForms) {
    const content = formContentTokens(form);
    if (!content.length) continue;
    const join = form.join(" ");
    const fullTitle = join === doc.normalizedTitle;
    const contiguous =
      form.length >= 2 &&
      (exactTokenSequence(form, doc.titleTokens) || exactTokenSequence(form, doc.titleLemmas));
    const singletonTitle =
      form.length === 1 &&
      hasIndependentTitleTokenFast(doc, content[0]) &&
      doc.nonStopTitle.length > 0 &&
      doc.nonStopTitle.every((tok) => tok === content[0]);
    if (!fullTitle && !contiguous && !singletonTitle) continue;
    const v = titlePrefixQualityForNorms(content, doc);
    if (v > best) best = v;
  }
  return best;
}

function queryCoverage(query: AnalyzedQuery, doc: IndexedDocument, v: ReturnType<typeof versionHit> = versionHit(query, doc)) {
  const unboundConcepts = query.concepts.filter((c) => !isBoundTrailingTermConcept(query, c));
  const concepts = unboundConcepts.filter((c) => c.kind !== "number" || unboundConcepts.length === 1);
  const usable = rankingCoverageConcepts(query, concepts.length ? concepts : unboundConcepts);
  if (!usable.length) return 0;
  const vOk = Boolean(v);
  let hit = 0;
  for (const c of usable) {
    if (conceptCoveredInTitle(c, doc) || vOk) hit += 1;
    else if (c.kind === "number" && vOk) hit += 1;
  }
  // Count number concepts via version hit once
  const hasNumber = unboundConcepts.some((c) => c.kind === "number");
  if (hasNumber && v) {
    const withoutNum = rankingCoverageConcepts(query, unboundConcepts.filter((c) => c.kind !== "number"));
    const numOk = v.compactHit || v.dottedHit;
    const otherHits = withoutNum.filter((c) => conceptCoveredInTitle(c, doc)).length;
    const denom = withoutNum.length + 1;
    return Number(((otherHits + (numOk ? 1 : 0)) / denom).toFixed(4));
  }
  return Number((hit / usable.length).toFixed(4));
}

function titleCoverage(query: AnalyzedQuery, doc: IndexedDocument) {
  if (!doc.nonStopTitle.length) return 0;
  const prep = getQueryFeatPrep(query);
  const coverTitle = (qToks: Array<{ normalized: string; lemma?: string }>) => {
    let hit = 0;
    for (let i = 0; i < doc.titleTokens.length; i++) {
      const tok = doc.titleTokens[i];
      if (DEFAULT_STOP.has(tok)) continue;
      const spanComponent = isDottedSpanComponentIndex(doc, i);
      const ok = qToks.some((qt) => {
        if (spanComponent && (qt.normalized === tok || qt.lemma === tok)) return false;
        if (qt.normalized === tok || qt.lemma === tok) return true;
        if (spanComponent) return false;
        if (allowPrefixMatch(qt.normalized, tok) || isNearCompletePrefix(qt.normalized, tok)) return true;
        return prep.formSet.has(tok);
      });
      if (ok) hit += 1;
    }
    return Number((hit / doc.nonStopTitle.length).toFixed(4));
  };
  if (hasConfiguredSequenceIntent(query)) {
    return maxOverPeerFormsNumber(query, (form) =>
      formContributesQueryShapedTitle(form, doc)
        ? coverTitle(formContentTokens(form).map((t) => ({ normalized: t, lemma: t })))
        : 0
    );
  }
  return coverTitle(evidenceTokens(query));
}

function emptyConfiguredFieldEvidence(): FeatureVector["configuredConceptFieldEvidence"] {
  return { title: false, summary: false, body: false };
}

function configuredConceptFieldEvidence(
  query: AnalyzedQuery,
  doc: IndexedDocument
): FeatureVector["configuredConceptFieldEvidence"] {
  const acr = getQueryFeatPrep(query).acronym;
  if (!acr) return emptyConfiguredFieldEvidence();
  const summaryTokens = doc.summaryTokens || [];
  const summaryLemmas = doc.summaryLemmas || summaryTokens;
  return {
    title: configuredConceptFieldMatch(
      acr,
      doc.titleTokens,
      doc.titleLemmas,
      doc.titleTokenSet,
      doc.titleLemmaSet,
      { requireContiguous: false }
    ),
    summary: configuredConceptFieldMatch(
      acr,
      summaryTokens,
      summaryLemmas,
      doc.summaryTokenSet || new Set(summaryTokens),
      doc.summaryLemmaSet || new Set(summaryLemmas),
      { requireContiguous: true }
    ),
    body: configuredConceptFieldMatch(
      acr,
      doc.bodyTokens,
      doc.bodyLemmas,
      doc.bodyTokenSet,
      doc.bodyLemmaSet,
      { requireContiguous: true }
    ),
  };
}

function configuredConceptMatchFromField(
  evidence: FeatureVector["configuredConceptFieldEvidence"]
): ConfiguredConceptMatch {
  if (evidence.title === "key") return "key-in-title";
  if (evidence.title === "form") return "form";
  return false;
}

function morphologyMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  if (hasConfiguredSequenceIntent(query)) {
    return anyOverPeerForms(query, (form) => {
      if (form.length !== 1) return false;
      const tok = form[0];
      if (!tok || DEFAULT_STOP.has(tok)) return false;
      const lemmaHit = doc.titleLemmaSet.has(tok) || doc.titleTokenSet.has(tok);
      if (!lemmaHit) return false;
      return !doc.titleTokenSet.has(tok);
    });
  }
  return evidenceTokens(query).some((t) => {
    const lemma = t.lemma || t.normalized;
    if (!lemma) return false;
    const lemmaHit = doc.titleLemmaSet.has(lemma) || doc.titleTokenSet.has(lemma);
    if (!lemmaHit) return false;
    return !doc.titleTokenSet.has(t.normalized);
  });
}

function typoDistance(query: AnalyzedQuery, doc: IndexedDocument) {
  const prep = getQueryFeatPrep(query);
  let best = 0;
  for (const t of prep.typoTokens) {
    if (isBoundTrailingTypedToken(query, t)) continue;
    if (t.sources.includes("repeat-collapse") && doc.titleTokenSet.has(t.normalized)) {
      best = Math.max(best, 1);
      continue;
    }
    const qn = t.normalized;
    const qLen = qn.length;
    for (const tok of doc.titleTokens) {
      if (tok === qn) continue;
      if (Math.abs(tok.length - qLen) > 2) continue;
      const d = levenshteinAtMost(qn, tok, 2);
      if (d > 0 && d <= 2) {
        best = Math.max(best, 3 - d);
        if (best === 2) return best;
      }
    }
  }
  return best;
}

function versionMatch(query: AnalyzedQuery, doc: IndexedDocument, v: ReturnType<typeof versionHit> = versionHit(query, doc)): VersionMatch {
  if (!v) return false;
  if (v.dottedHit && (v.companion === "covered" || v.companion === "absent")) return "dotted";
  if (v.compactHit && v.companion === "covered") return "compact-dotted";
  if (v.compactHit && v.companion === "absent") return "compact-weak";
  if (v.compactHit && v.companion === "weak") return "compact-weak";
  if (v.dottedHit) return "dotted-weak";
  return false;
}

function shortLiteralLeadMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  const tok = getQueryFeatPrep(query).shortLiteralTok || shortTitleTokenPrefixStub(query);
  if (tok == null) return false;
  if (!doc.firstToken) return false;
  return doc.firstToken === tok || doc.firstToken.startsWith(tok);
}

function dottedSpanComponentTitleMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  const spans = doc.dottedSpans || [];
  if (!spans.length) return false;
  return query.tokens.some((t) => {
    const forms = [t.normalized, t.surfaceNormalized, t.surface];
    return forms.some((f) => queryTokenMatchesDottedSpanComponent(f, spans));
  });
}

function sameStringArray(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function tokenAdjacencyMatch(qt: string, tt: string | undefined) {
  if (!tt) return false;
  return /^\d+$/.test(qt) || /^\d+$/.test(tt) ? tt === qt : tt === qt || tt.startsWith(qt);
}

const ADJACENCY_INDEX_MIN = 32;

function adjacencyStarts(qt: string, fieldToks: string[], posMap?: Map<string, number[]>) {
  if (!(posMap instanceof Map) || fieldToks.length < ADJACENCY_INDEX_MIN) return null;
  const starts: number[] = [];
  if (/^\d+$/.test(qt)) {
    const pos = posMap.get(qt);
    if (pos) {
      for (const i of pos) starts.push(i);
    }
    return starts;
  }
  for (const [tok, pos] of posMap) {
    if (tok === qt || (!/^\d+$/.test(tok) && tok.startsWith(qt))) {
      for (const i of pos) starts.push(i);
    }
  }
  return starts;
}

function adjacentOn(queryToks: string[], fieldToks: string[], posMap?: Map<string, number[]>) {
  if (queryToks.length < 2 || fieldToks.length < queryToks.length) return false;
  const first = queryToks[0];
  const m = queryToks.length;
  const last = fieldToks.length - m;
  const starts = adjacencyStarts(first, fieldToks, posMap);
  if (starts) {
    for (const i of starts) {
      if (i > last) continue;
      let ok = true;
      for (let j = 1; j < m; j++) {
        if (!tokenAdjacencyMatch(queryToks[j], fieldToks[i + j])) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }
  for (let i = 0; i <= last; i++) {
    if (!tokenAdjacencyMatch(first, fieldToks[i])) continue;
    let ok = true;
    for (let j = 1; j < m; j++) {
      if (!tokenAdjacencyMatch(queryToks[j], fieldToks[i + j])) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function formAdjacency(form: string[], query: AnalyzedQuery, doc: IndexedDocument) {
  if (form.length < 2) return 0;
  const qToks = form;
  const qLemmas = form;
  const queryLemmasDiffer = false;
  const store = asCompactStore(doc);
  if (store) {
    const ordinal = compactOrdinal(doc);
    const titleLemmasDiffer = compactLemmasDiffer(store, ordinal, "title");
    if (
      compactAdjacentTokens(store, ordinal, KIND_TITLE, qToks, tokenAdjacencyMatch) ||
      ((queryLemmasDiffer || titleLemmasDiffer) &&
        compactAdjacentTokens(store, ordinal, KIND_TITLE_LEMMA, qLemmas, tokenAdjacencyMatch))
    ) {
      return 1;
    }
    const bodyLemmasDiffer = compactLemmasDiffer(store, ordinal, "body");
    if (
      compactAdjacentTokens(store, ordinal, KIND_BODY, qToks, tokenAdjacencyMatch) ||
      ((queryLemmasDiffer || bodyLemmasDiffer) &&
        compactAdjacentTokens(store, ordinal, KIND_BODY_LEMMA, qLemmas, tokenAdjacencyMatch))
    ) {
      return 0.5;
    }
    return 0;
  }
  const titleLemmasDiffer = !sameStringArray(doc.titleTokens, doc.titleLemmas);
  if (adjacentOn(qToks, doc.titleTokens) || ((queryLemmasDiffer || titleLemmasDiffer) && adjacentOn(qLemmas, doc.titleLemmas))) {
    return 1;
  }
  const bodyLemmasDiffer = !sameStringArray(doc.bodyTokens, doc.bodyLemmas);
  if (
    adjacentOn(qToks, doc.bodyTokens, doc.bodyTokenPositions) ||
    ((queryLemmasDiffer || bodyLemmasDiffer) && adjacentOn(qLemmas, doc.bodyLemmas, doc.bodyLemmaPositions))
  ) {
    return 0.5;
  }
  return 0;
}

function phraseAdjacency(query: AnalyzedQuery, doc: IndexedDocument) {
  const prep = getQueryFeatPrep(query);
  if (prep.peerForms.length && hasConfiguredSequenceIntent(query)) {
    let best = 0;
    for (const form of prep.peerForms) {
      const score = formAdjacency(form, query, doc);
      if (score > best) best = score;
      if (best === 1) return 1;
    }
    return best;
  }
  const qToks = prep.nonStopNorm;
  const qLemmas = prep.nonStopLemma;
  if (qToks.length < 2) return 0;
  const queryLemmasDiffer = !sameStringArray(qToks, qLemmas);
  const store = asCompactStore(doc);
  if (store) {
    const ordinal = compactOrdinal(doc);
    const titleLemmasDiffer = compactLemmasDiffer(store, ordinal, "title");
    if (
      compactAdjacentTokens(store, ordinal, KIND_TITLE, qToks, tokenAdjacencyMatch) ||
      ((queryLemmasDiffer || titleLemmasDiffer) &&
        compactAdjacentTokens(store, ordinal, KIND_TITLE_LEMMA, qLemmas, tokenAdjacencyMatch))
    ) {
      return 1;
    }
    const bodyLemmasDiffer = compactLemmasDiffer(store, ordinal, "body");
    if (
      compactAdjacentTokens(store, ordinal, KIND_BODY, qToks, tokenAdjacencyMatch) ||
      ((queryLemmasDiffer || bodyLemmasDiffer) &&
        compactAdjacentTokens(store, ordinal, KIND_BODY_LEMMA, qLemmas, tokenAdjacencyMatch))
    ) {
      return 0.5;
    }
    return 0;
  }
  const titleLemmasDiffer = !sameStringArray(doc.titleTokens, doc.titleLemmas);
  if (adjacentOn(qToks, doc.titleTokens) || ((queryLemmasDiffer || titleLemmasDiffer) && adjacentOn(qLemmas, doc.titleLemmas))) {
    return 1;
  }
  const bodyLemmasDiffer = !sameStringArray(doc.bodyTokens, doc.bodyLemmas);
  if (
    adjacentOn(qToks, doc.bodyTokens, doc.bodyTokenPositions) ||
    ((queryLemmasDiffer || bodyLemmasDiffer) && adjacentOn(qLemmas, doc.bodyLemmas, doc.bodyLemmaPositions))
  ) {
    return 0.5;
  }
  return 0;
}

function configuredFormEvidence(query: AnalyzedQuery, doc: IndexedDocument) {
  const forms = getQueryFeatPrep(query).peerForms;
  if (!forms.length) return 0;
  let best = 0;
  for (const form of forms) {
    const content = formContentTokens(form);
    if (!content.length) continue;
    if (form.length === 1) {
      if (doc.titleTokenSet.has(content[0]) || doc.titleLemmaSet.has(content[0])) best = Math.max(best, 1);
      continue;
    }
    const phrase =
      exactTokenSequence(form, doc.titleTokens) || exactTokenSequence(form, doc.titleLemmas);
    const hits = content.filter((f) => doc.titleTokenSet.has(f) || doc.titleLemmaSet.has(f));
    if (!phrase && hits.length < 2) continue;
    const score = hits.length / content.length;
    if (score > best) best = score;
  }
  return Number(best.toFixed(4));
}

/**
 * Occupied matched-form completeness from query analysis.
 * 0 unless the query uniquely occupies a configured concept with at least
 * 2 matched form tokens (the existing prefix occupancy information bound).
 */
function occupiedPartialForm(query: AnalyzedQuery) {
  const acr = getQueryFeatPrep(query).acronym;
  if (!acr) return null;
  if ((acr.matchedFormTokens || 0) < 2) return null;
  const coverage = acr.formCoverage;
  if (typeof coverage !== "number" || !Number.isFinite(coverage)) return null;
  if (coverage < TWO_THIRDS_QUERY_COVERAGE || coverage >= FULL_QUERY_COVERAGE) return null;
  return acr;
}

function configuredFormCoverage(query: AnalyzedQuery) {
  // Candidate feature: occupied matched-form completeness only.
  // Non-occupied prefix spans / key prefixes stay on query analysis; they
  // must not stamp completeness onto every hit as ranking evidence.
  if (!hasConfiguredSequenceIntent(query)) return 0;
  const acr = getQueryFeatPrep(query).acronym;
  if (!acr) return 0;
  const coverage = acr.formCoverage;
  return typeof coverage === "number" && Number.isFinite(coverage) ? coverage : 0;
}

function exactTokenSequence(seq: string[], fieldToks: string[]) {
  if (seq.length < 2 || fieldToks.length < seq.length) return false;
  const m = seq.length;
  const last = fieldToks.length - m;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < m; j++) {
      if (fieldToks[i + j] !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function configuredFormBodyMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  const acr = occupiedPartialForm(query);
  if (!acr) return false;
  const forms = getQueryFeatPrep(query).peerForms.filter((form) => form.length >= 3);
  if (!forms.length) return false;
  const store = asCompactStore(doc);
  if (store) {
    const ordinal = compactOrdinal(doc);
    return forms.some(
      (form) =>
        compactAdjacentTokens(store, ordinal, KIND_BODY, form, (qt, tt) => qt === tt) ||
        compactAdjacentTokens(store, ordinal, KIND_BODY_LEMMA, form, (qt, tt) => qt === tt)
    );
  }
  return forms.some(
    (form) => exactTokenSequence(form, doc.bodyTokens) || exactTokenSequence(form, doc.bodyLemmas)
  );
}

function queryIsConfiguredKey(query: AnalyzedQuery) {
  return getQueryFeatPrep(query).isConfiguredKey;
}

function canonicalKeyTitle(query: AnalyzedQuery, doc: IndexedDocument) {
  if (!queryIsConfiguredKey(query)) return false;
  const acr = getQueryFeatPrep(query).acronym;
  if (!acr) return false;
  const keyInTitle = doc.titleTokenSet.has(acr.id) || doc.titleLemmaSet.has(acr.id);
  if (!keyInTitle) return false;
  return configuredFormEvidence(query, doc) >= 0.5;
}

/**
 * Body-only and title∪body coverage over typed/configured concepts.
 * queryCoverage stays title-only and is computed separately.
 * No extra array: skip search-equivalence recall concepts in the existing
 * concept walk and count hits with two integer accumulators.
 */
function lexicalCoverageFields(query: AnalyzedQuery, doc: IndexedDocument) {
  const concepts = rankingCoverageConcepts(query, query.concepts || []);
  let coverageConceptCount = 0;
  let bodyHits = 0;
  let unionHits = 0;
  for (const c of concepts) {
    if (isSearchEquivalenceRecallConcept(query, c)) continue;
    coverageConceptCount += 1;
    const body = conceptMatchesBody(c, doc);
    if (body) {
      bodyHits += 1;
      unionHits += 1;
      continue;
    }
    if (conceptMatchesTitle(c, doc) != null) unionHits += 1;
  }
  if (!coverageConceptCount) {
    return { coverageConceptCount: 0, bodyLexicalMatch: 0, lexicalConceptCoverage: 0 };
  }
  return {
    coverageConceptCount,
    bodyLexicalMatch: Number((bodyHits / coverageConceptCount).toFixed(4)),
    lexicalConceptCoverage: Number((unionHits / coverageConceptCount).toFixed(4)),
  };
}

/**
 * Candidate-local provenance for an ordinary same-concept search-equivalence
 * body hit. The source and target must belong to the same non-acronym concept,
 * and the body check is performed against the target alone so a source-only
 * body hit cannot activate this flag.
 */
function ordinaryEquivalenceBodyMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  for (const pair of query.equivalentRecall || []) {
    if (!pair.source || !pair.target || pair.source === pair.target) continue;
    const concept = (query.concepts || []).find(
      (candidate) =>
        candidate.kind !== "configured-concept" &&
        !isSearchEquivalenceRecallConcept(query, candidate) &&
        candidate.forms.includes(pair.source) &&
        candidate.forms.includes(pair.target)
    );
    if (!concept) continue;
    if (conceptMatchesBody({ ...concept, forms: [pair.target] }, doc)) return true;
  }
  return false;
}

function lexicalPhraseQueryTokens(query: AnalyzedQuery) {
  if (Array.isArray(query.lexicalTokens) && query.lexicalTokens.length) return query.lexicalTokens;
  return query.tokens;
}

function phraseKeyCandidates(query: AnalyzedQuery, peerForms?: string[][]) {
  const occupiedForms = Array.isArray(query.peerFormLexical) && query.peerFormLexical.length
    ? query.peerFormLexical
    : peerForms && peerForms.length
      ? peerForms
      : null;
  if (occupiedForms && hasConfiguredSequenceIntent(query)) {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const form of occupiedForms) {
      // One-token peer forms are not compiled phrase evidence.
      if (form.length < 2) continue;
      const toks = form.map((word) => word);
      const key = toks.join(" ");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      // Compiler stores 1–2 grams. A 3+ token form may miss as a full join;
      // the leading bigram is a compiler fallback, not a tail-bigram max.
      if (toks.length >= 3) {
        const left = toks.slice(0, 2).join(" ");
        if (left && !seen.has(left)) {
          seen.add(left);
          keys.push(left);
        }
      }
    }
    keys.sort();
    return keys;
  }
  const source = lexicalPhraseQueryTokens(query);
  const toks = canonicalLexicalTokensFromQuery(source);
  if (!toks.length) return [];
  const keys = [toks.join(" ")];
  // Compiler stores contiguous 1–2 grams. A 3+ token canonical stream cannot
  // hit as a full join; look up its compiled bigrams instead of unigrams.
  // Restricted to unique contextual completion so unrelated 3-token queries
  // keep their existing full-join lookup.
  if (hasBoundContextualCompletion(query) && toks.length >= 3) {
    for (const ng of extractCanonicalNgrams(toks, { minN: 2, maxN: 2 })) {
      if (ng && !keys.includes(ng)) keys.push(ng);
    }
  }
  const pc = query.prefixCompletion;
  // Ambiguous completions are explain/provenance only. They must not mint
  // alternate compiled phrase keys or pick a max bodyPhraseCount.
  if (!pc || pc.ambiguous || !pc.completedToken || !pc.canonicalToken) return keys;
  const head = canonicalLexicalTokensFromQuery(source.slice(0, -1));
  const key = head.length ? [...head, pc.canonicalToken].join(" ") : String(pc.canonicalToken);
  if (key && !keys.includes(key)) keys.push(key);
  return keys;
}

function typedPhraseFieldFrequencies(query: AnalyzedQuery, doc: IndexedDocument) {
  const tokens = (query.originalSurface || []).filter(Boolean);
  if (tokens.length < 2) {
    return { titlePhraseFrequency: 0, summaryPhraseFrequency: 0, exactTitleOrSummaryPhrase: false };
  }
  // Typed originalSurface only. Token-graph hits (configured-key shortcuts)
  // are not complete typed-phrase evidence — a summary mention of a 1-token
  // key is not an exact title/summary phrase of a multi-token form.
  const titlePhraseFrequency = sequenceCount(tokens, doc.titleTokens);
  const summaryPhraseFrequency = sequenceCount(tokens, doc.summaryTokens || []);
  return {
    titlePhraseFrequency,
    summaryPhraseFrequency,
    exactTitleOrSummaryPhrase: titlePhraseFrequency > 0 || summaryPhraseFrequency > 0,
  };
}

function compiledPhraseLookup(query: AnalyzedQuery, doc: IndexedDocument) {
  const prep = getQueryFeatPrep(query);
  const candidates = prep.phraseKeys;
  const ngrams = doc.lexicalFrequency || null;
  const primary = prep.primaryPhrase;
  let matchingPhraseKey: string | null = null;
  let count = 0;
  const firstPositive = hasBoundContextualCompletion(query) && candidates.length > 1;
  for (const key of candidates) {
    const n = key && ngrams && Number.isFinite(ngrams[key]) ? ngrams[key] : 0;
    if (firstPositive) {
      if (n > 0) {
        matchingPhraseKey = key;
        count = n;
        break;
      }
      continue;
    }
    if (n > count || (n === count && n > 0 && matchingPhraseKey != null && key < matchingPhraseKey)) {
      count = n;
      matchingPhraseKey = key;
    }
  }
  return {
    normalizedQueryPhrase: primary,
    matchingPhraseKey: count > 0 ? matchingPhraseKey : null,
    bodyPhraseCount: count,
    bodyPhraseFrequency: saturatingFrequency(count),
  };
}

function contextualFeatureFields(contextual: ContextualTitlePrefix | null) {
  if (!contextual) {
    return {
      contextualTitlePrefix: false,
      matchedPrefixTokens: [],
      activeFinalPrefix: null,
      completedTitleToken: null,
      unmatchedTitleTokensAfter: 0,
      titleSequenceTightness: 0,
      contextualPrefixQuality: 0,
    };
  }
  return {
    contextualTitlePrefix: true,
    matchedPrefixTokens: contextual.matchedPrefixTokens,
    activeFinalPrefix: contextual.activeFinalPrefix,
    completedTitleToken: contextual.completedTitleToken,
    unmatchedTitleTokensAfter: contextual.unmatchedTitleTokensAfter,
    titleSequenceTightness: contextual.titleSequenceTightness,
    contextualPrefixQuality: contextual.contextualPrefixQuality,
  };
}

function shadowStandaloneQuery(query: AnalyzedQuery): AnalyzedQuery | null {
  const hint = query.standaloneRecall;
  if (!hint?.key) return null;
  const keyTok: QueryToken = {
    surface: hint.key,
    surfaceNormalized: hint.key,
    normalized: hint.key,
    lemma: hint.key,
    sources: [],
  };
  const lexicalTokens = [keyTok];
  const lexicalPhraseTokens = lexicalTokens.map((token) => token.lemma || token.normalized);
  const concept = standaloneRecallConcept(query);
  return {
    ...query,
    tokens: [keyTok],
    concepts: concept ? [concept] : [],
    alternatives: [],
    prefixCompletion: null,
    contextualCompletion: null,
    configuredSequenceIntent: {
      key: hint.key,
      matchedForm: [...(hint.expansion || [])],
      matchedKinds: ["key"],
    },
    standaloneRecall: null,
    topicalRecall: null,
    lexicalTokens,
    lexicalPhraseTokens,
    lexicalPhraseKey: lexicalPhraseTokens.join(" "),
    stopstripped: [keyTok],
  };
}

function withTopicalRecallFields(
  query: AnalyzedQuery,
  doc: IndexedDocument,
  fields: ReturnType<typeof computeFeatureFields>
) {
  const hint = topicalRecallHint(query);
  if (!hint) return fields;
  let formCount = 0;
  let titleCount = 0;
  let phraseCount = 0;
  for (const form of hint.forms) {
    const ev = topicalFormEvidence(doc, form);
    if (!ev.hit) continue;
    formCount += 1;
    if (ev.title) titleCount += 1;
    if (ev.phrase) phraseCount += 1;
  }
  const match = formCount > 0;
  const score = match ? titleCount * 2 + phraseCount * 0.6 + formCount * 0.3 : 0;
  return {
    ...fields,
    topicalRecallMatch: match,
    topicalRecallFormCount: formCount,
    topicalRecallTitleMatch: titleCount > 0,
    topicalRecallPhraseMatch: phraseCount > 0,
    topicalRecallScore: Number(score.toFixed(4)),
  };
}

function withSynonymRecallFields(
  query: AnalyzedQuery,
  doc: IndexedDocument,
  fields: ReturnType<typeof computeFeatureFields>
) {
  const extras = searchEquivalenceRecallConcepts(query);
  if (!extras.length) return fields;
  let formCount = 0;
  let titleCount = 0;
  let bodyCount = 0;
  for (const concept of extras) {
    const title = conceptMatchesTitle(concept, doc) != null;
    const body = conceptMatchesBody(concept, doc);
    if (!title && !body) continue;
    formCount += 1;
    if (title) titleCount += 1;
    else bodyCount += 1;
  }
  const match = formCount > 0;
  const score = match ? titleCount * 2 + bodyCount * 0.3 + formCount * 0.3 : 0;
  return {
    ...fields,
    equivalentRecallMatch: match,
    equivalentRecallFormCount: formCount,
    equivalentRecallTitleMatch: titleCount > 0,
    equivalentRecallBodyMatch: bodyCount > 0,
    equivalentRecallScore: Number(score.toFixed(4)),
  };
}

function withStandaloneRecallFields(
  query: AnalyzedQuery,
  doc: IndexedDocument,
  fields: ReturnType<typeof computeFeatureFields>
) {
  if (!query.standaloneRecall?.key) return fields;
  const match = documentMatchesStandaloneRecall(query, doc);
  let standaloneRecallScore = 0;
  if (match) {
    const shadow = shadowStandaloneQuery(query);
    if (shadow) standaloneRecallScore = scoreFeatures(extractFeatures(shadow, doc));
  }
  return {
    ...fields,
    standaloneRecallMatch: match,
    standaloneRecallScore,
  };
}

function finishFeatures(
  relationship: RelationshipInfo | null,
  retrievalScore: number,
  fields: ReturnType<typeof computeFeatureFields>
): FeatureVector {
  const base: FeatureVector = {
    ...fields,
    relationshipStrength: relationship?.strength || 0,
    relationshipType: relationship?.type ?? null,
    relationshipSourceId: relationship?.sourceId ?? null,
    retrievalScore: retrievalScore || 0,
    relevanceKind: "direct",
    directClass: "none",
  };
  base.directClass = classifyDirect(base);
  base.relevanceKind = relationship && base.directClass === "none" ? "related" : "direct";
  return base;
}

function computeFeatureFields(query: AnalyzedQuery, doc: IndexedDocument) {
  getQueryFeatPrep(query);
  const vHit = versionHit(query, doc);
  const phrase = compiledPhraseLookup(query, doc);
  const contextual = hasConfiguredSequenceIntent(query) ? null : matchContextualTitlePrefix(query, doc);
  const fieldEvidence = configuredConceptFieldEvidence(query, doc);
  return {
    exactTitleMatch: exactTitle(query, doc),
    exactTitleTokenMatch: exactTitleTokenMatch(query, doc),
    typedSurfaceTitleMatch: typedSurfaceTitleMatch(query, doc),
    titleCoverage: titleCoverage(query, doc),
    queryCoverage: queryCoverage(query, doc, vHit),
    titlePrefixQuality: titlePrefixQuality(query, doc),
    ...contextualFeatureFields(contextual),
    configuredConceptMatch: configuredConceptMatchFromField(fieldEvidence),
    configuredConceptFieldEvidence: fieldEvidence,
    morphologyMatch: morphologyMatch(query, doc),
    typoDistance: typoDistance(query, doc),
    versionMatch: versionMatch(query, doc, vHit),
    shortLiteralLeadMatch: shortLiteralLeadMatch(query, doc),
    dottedSpanComponentTitleMatch: dottedSpanComponentTitleMatch(query, doc),
    phraseAdjacency: phraseAdjacency(query, doc),
    ...lexicalCoverageFields(query, doc),
    ordinaryEquivalenceBodyMatch: ordinaryEquivalenceBodyMatch(query, doc),
    titleTokenCount: doc.nonStopTitle.length,
    configuredFormEvidence: configuredFormEvidence(query, doc),
    configuredFormCoverage: configuredFormCoverage(query),
    configuredFormBodyMatch: configuredFormBodyMatch(query, doc),
    canonicalKeyTitle: canonicalKeyTitle(query, doc),
    queryTokenCount: getQueryFeatPrep(query).lexicalNonStopCount,
    normalizedQueryPhrase: phrase.normalizedQueryPhrase,
    matchingPhraseKey: phrase.matchingPhraseKey,
    bodyPhraseCount: phrase.bodyPhraseCount,
    bodyPhraseFrequency: phrase.bodyPhraseFrequency,
    ...typedPhraseFieldFrequencies(query, doc),
  };
}

export function extractFeatures(
  query: AnalyzedQuery,
  doc: IndexedDocument,
  { relationship = null, retrievalScore = 0 }: { relationship?: RelationshipInfo | null; retrievalScore?: number } = {}
): FeatureVector {
  if (!featureProfile) {
    return finishFeatures(
      relationship,
      retrievalScore,
      withSynonymRecallFields(
        query,
        doc,
        withTopicalRecallFields(query, doc, withStandaloneRecallFields(query, doc, computeFeatureFields(query, doc)))
      )
    );
  }
  timeFeat("queryPrep", () => getQueryFeatPrep(query));
  const vHit = timeFeat("versionHit", () => versionHit(query, doc));
  const phrase = timeFeat("compiledPhraseLookup", () => compiledPhraseLookup(query, doc));
  const contextual = timeFeat("contextualTitlePrefix", () =>
    hasConfiguredSequenceIntent(query) ? null : matchContextualTitlePrefix(query, doc)
  );
  const fieldEvidence = timeFeat("configuredConceptFieldEvidence", () =>
    configuredConceptFieldEvidence(query, doc)
  );
  return finishFeatures(
    relationship,
    retrievalScore,
    withSynonymRecallFields(
      query,
      doc,
      withTopicalRecallFields(query, doc, withStandaloneRecallFields(query, doc, {
    exactTitleMatch: timeFeat("exactTitleMatch", () => exactTitle(query, doc)),
    exactTitleTokenMatch: timeFeat("exactTitleTokenMatch", () => exactTitleTokenMatch(query, doc)),
    typedSurfaceTitleMatch: timeFeat("typedSurfaceTitleMatch", () => typedSurfaceTitleMatch(query, doc)),
    titleCoverage: timeFeat("titleCoverage", () => titleCoverage(query, doc)),
    queryCoverage: timeFeat("queryCoverage", () => queryCoverage(query, doc, vHit)),
    titlePrefixQuality: timeFeat("titlePrefixQuality", () => titlePrefixQuality(query, doc)),
    ...contextualFeatureFields(contextual),
    configuredConceptMatch: configuredConceptMatchFromField(fieldEvidence),
    configuredConceptFieldEvidence: fieldEvidence,
    morphologyMatch: timeFeat("morphologyMatch", () => morphologyMatch(query, doc)),
    typoDistance: timeFeat("typoDistance", () => typoDistance(query, doc)),
    versionMatch: timeFeat("versionMatch", () => versionMatch(query, doc, vHit)),
    shortLiteralLeadMatch: timeFeat("shortLiteralLeadMatch", () => shortLiteralLeadMatch(query, doc)),
    dottedSpanComponentTitleMatch: timeFeat("dottedSpanComponentTitleMatch", () => dottedSpanComponentTitleMatch(query, doc)),
    phraseAdjacency: timeFeat("phraseAdjacency", () => phraseAdjacency(query, doc)),
    ...timeFeat("lexicalCoverageFields", () => lexicalCoverageFields(query, doc)),
    ordinaryEquivalenceBodyMatch: timeFeat("ordinaryEquivalenceBodyMatch", () => ordinaryEquivalenceBodyMatch(query, doc)),
    titleTokenCount: doc.nonStopTitle.length,
    configuredFormEvidence: timeFeat("configuredFormEvidence", () => configuredFormEvidence(query, doc)),
    configuredFormCoverage: timeFeat("configuredFormCoverage", () => configuredFormCoverage(query)),
    configuredFormBodyMatch: timeFeat("configuredFormBodyMatch", () => configuredFormBodyMatch(query, doc)),
    canonicalKeyTitle: timeFeat("canonicalKeyTitle", () => canonicalKeyTitle(query, doc)),
    queryTokenCount: getQueryFeatPrep(query).lexicalNonStopCount,
    normalizedQueryPhrase: phrase.normalizedQueryPhrase,
    matchingPhraseKey: phrase.matchingPhraseKey,
    bodyPhraseCount: phrase.bodyPhraseCount,
    bodyPhraseFrequency: phrase.bodyPhraseFrequency,
    ...typedPhraseFieldFrequencies(query, doc),
      }))
    )
  );
}

/**
 * Interpretable direct-evidence class from named features. Not a float score.
 *   strong   — exact title, configured key-in-title, canonical form title, full coverage, dotted version
 *   moderate — meaningful title match / high query coverage / peer form / phrase
 *   weak     — incidental title token or body-only overlap
 *   none     — no lexical evidence (typical of a pure related neighbor)
 */
export function classifyDirect(f: Partial<FeatureVector>): DirectClass {
  if (
    f.exactTitleMatch ||
    f.configuredConceptMatch === "key-in-title" ||
    f.canonicalKeyTitle ||
    ((f.queryCoverage || 0) >= FULL_QUERY_COVERAGE &&
      (f.titlePrefixQuality || 0) >= STRONG_WITH_FULL_COVERAGE_TITLE_PREFIX_QUALITY) ||
    f.versionMatch === "compact-dotted" ||
    f.versionMatch === "dotted"
  ) {
    return "strong";
  }
  if (
    (f.queryCoverage || 0) >= TWO_THIRDS_QUERY_COVERAGE ||
    (f.titlePrefixQuality || 0) >= MODERATE_TITLE_PREFIX_QUALITY ||
    f.configuredConceptMatch === "form" ||
    (f.configuredFormEvidence || 0) >= TWO_THIRDS_QUERY_COVERAGE ||
    f.configuredFormBodyMatch ||
    f.phraseAdjacency === 1 ||
    f.exactTitleOrSummaryPhrase ||
    f.shortLiteralLeadMatch ||
    f.dottedSpanComponentTitleMatch ||
    (f.exactTitleTokenMatch && (f.queryCoverage || 0) > 0) ||
    ((f.queryTokenCount || 0) >= 2 && (f.bodyPhraseCount || 0) >= REPEATED_BODY_PHRASE_MIN) ||
    f.contextualTitlePrefix
  ) {
    return "moderate";
  }
  if (
    f.exactTitleTokenMatch ||
    f.morphologyMatch ||
    (f.typoDistance || 0) > 0 ||
    (f.bodyLexicalMatch || 0) > 0 ||
    (f.queryCoverage || 0) > 0 ||
    (f.titlePrefixQuality || 0) > 0 ||
    f.configuredConceptMatch ||
    Boolean(f.configuredConceptFieldEvidence?.summary) ||
    Boolean(f.configuredConceptFieldEvidence?.body)
  ) {
    return "weak";
  }
  return "none";
}

export const FEATURE_DEFINITIONS = {
  exactTitleMatch: "True when normalized query equals the full normalized title. Occupied ranking also accepts an authored peer-form join equal to the title. Configured-content identity unions that same peer-form title equality without replacing literal original-surface title equality.",
  exactTitleTokenMatch: "True when a non-stop canonical query token occurs as an independent title token (not a digit split from a dotted numeric span such as 1.2). Unique prefix completions and morphology use the lemma; typed stubs and completedToken are not exact surface evidence. A trailing stub bound by unique contextual form completion is not unbound exact-title-token evidence. Occupied multi-token peer forms contribute only when the title expresses the form (phrase or ≥2 content tokens).",
  typedSurfaceTitleMatch: "True when the typed/repaired surface (before lemma or unique-prefix rewrite) occurs as an independent title token or is a legitimate prefix of one. Digits produced by splitting a dotted span are not typed-surface evidence. Canonical retrieval lemmas are not typed-surface evidence. A trailing stub bound by unique contextual form completion is not unbound title-prefix evidence. Occupied multi-token peer forms contribute only when the title expresses the form.",
  titleCoverage: "Fraction of non-stop title tokens accounted for by the query. A trailing stub bound by unique contextual form completion is excluded. Occupied concepts take the max over peer forms that the title actually expresses.",
  queryCoverage: "Fraction of typed/configured query concepts evidenced in the title (or via a legitimate version alias). Extra search-equivalence recall concepts attached after configured occupancy are excluded. A trailing term concept bound by unique contextual form completion is excluded. Synonym forms merged into an ordinary term concept still count with that concept. Occupied or identity ranking intent excludes structural-wrapper term concepts (WH / copula / determiner) from the coverage set.",
  titlePrefixQuality: "How completely query tokens prefix title tokens, tightened by extra title tokens. A trailing stub bound by unique contextual form completion is excluded. Occupied concepts take the max over peer forms that the title actually expresses. Configured-content identity may use an authored peer form when that form is the full title, a contiguous title phrase, or the entire non-stop title.",
  contextualTitlePrefix: "True when preceding query tokens align with the title start and only the final token is a proper prefix of the aligned title token.",
  matchedPrefixTokens: "Preceding query tokens that aligned exactly/canonically with the title start.",
  activeFinalPrefix: "Final query token used as a contextual title prefix, or null.",
  completedTitleToken: "Title token completed by the contextual final prefix, or null.",
  unmatchedTitleTokensAfter: "Count of title tokens after the aligned final-token completion (0 when the title ends at the completed token).",
  titleSequenceTightness: "1 / (1 + unmatchedTitleTokensAfter). Prefer titles that complete the query and end there.",
  contextualPrefixQuality: "completeness * titleSequenceTightness, where completeness is finalPrefix.length / completedTitleToken.length.",
  configuredConceptMatch: "Configured-concept title match: key-in-title | form | false. The value form means a peer form is in the title, not aliases[0]. Title identity only; summary/body mentions live on configuredConceptFieldEvidence.",
  configuredConceptFieldEvidence: "Structured configured-concept evidence by field: title/summary/body each false | key | form. Title is authored identity. Summary is a weak authored mention. Body is a weak/incidental mention. Neither summary nor body becomes moderate/strong, and ranking does not consume summary vs body-only provenance. A single token of a multi-token form is not form.",
  morphologyMatch: "Query lemma matches a title token/lemma while surface may differ. A trailing stub bound by unique contextual form completion is excluded. Occupied concepts only use one-token peer forms.",
  typoDistance: "0–2 style evidence: 0 none, 1 repeat-collapse or edit-distance 2, 2 edit-distance 1.",
  versionMatch: "false | compact-weak | compact-dotted | dotted | dotted-weak.",
  shortLiteralLeadMatch: "Short query (≤3 tokens, or a stop-wrapped 2-character title-token prefix stub) matches the first surface title token as exact or prefix.",
  dottedSpanComponentTitleMatch: "True when a typed all-digit query token equals a component of a dotted numeric title span (the 2 in 1.2). Not independent exact-title evidence and not a versionMatch.",
  phraseAdjacency: "1 title-adjacent query tokens, 0.5 body-adjacent, else 0.",
  bodyLexicalMatch: "Fraction of typed/configured query concepts evidenced in the body field. Extra search-equivalence recall concepts attached after configured occupancy are excluded from the numerator and denominator. Synonym forms merged into an ordinary term concept still count with that concept.",
  lexicalConceptCoverage: "Fraction of typed/configured coverage concepts with lexical evidence in the title OR the body. Each concept counts once. Not max(queryCoverage, bodyLexicalMatch) and not their sum.",
  coverageConceptCount: "Count of typed/configured coverage concepts (search-equivalence recall concepts excluded; structural-wrapper term concepts excluded under occupied or identity ranking intent). Distinct from queryTokenCount, which for occupied concepts is the max non-stop length of one peer form, not a concatenated alias stream.",
  ordinaryEquivalenceBodyMatch: "True only when the candidate BODY matches a directed target form from an ordinary same-concept search equivalence. This is provenance, not additional lexical coverage or score.",
  titleTokenCount: "Non-stop title token count; used for tightness, not as a boost constant.",
  configuredFormEvidence: "Max fraction of any configured peer form's non-stop tokens evidenced in the title. Denominator is per form. Stopwords are not independent title evidence. A single content token from a multi-token form is not configured identity.",
  configuredFormCoverage: "Occupied matched-form completeness from query analysis (0 when the query does not uniquely occupy a configured concept). Unique occupancy does not imply 1. 2/3 is the existing form-prefix occupancy information bound.",
  configuredFormBodyMatch: "True when an unambiguous partial configured-form prefix (at least 2 tokens and 2/3 coverage, not a complete form) has any contiguous n≥3 peer form in the body.",
  canonicalKeyTitle: "True when the query is exactly a configured key and the title also states most of a peer form.",
  queryTokenCount: "Non-stop analyzed query token count. Occupied concepts use the max non-stop length of one peer form; this summary is not a lexical scoring denominator.",
  normalizedQueryPhrase: "Lemmatized non-stop query tokens joined as the compiled n-gram lookup key. An incomplete final token may be completed through vocabulary+morphology first.",
  matchingPhraseKey: "Compiled n-gram key that matched, or null when the count is 0.",
  bodyPhraseCount: "Build-time integer occurrence count of the normalized query phrase in this document BODY. 0 if missing.",
  bodyPhraseFrequency: "Bounded transform log1p(count)/(1+log1p(count)) of bodyPhraseCount.",
  titlePhraseFrequency: "Exact typed-surface originalSurface occurrences in the title field.",
  summaryPhraseFrequency: "Exact typed-surface originalSurface occurrences in the optional summary field.",
  exactTitleOrSummaryPhrase: "True when the complete typed phrase occurs in title or summary. Strong lexical field evidence, not a score boost.",
  relationshipStrength: "0–1 strength of a precomputed document relationship used for related-result ranking. 0 if none.",
  relationshipType: "Relationship type (semantic, same-category, …) or null. Not a query equivalence.",
  relationshipSourceId: "Primary document id that licensed this related candidate, or null.",
  retrievalScore: "Optional 0–1 retrieval evidence (e.g. normalized BM25). Default 0; not a substitute for constraints.",
  relevanceKind: "direct | related. Related only when directClass is none and query-anchored relationship evidence exists. Weak/moderate/strong lexical class stays direct even when a relationship is attached.",
  directClass: "strong | moderate | weak | none. Interpretable lexical/configured evidence class, independent of relatedness.",
};
