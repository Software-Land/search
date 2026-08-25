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
} from "./retrieve.js";
import { allowPrefixMatch } from "./text.js";
import { isAllDigitToken } from "./versionForms.js";
import { throwIfAborted } from "./cancel.js";
import {
  ensureCompiledLexicalIndex,
  type CompiledLexicalRuntime,
  type CompiledTermRuntime,
} from "./lexicalIndex.js";
import { planStage3ABodyOrdinals, stage3AUnsupportedReason } from "./exactBlockSkip.js";
import type {
  AdaptiveRetrieverOptions,
  AnalyzedQuery,
  IndexedLexicalOptions,
  IndexedLexicalState,
  Posting,
  Retriever,
  RetrieveOptions,
  SearchIndex,
} from "./types.js";

type QueryFormKind = "token" | "lemma" | "acronym-key" | "concept" | "acronym-form" | "standalone-recall" | "topical-recall";
type QueryForm = { form: string; kind: QueryFormKind };
type AdaptiveActive = "full-scan" | "indexed-lexical";

interface IndexedHit {
  pos: number;
  retrievalSources: string[];
  retrievalScore: number;
}

// Exact-title, configured-equivalence, and version bypass the BM25 budget
// without a cap. Contextual title-prefix and full-query title-prefix are
// capped must-keeps: overflow stays eligible for the ordinary candidateLimit
// pool. Title-prefix keeps short-literal / query-"2" winners from losing to
// high-TF body floods.
const UNBOUNDED_MUST_KEEP = new Set<string>(["exact-title", "configured-equivalence", "version"]);
const CONTEXTUAL_MUST_KEEP_SOURCE = "contextual-title-prefix";
const TITLE_PREFIX_KEEP_SOURCE = "title-prefix";
const K1 = 1.2;
const B = 0.75;
const TITLE_BOOST = 4;

function postingTitleSource(kind: QueryFormKind) {
  if (kind === "acronym-key" || kind === "acronym-form") return "configured-equivalence";
  if (kind === "standalone-recall") return "standalone-recall";
  if (kind === "topical-recall") return "topical-recall";
  return "title-token";
}

function postingBodySource(kind: QueryFormKind) {
  if (kind === "standalone-recall") return "standalone-recall";
  if (kind === "topical-recall") return "topical-recall";
  return "body-lexical";
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
  for (const tok of evidenceTokens(query)) {
    add(tok.normalized, "token");
    if (tok.lemma && tok.lemma !== tok.normalized) add(tok.lemma, "lemma");
  }
  for (const c of query.concepts || []) {
    if (isBoundTrailingTermConcept(query, c)) continue;
    add(c.id, c.kind === "acronym" ? "acronym-key" : "concept");
    for (const f of c.forms || []) add(f, c.kind === "acronym" ? "acronym-form" : "concept");
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
      return retrieveCandidatesAsync(query, index, { signal: opts.signal });
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
    { signal, n }: { signal?: AbortSignal; n?: number } = {}
  ) {
    if (!posting) return;
    const w = idf(n || 0, posting.df) * fieldBoost;
    for (let i = 0; i < posting.docs.length; i++) {
      if ((i & 63) === 0) throwIfAborted(signal);
      const pos = posting.docs[i];
      const tf = posting.tfs[i];
      addHit(byPos, pos, source, w * bm25Tf(tf, dlArr[pos], avgdl));
    }
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

  function retrieve(query: AnalyzedQuery, index: SearchIndex, { signal, candidateLimit: limitOverride }: RetrieveOptions = {}) {
    throwIfAborted(signal);
    if (!state.prepared) prepare(index);
    const docs = index.documents || [];
    const n = state.n || docs.length;
    const byPos = new Map<number, IndexedHit>();
    const k = limitOverride || candidateLimit;
    const forms = queryForms(query);
    const qNorm = identityTokens(query).map((t) => t.normalized).join(" ");

    const exact = state.titleByNorm.get(qNorm);
    if (exact) {
      for (const pos of exact) addHit(byPos, pos, "exact-title", 50);
    }

    if (qNorm) {
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

    let step = 0;
    for (const { form, kind } of forms) {
      if ((step++ & 7) === 0) throwIfAborted(signal);
      const titleP = state.titlePostings.get(form);
      if (titleP) accumulatePosting(byPos, titleP, postingTitleSource(kind), titleBoost, state.avgTitleDl, state.titleDl, { signal, n });
      const bodyP = state.bodyPostings.get(form);
      if (bodyP) accumulatePosting(byPos, bodyP, postingBodySource(kind), 1, state.avgBodyDl, state.bodyDl, { signal, n });
      const titleL = state.titleLemmaPostings.get(form);
      if (titleL && titleL !== titleP) {
        accumulatePosting(byPos, titleL, "morphology", titleBoost * 0.6, state.avgTitleDl, state.titleDl, { signal, n });
      }
      const bodyL = state.bodyLemmaPostings.get(form);
      if (bodyL) accumulatePosting(byPos, bodyL, "morphology", 0.5, state.avgBodyDl, state.bodyDl, { signal, n });

      if (kind !== "topical-recall" && !isAllDigitToken(form) && form.length >= 3) {
        for (const term of prefixTerms(form, (t) => allowPrefixMatch(form, t))) {
          if (term === form) continue;
          const tp = state.titlePostings.get(term);
          if (tp) accumulatePosting(byPos, tp, "title-token-prefix", titleBoost * 0.5, state.avgTitleDl, state.titleDl, { signal, n });
        }
        // Body prefix evidence matches scanDocument: length ≥ 3 and startsWith, not allowPrefixMatch.
        for (const term of prefixTerms(form, (t) => !isAllDigitToken(t))) {
          if (term === form) continue;
          const bp = state.bodyPostings.get(term);
          if (bp) accumulatePosting(byPos, bp, "indexed-lexical", 0.4, state.avgBodyDl, state.bodyDl, { signal, n });
        }
      }
    }

    const shortStub = shortTitleTokenPrefixStub(query);
    if (shortStub) {
      eachTitlePrefixTerm(state.sortedTerms, shortStub, (term) => {
        const tp = state.titlePostings.get(term);
        if (tp) accumulatePosting(byPos, tp, "title-token-prefix", titleBoost * 0.5, state.avgTitleDl, state.titleDl, { signal, n });
      });
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
    if (qToks.length >= 2) {
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
        if ((i & 7) === 0) throwIfAborted(signal);
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
      if ((step++ & 7) === 0) throwIfAborted(signal);
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
      const qa = qNorm.length / Math.max(titleA.length, 1);
      const qb = qNorm.length / Math.max(titleB.length, 1);
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
    return chosen.map((h) => ({
      document: docs[h.pos],
      retrievalSources: h.retrievalSources,
      retrievalScore: h.retrievalScore,
    }));
  }

  return {
    name: "indexed-lexical",
    prepare,
    retrieve,
    async retrieveAsync(query: AnalyzedQuery, index: SearchIndex, opts: RetrieveOptions = {}) {
      throwIfAborted(opts.signal);
      await Promise.resolve();
      throwIfAborted(opts.signal);
      return retrieve(query, index, opts);
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
 * Stage-1 exact compiled retrieval.
 *
 * Every potentially matching posting is visited and exact provenance is
 * rechecked against the reconstructed indexed document, except Stage 3A
 * unread 1-of-k body skip (presence masks) and Stage 2B skip of posting
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

  function prepare(index: SearchIndex, extra?: { plugins?: import("./types.js").SearchPlugin[] }) {
    state = ensureCompiledLexicalIndex(index, extra?.plugins || []);
  }

  function postingBlockCount(entries: number) {
    return entries > 0 ? Math.ceil(entries / 128) : 0;
  }

  function flatEach(
    flat: number[],
    visit: (doc: number, tf: number) => void,
    signal?: AbortSignal
  ) {
    let cursor = 0;
    let row = 0;
    while (cursor < flat.length) {
      if ((row++ & 63) === 0) throwIfAborted(signal);
      const doc = flat[cursor++];
      const tf = flat[cursor++];
      cursor += tf;
      last.postingEntriesVisited += 1;
      visit(doc, tf);
    }
  }

  function walkPostings(
    flat: number[],
    df: number,
    visit: (doc: number, tf: number) => void,
    signal: AbortSignal | undefined,
    walked: WeakSet<number[]>,
    skipDuplicate: boolean
  ) {
    if (!flat.length) return;
    if (skipDuplicate && walked.has(flat)) {
      const entries = df || 0;
      last.postingEntriesSkipped += entries;
      last.duplicatePostingEntriesAvoided += entries;
      // Stage 2B: ceil(df/128) of duplicate already-walked posting arrays.
      // Not unread skip. postingBlocksSkipped is the legacy name of
      // duplicatePostingBlocksAvoided.
      const duplicateBlocks = postingBlockCount(entries);
      last.postingBlocksSkipped += duplicateBlocks;
      last.duplicatePostingBlocksAvoided += duplicateBlocks;
      return;
    }
    if (skipDuplicate) walked.add(flat);
    const before = last.postingEntriesVisited;
    flatEach(flat, visit, signal);
    const entries = last.postingEntriesVisited - before;
    last.postingBlocksVisited += postingBlockCount(entries);
    last.termsExpanded += 1;
  }

  function retrieve(query: AnalyzedQuery, index: SearchIndex, {
    signal,
    skipDuplicatePostingLists = false,
    exactBlockSkip = false,
  }: RetrieveOptions = {}) {
    throwIfAborted(signal);
    if (!state) prepare(index);
    const compiled = state as CompiledLexicalRuntime;
    const docs = index.documents || [];
    const n = docs.length;
    const byPos = new Map<number, IndexedHit>();
    const walked = new WeakSet<number[]>();
    const skipDuplicate = Boolean(skipDuplicatePostingLists);
    last = {
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
    ) {
      if (!term) return;
      const flat = field === "title" ? term.title : term.body;
      const df = field === "title" ? term.titleDf : term.bodyDf;
      if (!flat.length || !df) return;
      const avgdl = field === "title" ? compiled.avgTitleDl : compiled.avgBodyDl;
      const lengths = field === "title" ? compiled.titleDl : compiled.bodyDl;
      const weight = idf(n, df) * boost;
      walkPostings(flat, df, (doc, tf) => {
        add(doc, source, skipScore ? 0 : weight * bm25Tf(tf, lengths[doc], avgdl));
      }, signal, walked, skipDuplicate);
    }

    function accumulateLemma(
      terms: CompiledTermRuntime[] | undefined,
      field: "title" | "body",
      source: string,
      boost: number
    ) {
      if (!terms?.length) return;
      const counts = new Map<number, number>();
      for (const term of terms) {
        const flat = field === "title" ? term.title : term.body;
        const df = field === "title" ? term.titleDf : term.bodyDf;
        walkPostings(flat, df, (doc, tf) => {
          counts.set(doc, (counts.get(doc) || 0) + tf);
        }, signal, walked, skipDuplicate);
      }
      if (!counts.size) return;
      const avgdl = field === "title" ? compiled.avgTitleDl : compiled.avgBodyDl;
      const lengths = field === "title" ? compiled.titleDl : compiled.bodyDl;
      const weight = idf(n, counts.size) * boost;
      for (const [doc, tf] of counts) {
        add(doc, source, skipScore ? 0 : weight * bm25Tf(tf, lengths[doc], avgdl));
      }
    }

    const forms = queryForms(query);
    last.queryFormsExpanded = forms.length;
    const qNorm = identityTokens(query).map((token) => token.normalized).join(" ");
    const exact = compiled.titleByNorm.get(qNorm);
    if (exact) for (const pos of exact) add(pos, "exact-title", 50);

    if (qNorm) {
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
      if ((step++ & 7) === 0) throwIfAborted(signal);
      const surface = compiled.bySurface.get(form);
      accumulateSurface(surface, "title", postingTitleSource(kind), TITLE_BOOST);
      if (!skipBodyWalk) accumulateSurface(surface, "body", postingBodySource(kind), 1);
      accumulateLemma(compiled.byLemma.get(form), "title", "morphology", TITLE_BOOST * 0.6);
      if (!skipBodyWalk) accumulateLemma(compiled.byLemma.get(form), "body", "morphology", 0.5);

      if (kind !== "topical-recall" && !isAllDigitToken(form) && form.length >= 3) {
        let i = lowerBoundTerm(compiled.sortedTerms, form);
        while (i < compiled.sortedTerms.length) {
          const term = compiled.sortedTerms[i++];
          if (!term.startsWith(form)) break;
          if (term === form) continue;
          const row = compiled.bySurface.get(term);
          if (allowPrefixMatch(form, term)) {
            accumulateSurface(row, "title", "title-token-prefix", TITLE_BOOST * 0.5);
          }
          if (!skipBodyWalk && !isAllDigitToken(term)) {
            accumulateSurface(row, "body", "indexed-lexical", 0.4);
          }
        }
      }
    }

    const shortStub = shortTitleTokenPrefixStub(query);
    if (shortStub) {
      eachTitlePrefixTerm(compiled.sortedTerms, shortStub, (term) => {
        accumulateSurface(compiled.bySurface.get(term), "title", "title-token-prefix", TITLE_BOOST * 0.5);
      });
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
    if (qTokens.length >= 2) {
      const first = qTokens[0];
      const keys = [...new Set([first?.normalized, first?.lemma].filter((value): value is string => Boolean(value)))];
      const positions = new Set<number>();
      for (const key of keys) {
        const surface = compiled.bySurface.get(key);
        if (surface) {
          walkPostings(surface.title, surface.titleDf, (doc) => positions.add(doc), signal, walked, skipDuplicate);
        }
        for (const term of compiled.byLemma.get(key) || []) {
          walkPostings(term.title, term.titleDf, (doc) => positions.add(doc), signal, walked, skipDuplicate);
        }
      }
      for (const pos of [...positions].sort((a, b) => a - b)) {
        if (matchContextualTitlePrefix(query, docs[pos])) {
          add(pos, "contextual-title-prefix", 10);
        }
      }
    }

    if (skipBodyWalk) {
      const plan = planStage3ABodyOrdinals({
        query,
        compiled,
        documents: docs,
        titleOrdinals: new Set(byPos.keys()),
        requiredDepth: skipPlan ? skipPlan.requiredDepth : 0,
        signal,
      });
      if (plan) {
        last.stage3A = "applied";
        last.postingBlocksTotal = plan.stats.postingBlocksTotal;
        last.postingBlocksDecoded = plan.stats.postingBlocksDecoded;
        last.postingBlocksClassifiedFromMasks = plan.stats.postingBlocksClassifiedFromMasks;
        last.postingBlocksSkippedUnread = plan.stats.postingBlocksSkippedUnread;
        last.postingEntriesDecoded = last.postingEntriesVisited + plan.stats.postingEntriesDecoded;
        for (const pos of plan.bodyOrdinals) add(pos, "body-lexical", 0);
      } else {
        last.stage3A = "fallback";
        last.stage3AFallbackReason = stage3AUnsupportedReason(query) || "unbounded-presence";
        for (const { form, kind } of forms) {
          if ((step++ & 7) === 0) throwIfAborted(signal);
          const surface = compiled.bySurface.get(form);
          accumulateSurface(surface, "body", postingBodySource(kind), 1);
          accumulateLemma(compiled.byLemma.get(form), "body", "morphology", 0.5);
          if (kind !== "topical-recall" && !isAllDigitToken(form) && form.length >= 3) {
            let i = lowerBoundTerm(compiled.sortedTerms, form);
            while (i < compiled.sortedTerms.length) {
              const term = compiled.sortedTerms[i++];
              if (!term.startsWith(form)) break;
              if (term === form || isAllDigitToken(term)) continue;
              accumulateSurface(compiled.bySurface.get(term), "body", "indexed-lexical", 0.4);
            }
          }
        }
      }
    }

    last.distinctDocumentsExamined = byPos.size;
    last.candidateDocumentsMaterialized = byPos.size;
    const hits: IndexedHit[] = [];
    for (const [pos, hit] of byPos) {
      if ((step++ & 7) === 0) throwIfAborted(signal);
      const sources = retrievalSourcesForDocument(query, docs[pos]);
      last.provenanceDocumentsScanned += 1;
      if (!sources.length) continue;
      hit.retrievalSources = sources;
      hits.push(hit);
    }
    hits.sort((a, b) => a.pos - b.pos);
    last.exactMatches = hits.length;
    if (last.stage3A !== "applied") {
      last.postingEntriesDecoded = last.postingEntriesVisited;
    }
    return hits.map((hit) => ({
      document: docs[hit.pos],
      retrievalSources: hit.retrievalSources,
      retrievalScore: hit.retrievalScore,
      documentOrdinal: hit.pos,
    }));
  }

  return {
    name: "indexed-lexical",
    exactSignatureSelection: true,
    prepare,
    retrieve,
    async retrieveAsync(query: AnalyzedQuery, index: SearchIndex, opts: RetrieveOptions = {}) {
      throwIfAborted(opts.signal);
      await Promise.resolve();
      throwIfAborted(opts.signal);
      return retrieve(query, index, opts);
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
}

export function createAdaptiveRetriever({ documentThreshold = 1500, smallLimit, indexedOptions }: AdaptiveRetrieverOptions = {}): Retriever {
  const full = createFullScanRetriever();
  const indexed = createCompiledLexicalRetriever();
  const threshold =
    typeof smallLimit === "number" && Number.isInteger(smallLimit) && smallLimit > 0
      ? smallLimit
      : documentThreshold || 1500;
  let active: AdaptiveActive = "full-scan";
  return {
    name: "adaptive",
    get exactSignatureSelection() {
      return active === "indexed-lexical";
    },
    prepare(index: SearchIndex, extra?: { plugins?: import("./types.js").SearchPlugin[] }) {
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
}

export function resolveRetriever(spec: unknown): Retriever {
  if (spec === "full-scan") return createFullScanRetriever();
  if (!spec) return createCompiledLexicalRetriever();
  if (typeof spec === "object" && spec && "retrieve" in spec && typeof spec.retrieve === "function") {
    return spec as Retriever;
  }
  if (spec === "indexed" || spec === "indexed-lexical") return createCompiledLexicalRetriever();
  if (spec === "adaptive") return createAdaptiveRetriever();
  if (typeof spec === "object" && spec && "type" in spec && spec.type === "indexed-lexical") {
    return createIndexedLexicalRetriever(spec as IndexedLexicalOptions);
  }
  if (typeof spec === "object" && spec && "type" in spec && spec.type === "adaptive") {
    return createAdaptiveRetriever(spec as AdaptiveRetrieverOptions);
  }
  return createIndexedLexicalRetriever();
}

export { UNBOUNDED_MUST_KEEP, CONTEXTUAL_MUST_KEEP_SOURCE, TITLE_PREFIX_KEEP_SOURCE, queryForms };
