import { isNearCompletePrefix, levenshteinAtMost, DEFAULT_STOP, allowPrefixMatch } from "./text.js";
import { hasIndependentTitleToken, isDottedSpanComponentIndex, queryTokenMatchesDottedSpanComponent } from "./versionForms.js";
import { versionHit, conceptMatchesTitle, conceptMatchesBody, matchContextualTitlePrefix } from "./retrieve.js";
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
  expansion: string[];
  typoTokens: QueryToken[];
  formSet: Set<string>;
  shortLiteralTok: string | null;
};

const queryFeatPrep = new WeakMap<AnalyzedQuery, QueryFeatPrep>();

function getQueryFeatPrep(query: AnalyzedQuery): QueryFeatPrep {
  const cached = queryFeatPrep.get(query);
  if (cached) return cached;
  const tokens = query.tokens || [];
  const nonStop = tokens.filter((t) => !DEFAULT_STOP.has(t.normalized) || tokens.length <= 2);
  const nonStopUse = nonStop.length ? nonStop : tokens;
  const lexicalSource = Array.isArray(query.lexicalTokens) && query.lexicalTokens.length ? query.lexicalTokens : tokens;
  const lexicalNonStop = lexicalSource.filter((t) => !DEFAULT_STOP.has(t.normalized) || lexicalSource.length <= 2);
  const lexicalUse = lexicalNonStop.length ? lexicalNonStop : lexicalSource;
  const acronym = query.concepts.find((c) => c.kind === "acronym") || null;
  const expansion =
    acronym == null
      ? []
      : Array.isArray(acronym.expansion) && acronym.expansion.length
        ? acronym.expansion.filter((f) => f !== acronym.id && !/^\d+$/.test(f))
        : (acronym.forms || []).filter((f) => f !== acronym.id && !/^\d+$/.test(f));
  const formSet = new Set<string>();
  for (const c of query.concepts) {
    if (c.kind === "acronym") continue;
    for (const form of c.forms || []) formSet.add(form);
  }
  const phraseKeys = phraseKeyCandidates(query);
  const prep: QueryFeatPrep = {
    joinedNorm: tokens.map((t) => t.normalized).join(" "),
    nonStop: nonStopUse,
    nonStopNorm: nonStopUse.map((t) => t.normalized),
    nonStopLemma: nonStopUse.map((t) => t.lemma || t.normalized),
    lexicalNonStopCount: lexicalUse.length,
    phraseKeys,
    primaryPhrase: phraseKeys[0] || "",
    acronym,
    isConfiguredKey: Boolean(acronym && tokens.length === 1 && tokens[0].normalized === acronym.id),
    expansion,
    typoTokens: tokens.filter((t) => t.normalized.length >= 5),
    formSet,
    shortLiteralTok: tokens.length === 1 && tokens[0].normalized.length <= 3 ? tokens[0].normalized : null,
  };
  queryFeatPrep.set(query, prep);
  return prep;
}

type ConfiguredEquivalenceMatch = false | "key-in-title" | "expansion";
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
  const q = getQueryFeatPrep(query).joinedNorm;
  return q.length > 0 && q === doc.normalizedTitle;
}

function tokenLiteral(t: QueryToken) {
  return t.surfaceNormalized || t.surface;
}

function hasBoundContextualCompletion(query: AnalyzedQuery) {
  return Boolean(query.contextualCompletion?.completedToken);
}

function hasIndependentTitleTokenFast(doc: IndexedDocument, tok: string) {
  if (doc.independentTitleTokenSet) return doc.independentTitleTokenSet.has(tok);
  return hasIndependentTitleToken(doc, tok);
}

function exactTitleTokenMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  return query.tokens.some((t) => {
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
  const last = query.tokens[query.tokens.length - 1];
  const skipLast = hasBoundContextualCompletion(query);
  return query.tokens.some((t) => {
    if (skipLast && t === last) return false;
    const literal = tokenLiteral(t);
    if (!literal || DEFAULT_STOP.has(literal)) return false;
    if (hasIndependentTitleTokenFast(doc, literal)) return true;
    return independent.some(
      (tok) => allowPrefixMatch(literal, tok) || isNearCompletePrefix(literal, tok)
    );
  });
}

function titlePrefixQuality(query: AnalyzedQuery, doc: IndexedDocument) {
  const last = query.tokens[query.tokens.length - 1];
  const skipLast = hasBoundContextualCompletion(query);
  const qToks = queryNonStop(query).filter((qt) => !(skipLast && qt === last));
  const independent = independentTitleTokensOf(doc);
  if (!qToks.length || !doc.titleTokens.length) return 0;
  let matched = 0;
  let prefixChars = 0;
  let titleChars = 0;
  for (const qt of qToks) {
    titleChars += qt.normalized.length;
    const hit = independent.find(
      (tok) => allowPrefixMatch(qt.normalized, tok) || isNearCompletePrefix(qt.normalized, tok)
    );
    if (hit) {
      matched += 1;
      prefixChars += qt.normalized.length;
    }
  }
  if (!matched) return 0;
  const coverage = matched / qToks.length;
  const completeness = titleChars ? prefixChars / Math.max(titleChars, 1) : 0;
  const tightness = qToks.length / Math.max(doc.nonStopTitle.length, 1);
  return Number((0.5 * coverage + 0.3 * completeness + 0.2 * Math.min(1, tightness)).toFixed(4));
}

function queryCoverage(query: AnalyzedQuery, doc: IndexedDocument, v: ReturnType<typeof versionHit> = versionHit(query, doc)) {
  const concepts = query.concepts.filter((c) => c.kind !== "number" || query.concepts.length === 1);
  const usable = concepts.length ? concepts : query.concepts;
  if (!usable.length) return 0;
  const vOk = Boolean(v);
  let hit = 0;
  for (const c of usable) {
    if (conceptCoveredInTitle(c, doc) || vOk) hit += 1;
    else if (c.kind === "number" && vOk) hit += 1;
  }
  // Count number concepts via version hit once
  const hasNumber = query.concepts.some((c) => c.kind === "number");
  if (hasNumber && v) {
    const withoutNum = query.concepts.filter((c) => c.kind !== "number");
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
  const qToks = query.tokens;
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
}

function configuredEquivalenceMatch(query: AnalyzedQuery, doc: IndexedDocument): ConfiguredEquivalenceMatch {
  const acr = getQueryFeatPrep(query).acronym;
  if (!acr) return false;
  if (doc.titleTokenSet.has(acr.id) || doc.titleLemmaSet.has(acr.id)) return "key-in-title";
  if (conceptMatchesTitle(acr, doc)) return "expansion";
  return false;
}

function morphologyMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  return query.tokens.some((t) => {
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
  const tok = getQueryFeatPrep(query).shortLiteralTok;
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

function phraseAdjacency(query: AnalyzedQuery, doc: IndexedDocument) {
  const prep = getQueryFeatPrep(query);
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

function expansionEvidence(query: AnalyzedQuery, doc: IndexedDocument) {
  const expansion = getQueryFeatPrep(query).expansion;
  if (!expansion.length) return 0;
  const hits = expansion.filter((f) => doc.titleTokenSet.has(f) || doc.titleLemmaSet.has(f));
  return Number((hits.length / expansion.length).toFixed(4));
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
  return expansionEvidence(query, doc) >= 0.5;
}

function hasDirectTitleEvidence(f: Partial<FeatureVector>) {
  if (f.exactTitleMatch || f.exactTitleTokenMatch) return true;
  if ((f.queryCoverage || 0) > 0) return true;
  if (f.configuredEquivalenceMatch) return true;
  if (f.morphologyMatch) return true;
  if (f.versionMatch) return true;
  if (f.dottedSpanComponentTitleMatch) return true;
  if ((f.titlePrefixQuality || 0) > 0) return true;
  if (f.canonicalKeyTitle) return true;
  if (f.contextualTitlePrefix) return true;
  return false;
}

function bodyLexicalMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  let hits = 0;
  for (const c of query.concepts) {
    if (conceptMatchesBody(c, doc)) hits += 1;
  }
  if (!query.concepts.length) return 0;
  return Number((hits / query.concepts.length).toFixed(4));
}

function lexicalPhraseQueryTokens(query: AnalyzedQuery) {
  if (Array.isArray(query.lexicalTokens) && query.lexicalTokens.length) return query.lexicalTokens;
  return query.tokens;
}

function phraseKeyCandidates(query: AnalyzedQuery) {
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
    if (n > count) {
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
  const direct = hasDirectTitleEvidence(base);
  base.directClass = classifyDirect(base);
  base.relevanceKind = relationship && !direct ? "related" : "direct";
  return base;
}

function computeFeatureFields(query: AnalyzedQuery, doc: IndexedDocument) {
  getQueryFeatPrep(query);
  const vHit = versionHit(query, doc);
  const phrase = compiledPhraseLookup(query, doc);
  const contextual = matchContextualTitlePrefix(query, doc);
  return {
    exactTitleMatch: exactTitle(query, doc),
    exactTitleTokenMatch: exactTitleTokenMatch(query, doc),
    typedSurfaceTitleMatch: typedSurfaceTitleMatch(query, doc),
    titleCoverage: titleCoverage(query, doc),
    queryCoverage: queryCoverage(query, doc, vHit),
    titlePrefixQuality: titlePrefixQuality(query, doc),
    ...contextualFeatureFields(contextual),
    configuredEquivalenceMatch: configuredEquivalenceMatch(query, doc),
    morphologyMatch: morphologyMatch(query, doc),
    typoDistance: typoDistance(query, doc),
    versionMatch: versionMatch(query, doc, vHit),
    shortLiteralLeadMatch: shortLiteralLeadMatch(query, doc),
    dottedSpanComponentTitleMatch: dottedSpanComponentTitleMatch(query, doc),
    phraseAdjacency: phraseAdjacency(query, doc),
    bodyLexicalMatch: bodyLexicalMatch(query, doc),
    titleTokenCount: doc.nonStopTitle.length,
    expansionEvidence: expansionEvidence(query, doc),
    canonicalKeyTitle: canonicalKeyTitle(query, doc),
    queryTokenCount: getQueryFeatPrep(query).lexicalNonStopCount,
    normalizedQueryPhrase: phrase.normalizedQueryPhrase,
    matchingPhraseKey: phrase.matchingPhraseKey,
    bodyPhraseCount: phrase.bodyPhraseCount,
    bodyPhraseFrequency: phrase.bodyPhraseFrequency,
  };
}

export function extractFeatures(
  query: AnalyzedQuery,
  doc: IndexedDocument,
  { relationship = null, retrievalScore = 0 }: { relationship?: RelationshipInfo | null; retrievalScore?: number } = {}
): FeatureVector {
  if (!featureProfile) {
    return finishFeatures(relationship, retrievalScore, computeFeatureFields(query, doc));
  }
  timeFeat("queryPrep", () => getQueryFeatPrep(query));
  const vHit = timeFeat("versionHit", () => versionHit(query, doc));
  const phrase = timeFeat("compiledPhraseLookup", () => compiledPhraseLookup(query, doc));
  const contextual = timeFeat("contextualTitlePrefix", () => matchContextualTitlePrefix(query, doc));
  return finishFeatures(relationship, retrievalScore, {
    exactTitleMatch: timeFeat("exactTitleMatch", () => exactTitle(query, doc)),
    exactTitleTokenMatch: timeFeat("exactTitleTokenMatch", () => exactTitleTokenMatch(query, doc)),
    typedSurfaceTitleMatch: timeFeat("typedSurfaceTitleMatch", () => typedSurfaceTitleMatch(query, doc)),
    titleCoverage: timeFeat("titleCoverage", () => titleCoverage(query, doc)),
    queryCoverage: timeFeat("queryCoverage", () => queryCoverage(query, doc, vHit)),
    titlePrefixQuality: timeFeat("titlePrefixQuality", () => titlePrefixQuality(query, doc)),
    ...contextualFeatureFields(contextual),
    configuredEquivalenceMatch: timeFeat("configuredEquivalenceMatch", () => configuredEquivalenceMatch(query, doc)),
    morphologyMatch: timeFeat("morphologyMatch", () => morphologyMatch(query, doc)),
    typoDistance: timeFeat("typoDistance", () => typoDistance(query, doc)),
    versionMatch: timeFeat("versionMatch", () => versionMatch(query, doc, vHit)),
    shortLiteralLeadMatch: timeFeat("shortLiteralLeadMatch", () => shortLiteralLeadMatch(query, doc)),
    dottedSpanComponentTitleMatch: timeFeat("dottedSpanComponentTitleMatch", () => dottedSpanComponentTitleMatch(query, doc)),
    phraseAdjacency: timeFeat("phraseAdjacency", () => phraseAdjacency(query, doc)),
    bodyLexicalMatch: timeFeat("bodyLexicalMatch", () => bodyLexicalMatch(query, doc)),
    titleTokenCount: doc.nonStopTitle.length,
    expansionEvidence: timeFeat("expansionEvidence", () => expansionEvidence(query, doc)),
    canonicalKeyTitle: timeFeat("canonicalKeyTitle", () => canonicalKeyTitle(query, doc)),
    queryTokenCount: getQueryFeatPrep(query).lexicalNonStopCount,
    normalizedQueryPhrase: phrase.normalizedQueryPhrase,
    matchingPhraseKey: phrase.matchingPhraseKey,
    bodyPhraseCount: phrase.bodyPhraseCount,
    bodyPhraseFrequency: phrase.bodyPhraseFrequency,
  });
}

/**
 * Interpretable direct-evidence class from named features. Not a float score.
 *   strong   — exact title, configured key-in-title, canonical expansion title, full coverage, dotted version
 *   moderate — meaningful title match / high query coverage / expansion / phrase
 *   weak     — incidental title token or body-only overlap
 *   none     — no lexical evidence (typical of a pure related neighbor)
 */
export function classifyDirect(f: Partial<FeatureVector>): DirectClass {
  if (
    f.exactTitleMatch ||
    f.configuredEquivalenceMatch === "key-in-title" ||
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
    f.configuredEquivalenceMatch === "expansion" ||
    f.phraseAdjacency === 1 ||
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
    f.configuredEquivalenceMatch
  ) {
    return "weak";
  }
  return "none";
}

export const FEATURE_DEFINITIONS = {
  exactTitleMatch: "True when normalized query equals the full normalized title.",
  exactTitleTokenMatch: "True when a non-stop canonical query token occurs as an independent title token (not a digit split from a dotted numeric span such as 1.2). Unique prefix completions and morphology use the lemma; typed stubs and completedToken are not exact surface evidence.",
  typedSurfaceTitleMatch: "True when the typed/repaired surface (before lemma or unique-prefix rewrite) occurs as an independent title token or is a legitimate prefix of one. Digits produced by splitting a dotted span are not typed-surface evidence. Canonical retrieval lemmas are not typed-surface evidence. A trailing stub bound by unique contextual expansion completion is not unbound title-prefix evidence.",
  titleCoverage: "Fraction of non-stop title tokens accounted for by the query.",
  queryCoverage: "Fraction of query concepts evidenced in the title (or via a legitimate version alias).",
  titlePrefixQuality: "How completely query tokens prefix title tokens, tightened by extra title tokens. A trailing stub bound by unique contextual expansion completion is excluded.",
  contextualTitlePrefix: "True when preceding query tokens align with the title start and only the final token is a proper prefix of the aligned title token.",
  matchedPrefixTokens: "Preceding query tokens that aligned exactly/canonically with the title start.",
  activeFinalPrefix: "Final query token used as a contextual title prefix, or null.",
  completedTitleToken: "Title token completed by the contextual final prefix, or null.",
  unmatchedTitleTokensAfter: "Count of title tokens after the aligned final-token completion (0 when the title ends at the completed token).",
  titleSequenceTightness: "1 / (1 + unmatchedTitleTokensAfter). Prefer titles that complete the query and end there.",
  contextualPrefixQuality: "completeness * titleSequenceTightness, where completeness is finalPrefix.length / completedTitleToken.length.",
  configuredEquivalenceMatch: "Dictionary hit: key-in-title | expansion | false.",
  morphologyMatch: "Query lemma matches a title token/lemma while surface may differ.",
  typoDistance: "0–2 style evidence: 0 none, 1 repeat-collapse or edit-distance 2, 2 edit-distance 1.",
  versionMatch: "false | compact-weak | compact-dotted | dotted | dotted-weak.",
  shortLiteralLeadMatch: "Short query (≤3) matches the first surface title token as exact or prefix.",
  dottedSpanComponentTitleMatch: "True when a typed all-digit query token equals a component of a dotted numeric title span (the 2 in 1.2). Not independent exact-title evidence and not a versionMatch.",
  phraseAdjacency: "1 title-adjacent query tokens, 0.5 body-adjacent, else 0.",
  bodyLexicalMatch: "Fraction of query concepts evidenced in the body field.",
  titleTokenCount: "Non-stop title token count; used for tightness, not as a boost constant.",
  expansionEvidence: "Fraction of a configured expansion evidenced in the title.",
  canonicalKeyTitle: "True when the query is exactly a configured key and the title also states most of the expansion.",
  queryTokenCount: "Non-stop analyzed query token count.",
  normalizedQueryPhrase: "Lemmatized non-stop query tokens joined as the compiled n-gram lookup key. An incomplete final token may be completed through vocabulary+morphology first.",
  matchingPhraseKey: "Compiled n-gram key that matched, or null when the count is 0.",
  bodyPhraseCount: "Build-time integer occurrence count of the normalized query phrase in this document BODY. 0 if missing.",
  bodyPhraseFrequency: "Bounded transform log1p(count)/(1+log1p(count)) of bodyPhraseCount.",
  relationshipStrength: "0–1 strength of a precomputed document relationship used for related-result ranking. 0 if none.",
  relationshipType: "Relationship type (semantic, same-category, …) or null. Not a query equivalence.",
  relationshipSourceId: "Primary document id that licensed this related candidate, or null.",
  retrievalScore: "Optional 0–1 retrieval evidence (e.g. normalized BM25). Default 0; not a substitute for constraints.",
  relevanceKind: "direct | related. Related never counts as direct-intent evidence.",
  directClass: "strong | moderate | weak | none. Interpretable lexical evidence class, independent of relatedness.",
};
