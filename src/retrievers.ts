/**
 * Replaceable candidate retrieval.
 *
 * Query analysis and ranking stay in Search Core. Retrievers emit
 * { document, retrievalSources, retrievalScore? } only.
 *
 * Indexed lexical retrieval is the default production path: inverted
 * postings propose documents, exact scanDocument provenance is required,
 * and BM25 orders only the budgeted ordinary slice. It is not the ranker.
 * Full-scan remains an explicit small-corpus / reference mode.
 */

import {
  retrieveCandidates,
  retrieveCandidatesAsync,
  matchContextualTitlePrefix,
  retrievalSourcesForDocument,
} from "./retrieve.js";
import { allowPrefixMatch } from "./text.js";
import { isAllDigitToken } from "./versionForms.js";
import { throwIfAborted } from "./cancel.js";
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

type QueryFormKind = "token" | "lemma" | "acronym-key" | "concept" | "acronym-form";
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

function queryForms(query: AnalyzedQuery) {
  const forms: QueryForm[] = [];
  const seen = new Set<string>();
  function add(form: unknown, kind: QueryFormKind) {
    const f = String(form || "");
    if (!f || seen.has(`${kind}:${f}`)) return;
    seen.add(`${kind}:${f}`);
    forms.push({ form: f, kind });
  }
  for (const tok of query.tokens || []) {
    add(tok.normalized, "token");
    if (tok.lemma && tok.lemma !== tok.normalized) add(tok.lemma, "lemma");
  }
  for (const c of query.concepts || []) {
    add(c.id, c.kind === "acronym" ? "acronym-key" : "concept");
    for (const f of c.forms || []) add(f, c.kind === "acronym" ? "acronym-form" : "concept");
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
    const qNorm = (query.tokens || []).map((t) => t.normalized).join(" ");

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
      const acronym = kind === "acronym-key" || kind === "acronym-form";
      const titleP = state.titlePostings.get(form);
      if (titleP) accumulatePosting(byPos, titleP, acronym ? "configured-equivalence" : "title-token", titleBoost, state.avgTitleDl, state.titleDl, { signal, n });
      const bodyP = state.bodyPostings.get(form);
      if (bodyP) accumulatePosting(byPos, bodyP, "body-lexical", 1, state.avgBodyDl, state.bodyDl, { signal, n });
      const titleL = state.titleLemmaPostings.get(form);
      if (titleL && titleL !== titleP) {
        accumulatePosting(byPos, titleL, "morphology", titleBoost * 0.6, state.avgTitleDl, state.titleDl, { signal, n });
      }
      const bodyL = state.bodyLemmaPostings.get(form);
      if (bodyL) accumulatePosting(byPos, bodyL, "morphology", 0.5, state.avgBodyDl, state.bodyDl, { signal, n });

      if (!isAllDigitToken(form) && form.length >= 3) {
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

export function createAdaptiveRetriever({ documentThreshold = 1500, smallLimit, indexedOptions }: AdaptiveRetrieverOptions = {}): Retriever {
  const full = createFullScanRetriever();
  const indexed = createIndexedLexicalRetriever(indexedOptions);
  const threshold =
    typeof smallLimit === "number" && Number.isInteger(smallLimit) && smallLimit > 0
      ? smallLimit
      : documentThreshold || 1500;
  let active: AdaptiveActive = "full-scan";
  return {
    name: "adaptive",
    prepare(index: SearchIndex) {
      const n = index.documents?.length || 0;
      active = n <= threshold ? "full-scan" : "indexed-lexical";
      if (active === "indexed-lexical") indexed.prepare(index);
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
  if (!spec) return createIndexedLexicalRetriever();
  if (typeof spec === "object" && spec && "retrieve" in spec && typeof spec.retrieve === "function") {
    return spec as Retriever;
  }
  if (spec === "indexed" || spec === "indexed-lexical") return createIndexedLexicalRetriever();
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
