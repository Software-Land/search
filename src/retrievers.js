/**
 * Replaceable candidate retrieval.
 *
 * Query analysis and ranking stay in Search Core. Retrievers emit
 * { document, retrievalSources, retrievalScore? } only.
 *
 * Full scan remains the default. Indexed lexical retrieval is a candidate
 * generator (BM25 orders the budgeted set). It is not the ranker.
 */

import { retrieveCandidates, retrieveCandidatesAsync, matchContextualTitlePrefix } from "./retrieve.js";
import { allowPrefixMatch } from "./text.js";
import { isAllDigitToken } from "./versionForms.js";
import { throwIfAborted } from "./cancel.js";

// Exact-title, configured-equivalence, and version bypass the BM25 budget
// without a cap. Contextual title-prefix is a capped must-keep: overflow
// stays eligible for the ordinary candidateLimit pool.
const UNBOUNDED_MUST_KEEP = new Set(["exact-title", "configured-equivalence", "version"]);
const CONTEXTUAL_MUST_KEEP_SOURCE = "contextual-title-prefix";
const K1 = 1.2;
const B = 0.75;
const TITLE_BOOST = 4;

/** @param {{ retrievalSources: string[] }} hit @param {string} source */
function pushSource(hit, source) {
  if (!hit.retrievalSources.includes(source)) hit.retrievalSources.push(source);
}

/** @param {number} n @param {number} df */
function idf(n, df) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** @param {number} tf @param {number} dl @param {number} avgdl */
function bm25Tf(tf, dl, avgdl) {
  const denom = tf + K1 * (1 - B + B * (dl / Math.max(avgdl, 1)));
  return (tf * (K1 + 1)) / Math.max(denom, 1e-9);
}

/** @param {Array<{ norm: string }>} arr @param {string} key */
function lowerBoundNorm(arr, key) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].norm < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** @param {string[]} terms @param {string} key */
function lowerBoundTerm(terms, key) {
  let lo = 0;
  let hi = terms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (terms[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** @param {import("./types.js").AnalyzedQuery} query */
function queryForms(query) {
  /** @type {Array<{ form: string, kind: string }>} */
  const forms = [];
  const seen = new Set();
  /** @param {unknown} form @param {string} kind */
  function add(form, kind) {
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

export function createFullScanRetriever() {
  return {
    name: "full-scan",
    prepare() {},
    /**
     * @param {import("./types.js").AnalyzedQuery} query
     * @param {import("./types.js").SearchIndex} index
     * @param {import("./types.js").RetrieveOptions} [opts]
     */
    retrieve(query, index, opts = {}) {
      return retrieveCandidates(query, index, { signal: opts.signal });
    },
    /**
     * @param {import("./types.js").AnalyzedQuery} query
     * @param {import("./types.js").SearchIndex} index
     * @param {import("./types.js").RetrieveOptions} [opts]
     */
    retrieveAsync(query, index, opts = {}) {
      return retrieveCandidatesAsync(query, index, { signal: opts.signal });
    },
    stats() {
      return { kind: "full-scan" };
    },
  };
}

/** @returns {import("./types.js").Posting} */
function emptyPosting() {
  return { df: 0, docs: [], tfs: [] };
}

/** @param {Map<string, import("./types.js").Posting>} map @param {string[]} tokens @param {number} docPos */
function addTokenCounts(map, tokens, docPos) {
  const counts = new Map();
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

/** @param {Map<string, number>} counts */
function postingLength(counts) {
  let n = 0;
  for (const tf of counts.values()) n += tf;
  return Math.max(n, 1);
}

/**
 * Inverted lexical index + deterministic exact sources.
 * BM25 scores order the budgeted (non-exact) slice only.
 * @param {import("./types.js").IndexedLexicalOptions} [opts]
 * @returns {import("./types.js").Retriever}
 */
export function createIndexedLexicalRetriever({
  candidateLimit = 200,
  prefixCap = 800,
  unionDeterministic = true,
  titleBoost = TITLE_BOOST,
} = {}) {
  /** @type {import("./types.js").IndexedLexicalState} */
  const state = {
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

  /** @param {import("./types.js").SearchIndex} index */
  function prepare(index) {
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
    /** @type {Array<{ norm: string, pos: number }>} */
    const titles = [];
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

  /**
   * @param {Map<number, { pos: number, retrievalSources: string[], retrievalScore: number }>} byPos
   * @param {number} pos
   * @param {string} source
   * @param {number} [scoreDelta]
   */
  function addHit(byPos, pos, source, scoreDelta) {
    let hit = byPos.get(pos);
    if (!hit) {
      hit = { pos, retrievalSources: [], retrievalScore: 0 };
      byPos.set(pos, hit);
    }
    pushSource(hit, source);
    if (scoreDelta) hit.retrievalScore += scoreDelta;
  }

  /**
   * @param {Map<number, { pos: number, retrievalSources: string[], retrievalScore: number }>} byPos
   * @param {import("./types.js").Posting | undefined} posting
   * @param {string} source
   * @param {number} fieldBoost
   * @param {number} avgdl
   * @param {number[]} dlArr
   * @param {{ signal?: AbortSignal, n?: number }} [opts]
   */
  function accumulatePosting(byPos, posting, source, fieldBoost, avgdl, dlArr, { signal, n } = {}) {
    if (!posting) return;
    const w = idf(n || 0, posting.df) * fieldBoost;
    for (let i = 0; i < posting.docs.length; i++) {
      if ((i & 63) === 0) throwIfAborted(signal);
      const pos = posting.docs[i];
      const tf = posting.tfs[i];
      addHit(byPos, pos, source, w * bm25Tf(tf, dlArr[pos], avgdl));
    }
  }

  /** @param {string} prefix */
  function prefixTerms(prefix) {
    if (!prefix) return [];
    const out = [];
    let i = lowerBoundTerm(state.sortedTerms, prefix);
    while (i < state.sortedTerms.length) {
      const term = state.sortedTerms[i];
      if (!term.startsWith(prefix)) break;
      if (allowPrefixMatch(prefix, term)) out.push(term);
      i += 1;
      if (out.length >= 64) break;
    }
    return out;
  }

  /**
   * @param {import("./types.js").AnalyzedQuery} query
   * @param {import("./types.js").SearchIndex} index
   * @param {import("./types.js").RetrieveOptions} [opts]
   */
  function retrieve(query, index, { signal, candidateLimit: limitOverride } = {}) {
    throwIfAborted(signal);
    if (!state.prepared) prepare(index);
    const docs = index.documents || [];
    const n = state.n || docs.length;
    /** @type {Map<number, { pos: number, retrievalSources: string[], retrievalScore: number }>} */
    const byPos = new Map();
    const k = limitOverride || candidateLimit;
    const forms = queryForms(query);
    const qNorm = (query.tokens || []).map((t) => t.normalized).join(" ");

    const exact = state.titleByNorm.get(qNorm);
    if (exact) {
      for (const pos of exact) addHit(byPos, pos, "exact-title", 50);
    }

    if (qNorm) {
      const start = lowerBoundNorm(state.sortedTitles, qNorm);
      const prefixHits = [];
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
        for (const term of prefixTerms(form)) {
          if (term === form) continue;
          const tp = state.titlePostings.get(term);
          if (tp) accumulatePosting(byPos, tp, "title-token-prefix", titleBoost * 0.5, state.avgTitleDl, state.titleDl, { signal, n });
          const bp = state.bodyPostings.get(term);
          if (bp && form.length >= 3) {
            accumulatePosting(byPos, bp, "indexed-lexical", 0.4, state.avgBodyDl, state.bodyDl, { signal, n });
          }
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
    /** @type {Map<number, number>} */
    const contextualQuality = new Map();
    if (qToks.length >= 2) {
      const first = qToks[0];
      const keys = [...new Set([first?.normalized, first?.lemma].filter(Boolean))];
      /** @type {Set<number>} */
      const contextualPos = new Set();
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

    const hits = [...byPos.values()];
    const unboundedMust = [];
    const contextualMust = [];
    const rest = [];
    for (const h of hits) {
      const keepUnbounded = unionDeterministic && h.retrievalSources.some((s) => UNBOUNDED_MUST_KEEP.has(s));
      const keepContextual =
        unionDeterministic && h.retrievalSources.includes(CONTEXTUAL_MUST_KEEP_SOURCE);
      if (keepUnbounded) unboundedMust.push(h);
      else if (keepContextual) contextualMust.push(h);
      else rest.push(h);
    }
    contextualMust.sort((a, b) => {
      const qa = contextualQuality.get(a.pos) || 0;
      const qb = contextualQuality.get(b.pos) || 0;
      if (qb !== qa) return qb - qa;
      return a.pos - b.pos;
    });
    const contextualKept = contextualMust.slice(0, prefixCap);
    const contextualOverflow = contextualMust.slice(prefixCap);
    for (const h of contextualOverflow) rest.push(h);
    rest.sort((a, b) => b.retrievalScore - a.retrievalScore || a.pos - b.pos);
    const must = unionDeterministic ? [...unboundedMust, ...contextualKept] : [];
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
    async retrieveAsync(/** @type {import("./types.js").AnalyzedQuery} */ query, /** @type {import("./types.js").SearchIndex} */ index, /** @type {import("./types.js").RetrieveOptions} */ opts = {}) {
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
 * @param {import("./types.js").AdaptiveRetrieverOptions} [opts]
 * @returns {import("./types.js").Retriever}
 */
export function createAdaptiveRetriever({ documentThreshold = 1500, smallLimit, indexedOptions } = {}) {
  const full = createFullScanRetriever();
  const indexed = createIndexedLexicalRetriever(indexedOptions);
  const threshold =
    typeof smallLimit === "number" && Number.isInteger(smallLimit) && smallLimit > 0
      ? smallLimit
      : documentThreshold || 1500;
  let active = "full-scan";
  return {
    name: "adaptive",
    prepare(/** @type {import("./types.js").SearchIndex} */ index) {
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

/** @param {unknown} spec @returns {import("./types.js").Retriever} */
export function resolveRetriever(spec) {
  if (!spec || spec === "full-scan") return createFullScanRetriever();
  if (typeof spec === "object" && spec && "retrieve" in spec && typeof spec.retrieve === "function") {
    return /** @type {import("./types.js").Retriever} */ (spec);
  }
  if (spec === "indexed" || spec === "indexed-lexical") return createIndexedLexicalRetriever();
  if (spec === "adaptive") return createAdaptiveRetriever();
  if (typeof spec === "object" && spec && "type" in spec && spec.type === "indexed-lexical") {
    return createIndexedLexicalRetriever(/** @type {import("./types.js").IndexedLexicalOptions} */ (spec));
  }
  if (typeof spec === "object" && spec && "type" in spec && spec.type === "adaptive") {
    return createAdaptiveRetriever(/** @type {import("./types.js").AdaptiveRetrieverOptions} */ (spec));
  }
  return createFullScanRetriever();
}

export { UNBOUNDED_MUST_KEEP, CONTEXTUAL_MUST_KEEP_SOURCE, queryForms };
