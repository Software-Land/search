/**
 * Replaceable candidate retrieval.
 *
 * Query analysis and ranking stay in Search Core. Retrievers emit
 * { document, retrievalSources, retrievalScore? } only.
 *
 * Exact compiled lexical retrieval is the default production path: every
 * legitimate posting match is enumerated and provenance is reconstructed from
 * hydrated IndexedDocument state. The older budgeted BM25-ish retriever remains
 * below only for explicit experimental compatibility. Full-scan is the
 * small-corpus/reference mode.
 */

import {
  retrieveCandidates,
  retrieveCandidatesAsync,
  matchContextualTitlePrefix,
  retrievalSourcesForDocument,
  unboundTypedTokens,
  isBoundTrailingTermConcept,
  identityTokens,
  evidenceTokens,
  standaloneRecallHint,
  topicalRecallHint,
  shortTitleTokenPrefixStub,
  isSearchEquivalenceRecallConcept,
  retrievalFormKindAllowsPrefix,
  occupiedTitleJoins,
  configuredPeerForms,
  formContentTokens,
  formAllowsOrdinaryLexicalPrefix,
} from "./retrieve.js";
import { querySemanticFacts } from "../query/querySemantics.js";
import { allowPrefixMatch, DEFAULT_STOP } from "../text/text.js";
import { isAllDigitToken } from "../text/versionForms.js";
import { throwIfAborted } from "../cancel.js";
import { checkpoint, createCooperation, readCooperation, type Cooperation } from "../execution/cooperate.js";
import {
  ensureCompiledLexicalIndex,
  type CompiledLexicalRuntime,
  type CompiledTermRuntime,
} from "../indexing/lexicalIndex.js";
import { planBodyPostingPruning, bodyPostingPruningUnsupportedReason } from "./exactBlockSkip.js";
import type { RankingEvidenceFieldCode } from "../ranking/evidence/rankingEvidencePlan.js";
import type { RankingEvidenceSession } from "../ranking/evidence/rankingEvidenceState.js";
import type {
  AdaptiveRetrieverOptions,
  AnalyzedQuery,
  IndexedLexicalOptions,
  IndexedLexicalState,
  Posting,
  RetrievalHit,
  Retriever,
  RetrieveOptions,
  SearchIndex,
} from "../types.js";

type QueryFormKind = "token" | "lemma" | "acronym-key" | "concept" | "acronym-form" | "standalone-recall" | "topical-recall" | "equivalent-recall" | "configured-prefix-recall";
type QueryForm = { form: string; kind: QueryFormKind };
type AdaptiveActive = "full-scan" | "indexed-lexical";

interface IndexedHit {
  pos: number;
  retrievalSources: string[];
  retrievalScore: number;
}

// Keep the legacy retriever graph independent of the evidence-plan runtime.
// These codes are part of the private writer contract and are type-checked
// against RankingEvidenceFieldCode at each call site.
const RANKING_EVIDENCE_TITLE_FIELD: RankingEvidenceFieldCode = 0;
const RANKING_EVIDENCE_BODY_FIELD: RankingEvidenceFieldCode = 1;
const RANKING_EVIDENCE_NO_ACTION = 0;

type RankingEvidenceRetrieverCapability = {
  retrieve(
    query: AnalyzedQuery,
    index: SearchIndex,
    options: RetrieveOptions,
    writer: RankingEvidenceSession
  ): RetrievalHit[] | null;
  retrieveAsync(
    query: AnalyzedQuery,
    index: SearchIndex,
    options: RetrieveOptions,
    writer: RankingEvidenceSession
  ): Promise<RetrievalHit[] | null>;
};

const rankingEvidenceCapabilities = new WeakMap<object, RankingEvidenceRetrieverCapability>();

/** Internal capability lookup; does not alter Retriever or RetrieveOptions. */
export function hasRankingEvidenceRetrieverCapability(retriever: Retriever) {
  return rankingEvidenceCapabilities.has(retriever as object);
}

/** Internal sync evidence retrieval. Null means this retriever branch is unsupported. */
export function retrieveWithRankingEvidence(
  retriever: Retriever,
  query: AnalyzedQuery,
  index: SearchIndex,
  writer: RankingEvidenceSession,
  options: RetrieveOptions = {}
): RetrievalHit[] | null {
  const capability = rankingEvidenceCapabilities.get(retriever as object);
  return capability ? capability.retrieve(query, index, options, writer) : null;
}

/** Internal async evidence retrieval. Null means this retriever branch is unsupported. */
export async function retrieveWithRankingEvidenceAsync(
  retriever: Retriever,
  query: AnalyzedQuery,
  index: SearchIndex,
  writer: RankingEvidenceSession,
  options: RetrieveOptions = {}
): Promise<RetrievalHit[] | null> {
  const capability = rankingEvidenceCapabilities.get(retriever as object);
  return capability
    ? capability.retrieveAsync(query, index, options, writer)
    : null;
}

// Exact-title, configured-concept, version, and configured-prefix-recall
// key identity bypass the BM25 budget without a cap. Contextual title-prefix
// and full-query title-prefix are capped must-keeps: overflow stays eligible
// for the ordinary candidateLimit pool. Title-prefix keeps short-literal /
// query-"2" winners from losing to high-TF body floods.
const UNBOUNDED_MUST_KEEP = new Set<string>(["exact-title", "configured-concept", "version", "configured-prefix-recall"]);
const CONTEXTUAL_MUST_KEEP_SOURCE = "contextual-title-prefix";
const TITLE_PREFIX_KEEP_SOURCE = "title-prefix";
const K1 = 1.2;
const B = 0.75;
const TITLE_BOOST = 4;

function postingTitleSource(kind: QueryFormKind) {
  if (kind === "acronym-key" || kind === "acronym-form") return "configured-concept";
  if (kind === "standalone-recall") return "standalone-recall";
  if (kind === "topical-recall") return "topical-recall";
  if (kind === "equivalent-recall") return "equivalent-recall";
  if (kind === "configured-prefix-recall") return "configured-prefix-recall";
  return "title-token";
}

function postingBodySource(kind: QueryFormKind) {
  if (kind === "standalone-recall") return "standalone-recall";
  if (kind === "topical-recall") return "topical-recall";
  if (kind === "equivalent-recall") return "equivalent-recall";
  if (kind === "configured-prefix-recall") return "configured-prefix-recall";
  return "body-lexical";
}

function titleNormsForQuery(query: AnalyzedQuery): string[] {
  const joins = occupiedTitleJoins(query);
  if (joins.length) return joins;
  const qNorm = identityTokens(query).map((t) => t.normalized).join(" ");
  return qNorm ? [qNorm] : [];
}

function formKindAllowsPrefix(kind: QueryFormKind, query: AnalyzedQuery, form: string) {
  return retrievalFormKindAllowsPrefix(kind) && formAllowsOrdinaryLexicalPrefix(query, form);
}

function pushSource(hit: { retrievalSources: string[] }, source: string) {
  if (!hit.retrievalSources.includes(source)) hit.retrievalSources.push(source);
}

function idf(n: number, df: number) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function bm25Tf(tf: number, dl: number, avgdl: number) {
  const denom = tf + K1 * (1 - B + B * (dl / Math.max(avgdl, 1)));
  return (tf * (K1 + 1)) / Math.max(denom, 1e-9);
}

function lowerBoundNorm(arr: Array<{ norm: string }>, key: string) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].norm < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundTerm(terms: string[], key: string) {
  let lo = 0;
  let hi = terms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (terms[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function eachTitlePrefixTerm(sortedTerms: string[], stub: string, onTerm: (term: string) => void) {
  if (!stub) return;
  let i = lowerBoundTerm(sortedTerms, stub);
  while (i < sortedTerms.length) {
    const term = sortedTerms[i++];
    if (!term.startsWith(stub)) break;
    if (term === stub || isAllDigitToken(term)) continue;
    onTerm(term);
  }
}

function queryForms(query: AnalyzedQuery) {
  const forms: QueryForm[] = [];
  const seen = new Set<string>();
  function add(form: unknown, kind: QueryFormKind) {
    const f = String(form || "");
    if (!f || seen.has(`${kind}:${f}`)) return;
    seen.add(`${kind}:${f}`);
    forms.push({ form: f, kind });
  }
  const semantics = querySemanticFacts(query);
  const occupied = Boolean(semantics.configured.occupiedKey);
  if (!occupied) {
    for (const tok of evidenceTokens(query)) {
      add(tok.normalized, "token");
      if (tok.lemma && tok.lemma !== tok.normalized) add(tok.lemma, "lemma");
    }
  }
  for (const c of query.concepts || []) {
    if (isBoundTrailingTermConcept(query, c)) continue;
    if (isSearchEquivalenceRecallConcept(query, c)) {
      add(c.id, "equivalent-recall");
      for (const f of c.forms || []) {
        add(f, "equivalent-recall");
        const parts = String(f).split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
          for (const part of parts) add(part, "equivalent-recall");
        }
      }
      continue;
    }
    if (c.kind === "configured-concept") {
      add(c.id, "acronym-key");
      for (const form of configuredPeerForms(c)) {
        const join = form.join(" ");
        if (join) add(join, "acronym-form");
        // Candidate generation is a union of peer forms, not a concatenated
        // token query. Stopwords never become independent retrieval terms.
        // Multi-token content tokens probe inverted lists; scanDocument then
        // rechecks form-level provenance before a hit is kept.
        if (form.length === 1) {
          if (form[0] && !DEFAULT_STOP.has(form[0])) add(form[0], "acronym-form");
        } else {
          for (const part of formContentTokens(form)) add(part, "acronym-form");
        }
      }
      continue;
    }
    add(c.id, "concept");
    for (const f of c.forms || []) {
      add(f, "concept");
      const parts = String(f).split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        for (const part of parts) add(part, "concept");
      }
    }
  }
  const hint = standaloneRecallHint(query);
  if (hint) {
    add(hint.key, "standalone-recall");
    for (const f of hint.forms || []) add(f, "standalone-recall");
  }
  const topical = topicalRecallHint(query);
  if (topical) {
    for (const form of topical.forms || []) {
      for (const token of form) add(token, "topical-recall");
    }
  }
  for (const row of semantics.configured.weakRecall?.candidates || []) {
    if (row.key) add(row.key, "configured-prefix-recall");
  }
  return forms;
}

export function createFullScanRetriever(): Retriever {
  return {
    name: "full-scan",
    prepare() {},
    retrieve(query, index, opts = {}) {
      return retrieveCandidates(query, index, { signal: opts.signal });
    },
    retrieveAsync(query, index, opts = {}) {
      return retrieveCandidatesAsync(query, index, opts);
    },
    stats() {
      return { kind: "full-scan" };
    },
  };
}

function emptyPosting(): Posting {
  return { df: 0, docs: [], tfs: [] };
}

function addTokenCounts(map: Map<string, Posting>, tokens: string[], docPos: number) {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  for (const [term, tf] of counts) {
    let e = map.get(term);
    if (!e) {
      e = emptyPosting();
      map.set(term, e);
    }
    e.df += 1;
    e.docs.push(docPos);
    e.tfs.push(tf);
  }
  return counts;
}

function postingLength(counts: Map<string, number>) {
  let n = 0;
  for (const tf of counts.values()) n += tf;
  return Math.max(n, 1);
}

/**
 * Inverted lexical index + deterministic exact sources.
 * BM25 scores order the budgeted (non-exact) slice only.
 */
export function createIndexedLexicalRetriever({
  candidateLimit = 200,
  prefixCap = 800,
  unionDeterministic = true,
  titleBoost = TITLE_BOOST,
}: IndexedLexicalOptions = {}): Retriever {
  const state: IndexedLexicalState = {
    prepared: false,
    n: 0,
    titlePostings: new Map(),
    bodyPostings: new Map(),
    titleLemmaPostings: new Map(),
    bodyLemmaPostings: new Map(),
    sortedTerms: [],
    sortedTitles: [],
    titleByNorm: new Map(),
    versionIndex: new Map(),
    titleDl: [],
    bodyDl: [],
    avgTitleDl: 1,
    avgBodyDl: 1,
    postingBytes: 0,
    termCount: 0,
  };

  function prepare(index: SearchIndex) {
    const docs = index.documents || [];
    state.n = docs.length;
    state.titlePostings = new Map();
    state.bodyPostings = new Map();
    state.titleLemmaPostings = new Map();
    state.bodyLemmaPostings = new Map();
    state.titleByNorm = new Map();
    state.versionIndex = new Map();
    state.titleDl = new Array(docs.length);
    state.bodyDl = new Array(docs.length);
    let titleLen = 0;
    let bodyLen = 0;
    const titles: Array<{ norm: string; pos: number }> = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const tCounts = addTokenCounts(state.titlePostings, doc.titleTokens || [], i);
      addTokenCounts(state.titleLemmaPostings, doc.titleLemmas || [], i);
      const bCounts = addTokenCounts(state.bodyPostings, doc.bodyTokens || [], i);
      addTokenCounts(state.bodyLemmaPostings, doc.bodyLemmas || [], i);
      state.titleDl[i] = postingLength(tCounts);
      state.bodyDl[i] = postingLength(bCounts);
      titleLen += state.titleDl[i];
      bodyLen += state.bodyDl[i];
      const norm = doc.normalizedTitle || "";
      titles.push({ norm, pos: i });
      if (!state.titleByNorm.has(norm)) state.titleByNorm.set(norm, []);
      state.titleByNorm.get(norm)?.push(i);
      for (const form of doc.versionCompactForms || []) {
        if (!state.versionIndex.has(form)) state.versionIndex.set(form, []);
        state.versionIndex.get(form)?.push(i);
      }
      for (const span of doc.dottedSpans || []) {
        if (!state.versionIndex.has(span)) state.versionIndex.set(span, []);
        state.versionIndex.get(span)?.push(i);
      }
    }
    titles.sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : a.pos - b.pos));
    state.sortedTitles = titles;
    const termSet = new Set([
      ...state.titlePostings.keys(),
      ...state.bodyPostings.keys(),
      ...state.titleLemmaPostings.keys(),
    ]);
    state.sortedTerms = [...termSet].sort();
    state.avgTitleDl = state.n ? titleLen / state.n : 1;
    state.avgBodyDl = state.n ? bodyLen / state.n : 1;
    state.termCount = state.sortedTerms.length;
    let postings = 0;
    for (const m of [state.titlePostings, state.bodyPostings, state.titleLemmaPostings, state.bodyLemmaPostings]) {
      for (const e of m.values()) postings += e.docs.length;
    }
    state.postingBytes = postings * 8 + state.termCount * 16;
    state.prepared = true;
  }

  function addHit(byPos: Map<number, IndexedHit>, pos: number, source: string, scoreDelta?: number) {
    let hit = byPos.get(pos);
    if (!hit) {
      hit = { pos, retrievalSources: [], retrievalScore: 0 };
      byPos.set(pos, hit);
    }
    pushSource(hit, source);
    if (scoreDelta) hit.retrievalScore += scoreDelta;
  }

  function accumulatePosting(
    byPos: Map<number, IndexedHit>,
    posting: Posting | undefined,
    source: string,
    fieldBoost: number,
    avgdl: number,
    dlArr: number[],
    { signal, n, coop }: { signal?: AbortSignal; n?: number; coop?: Cooperation | null } = {}
  ): void | Promise<void> {
    if (!posting) return;
    const w = idf(n || 0, posting.df) * fieldBoost;
    let i = 0;
    const run = (): void | Promise<void> => {
      while (i < posting.docs.length) {
        if ((i & 63) === 0) {
          const pending = checkpoint(coop, signal, 64);
          if (pending) return pending.then(run);
        }
        const pos = posting.docs[i];
        const tf = posting.tfs[i];
        addHit(byPos, pos, source, w * bm25Tf(tf, dlArr[pos], avgdl));
        i += 1;
      }
    };
    return run();
  }

  function prefixTerms(prefix: string, accept: (term: string) => boolean) {
    if (!prefix) return [];
    const out: string[] = [];
    let i = lowerBoundTerm(state.sortedTerms, prefix);
    while (i < state.sortedTerms.length) {
      const term = state.sortedTerms[i];
      if (!term.startsWith(prefix)) break;
      if (accept(term)) out.push(term);
      i += 1;
    }
    return out;
  }

  async function retrieveIndexed(query: AnalyzedQuery, index: SearchIndex, { signal, candidateLimit: limitOverride }: RetrieveOptions = {}, coop: Cooperation | null = null, box: { settled: boolean; result?: any; error?: unknown } | null = null) {
    try {
    throwIfAborted(signal);
    if (!state.prepared) prepare(index);
    const docs = index.documents || [];
    const n = state.n || docs.length;
    const byPos = new Map<number, IndexedHit>();
    const k = limitOverride || candidateLimit;
    const forms = queryForms(query);
    const semantics = querySemanticFacts(query);
    const occupied = Boolean(semantics.configured.occupiedKey);
    const prefixRecallTitleOnly = semantics.configured.weakRecall?.ambiguity === "group";
    for (const qNorm of titleNormsForQuery(query)) {
      const exact = state.titleByNorm.get(qNorm);
      if (exact) {
        for (const pos of exact) addHit(byPos, pos, "exact-title", 50);
      }
      const start = lowerBoundNorm(state.sortedTitles, qNorm);
      const prefixHits: Array<{ norm: string; pos: number }> = [];
      for (let i = start; i < state.sortedTitles.length; i++) {
        const row = state.sortedTitles[i];
        if (!row.norm.startsWith(qNorm)) break;
        prefixHits.push(row);
        if (prefixHits.length >= prefixCap * 4) break;
      }
      prefixHits.sort((a, b) => {
        const ta = qNorm.length / Math.max(a.norm.length, 1);
        const tb = qNorm.length / Math.max(b.norm.length, 1);
        if (tb !== ta) return tb - ta;
        return a.pos - b.pos;
      });
      const cap = qNorm.length <= 2 ? prefixCap : Math.min(prefixCap, k * 4);
      for (let i = 0; i < Math.min(prefixHits.length, cap); i++) {
        addHit(byPos, prefixHits[i].pos, "title-prefix", 8 * (qNorm.length / Math.max(prefixHits[i].norm.length, 1)));
      }
    }

    const post = (posting: Posting | undefined, source: string, boost: number, avgdl: number, lengths: number[]) =>
      accumulatePosting(byPos, posting, source, boost, avgdl, lengths, { signal, n, coop });

    let step = 0;
    for (const { form, kind } of forms) {
      if ((step++ & 7) === 0) {
        const pending = checkpoint(coop, signal, 8);
        if (pending) await pending;
      }
      const titleP = state.titlePostings.get(form);
      if (titleP) {
        const pending = post(titleP, postingTitleSource(kind), titleBoost, state.avgTitleDl, state.titleDl);
        if (pending) await pending;
      }
      const skipPrefixBody = kind === "configured-prefix-recall" && prefixRecallTitleOnly;
      const bodyP = state.bodyPostings.get(form);
      if (bodyP && !skipPrefixBody) {
        const pending = post(bodyP, postingBodySource(kind), 1, state.avgBodyDl, state.bodyDl);
        if (pending) await pending;
      }
      const titleL = state.titleLemmaPostings.get(form);
      if (titleL && titleL !== titleP) {
        const pending = post(titleL, kind === "configured-prefix-recall" ? "configured-prefix-recall" : "morphology", titleBoost * 0.6, state.avgTitleDl, state.titleDl);
        if (pending) await pending;
      }
      const bodyL = state.bodyLemmaPostings.get(form);
      if (bodyL && !skipPrefixBody) {
        const pending = post(bodyL, kind === "configured-prefix-recall" ? "configured-prefix-recall" : "morphology", 0.5, state.avgBodyDl, state.bodyDl);
        if (pending) await pending;
      }

      const skipOccupiedFormPrefix =
        occupied && (kind === "acronym-form" || kind === "acronym-key");
      if (!skipOccupiedFormPrefix && formKindAllowsPrefix(kind, query, form) && !isAllDigitToken(form) && form.length >= 3) {
        for (const term of prefixTerms(form, (t) => allowPrefixMatch(form, t))) {
          if (term === form) continue;
          const tp = state.titlePostings.get(term);
          if (tp) {
            const pending = post(tp, "title-token-prefix", titleBoost * 0.5, state.avgTitleDl, state.titleDl);
            if (pending) await pending;
          }
        }
        // Body prefix evidence matches scanDocument: length ≥ 3 and startsWith, not allowPrefixMatch.
        for (const term of prefixTerms(form, (t) => !isAllDigitToken(t))) {
          if (term === form) continue;
          const bp = state.bodyPostings.get(term);
          if (bp) {
            const pending = post(bp, "indexed-lexical", 0.4, state.avgBodyDl, state.bodyDl);
            if (pending) await pending;
          }
        }
      }
    }

    const shortStub = shortTitleTokenPrefixStub(query);
    if (shortStub) {
      let i = lowerBoundTerm(state.sortedTerms, shortStub);
      while (i < state.sortedTerms.length) {
        const term = state.sortedTerms[i++];
        if (!term.startsWith(shortStub)) break;
        if (term === shortStub || isAllDigitToken(term)) continue;
        const tp = state.titlePostings.get(term);
        if (!tp) continue;
        const pending = post(tp, "title-token-prefix", titleBoost * 0.5, state.avgTitleDl, state.titleDl);
        if (pending) await pending;
      }
    }

    for (const tok of query.tokens || []) {
      const posts = state.versionIndex.get(tok.normalized);
      if (posts) {
        for (const pos of posts) addHit(byPos, pos, "version", 12);
      }
    }
    for (const span of query.dottedSpans || []) {
      const posts = state.versionIndex.get(span);
      if (posts) for (const pos of posts) addHit(byPos, pos, "version", 12);
    }

    const qToks = query.tokens || [];
    const contextualQuality = new Map<number, number>();
    if (!occupied && qToks.length >= 2) {
      const first = qToks[0];
      const keys = [...new Set([first?.normalized, first?.lemma].filter(Boolean))];
      const contextualPos = new Set<number>();
      for (const key of keys) {
        for (const map of [state.titlePostings, state.titleLemmaPostings]) {
          const posting = map.get(key);
          if (!posting) continue;
          for (const pos of posting.docs) contextualPos.add(pos);
        }
      }
      const positions = [...contextualPos].sort((a, b) => a - b);
      for (let i = 0; i < positions.length; i++) {
        if ((i & 7) === 0) {
          const pending = checkpoint(coop, signal, 8);
          if (pending) await pending;
        }
        const pos = positions[i];
        const doc = docs[pos];
        if (!doc) continue;
        const hit = matchContextualTitlePrefix(query, doc);
        if (!hit) continue;
        addHit(byPos, pos, "contextual-title-prefix", 10);
        contextualQuality.set(pos, hit.contextualPrefixQuality);
      }
    }

    const drop: number[] = [];
    for (const [pos, hit] of byPos) {
      if ((step++ & 7) === 0) {
        const pending = checkpoint(coop, signal, 8);
        if (pending) await pending;
      }
      const sources = retrievalSourcesForDocument(query, docs[pos]);
      if (!sources.length) {
        drop.push(pos);
        continue;
      }
      hit.retrievalSources = sources;
    }
    for (const pos of drop) byPos.delete(pos);

    const hits = [...byPos.values()];
    const unboundedMust: IndexedHit[] = [];
    const contextualMust: IndexedHit[] = [];
    const titlePrefixMust: IndexedHit[] = [];
    const rest: IndexedHit[] = [];
    for (const h of hits) {
      const keepUnbounded = unionDeterministic && h.retrievalSources.some((s) => UNBOUNDED_MUST_KEEP.has(s));
      const keepContextual =
        unionDeterministic && h.retrievalSources.includes(CONTEXTUAL_MUST_KEEP_SOURCE);
      const keepTitlePrefix =
        unionDeterministic && h.retrievalSources.includes(TITLE_PREFIX_KEEP_SOURCE);
      if (keepUnbounded) unboundedMust.push(h);
      else if (keepContextual) contextualMust.push(h);
      else if (keepTitlePrefix) titlePrefixMust.push(h);
      else rest.push(h);
    }
    contextualMust.sort((a, b) => {
      const qa = contextualQuality.get(a.pos) || 0;
      const qb = contextualQuality.get(b.pos) || 0;
      if (qb !== qa) return qb - qa;
      return a.pos - b.pos;
    });
    titlePrefixMust.sort((a, b) => {
      const titleA = docs[a.pos]?.normalizedTitle || "";
      const titleB = docs[b.pos]?.normalizedTitle || "";
      const tightness = (title: string) => {
        let best = 0;
        for (const qNorm of titleNormsForQuery(query)) {
          if (!qNorm) continue;
          if (title === qNorm || title.startsWith(qNorm)) {
            best = Math.max(best, qNorm.length / Math.max(title.length, 1));
          }
        }
        return best;
      };
      const qa = tightness(titleA);
      const qb = tightness(titleB);
      if (qb !== qa) return qb - qa;
      return a.pos - b.pos;
    });
    const contextualKept = contextualMust.slice(0, prefixCap);
    for (const h of contextualMust.slice(prefixCap)) rest.push(h);
    const titlePrefixKept = titlePrefixMust.slice(0, prefixCap);
    for (const h of titlePrefixMust.slice(prefixCap)) rest.push(h);
    rest.sort((a, b) => b.retrievalScore - a.retrievalScore || a.pos - b.pos);
    const must = unionDeterministic ? [...unboundedMust, ...contextualKept, ...titlePrefixKept] : [];
    const chosen = unionDeterministic ? [...must, ...rest.slice(0, k)] : rest.slice(0, k);
    chosen.sort((a, b) => a.pos - b.pos);
    const mapped = chosen.map((h) => ({
      document: docs[h.pos],
      retrievalSources: h.retrievalSources,
      retrievalScore: h.retrievalScore,
    }));
    if (box) {
      box.result = mapped;
      box.settled = true;
    }
    return mapped;
    } catch (error) {
      if (box) {
        box.error = error;
        box.settled = true;
      }
      throw error;
    }
  }

  return {
    name: "indexed-lexical",
    prepare,
    retrieve(query: AnalyzedQuery, index: SearchIndex, opts: RetrieveOptions = {}) {
      const box = { settled: false, result: undefined as any, error: undefined as unknown };
      const pending = retrieveIndexed(query, index, opts, null, box);
      pending.catch(() => {});
      if (!box.settled) throw new Error("synchronous lexical retrieval suspended");
      if (box.error) throw box.error;
      return box.result;
    },
    async retrieveAsync(query: AnalyzedQuery, index: SearchIndex, opts: RetrieveOptions = {}) {
      const coop = readCooperation(opts) ?? createCooperation();
      return retrieveIndexed(query, index, opts, coop, null);
    },
    stats() {
      return {
        kind: "indexed-lexical",
        documents: state.n,
        terms: state.termCount,
        postingBytes: state.postingBytes,
        candidateLimit,
        prefixCap,
        unionDeterministic,
      };
    },
  };
}

/**
 * Exact compiled retrieval.
 *
 * Every potentially matching posting is visited and exact provenance is
 * rechecked against the reconstructed indexed document, except unread 1-of-k
 * body postings skipped by body posting pruning and duplicate skips of posting
 * arrays this query already walked. There is no candidate budget, prefix
 * cap, or approximate top-K.
 */
export function createCompiledLexicalRetriever(): Retriever {
  let state: CompiledLexicalRuntime | null = null;
  let last = {
    postingEntriesVisited: 0,
    postingEntriesSkipped: 0,
    postingBlocksVisited: 0,
    postingBlocksSkipped: 0,
    duplicatePostingEntriesAvoided: 0,
    queryFormsExpanded: 0,
    termsExpanded: 0,
    distinctDocumentsExamined: 0,
    exactMatches: 0,
    rawDocumentScans: 0,
    postingBlocksTotal: 0,
    postingBlocksDecoded: 0,
    postingBlocksClassifiedFromMasks: 0,
    postingBlocksSkippedUnread: 0,
    duplicatePostingBlocksAvoided: 0,
    postingEntriesDecoded: 0,
    candidateDocumentsMaterialized: 0,
    provenanceDocumentsScanned: 0,
    stage3A: "off",
    stage3AFallbackReason: null as string | null,
  };

  function prepare(index: SearchIndex, extra?: { plugins?: import("../types.js").SearchPlugin[] }) {
    state = ensureCompiledLexicalIndex(index, extra?.plugins || []);
  }

  function postingBlockCount(entries: number) {
    return entries > 0 ? Math.ceil(entries / 128) : 0;
  }

  type CompiledRetrieveStats = typeof last;

  function readPostingRow(flat: number[], cursor: number) {
    const doc = flat[cursor];
    const tf = flat[cursor + 1];
    const positionsOffset = cursor + 2;
    return { doc, tf, positionsOffset, next: positionsOffset + tf };
  }

  function drivePostingRows(
    flat: number[],
    signal: AbortSignal | undefined,
    stats: CompiledRetrieveStats,
    coop: Cooperation | null,
    consume: (doc: number, tf: number, positionsOffset: number) => void
  ): void | Promise<void> {
    let cursor = 0;
    let row = 0;
    const run = (): void | Promise<void> => {
      while (cursor < flat.length) {
        if ((row & 63) === 0) {
          const pending = checkpoint(coop, signal, 64);
          if (pending) return pending.then(run);
        }
        const posting = readPostingRow(flat, cursor);
        cursor = posting.next;
        row += 1;
        stats.postingEntriesVisited += 1;
        consume(posting.doc, posting.tf, posting.positionsOffset);
      }
    };
    return run();
  }

  function walkPostings(
    flat: number[],
    df: number,
    visit: (doc: number, tf: number) => void,
    signal: AbortSignal | undefined,
    walked: WeakSet<number[]>,
    skipDuplicate: boolean,
    field: RankingEvidenceFieldCode,
    evidenceWriter: RankingEvidenceSession | null,
    stats: CompiledRetrieveStats,
    coop: Cooperation | null
  ): void | Promise<void> {
    if (!flat.length) return;
    if (skipDuplicate && walked.has(flat)) {
      const entries = df || 0;
      stats.postingEntriesSkipped += entries;
      stats.duplicatePostingEntriesAvoided += entries;
      // Duplicate posting-list skip: ceil(df/128) of posting arrays already walked.
      // Not unread skip. postingBlocksSkipped is the legacy name of
      // duplicatePostingBlocksAvoided.
      const duplicateBlocks = postingBlockCount(entries);
      stats.postingBlocksSkipped += duplicateBlocks;
      stats.duplicatePostingBlocksAvoided += duplicateBlocks;
      return;
    }
    if (skipDuplicate) walked.add(flat);
    const before = stats.postingEntriesVisited;
    const actionId = evidenceWriter
      ? evidenceWriter.beginPostingList(field, flat, df)
      : RANKING_EVIDENCE_NO_ACTION;
    const pending = !actionId || !evidenceWriter
      ? drivePostingRows(flat, signal, stats, coop, (doc, tf) => visit(doc, tf))
      : field === RANKING_EVIDENCE_TITLE_FIELD
        ? drivePostingRows(flat, signal, stats, coop, (doc, tf, positionsOffset) => {
            evidenceWriter.writeTitlePosting(actionId, doc, tf, flat, positionsOffset);
            visit(doc, tf);
          })
        : drivePostingRows(flat, signal, stats, coop, (doc, tf) => {
            evidenceWriter.writeBodyPosting(actionId, doc);
            visit(doc, tf);
          });
    const finish = () => {
      const entries = stats.postingEntriesVisited - before;
      stats.postingBlocksVisited += postingBlockCount(entries);
      stats.termsExpanded += 1;
    };
    if (pending) return pending.then(finish);
    finish();
  }

  async function retrieveInternal(query: AnalyzedQuery, index: SearchIndex, {
    signal,
    skipDuplicatePostingLists = false,
    exactBlockSkip = false,
  }: RetrieveOptions = {}, evidenceWriter: RankingEvidenceSession | null = null, coop: Cooperation | null = null, box: {
    settled: boolean;
    result?: ReturnType<typeof retrieveInternal> extends Promise<infer T> ? T : never;
    error?: unknown;
  } | null = null) {
    const stats = {
      postingEntriesVisited: 0,
      postingEntriesSkipped: 0,
      postingBlocksVisited: 0,
      postingBlocksSkipped: 0,
      duplicatePostingEntriesAvoided: 0,
      queryFormsExpanded: 0,
      termsExpanded: 0,
      distinctDocumentsExamined: 0,
      exactMatches: 0,
      rawDocumentScans: 0,
      postingBlocksTotal: 0,
      postingBlocksDecoded: 0,
      postingBlocksClassifiedFromMasks: 0,
      postingBlocksSkippedUnread: 0,
      duplicatePostingBlocksAvoided: 0,
      postingEntriesDecoded: 0,
      candidateDocumentsMaterialized: 0,
      provenanceDocumentsScanned: 0,
      stage3A: "off",
      stage3AFallbackReason: null as string | null,
    };
    try {
    throwIfAborted(signal);
    if (evidenceWriter) evidenceWriter.assertQuery(query, index);
    if (!state) prepare(index);
    const compiled = state as CompiledLexicalRuntime;
    const docs = index.documents || [];
    const n = docs.length;
    const byPos = new Map<number, IndexedHit>();
    const walked = new WeakSet<number[]>();
    const skipDuplicate = Boolean(skipDuplicatePostingLists);
    const skipPlan = typeof exactBlockSkip === "object" && exactBlockSkip ? exactBlockSkip : null;
    const skipScore = skipPlan !== null;

    function add(pos: number, source: string, scoreDelta = 0) {
      let hit = byPos.get(pos);
      if (!hit) {
        hit = { pos, retrievalSources: [], retrievalScore: 0 };
        byPos.set(pos, hit);
      }
      pushSource(hit, source);
      if (scoreDelta) hit.retrievalScore += scoreDelta;
    }

    function accumulateSurface(
      term: CompiledTermRuntime | undefined,
      field: "title" | "body",
      source: string,
      boost: number
    ): void | Promise<void> {
      if (!term) return;
      const flat = field === "title" ? term.title : term.body;
      const df = field === "title" ? term.titleDf : term.bodyDf;
      if (!flat.length || !df) return;
      const avgdl = field === "title" ? compiled.avgTitleDl : compiled.avgBodyDl;
      const lengths = field === "title" ? compiled.titleDl : compiled.bodyDl;
      const weight = idf(n, df) * boost;
      return walkPostings(flat, df, (doc, tf) => {
        add(doc, source, skipScore ? 0 : weight * bm25Tf(tf, lengths[doc], avgdl));
      }, signal, walked, skipDuplicate,
      field === "title" ? RANKING_EVIDENCE_TITLE_FIELD : RANKING_EVIDENCE_BODY_FIELD,
      evidenceWriter, stats, coop);
    }

    function accumulateLemma(
      terms: CompiledTermRuntime[] | undefined,
      field: "title" | "body",
      source: string,
      boost: number
    ): void | Promise<void> {
      if (!terms?.length) return;
      const counts = new Map<number, number>();
      let index = 0;
      const finish = () => {
        if (!counts.size) return;
        const avgdl = field === "title" ? compiled.avgTitleDl : compiled.avgBodyDl;
        const lengths = field === "title" ? compiled.titleDl : compiled.bodyDl;
        const weight = idf(n, counts.size) * boost;
        for (const [doc, tf] of counts) {
          add(doc, source, skipScore ? 0 : weight * bm25Tf(tf, lengths[doc], avgdl));
        }
      };
      const run = (): void | Promise<void> => {
        while (index < terms.length) {
          const term = terms[index++];
          const flat = field === "title" ? term.title : term.body;
          const df = field === "title" ? term.titleDf : term.bodyDf;
          const pending = walkPostings(flat, df, (doc, tf) => {
            counts.set(doc, (counts.get(doc) || 0) + tf);
          }, signal, walked, skipDuplicate,
          field === "title" ? RANKING_EVIDENCE_TITLE_FIELD : RANKING_EVIDENCE_BODY_FIELD,
          evidenceWriter, stats, coop);
          if (pending) return pending.then(run);
        }
        finish();
      };
      return run();
    }

    const forms = queryForms(query);
    stats.queryFormsExpanded = forms.length;
    const semantics = querySemanticFacts(query);
    const occupied = Boolean(semantics.configured.occupiedKey);
    const prefixRecallTitleOnly = semantics.configured.weakRecall?.ambiguity === "group";
    for (const qNorm of titleNormsForQuery(query)) {
      const exact = compiled.titleByNorm.get(qNorm);
      if (exact) {
        for (const pos of exact) {
          if (evidenceWriter) evidenceWriter.markExactTitle(pos);
          add(pos, "exact-title", 50);
        }
      }
      let i = lowerBoundNorm(compiled.sortedTitles, qNorm);
      while (i < compiled.sortedTitles.length) {
        const row = compiled.sortedTitles[i++];
        if (!row.norm.startsWith(qNorm)) break;
        add(row.pos, "title-prefix", 8 * (qNorm.length / Math.max(row.norm.length, 1)));
      }
    }

    let step = 0;
    const skipBodyWalk = skipPlan !== null;
    for (const { form, kind } of forms) {
      if ((step++ & 7) === 0) {
        const pending = checkpoint(coop, signal, 8);
        if (pending) await pending;
      }
      const surface = compiled.bySurface.get(form);
      {
        const pending = accumulateSurface(surface, "title", postingTitleSource(kind), TITLE_BOOST);
        if (pending) await pending;
      }
      const skipPrefixBody = kind === "configured-prefix-recall" && prefixRecallTitleOnly;
      if (!skipBodyWalk && !skipPrefixBody) {
        const pending = accumulateSurface(surface, "body", postingBodySource(kind), 1);
        if (pending) await pending;
      }
      {
        const pending = accumulateLemma(
          compiled.byLemma.get(form),
          "title",
          kind === "configured-prefix-recall" ? "configured-prefix-recall" : "morphology",
          TITLE_BOOST * 0.6
        );
        if (pending) await pending;
      }
      if (!skipBodyWalk && !skipPrefixBody) {
        const pending = accumulateLemma(
          compiled.byLemma.get(form),
          "body",
          kind === "configured-prefix-recall" ? "configured-prefix-recall" : "morphology",
          0.5
        );
        if (pending) await pending;
      }

      const skipOccupiedFormPrefix =
        occupied && (kind === "acronym-form" || kind === "acronym-key");
      if (!skipOccupiedFormPrefix && formKindAllowsPrefix(kind, query, form) && !isAllDigitToken(form) && form.length >= 3) {
        let i = lowerBoundTerm(compiled.sortedTerms, form);
        while (i < compiled.sortedTerms.length) {
          const term = compiled.sortedTerms[i++];
          if (!term.startsWith(form)) break;
          if (term === form) continue;
          const row = compiled.bySurface.get(term);
          if (allowPrefixMatch(form, term)) {
            const pending = accumulateSurface(row, "title", "title-token-prefix", TITLE_BOOST * 0.5);
            if (pending) await pending;
          }
          if (!skipBodyWalk && !isAllDigitToken(term)) {
            const pending = accumulateSurface(row, "body", "indexed-lexical", 0.4);
            if (pending) await pending;
          }
        }
      }
    }

    const shortStub = shortTitleTokenPrefixStub(query);
    if (shortStub) {
      let i = lowerBoundTerm(compiled.sortedTerms, shortStub);
      while (i < compiled.sortedTerms.length) {
        const term = compiled.sortedTerms[i++];
        if (!term.startsWith(shortStub)) break;
        if (term === shortStub || isAllDigitToken(term)) continue;
        const pending = accumulateSurface(compiled.bySurface.get(term), "title", "title-token-prefix", TITLE_BOOST * 0.5);
        if (pending) await pending;
      }
    }

    for (const token of query.tokens || []) {
      const posts = compiled.versionIndex.get(token.normalized);
      if (posts) for (const pos of posts) add(pos, "version", 12);
    }
    for (const span of query.dottedSpans || []) {
      const posts = compiled.versionIndex.get(span);
      if (posts) for (const pos of posts) add(pos, "version", 12);
    }

    const qTokens = query.tokens || [];
    if (!occupied && qTokens.length >= 2) {
      const first = qTokens[0];
      const keys = [...new Set([first?.normalized, first?.lemma].filter((value): value is string => Boolean(value)))];
      const positions = new Set<number>();
      for (const key of keys) {
        const surface = compiled.bySurface.get(key);
        if (surface) {
          const pending = walkPostings(
            surface.title,
            surface.titleDf,
            (doc) => positions.add(doc),
            signal,
            walked,
            skipDuplicate,
            RANKING_EVIDENCE_TITLE_FIELD,
            evidenceWriter,
            stats,
            coop
          );
          if (pending) await pending;
        }
        for (const term of compiled.byLemma.get(key) || []) {
          const pending = walkPostings(
            term.title,
            term.titleDf,
            (doc) => positions.add(doc),
            signal,
            walked,
            skipDuplicate,
            RANKING_EVIDENCE_TITLE_FIELD,
            evidenceWriter,
            stats,
            coop
          );
          if (pending) await pending;
        }
      }
      for (const pos of [...positions].sort((a, b) => a - b)) {
        if (matchContextualTitlePrefix(query, docs[pos])) {
          add(pos, "contextual-title-prefix", 10);
        }
      }
    }

    if (skipBodyWalk) {
      const plan = planBodyPostingPruning({
        query,
        compiled,
        documents: docs,
        titleOrdinals: new Set(byPos.keys()),
        requiredDepth: skipPlan ? skipPlan.requiredDepth : 0,
        signal,
        evidenceWriter,
        relatedExpansionSources: skipPlan?.relatedExpansionSources || null,
      });
      if (plan) {
        stats.stage3A = "applied";
        stats.postingBlocksTotal = plan.stats.postingBlocksTotal;
        stats.postingBlocksDecoded = plan.stats.postingBlocksDecoded;
        stats.postingBlocksClassifiedFromMasks = plan.stats.postingBlocksClassifiedFromMasks;
        stats.postingBlocksSkippedUnread = plan.stats.postingBlocksSkippedUnread;
        stats.postingEntriesDecoded = stats.postingEntriesVisited + plan.stats.postingEntriesDecoded;
        for (const pos of plan.bodyOrdinals) add(pos, "body-lexical", 0);
      } else {
        stats.stage3A = "fallback";
        stats.stage3AFallbackReason = bodyPostingPruningUnsupportedReason(query) || "unbounded-presence";
        for (const { form, kind } of forms) {
          if ((step++ & 7) === 0) {
            const pending = checkpoint(coop, signal, 8);
            if (pending) await pending;
          }
          if (kind === "configured-prefix-recall" && prefixRecallTitleOnly) continue;
          const surface = compiled.bySurface.get(form);
          {
            const pending = accumulateSurface(surface, "body", postingBodySource(kind), 1);
            if (pending) await pending;
          }
          {
            const pending = accumulateLemma(
              compiled.byLemma.get(form),
              "body",
              kind === "configured-prefix-recall" ? "configured-prefix-recall" : "morphology",
              0.5
            );
            if (pending) await pending;
          }
          if (formKindAllowsPrefix(kind, query, form) && !isAllDigitToken(form) && form.length >= 3) {
            let i = lowerBoundTerm(compiled.sortedTerms, form);
            while (i < compiled.sortedTerms.length) {
              const term = compiled.sortedTerms[i++];
              if (!term.startsWith(form)) break;
              if (term === form || isAllDigitToken(term)) continue;
              const pending = accumulateSurface(compiled.bySurface.get(term), "body", "indexed-lexical", 0.4);
              if (pending) await pending;
            }
          }
        }
      }
    }

    stats.distinctDocumentsExamined = byPos.size;
    stats.candidateDocumentsMaterialized = byPos.size;
    const hits: IndexedHit[] = [];
    for (const [pos, hit] of byPos) {
      if ((step++ & 7) === 0) {
        const pending = checkpoint(coop, signal, 8);
        if (pending) await pending;
      }
      const sources = retrievalSourcesForDocument(query, docs[pos]);
      stats.provenanceDocumentsScanned += 1;
      if (!sources.length) continue;
      if (evidenceWriter) evidenceWriter.admitCandidate(pos);
      hit.retrievalSources = sources;
      hits.push(hit);
    }
    hits.sort((a, b) => a.pos - b.pos);
    stats.exactMatches = hits.length;
    if (stats.stage3A !== "applied") {
      stats.postingEntriesDecoded = stats.postingEntriesVisited;
    }
    const mapped = hits.map((hit) => ({
      document: docs[hit.pos],
      retrievalSources: hit.retrievalSources,
      retrievalScore: hit.retrievalScore,
      documentOrdinal: hit.pos,
    }));
    last = stats;
    if (box) {
      box.result = mapped;
      box.settled = true;
    }
    return mapped;
    } catch (error) {
      if (box) {
        box.error = error;
        box.settled = true;
      }
      throw error;
    }
  }

  function finishSyncRetrieval(pending: Promise<unknown>, box: { settled: boolean; result?: any; error?: unknown }) {
    pending.catch(() => {});
    if (!box.settled) throw new Error("synchronous compiled retrieval suspended");
    if (box.error) throw box.error;
    return box.result;
  }

  const retriever: Retriever = {
    name: "indexed-lexical",
    exactSignatureSelection: true,
    prepare,
    retrieve(query: AnalyzedQuery, index: SearchIndex, opts: RetrieveOptions = {}) {
      const box = { settled: false, result: undefined as any, error: undefined as unknown };
      return finishSyncRetrieval(retrieveInternal(query, index, opts, null, null, box), box);
    },
    async retrieveAsync(query: AnalyzedQuery, index: SearchIndex, opts: RetrieveOptions = {}) {
      const coop = readCooperation(opts) ?? createCooperation();
      return retrieveInternal(query, index, opts, null, coop, null);
    },
    stats() {
      return {
        kind: "compiled-indexed",
        documents: state?.titleDl.length || 0,
        terms: state?.terms.length || 0,
        postingEntries: state?.postingEntries || 0,
        ...last,
        postingEntriesDecoded: last.postingEntriesDecoded || last.postingEntriesVisited,
        candidateDocumentsMaterialized: last.candidateDocumentsMaterialized,
        provenanceDocumentsScanned: last.provenanceDocumentsScanned,
        stage3A: last.stage3A,
        stage3AFallbackReason: last.stage3AFallbackReason,
        postingEntriesVisited: last.postingEntriesVisited,
        pruning: last.postingEntriesSkipped ? "duplicate-posting-lists" : last.stage3A === "applied" ? "unread-body-blocks" : "none",
      };
    },
  };
  rankingEvidenceCapabilities.set(retriever, {
    retrieve(query, index, options, writer) {
      const box = { settled: false, result: undefined as any, error: undefined as unknown };
      return finishSyncRetrieval(retrieveInternal(query, index, options, writer, null, box), box);
    },
    async retrieveAsync(query, index, options, writer) {
      const coop = readCooperation(options) ?? createCooperation();
      return retrieveInternal(query, index, options, writer, coop, null);
    },
  });
  return retriever;
}

export function createAdaptiveRetriever({ documentThreshold = 1500, smallLimit }: AdaptiveRetrieverOptions = {}): Retriever {
  const full = createFullScanRetriever();
  const indexed = createCompiledLexicalRetriever();
  const threshold =
    typeof smallLimit === "number" && Number.isInteger(smallLimit) && smallLimit > 0
      ? smallLimit
      : documentThreshold || 1500;
  let active: AdaptiveActive = "full-scan";
  const retriever: Retriever = {
    name: "adaptive",
    get exactSignatureSelection() {
      return active === "indexed-lexical";
    },
    prepare(index: SearchIndex, extra?: { plugins?: import("../types.js").SearchPlugin[] }) {
      const n = index.documents?.length || 0;
      active = n <= threshold ? "full-scan" : "indexed-lexical";
      if (active === "indexed-lexical") indexed.prepare(index, extra);
    },
    retrieve(query, index, opts = {}) {
      return active === "full-scan" ? full.retrieve(query, index, opts) : indexed.retrieve(query, index, opts);
    },
    retrieveAsync(query, index, opts = {}) {
      return active === "full-scan" ? full.retrieveAsync(query, index, opts) : indexed.retrieveAsync(query, index, opts);
    },
    stats() {
      const extra = active === "indexed-lexical" ? indexed.stats?.() : full.stats?.();
      return { kind: "adaptive", active, documentThreshold: threshold, ...(extra || {}) };
    },
  };
  rankingEvidenceCapabilities.set(retriever, {
    retrieve(query, index, options, writer) {
      if (active !== "indexed-lexical") return null;
      return retrieveWithRankingEvidence(indexed, query, index, writer, options);
    },
    async retrieveAsync(query, index, options, writer) {
      if (active !== "indexed-lexical") return null;
      return retrieveWithRankingEvidenceAsync(indexed, query, index, writer, options);
    },
  });
  return retriever;
}

export { UNBOUNDED_MUST_KEEP, CONTEXTUAL_MUST_KEEP_SOURCE, TITLE_PREFIX_KEEP_SOURCE, queryForms };
