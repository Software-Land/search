#!/usr/bin/env node
/**
 * Deterministic retrieval-pressure and exact compiled-index benchmark harness.
 *
 * Authoritative ranking: full-scan retrieve → current extractFeatures → sparse ranker.
 * Legacy suites retain the candidateLimit survival diagnostics. The `stage1`
 * suite measures the exact compiled path, fallback construction, posting work,
 * representative selection, artifact size, load cost, memory, and deterministic
 * A/B/C serialization projections.
 *
 *   node scripts/budget-pressure.mjs
 *   node scripts/budget-pressure.mjs --suite adversarial
 *   node --expose-gc scripts/budget-pressure.mjs --suite stage1 --sizes 1000,5000
 *
 * Not packed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { attachLexicalFrequency, compileLexicalIndex } from "../tools/search-lexical/index.js";
import { retrieveCandidates } from "../dist/retrieval/retrieve.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";
import { rankCandidates } from "../dist/ranking/rank.js";
import { constraintSignature } from "../dist/ranking/rankSignature.js";
import { compareConstraint, constraintsForStrategy } from "../dist/ranking/constraints.js";
import { queryForms } from "../dist/retrieval/retrievers.js";
import { allowPrefixMatch } from "../dist/text/text.js";
import { isAllDigitToken } from "../dist/text/versionForms.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "software-land");
const UNBOUNDED = new Set(["exact-title", "configured-concept", "version"]);
const CONTEXTUAL = "contextual-title-prefix";
const TITLE_PREFIX = "title-prefix";
const PREFIX_CAP = 800;
const SCHEMA = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const SEED = 0x60d6e7ed;

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

function isUnbounded(hit) {
  return (hit.retrievalSources || []).some((s) => UNBOUNDED.has(s));
}

function isContextual(hit) {
  return (hit.retrievalSources || []).includes(CONTEXTUAL);
}

function isTitlePrefix(hit) {
  return (hit.retrievalSources || []).includes(TITLE_PREFIX);
}

function titlePrefixQuality(hit, qNorm) {
  const title = hit.document?.normalizedTitle || "";
  return (qNorm || "").length / Math.max(title.length, 1);
}

function topIds(detailed, n) {
  return (detailed.results || []).slice(0, n).map((h) => h.id);
}

function publicSurface(detailed) {
  return {
    results: detailed.results || [],
    related: detailed.related || [],
  };
}

function exactPrefix(a, b, n) {
  const left = a.slice(0, n);
  const right = b.slice(0, n);
  if (left.length !== right.length) return false;
  return left.every((id, i) => id === right[i]);
}

function idCompare(a, b) {
  const left = typeof a === "string" ? a : a.document.id;
  const right = typeof b === "string" ? b : b.document.id;
  return left < right ? -1 : left > right ? 1 : 0;
}

function scoreIdCompare(a, b) {
  if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
  return idCompare(a, b);
}

function visibleRanked(ranked, strategy) {
  if (strategy === "none" || strategy === "separate") {
    return ranked.filter((h) => h.features.relevanceKind !== "related");
  }
  return ranked;
}

function rankState(engine, queryText, candidateLimit = null) {
  const query = engine._prepareQuery(queryText);
  const strategy = engine.relationshipStrategy || "hybrid";
  const constraints = constraintsForStrategy(strategy);
  const tRetrieve = performance.now();
  const retrieved = engine.retriever.retrieve(query, engine._index, {
    candidateLimit: candidateLimit == null ? engine.candidateLimit : candidateLimit,
  });
  const retrieveMs = performance.now() - tRetrieve;
  const { featured, featureMs, relationshipMs } = engine._expandAndFeature(retrieved, query, strategy);
  const tRank = performance.now();
  const ranked = rankCandidates(featured, { constraints });
  const rankMs = performance.now() - tRank;
  return {
    query,
    strategy,
    constraints,
    retrieved,
    featured,
    ranked,
    visible: visibleRanked(ranked, strategy),
    timing: {
      retrieveMs,
      featureMs,
      relationshipMs,
      rankMs,
      totalMs: retrieveMs + featureMs + relationshipMs + rankMs,
    },
  };
}

function stronglyConnected(adj) {
  const n = adj.length;
  const index = new Int32Array(n);
  index.fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack = [];
  const groups = [];
  let next = 0;

  function visit(v) {
    index[v] = next;
    low[v] = next;
    next += 1;
    stack.push(v);
    onStack[v] = 1;
    for (const w of adj[v]) {
      if (index[w] < 0) {
        visit(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], index[w]);
      }
    }
    if (low[v] !== index[v]) return;
    const group = [];
    while (stack.length) {
      const w = stack.pop();
      onStack[w] = 0;
      group.push(w);
      if (w === v) break;
    }
    groups.push(group);
  }

  for (let v = 0; v < n; v += 1) if (index[v] < 0) visit(v);
  const comp = new Int32Array(n);
  for (let g = 0; g < groups.length; g += 1) {
    for (const v of groups[g]) comp[v] = g;
  }
  return { groups, comp };
}

function signatureGraph(ranked, constraints) {
  const byKey = new Map();
  for (const hit of ranked) {
    const key = constraintSignature(hit.features);
    const group = byKey.get(key);
    if (group) group.push(hit);
    else byKey.set(key, [hit]);
  }
  const keys = [...byKey.keys()];
  const buckets = keys.map((key) => byKey.get(key).slice().sort(scoreIdCompare));
  const adj = Array.from({ length: buckets.length }, () => new Set());
  let conflicts = 0;
  for (let a = 0; a < buckets.length; a += 1) {
    for (let b = a + 1; b < buckets.length; b += 1) {
      const cmp = compareConstraint(buckets[a][0], buckets[b][0], constraints);
      if (cmp.conflict) conflicts += 1;
      if (cmp.order < 0) adj[a].add(b);
      else if (cmp.order > 0) adj[b].add(a);
    }
  }
  const scc = stronglyConnected(adj);
  const indegree = new Int32Array(scc.groups.length);
  for (let a = 0; a < adj.length; a += 1) {
    for (const b of adj[a]) {
      if (scc.comp[a] !== scc.comp[b]) indegree[scc.comp[b]] += 1;
    }
  }
  const sourceComponents = [];
  for (let g = 0; g < indegree.length; g += 1) {
    if (indegree[g] === 0) sourceComponents.push(g);
  }
  const sourceBuckets = new Set(sourceComponents.flatMap((g) => scc.groups[g]));
  return {
    keys,
    buckets,
    adj,
    scc,
    indegree,
    sourceComponents,
    sourceBuckets,
    conflicts,
    cycleComponents: scc.groups.filter((group) => group.length > 1),
  };
}

function selectTopM(graph, m, sourceOnly = false) {
  const out = [];
  for (let b = 0; b < graph.buckets.length; b += 1) {
    if (sourceOnly && !graph.sourceBuckets.has(b)) continue;
    out.push(...graph.buckets[b].slice(0, m));
  }
  return out;
}

function rankSelection(selected, constraints, strategy) {
  return visibleRanked(rankCandidates(selected, { constraints }), strategy);
}

function signatureArchetype(hit) {
  const f = hit?.features || {};
  const evidence = [];
  if (f.exactTitleMatch) evidence.push("exact-title");
  if (f.exactTitleTokenMatch) evidence.push("title-token");
  if (f.contextualTitlePrefix) evidence.push("contextual-prefix");
  if (f.shortLiteralLeadMatch) evidence.push("short-literal");
  if (f.configuredConceptMatch) evidence.push(`configured-concept:${f.configuredConceptMatch}`);
  if (f.versionMatch) evidence.push(`version:${f.versionMatch}`);
  if (f.dottedSpanComponentTitleMatch) evidence.push("dotted-component");
  if (f.canonicalKeyTitle) evidence.push("canonical-key");
  if ((f.bodyPhraseCount || 0) > 0) evidence.push(`phrase:${f.bodyPhraseCount >= 2 ? "repeated" : "single"}`);
  if ((f.queryCoverage || 0) > 0 && !f.exactTitleMatch && !f.exactTitleTokenMatch) evidence.push("title-query-coverage");
  if ((f.titlePrefixQuality || 0) > 0 && !f.contextualTitlePrefix) evidence.push("title-prefix-quality");
  if ((f.bodyLexicalMatch || 0) > 0 && !evidence.length) evidence.push("body-only");
  if (!evidence.length) evidence.push("other");
  return `${f.relevanceKind || "direct"}/${f.directClass || "none"}/${evidence.join("+")}`;
}

function winnerTaxonomy(graph, winner) {
  const key = constraintSignature(winner.features);
  const bucket = graph.keys.indexOf(key);
  const component = graph.scc.comp[bucket];
  const cycle = graph.scc.groups[component].length > 1;
  if (cycle) return "SCC/cycle";
  if (graph.sourceComponents.length > 1) return "incomparable-frontier score";
  if (graph.buckets.length === 1) return "within-signature score";
  if (graph.adj[bucket].size > 0) return "constraint-dominance";
  return graph.buckets[bucket].length > 1 ? "within-signature score" : "other";
}

function rawRetrievalRanks(indexedAll, ids) {
  const sorted = indexedAll
    .slice()
    .sort((a, b) => (b.retrievalScore || 0) - (a.retrievalScore || 0) || idCompare(a, b));
  const rankById = new Map(sorted.map((h, i) => [h.document.id, i + 1]));
  return ids.map((id) => rankById.get(id) || null);
}

function retrievalFinalDivergence(indexedAll, finalRanked) {
  const sorted = indexedAll
    .slice()
    .sort((a, b) => (b.retrievalScore || 0) - (a.retrievalScore || 0) || idCompare(a, b));
  const rawRank = new Map(sorted.map((hit, i) => [hit.document.id, i + 1]));
  const pairs = [];
  for (let i = 0; i < finalRanked.length; i += 1) {
    const retrievalRank = rawRank.get(finalRanked[i].document.id);
    if (retrievalRank != null) pairs.push([i + 1, retrievalRank]);
  }
  const n = pairs.length;
  const meanFinal = pairs.reduce((sum, pair) => sum + pair[0], 0) / Math.max(n, 1);
  const meanRetrieval = pairs.reduce((sum, pair) => sum + pair[1], 0) / Math.max(n, 1);
  let covariance = 0;
  let finalVariance = 0;
  let retrievalVariance = 0;
  let absoluteDelta = 0;
  for (const [finalRank, retrievalRank] of pairs) {
    const df = finalRank - meanFinal;
    const dr = retrievalRank - meanRetrieval;
    covariance += df * dr;
    finalVariance += df * df;
    retrievalVariance += dr * dr;
    absoluteDelta += Math.abs(finalRank - retrievalRank);
  }
  const denominator = Math.sqrt(finalVariance * retrievalVariance);
  const topRaw = (k) => {
    const raw = new Set(sorted.slice(0, k).map((hit) => hit.document.id));
    return finalRanked.slice(0, Math.min(k, finalRanked.length)).filter((hit) => raw.has(hit.document.id)).length;
  };
  return {
    compared: n,
    spearman: denominator ? Number((covariance / denominator).toFixed(4)) : n <= 1 ? 1 : 0,
    meanAbsoluteRankDelta: Number((absoluteDelta / Math.max(n, 1)).toFixed(2)),
    finalTop1InRawTop200: finalRanked[0] ? (rawRank.get(finalRanked[0].document.id) || Infinity) <= 200 : true,
    finalTop3InRawTop200: finalRanked.slice(0, 3).every((hit) => (rawRank.get(hit.document.id) || Infinity) <= 200),
    finalTop5InRawTop200: finalRanked.slice(0, 5).every((hit) => (rawRank.get(hit.document.id) || Infinity) <= 200),
    finalTop10InRawTop200: finalRanked.slice(0, 10).every((hit) => (rawRank.get(hit.document.id) || Infinity) <= 200),
    overlapAt10: topRaw(10),
  };
}

const postingAnalysisCache = new WeakMap();

function postingAnalysisIndex(index) {
  const cached = postingAnalysisCache.get(index);
  if (cached) return cached;
  const maps = {
    title: new Map(),
    body: new Map(),
    titleLemma: new Map(),
    bodyLemma: new Map(),
    version: new Map(),
  };
  function add(map, term, pos) {
    if (!term) return;
    const docs = map.get(term);
    if (docs) {
      if (docs[docs.length - 1] !== pos) docs.push(pos);
    } else {
      map.set(term, [pos]);
    }
  }
  for (let pos = 0; pos < index.documents.length; pos += 1) {
    const doc = index.documents[pos];
    for (const term of new Set(doc.titleTokens || [])) add(maps.title, term, pos);
    for (const term of new Set(doc.bodyTokens || [])) add(maps.body, term, pos);
    for (const term of new Set(doc.titleLemmas || [])) add(maps.titleLemma, term, pos);
    for (const term of new Set(doc.bodyLemmas || [])) add(maps.bodyLemma, term, pos);
    for (const term of new Set([...(doc.versionCompactForms || []), ...(doc.dottedSpans || [])])) {
      add(maps.version, term, pos);
    }
  }
  const out = {
    ...maps,
    terms: [...new Set([...maps.title.keys(), ...maps.body.keys(), ...maps.titleLemma.keys()])].sort(idCompare),
    titles: index.documents
      .map((doc, pos) => ({ norm: doc.normalizedTitle || "", pos }))
      .sort((a, b) => idCompare(a.norm, b.norm) || a.pos - b.pos),
  };
  postingAnalysisCache.set(index, out);
  return out;
}

function lowerBoundStrings(values, key, pick = (v) => v) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pick(values[mid]) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function currentPostingWork(query, index, { candidateLimit = 200, prefixCap = PREFIX_CAP } = {}) {
  const state = postingAnalysisIndex(index);
  let postingHitsExamined = 0;
  let postingListsExamined = 0;
  let prefixTermsExpanded = 0;
  let titleRowsExamined = 0;
  let contextualPostingHits = 0;
  const addPosting = (docs) => {
    if (!docs) return;
    postingListsExamined += 1;
    postingHitsExamined += docs.length;
  };
  const qNorm = (query.tokens || []).map((t) => t.normalized).join(" ");
  if (qNorm) {
    let i = lowerBoundStrings(state.titles, qNorm, (row) => row.norm);
    let matched = 0;
    while (i < state.titles.length && state.titles[i].norm.startsWith(qNorm) && matched < prefixCap * 4) {
      titleRowsExamined += 1;
      matched += 1;
      i += 1;
    }
  }
  for (const { form } of queryForms(query)) {
    addPosting(state.title.get(form));
    addPosting(state.body.get(form));
    addPosting(state.titleLemma.get(form));
    addPosting(state.bodyLemma.get(form));
    if (!isAllDigitToken(form) && form.length >= 3) {
      let i = lowerBoundStrings(state.terms, form);
      while (i < state.terms.length && state.terms[i].startsWith(form)) {
        const term = state.terms[i];
        if (term !== form && allowPrefixMatch(form, term)) {
          prefixTermsExpanded += 1;
          addPosting(state.title.get(term));
        }
        if (term !== form && !isAllDigitToken(term)) {
          prefixTermsExpanded += 1;
          addPosting(state.body.get(term));
        }
        i += 1;
      }
    }
  }
  for (const token of query.tokens || []) addPosting(state.version.get(token.normalized));
  for (const span of query.dottedSpans || []) addPosting(state.version.get(span));
  if ((query.tokens || []).length >= 2) {
    const first = query.tokens[0];
    const keys = [...new Set([first?.normalized, first?.lemma].filter(Boolean))];
    for (const key of keys) {
      for (const map of [state.title, state.titleLemma]) {
        const docs = map.get(key);
        if (!docs) continue;
        postingListsExamined += 1;
        postingHitsExamined += docs.length;
        contextualPostingHits += docs.length;
      }
    }
  }
  return {
    postingHitsExamined,
    postingListsExamined,
    prefixTermsExpanded,
    titleRowsExamined,
    contextualPostingHits,
    postingsSkippedBySafeBounds: 0,
    candidateLimit,
  };
}

function analyzePressureQuery(fullEngine, indexedEngine, queryText, meta = {}) {
  const full = rankState(fullEngine, queryText);
  if (full.featured.length <= 200) return null;
  const indexed = rankState(indexedEngine, queryText, 200);
  const indexedAllHits = indexedEngine.retriever.retrieve(indexed.query, indexedEngine._index, {
    candidateLimit: 1_000_000,
  });
  const graph = signatureGraph(full.ranked, full.constraints);
  const fullIds = full.visible.slice(0, 10).map((h) => h.document.id);
  const indexedIds = indexed.visible.slice(0, 10).map((h) => h.document.id);
  const winner = full.visible[0];
  const indexedWinner = indexed.visible[0];
  const topM = {};
  const maximalM = {};
  for (const m of [1, 2, 3, 5, 10, 20]) {
    const perSignature = rankSelection(selectTopM(graph, m), full.constraints, full.strategy);
    const maximal = rankSelection(selectTopM(graph, m, true), full.constraints, full.strategy);
    topM[m] = {
      C: selectTopM(graph, m).length,
      top1: exactPrefix(fullIds, perSignature.map((h) => h.document.id), 1),
      top3: exactPrefix(fullIds, perSignature.map((h) => h.document.id), 3),
      top5: exactPrefix(fullIds, perSignature.map((h) => h.document.id), 5),
      top10: exactPrefix(fullIds, perSignature.map((h) => h.document.id), 10),
    };
    maximalM[m] = {
      C: selectTopM(graph, m, true).length,
      top1: exactPrefix(fullIds, maximal.map((h) => h.document.id), 1),
      top3: exactPrefix(fullIds, maximal.map((h) => h.document.id), 3),
      top5: exactPrefix(fullIds, maximal.map((h) => h.document.id), 5),
      top10: exactPrefix(fullIds, maximal.map((h) => h.document.id), 10),
    };
  }
  const qNorm = (indexed.query.tokens || []).map((t) => t.normalized).join(" ");
  const indexedPosition = winnerRetrievalPosition(indexedAllHits, winner?.document.id, qNorm);
  const topRanks = rawRetrievalRanks(indexedAllHits, full.visible.slice(0, 10).map((h) => h.document.id));
  const winnerVsIndexed = winner && indexedWinner
    ? compareConstraint(winner, indexedWinner, full.constraints)
    : null;
  const sourceSignatureCount = [...graph.sourceBuckets].length;
  const signatureSafe = {};
  for (const k of [1, 3, 5, 10]) {
    signatureSafe[k] = graph.buckets.reduce((sum, bucket) => sum + Math.min(k, bucket.length), 0);
  }
  return {
    ...meta,
    query: queryText,
    N: fullEngine._index.documents.length,
    fullC: full.featured.length,
    indexedC: indexed.featured.length,
    legitimateMatches: full.retrieved.length,
    signatures: graph.buckets.length,
    maximalSignatures: sourceSignatureCount,
    maximalComponents: graph.sourceComponents.length,
    cycles: graph.cycleComponents.length,
    conflicts: graph.conflicts,
    winner: {
      id: winner?.document.id || null,
      title: winner?.document.title || null,
      score: winner?.score || 0,
      signature: winner ? constraintSignature(winner.features) : null,
      archetype: signatureArchetype(winner),
      taxonomy: winner ? winnerTaxonomy(graph, winner) : "other",
      directClass: winner?.features.directClass || null,
      relevanceKind: winner?.features.relevanceKind || null,
      retrievalSources: winner?.retrievalSources || [],
      indexedLane: indexedPosition.lane,
      indexedOrdinaryPosition: indexedPosition.ordinaryPos,
      rawRetrievalRank: topRanks[0],
      features: winner?.features || null,
    },
    indexedWinner: {
      id: indexedWinner?.document.id || null,
      title: indexedWinner?.document.title || null,
      score: indexedWinner?.score || 0,
      archetype: signatureArchetype(indexedWinner),
      retrievalSources: indexedWinner?.retrievalSources || [],
    },
    winnerVsIndexed,
    fullTop: fullIds,
    indexedTop: indexedIds,
    exact: {
      top1: exactPrefix(fullIds, indexedIds, 1),
      top3: exactPrefix(fullIds, indexedIds, 3),
      top5: exactPrefix(fullIds, indexedIds, 5),
      top10: exactPrefix(fullIds, indexedIds, 10),
    },
    topRetrievalRanks: {
      top1: topRanks.slice(0, 1),
      top3: topRanks.slice(0, 3),
      top5: topRanks.slice(0, 5),
      top10: topRanks,
    },
    retrievalFinalDivergence: retrievalFinalDivergence(indexedAllHits, full.visible),
    minimalOracleC: { top1: 1, top3: Math.min(3, fullIds.length), top5: Math.min(5, fullIds.length), top10: Math.min(10, fullIds.length) },
    signatureSafeC: {
      top1: signatureSafe[1],
      top3: signatureSafe[3],
      top5: signatureSafe[5],
      top10: signatureSafe[10],
    },
    topM,
    maximalM,
    postingWork: {
      currentIndexed: {
        ...currentPostingWork(indexed.query, indexedEngine._index, { candidateLimit: 200 }),
        exactMatchingDocuments: indexedAllHits.length,
      },
      fullScanDocumentsExamined: fullEngine._index.documents.length,
      documentsFullyFeatured: {
        full: full.featured.length,
        indexed: indexed.featured.length,
      },
    },
    timing: { full: full.timing, indexed: indexed.timing },
  };
}

function createEngine(retriever, docs, extra = {}) {
  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins: extra.plugins || [morphology({ lemmas: extra.lemmas || {} }), compileConfiguredConceptPlugin({ configuredConcepts: extra.configuredConcepts || [] })],
    documentRelationships: extra.relationships || null,
    relationshipStrategy: extra.relationshipStrategy || "hybrid",
    retriever,
    candidateLimit: extra.candidateLimit ?? 200,
  });
  return engine.index(docs).then(() => engine);
}

function retrieveAll(engine, query) {
  const analyzed = engine._prepareQuery(query);
  const fullHits = retrieveCandidates(analyzed, engine._index);
  const indexedHits = engine.retriever.retrieve(analyzed, engine._index, { candidateLimit: 1_000_000 });
  return { analyzed, fullHits, indexedHits };
}

function ordinaryRank(hits, qNorm = "") {
  const unbounded = [];
  const contextual = [];
  const titlePrefix = [];
  const rest = [];
  for (const h of hits) {
    if (isUnbounded(h)) unbounded.push(h);
    else if (isContextual(h)) contextual.push(h);
    else if (isTitlePrefix(h)) titlePrefix.push(h);
    else rest.push(h);
  }
  titlePrefix.sort((a, b) => {
    const qa = titlePrefixQuality(a, qNorm);
    const qb = titlePrefixQuality(b, qNorm);
    if (qb !== qa) return qb - qa;
    return idCompare(a, b);
  });
  const titlePrefixKept = titlePrefix.slice(0, PREFIX_CAP);
  for (const h of titlePrefix.slice(PREFIX_CAP)) rest.push(h);
  rest.sort((a, b) => (b.retrievalScore || 0) - (a.retrievalScore || 0) || idCompare(a, b));
  return { unbounded, contextual, titlePrefix: titlePrefixKept, rest, ordinary: rest };
}

function winnerRetrievalPosition(indexedHits, winnerId, qNorm = "") {
  if (!winnerId) return { lane: "none", ordinaryPos: null, survivesK: () => false };
  const hit = indexedHits.find((h) => h.document.id === winnerId);
  if (!hit) return { lane: "missing", ordinaryPos: null, survivesK: () => false, sources: [] };
  if (isUnbounded(hit)) return { lane: "unbounded", ordinaryPos: null, survivesK: () => true, sources: hit.retrievalSources, retrievalScore: hit.retrievalScore };
  if (isContextual(hit)) return { lane: "contextual-prefix", ordinaryPos: null, survivesK: () => true, sources: hit.retrievalSources, retrievalScore: hit.retrievalScore };
  const ranked = ordinaryRank(indexedHits, qNorm);
  if (ranked.titlePrefix.some((h) => h.document.id === winnerId)) {
    return { lane: "title-prefix", ordinaryPos: null, survivesK: () => true, sources: hit.retrievalSources, retrievalScore: hit.retrievalScore };
  }
  const { ordinary } = ranked;
  const pos = ordinary.findIndex((h) => h.document.id === winnerId) + 1;
  return {
    lane: "ordinary",
    ordinaryPos: pos || null,
    ordinaryCount: ordinary.length,
    survivesK: (k) => pos > 0 && pos <= k,
    sources: hit.retrievalSources,
    retrievalScore: hit.retrievalScore,
  };
}

function compareQuery(fullEngine, indexedEngine, query, { k = 200, topN = 10 } = {}) {
  const fullD = fullEngine.searchDetailed(query, { limit: topN, relatedLimit: 5, explain: true });
  const idxD = indexedEngine.searchDetailed(query, { limit: topN, relatedLimit: 5, explain: true, candidateLimit: k });
  const { analyzed, fullHits, indexedHits } = retrieveAll(indexedEngine, query);
  const qNorm = (analyzed.tokens || []).map((t) => t.normalized).join(" ");
  const fullIds = topIds(fullD, topN);
  const idxIds = topIds(idxD, topN);
  const winnerId = fullIds[0] || null;
  const pos = winnerRetrievalPosition(indexedHits, winnerId, qNorm);
  const rankedIndexed = ordinaryRank(indexedHits, qNorm);
  const rankedFull = ordinaryRank(fullHits, qNorm);
  const fullTitles = fullD.results || [];
  const retrievedIds = new Set(
    [...rankedIndexed.unbounded, ...rankedIndexed.contextual, ...rankedIndexed.titlePrefix, ...rankedIndexed.ordinary.slice(0, k)].map(
      (h) => h.document.id
    )
  );
  const topSurvive = (n) => fullTitles.slice(0, n).every((h) => retrievedIds.has(h.id));
  return {
    query,
    k,
    fullC: fullD.meta.candidateCount,
    indexedC: idxD.meta.candidateCount,
    legitimateOrdinary: rankedFull.ordinary.length,
    legitimateAll: fullHits.length,
    retrieveMs: { full: fullD.meta.retrieveMs, indexed: idxD.meta.retrieveMs },
    featureMs: { full: fullD.meta.featureMs, indexed: idxD.meta.featureMs },
    rankMs: { full: fullD.meta.rankMs, indexed: idxD.meta.rankMs },
    totalMs: { full: fullD.meta.totalMs, indexed: idxD.meta.totalMs },
    fullTop: fullIds,
    indexedTop: idxIds,
    top1: exactPrefix(fullIds, idxIds, 1),
    top3: exactPrefix(fullIds, idxIds, 3),
    top5: exactPrefix(fullIds, idxIds, 5),
    top10: exactPrefix(fullIds, idxIds, 10),
    winnerId,
    winnerTitle: fullD.results[0]?.title || null,
    winnerDirectClass: fullD.results[0]?.directClass || null,
    winnerSources: fullD.results[0]?.retrievalSources || null,
    indexedWinnerId: idxIds[0] || null,
    indexedWinnerTitle: idxD.results[0]?.title || null,
    retrieval: pos,
    survival: {
      top1: topSurvive(1),
      top3: topSurvive(3),
      top5: topSurvive(5),
      top10: topSurvive(10),
    },
    relatedEqual: JSON.stringify((fullD.related || []).slice(0, 5).map((h) => h.id)) === JSON.stringify((idxD.related || []).slice(0, 5).map((h) => h.id)),
    scoreEqual: (fullD.results[0]?.score ?? null) === (idxD.results[0]?.score ?? null),
    kindEqual: (fullD.results[0]?.relevanceKind ?? null) === (idxD.results[0]?.relevanceKind ?? null),
    classEqual: (fullD.results[0]?.directClass ?? null) === (idxD.results[0]?.directClass ?? null),
  };
}

function summarize(rows) {
  const n = rows.length || 1;
  const rate = (key) => Number((rows.filter((r) => r[key]).length / rows.length).toFixed(4));
  const surv = (key) => Number((rows.filter((r) => r.survival?.[key]).length / rows.length).toFixed(4));
  return {
    n: rows.length,
    top1: rate("top1"),
    top3: rate("top3"),
    top5: rate("top5"),
    top10: rate("top10"),
    survivalTop1: surv("top1"),
    droppedWinners: rows.filter((r) => !r.survival.top1).map((r) => ({
      query: r.query,
      winner: r.winnerTitle,
      winnerId: r.winnerId,
      ordinaryPos: r.retrieval.ordinaryPos,
      ordinaryCount: r.retrieval.ordinaryCount,
      lane: r.retrieval.lane,
      indexedTop: r.indexedWinnerTitle,
      legitimateOrdinary: r.legitimateOrdinary,
      sources: r.retrieval.sources,
    })),
    overBudget: rows.filter((r) => r.legitimateOrdinary > 200).length,
    meanFullC: Number((rows.reduce((s, r) => s + r.fullC, 0) / n).toFixed(1)),
    meanIndexedC: Number((rows.reduce((s, r) => s + r.indexedC, 0) / n).toFixed(1)),
  };
}

function adversarialShortLiteral(matchN, backgroundN = 800) {
  const docs = [
    {
      id: "winner-short-literal",
      title: "Zzwinner unique ranking title analog",
      body: "unrelated body without the query token repeated",
    },
  ];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `flood-${String(i).padStart(5, "0")}`,
      title: `Unrelated filler ${i}`,
      body: Array.from({ length: 24 }, () => "zz").join(" "),
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-${String(i).padStart(5, "0")}`,
      title: `Background document ${i}`,
      body: "lorem ipsum dolor sit amet unrelated content",
    });
  }
  return docs;
}

function adversarialIndependentTitleToken(matchN, backgroundN = 800) {
  const docs = [];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `indep-flood-${String(i).padStart(5, "0")}`,
      title: `Notes probezz extra extra extra ${i}`,
      body: `probezz ${"probezz ".repeat(12)}`,
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-indep-${String(i).padStart(5, "0")}`,
      title: "Background notes",
      body: "lorem ipsum dolor sit amet",
    });
  }
  docs.push({ id: "winner-indep-title-token", title: "The Probezz", body: "notes" });
  return docs;
}

function adversarialExactTitleToken(matchN, backgroundN = 800) {
  const docs = [{ id: "winner-title-token", title: "The Probezz", body: "notes" }];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `title-flood-${String(i).padStart(5, "0")}`,
      title: `Probezz probezz probezz notes ${i}`,
      body: `probezz ${"probezz ".repeat(12)}`,
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-tt-${String(i).padStart(5, "0")}`,
      title: `Background ${i}`,
      body: "lorem ipsum dolor sit amet",
    });
  }
  return docs;
}

function adversarialCoverage(matchN, backgroundN = 800) {
  const docs = [{ id: "winner-coverage", title: "Alpha Beta Gamma", body: "unique" }];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `cov-${String(i).padStart(5, "0")}`,
      title: `Other ${i}`,
      body: `alpha ${"alpha ".repeat(20)}`,
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-cov-${String(i).padStart(5, "0")}`,
      title: `Background ${i}`,
      body: "lorem ipsum dolor sit amet",
    });
  }
  return { docs, query: "alpha beta gamma" };
}

function adversarialPhrase(matchN, backgroundN = 800) {
  const docs = [{ id: "winner-phrase", title: "Other notes", body: "machine learning machine learning applied" }];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `ph-${String(i).padStart(5, "0")}`,
      title: `Machine ${i}`,
      body: `learning ${"token ".repeat(16)}`,
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-ph-${String(i).padStart(5, "0")}`,
      title: `Background ${i}`,
      body: "lorem ipsum dolor sit amet",
    });
  }
  return { docs, query: "machine learning" };
}

function adversarialDottedSpan(matchN, backgroundN = 800) {
  const docs = [{ id: "winner-dotted", title: "TLS 1.2 Vulnerability", body: "transport" }];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `dot-${String(i).padStart(5, "0")}`,
      title: "Digit flood item",
      body: Array.from({ length: 16 }, () => "2").join(" "),
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-dot-${String(i).padStart(5, "0")}`,
      title: "Background notes",
      body: "lorem ipsum dolor sit amet",
    });
  }
  return docs;
}

function adversarialEqualSignature(matchN, backgroundN = 800) {
  const docs = [
    {
      id: "000-equal-signature-winner",
      title: "Notes Tiezz",
      body: "tiezz",
    },
  ];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `tie-flood-${String(i).padStart(5, "0")}`,
      title: "Notes Tiezz",
      body: Array.from({ length: 24 }, () => "tiezz").join(" "),
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-tie-${String(i).padStart(5, "0")}`,
      title: "Background notes",
      body: "lorem ipsum dolor sit amet",
    });
  }
  return docs;
}

function adversarialSameSignatureDifferentScore(matchN, backgroundN = 800) {
  const docs = [
    {
      id: "winner-body-coverage",
      title: "Unrelated winner",
      body: "alpha spacer beta spacer gamma",
    },
  ];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `body-score-flood-${String(i).padStart(5, "0")}`,
      title: "Unrelated flood",
      body: Array.from({ length: 24 }, () => "alpha").join(" "),
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-body-score-${String(i).padStart(5, "0")}`,
      title: "Background notes",
      body: "lorem ipsum dolor sit amet",
    });
  }
  return docs;
}

function adversarialEqualTightnessDifferentScore(matchN, backgroundN = 800) {
  const docs = [
    {
      id: "winner-equal-tightness",
      title: "Notes Alpha Filler",
      body: "alpha beta",
    },
  ];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `equal-tightness-flood-${String(i).padStart(5, "0")}`,
      title: "Notes Alpha Filler",
      body: `${"alpha ".repeat(12)}separator ${"beta ".repeat(12)}`,
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-equal-tightness-${String(i).padStart(5, "0")}`,
      title: "Background notes",
      body: "lorem ipsum dolor sit amet",
    });
  }
  return docs;
}

function mixedCorpus(n) {
  const specials = [
    { id: "rare-exact", title: "ZX9 UniqueRareTitle", body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security handshake certificate pinning" },
    { id: "vpn", title: "What is VPN?", body: "virtual private network tunnel bluetooth accessories" },
    { id: "iot", title: "What is IoT?", body: "internet of things sensors search index document" },
    { id: "io", title: "What is IO?", body: "input output streams latency throughput" },
    { id: "bluetooth", title: "Bluetooth Settings", body: "connect wireless accessories bluetooth pairing" },
    { id: "fps", title: "200FPS Canvas Notes", body: "css vs canvas rendering" },
  ];
  const rest = Math.max(0, n - specials.length);
  const settingsN = Math.floor(rest * 0.3);
  const articleN = rest - settingsN;
  return [...specials, ...generateSettings(settingsN, SEED ^ 0x11), ...generateArticle(articleN, { bodyTokens: 60, seed: SEED ^ 0x22, diverse: false })];
}

const MIXED_QUERIES = [
  { cls: "rare-exact-title", q: "ZX9 UniqueRareTitle" },
  { cls: "common-title-token", q: "bluetooth" },
  { cls: "common-body-token", q: "search" },
  { cls: "multi-token-phrase", q: "virtual private network" },
  { cls: "prefix", q: "virt" },
  { cls: "typo", q: "blutooth" },
  { cls: "morphology", q: "searching" },
  { cls: "configured-concept", q: "tls" },
  { cls: "version", q: "1.2" },
  { cls: "dotted-span", q: "tls 1.2" },
  { cls: "short-literal", q: "io" },
  { cls: "relationship", q: "vpn" },
  { cls: "high-df", q: "the" },
  { cls: "mixed-title-body", q: "network" },
];

const LEMMAS = { searching: "search", searched: "search", searches: "search" };
const CONFIGURED_CONCEPTS = [{ key: "tls", aliases: [["transport", "layer", "security"]] }];
const RELATIONSHIPS = {
  format: "search-v2-relationships",
  version: 1,
  relationships: {
    tls: [{ target: "vpn", type: "editorial", strength: 1, provenance: "manual" }],
    vpn: [{ target: "tls", type: "editorial", strength: 1, provenance: "manual" }],
  },
};

async function suiteMixed(sizes) {
  const out = [];
  for (const n of sizes) {
    const docs = mixedCorpus(n);
    const extra = { lemmas: LEMMAS, configuredConcepts: CONFIGURED_CONCEPTS, relationships: RELATIONSHIPS, relationshipStrategy: "hybrid" };
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, extra);
    for (const { cls, q } of MIXED_QUERIES) {
      const row = compareQuery(full, indexed, q, { k: 200, topN: 10 });
      out.push({ n, cls, ...row });
    }
  }
  return out;
}

async function suiteAdversarial() {
  const counts = [24, 49, 99, 149, 199, 200, 201, 249, 499];
  const rows = [];
  for (const d of counts) {
    const docs = adversarialShortLiteral(d);
    const extra = { relationshipStrategy: "none" };
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, extra);
    const row = compareQuery(full, indexed, "zz", { k: 200, topN: 10 });
    rows.push({ family: "short-literal-body-flood", distractors: d, ...row });
  }
  for (const d of [199, 250, 400]) {
    const docs = adversarialExactTitleToken(d);
    const extra = { relationshipStrategy: "none" };
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, extra);
    rows.push({ family: "title-token-flood", distractors: d, ...compareQuery(full, indexed, "probezz", { k: 200, topN: 10 }) });
  }
  for (const d of [199, 250, 400]) {
    const docs = adversarialIndependentTitleToken(d);
    const extra = { relationshipStrategy: "none" };
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, extra);
    rows.push({ family: "independent-title-token-flood", distractors: d, ...compareQuery(full, indexed, "probezz", { k: 200, topN: 10 }) });
  }
  for (const d of [199, 250, 400]) {
    const { docs, query } = adversarialCoverage(d);
    const extra = { relationshipStrategy: "none" };
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, extra);
    rows.push({ family: "coverage-vs-body", distractors: d, ...compareQuery(full, indexed, query, { k: 200, topN: 10 }) });
  }
  for (const d of [199, 250, 400]) {
    const { docs, query } = adversarialPhrase(d);
    const extra = { relationshipStrategy: "none", configuredConcepts: [{ key: "ml", aliases: [["machine", "learning"]] }] };
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, extra);
    rows.push({ family: "phrase-vs-title-token", distractors: d, ...compareQuery(full, indexed, query, { k: 200, topN: 10 }) });
  }
  for (const d of [199, 250, 400]) {
    const docs = adversarialDottedSpan(d);
    const extra = { relationshipStrategy: "none" };
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, extra);
    rows.push({ family: "dotted-span-vs-digit-body", distractors: d, ...compareQuery(full, indexed, "2", { k: 200, topN: 10 }) });
  }
  return rows;
}

async function suiteSweep() {
  const ks = [50, 100, 150, 200, 300, 500, 1000];
  const rows = new Map(ks.map((k) => [k, []]));

  async function addPressureQueries(corpus, docs, queries, extra) {
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, { ...extra, candidateLimit: 1000 });
    for (const query of queries) {
      const { analyzed, fullHits } = retrieveAll(indexed, query);
      const qNorm = (analyzed.tokens || []).map((token) => token.normalized).join(" ");
      if (ordinaryRank(fullHits, qNorm).ordinary.length <= 200) continue;
      for (const k of ks) rows.get(k).push({ corpus, ...compareQuery(full, indexed, query, { k, topN: 10 }) });
    }
  }

  await addPressureQueries(
    "mixed-5000",
    mixedCorpus(5000),
    MIXED_QUERIES.map((row) => row.q),
    {
      lemmas: LEMMAS,
      configuredConcepts: CONFIGURED_CONCEPTS,
      relationships: RELATIONSHIPS,
      relationshipStrategy: "hybrid",
    }
  );

  const originals = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
  const oracle = load("query-result-oracle.json");
  await addPressureQueries(
    "software-land+5000",
    [...originals, ...slDistractors(5000)],
    oracle.rows.map((row) => row.query),
    {
      lemmas: load("lemmas.json"),
      configuredConcepts: load("configured-concepts.json"),
      relationships: load("relationships.json"),
      relationshipStrategy: "hybrid",
    }
  );

  const adversarial = [
    ["short-literal", adversarialShortLiteral(1000), "zz", {}],
    ["independent-title-token", adversarialIndependentTitleToken(1000), "probezz", {}],
    ["equal-signature-id", adversarialEqualSignature(1000), "tiezz", {}],
    ["equal-tightness-score", adversarialEqualTightnessDifferentScore(1000), "alpha beta", {}],
    ["coverage", adversarialCoverage(1000).docs, "alpha beta gamma", {}],
    ["phrase", adversarialPhrase(1000).docs, "machine learning", { configuredConcepts: [{ key: "ml", aliases: [["machine", "learning"]] }] }],
    ["dotted-span", adversarialDottedSpan(1000), "2", {}],
  ];
  for (const [corpus, docs, query, extra] of adversarial) {
    await addPressureQueries(`adversarial:${corpus}`, docs, [query], { relationshipStrategy: "none", ...extra });
  }

  const rate = (values, predicate) => Number((values.filter(predicate).length / Math.max(values.length, 1)).toFixed(4));
  const mean = (values, selector) => Number((values.reduce((sum, row) => sum + selector(row), 0) / Math.max(values.length, 1)).toFixed(2));
  return ks.map((k) => {
    const values = rows.get(k);
    return {
      k,
      pressureQueries: values.length,
      top1: rate(values, (row) => row.top1),
      top3: rate(values, (row) => row.top3),
      top5: rate(values, (row) => row.top5),
      top10: rate(values, (row) => row.top10),
      survivalTop1: rate(values, (row) => row.survival.top1),
      survivalTop3: rate(values, (row) => row.survival.top3),
      survivalTop5: rate(values, (row) => row.survival.top5),
      survivalTop10: rate(values, (row) => row.survival.top10),
      meanIndexedC: mean(values, (row) => row.indexedC),
      meanRetrieveMs: mean(values, (row) => row.retrieveMs.indexed),
      meanFeatureMs: mean(values, (row) => row.featureMs.indexed),
      meanRankMs: mean(values, (row) => row.rankMs.indexed),
      meanTotalMs: mean(values, (row) => row.totalMs.indexed),
      droppedWinners: values
        .filter((row) => !row.survival.top1)
        .map((row) => ({
          corpus: row.corpus,
          query: row.query,
          winner: row.winnerTitle,
          ordinaryPos: row.retrieval.ordinaryPos,
          ordinaryCount: row.retrieval.ordinaryCount,
        })),
    };
  });
}

function slDistractors(n) {
  const docs = [];
  for (let i = 0; i < n; i += 1) {
    docs.push({
      id: `sl-flood-${String(i).padStart(5, "0")}`,
      title: "Unrelated filler notes",
      body: [
        "2 2 2 2 2",
        "testing search index document query title body token",
        "what is the of and to in a for on with as by from",
        "tls vpn network protocol security machine learning",
      ].join(" "),
    });
  }
  return docs;
}

async function suiteSoftwareLand(floodNs) {
  const originals = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
  const oracle = load("query-result-oracle.json");
  const extra = {
    lemmas: load("lemmas.json"),
    configuredConcepts: load("configured-concepts.json"),
    relationships: load("relationships.json"),
    relationshipStrategy: "hybrid",
  };
  const out = [];
  for (const flood of floodNs) {
    const docs = flood ? [...originals, ...slDistractors(flood)] : originals;
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, extra);
    const rows = [];
    for (const frozen of oracle.rows) {
      const row = compareQuery(full, indexed, frozen.query, { k: 200, topN: 10 });
      const originalWinner = frozen.results[0]?.id || null;
      rows.push({
        ...row,
        originalWinner,
        originalStillFullScanTop: row.winnerId === originalWinner,
        originalDroppedByIndexed: originalWinner != null && row.survival.top1 === false && row.winnerId === originalWinner,
      });
    }
    out.push({
      flood,
      n: docs.length,
      summary: summarize(rows),
      query2: rows.find((r) => r.query === "2"),
      originalWinnerPushed: rows.filter((r) => r.originalWinner && !r.originalStillFullScanTop).length,
      originalDropped: rows.filter((r) => r.originalDroppedByIndexed),
    });
  }
  return out;
}

function countBy(rows, fn) {
  const out = {};
  for (const row of rows) {
    const key = String(fn(row));
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function quantiles(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, min: null, p50: null, p90: null, p95: null, max: null };
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}

function sampleSync(engine, query, opts, mode, { warmup = 2, iterations = 5 } = {}) {
  const run = () => engine._searchDetailedSync(query, opts, false, mode);
  for (let i = 0; i < warmup; i += 1) run();
  const total = [];
  const retrieve = [];
  const feature = [];
  const selection = [];
  const rank = [];
  let last;
  for (let i = 0; i < iterations; i += 1) {
    last = run();
    total.push(last.meta.totalMs);
    retrieve.push(last.meta.retrieveMs);
    feature.push(last.meta.featureMs);
    selection.push(last.meta.selectionMs);
    rank.push(last.meta.rankMs);
  }
  return {
    last,
    warmup,
    iterations,
    totalMs: quantiles(total),
    retrieveMs: quantiles(retrieve),
    featureMs: quantiles(feature),
    selectionMs: quantiles(selection),
    rankMs: quantiles(rank),
  };
}

function architectureSummary(rows) {
  const rate = (fn) => Number((rows.filter(fn).length / Math.max(rows.length, 1)).toFixed(4));
  const byM = {};
  for (const m of [1, 2, 3, 5, 10, 20]) {
    byM[m] = {
      top1: rate((r) => r.topM[m].top1),
      top3: rate((r) => r.topM[m].top3),
      top5: rate((r) => r.topM[m].top5),
      top10: rate((r) => r.topM[m].top10),
      meanC: Number((rows.reduce((sum, r) => sum + r.topM[m].C, 0) / Math.max(rows.length, 1)).toFixed(1)),
      maxC: Math.max(0, ...rows.map((r) => r.topM[m].C)),
    };
  }
  const maximalByM = {};
  for (const m of [1, 2, 3, 5, 10, 20]) {
    maximalByM[m] = {
      top1: rate((r) => r.maximalM[m].top1),
      top3: rate((r) => r.maximalM[m].top3),
      top5: rate((r) => r.maximalM[m].top5),
      top10: rate((r) => r.maximalM[m].top10),
      meanC: Number((rows.reduce((sum, r) => sum + r.maximalM[m].C, 0) / Math.max(rows.length, 1)).toFixed(1)),
      maxC: Math.max(0, ...rows.map((r) => r.maximalM[m].C)),
    };
  }
  const safeC = {};
  for (const k of ["top1", "top3", "top5", "top10"]) {
    safeC[k] = quantiles(rows.map((r) => r.signatureSafeC[k]));
  }
  return {
    pressureQueries: rows.length,
    current: {
      top1: rate((r) => r.exact.top1),
      top3: rate((r) => r.exact.top3),
      top5: rate((r) => r.exact.top5),
      top10: rate((r) => r.exact.top10),
    },
    taxonomy: countBy(rows, (r) => r.winner.taxonomy),
    archetype: countBy(rows, (r) => r.winner.archetype),
    signatures: quantiles(rows.map((r) => r.signatures)),
    maximalSignatures: quantiles(rows.map((r) => r.maximalSignatures)),
    fullC: quantiles(rows.map((r) => r.fullC)),
    indexedC: quantiles(rows.map((r) => r.indexedC)),
    winningRawRetrievalRank: quantiles(rows.map((r) => r.winner.rawRetrievalRank)),
    top3RawRetrievalRank: quantiles(rows.flatMap((r) => r.topRetrievalRanks.top3)),
    top5RawRetrievalRank: quantiles(rows.flatMap((r) => r.topRetrievalRanks.top5)),
    top10RawRetrievalRank: quantiles(rows.flatMap((r) => r.topRetrievalRanks.top10)),
    retrievalFinalDivergence: {
      spearman: quantiles(rows.map((r) => r.retrievalFinalDivergence.spearman)),
      meanAbsoluteRankDelta: quantiles(rows.map((r) => r.retrievalFinalDivergence.meanAbsoluteRankDelta)),
      fullTop1InRawTop200: rate((r) => r.retrievalFinalDivergence.finalTop1InRawTop200),
      fullTop3InRawTop200: rate((r) => r.retrievalFinalDivergence.finalTop3InRawTop200),
      fullTop5InRawTop200: rate((r) => r.retrievalFinalDivergence.finalTop5InRawTop200),
      fullTop10InRawTop200: rate((r) => r.retrievalFinalDivergence.finalTop10InRawTop200),
      overlapAt10: quantiles(rows.map((r) => r.retrievalFinalDivergence.overlapAt10)),
    },
    signatureSafeC: safeC,
    topM: byM,
    maximalM: maximalByM,
    cycles: rows.reduce((sum, r) => sum + r.cycles, 0),
    conflicts: rows.reduce((sum, r) => sum + r.conflicts, 0),
    failures: rows
      .filter((r) => !r.exact.top1)
      .map((r) => ({
        corpus: r.corpus,
        query: r.query,
        N: r.N,
        fullC: r.fullC,
        winner: r.winner,
        indexedWinner: r.indexedWinner,
        winnerVsIndexed: r.winnerVsIndexed,
      })),
  };
}

async function suiteArchitecture(sizes, floodNs) {
  const rows = [];

  for (const n of sizes) {
    const docs = mixedCorpus(n);
    const extra = {
      lemmas: LEMMAS,
      configuredConcepts: CONFIGURED_CONCEPTS,
      relationships: RELATIONSHIPS,
      relationshipStrategy: "hybrid",
    };
    const full = await createEngine("full-scan", docs, extra);
    const indexed = await createEngine("indexed", docs, extra);
    for (const { cls, q } of MIXED_QUERIES) {
      const row = analyzePressureQuery(full, indexed, q, { corpus: "mixed", family: cls, scale: n });
      if (row) rows.push(row);
    }
  }

  const originals = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
  const oracle = load("query-result-oracle.json");
  const slExtra = {
    lemmas: load("lemmas.json"),
    configuredConcepts: load("configured-concepts.json"),
    relationships: load("relationships.json"),
    relationshipStrategy: "hybrid",
  };
  for (const flood of floodNs) {
    const docs = [...originals, ...slDistractors(flood)];
    const full = await createEngine("full-scan", docs, slExtra);
    const indexed = await createEngine("indexed", docs, slExtra);
    for (const frozen of oracle.rows) {
      const row = analyzePressureQuery(full, indexed, frozen.query, {
        corpus: "software-land-expanded",
        family: "historical",
        flood,
        oracleWinner: frozen.results[0]?.id || null,
      });
      if (row) rows.push(row);
    }
  }

  const adversarial = [
    {
      family: "short-literal-body-flood",
      query: "zz",
      docs: adversarialShortLiteral(1000),
    },
    {
      family: "independent-title-token",
      query: "probezz",
      docs: adversarialIndependentTitleToken(1000),
    },
    {
      family: "equal-signature-id-tie",
      query: "tiezz",
      docs: adversarialEqualSignature(1000),
    },
    {
      family: "same-signature-final-score",
      query: "alpha beta gamma",
      docs: adversarialSameSignatureDifferentScore(1000),
    },
    {
      family: "equal-title-tightness-final-score",
      query: "alpha beta",
      docs: adversarialEqualTightnessDifferentScore(1000),
    },
    {
      family: "full-coverage",
      query: "alpha beta gamma",
      docs: adversarialCoverage(1000).docs,
    },
    {
      family: "phrase",
      query: "machine learning",
      docs: adversarialPhrase(1000).docs,
      extra: { configuredConcepts: [{ key: "ml", aliases: [["machine", "learning"]] }] },
    },
    {
      family: "dotted-span",
      query: "2",
      docs: adversarialDottedSpan(1000),
    },
  ];
  for (const spec of adversarial) {
    const extra = { relationshipStrategy: "none", ...(spec.extra || {}) };
    const full = await createEngine("full-scan", spec.docs, extra);
    const indexed = await createEngine("indexed", spec.docs, extra);
    const row = analyzePressureQuery(full, indexed, spec.query, {
      corpus: "adversarial",
      family: spec.family,
      scale: spec.docs.length,
    });
    if (row) rows.push(row);
  }

  return { summary: architectureSummary(rows), rows };
}

function positionsByTerm(tokens) {
  const out = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const term = tokens[i];
    if (!term) continue;
    const positions = out.get(term);
    if (positions) positions.push(i);
    else out.set(term, [i]);
  }
  return out;
}

function estimateCompiledIndex(engine, rawDocs) {
  const started = performance.now();
  const docs = engine._index.documents;
  const byTerm = new Map();
  const docRows = [];
  let titleOccurrences = 0;
  let bodyOccurrences = 0;
  let canonicalOccurrences = 0;
  let surfacePostingRows = 0;
  let lemmaDeltaPostingRows = 0;
  let lemmaDeltaOccurrences = 0;
  let versionUtf8Bytes = 0;
  let lexicalFrequencyUtf8Bytes = 0;

  function posting(term) {
    let row = byTerm.get(term);
    if (!row) {
      row = { term, title: [], body: [], titleLemma: [], bodyLemma: [] };
      byTerm.set(term, row);
    }
    return row;
  }

  function addField(mapName, tokens, docOrdinal) {
    const positions = positionsByTerm(tokens);
    for (const [term, pos] of positions) posting(term)[mapName].push([docOrdinal, pos]);
    return positions.size;
  }

  let uniquePostingRows = 0;
  for (let d = 0; d < docs.length; d += 1) {
    const doc = docs[d];
    titleOccurrences += doc.titleTokens.length;
    bodyOccurrences += doc.bodyTokens.length;
    canonicalOccurrences += doc.titleLemmas.length + doc.bodyLemmas.length;
    surfacePostingRows += positionsByTerm(doc.titleTokens).size + positionsByTerm(doc.bodyTokens).size;
    const titleLemmaDelta = new Map();
    const bodyLemmaDelta = new Map();
    for (let i = 0; i < doc.titleLemmas.length; i += 1) {
      if (doc.titleLemmas[i] === doc.titleTokens[i]) continue;
      lemmaDeltaOccurrences += 1;
      titleLemmaDelta.set(doc.titleLemmas[i], true);
    }
    for (let i = 0; i < doc.bodyLemmas.length; i += 1) {
      if (doc.bodyLemmas[i] === doc.bodyTokens[i]) continue;
      lemmaDeltaOccurrences += 1;
      bodyLemmaDelta.set(doc.bodyLemmas[i], true);
    }
    lemmaDeltaPostingRows += titleLemmaDelta.size + bodyLemmaDelta.size;
    uniquePostingRows += addField("title", doc.titleTokens, d);
    uniquePostingRows += addField("body", doc.bodyTokens, d);
    uniquePostingRows += addField("titleLemma", doc.titleLemmas, d);
    uniquePostingRows += addField("bodyLemma", doc.bodyLemmas, d);
    const versions = [...(doc.versionCompactForms || []), ...(doc.dottedSpans || [])];
    versionUtf8Bytes += Buffer.byteLength(JSON.stringify(versions));
    lexicalFrequencyUtf8Bytes += Buffer.byteLength(JSON.stringify(doc.lexicalFrequency || {}));
    docRows.push({
      id: doc.id,
      titleTokens: doc.titleTokens,
      titleLemmas: doc.titleLemmas,
      titleTokenCount: doc.nonStopTitle.length,
      firstToken: doc.firstToken,
      normalizedTitle: doc.normalizedTitle,
      versions,
      lexicalFrequency: doc.lexicalFrequency || null,
    });
  }
  const terms = [...byTerm.values()].sort((a, b) => idCompare(a.term, b.term));
  const artifact = {
    format: "search-v2-lexical-index",
    version: 1,
    analyzer: { normalization: "runtime-current", morphologyHash: "required" },
    documents: docRows,
    terms,
  };
  const json = JSON.stringify(artifact);
  const rawJson = JSON.stringify(rawDocs);
  const blockSize = 128;
  let postingBlocks = 0;
  for (const term of terms) {
    for (const field of ["title", "body", "titleLemma", "bodyLemma"]) {
      postingBlocks += Math.ceil(term[field].length / blockSize);
    }
  }
  const termUtf8Bytes = terms.reduce((sum, row) => sum + Buffer.byteLength(row.term), 0);
  const docIdUtf8Bytes = docs.reduce((sum, doc) => sum + Buffer.byteLength(doc.id), 0);
  const packedBytes =
    termUtf8Bytes +
    docIdUtf8Bytes +
    4 * (terms.length + 1) +
    4 * (docs.length + 1) +
    4 * uniquePostingRows +
    4 * (uniquePostingRows + 4 * (terms.length + 1)) +
    4 * (titleOccurrences + bodyOccurrences + canonicalOccurrences) +
    2 * docs.length +
    4 * docs.length +
    versionUtf8Bytes +
    lexicalFrequencyUtf8Bytes +
    24 * postingBlocks;
  const unifiedPostingRows = surfacePostingRows + lemmaDeltaPostingRows;
  let unifiedBlocks = 0;
  for (const term of terms) {
    unifiedBlocks += Math.ceil(Math.max(term.title.length, term.titleLemma.length) / blockSize);
    unifiedBlocks += Math.ceil(Math.max(term.body.length, term.bodyLemma.length) / blockSize);
  }
  const positionWidth = Math.max(...docs.map((doc) => doc.bodyTokens.length), 0) <= 65535 ? 2 : 4;
  const unifiedPackedBytes =
    termUtf8Bytes +
    docIdUtf8Bytes +
    4 * (terms.length + 1) +
    4 * (docs.length + 1) +
    4 * unifiedPostingRows +
    4 * (unifiedPostingRows + 1) +
    positionWidth * (titleOccurrences + bodyOccurrences + lemmaDeltaOccurrences) +
    2 * docs.length +
    4 * docs.length +
    versionUtf8Bytes +
    lexicalFrequencyUtf8Bytes +
    24 * unifiedBlocks;
  return {
    N: docs.length,
    terms: terms.length,
    uniquePostingRows,
    surfacePostingRows,
    lemmaDeltaPostingRows,
    lemmaDeltaOccurrences,
    titleOccurrences,
    bodyOccurrences,
    postingBlocks,
    buildMs: performance.now() - started,
    rawDocumentsJsonBytes: Buffer.byteLength(rawJson),
    rawDocumentsGzipBytes: gzipSync(rawJson).byteLength,
    illustrativeJsonArtifactBytes: Buffer.byteLength(json),
    illustrativeJsonArtifactGzipBytes: gzipSync(json).byteLength,
    estimatedPackedArtifactBytes: packedBytes,
    estimatedUnifiedPackedArtifactBytes: unifiedPackedBytes,
    jsonVsRawRatio: Number((Buffer.byteLength(json) / Math.max(Buffer.byteLength(rawJson), 1)).toFixed(3)),
    packedVsRawRatio: Number((packedBytes / Math.max(Buffer.byteLength(rawJson), 1)).toFixed(3)),
    unifiedPackedVsRawRatio: Number((unifiedPackedBytes / Math.max(Buffer.byteLength(rawJson), 1)).toFixed(3)),
  };
}

async function suiteArtifactEstimate(sizes) {
  const rows = [];
  for (const n of sizes) {
    const docs = mixedCorpus(n);
    const engine = await createEngine("indexed", docs, {
      lemmas: LEMMAS,
      configuredConcepts: CONFIGURED_CONCEPTS,
      relationships: RELATIONSHIPS,
      relationshipStrategy: "hybrid",
    });
    rows.push({ corpus: "mixed", ...estimateCompiledIndex(engine, docs) });
  }
  const originals = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
  const engine = await createEngine("indexed", originals, {
    lemmas: load("lemmas.json"),
    configuredConcepts: load("configured-concepts.json"),
    relationships: load("relationships.json"),
    relationshipStrategy: "hybrid",
  });
  rows.push({ corpus: "software-land", ...estimateCompiledIndex(engine, originals) });
  return rows;
}

function tfOnlyRows(flat) {
  const out = [];
  let cursor = 0;
  while (cursor < flat.length) {
    const doc = flat[cursor++];
    const tf = flat[cursor++];
    out.push(doc, tf);
    cursor += tf;
  }
  return out;
}

function compareArtifactLayouts(artifact) {
  const payload = artifact.data;
  const surface = payload.terms.map(([term, lemma, title, body]) => [
    term,
    lemma,
    tfOnlyRows(title),
    tfOnlyRows(body),
  ]);
  const lemmaMaps = new Map();
  function addLemma(lemma, field, flat) {
    let row = lemmaMaps.get(lemma);
    if (!row) {
      row = { title: new Map(), body: new Map() };
      lemmaMaps.set(lemma, row);
    }
    const target = row[field];
    const tf = tfOnlyRows(flat);
    for (let i = 0; i < tf.length; i += 2) {
      target.set(tf[i], (target.get(tf[i]) || 0) + tf[i + 1]);
    }
  }
  for (const [, lemma, title, body] of payload.terms) {
    addLemma(lemma, "title", title);
    addLemma(lemma, "body", body);
  }
  const lemma = [...lemmaMaps.entries()]
    .sort(([a], [b]) => idCompare(a, b))
    .map(([term, fields]) => [
      term,
      [...fields.title].flat(),
      [...fields.body].flat(),
    ]);

  const titleSlots = payload.documents.map((row) => new Array(row[1]));
  const bodySlots = payload.documents.map((row) => new Array(row[2]));
  function fill(slots, flat, termId) {
    let cursor = 0;
    while (cursor < flat.length) {
      const doc = flat[cursor++];
      const count = flat[cursor++];
      for (let i = 0; i < count; i += 1) slots[doc][flat[cursor++]] = termId;
    }
  }
  for (let termId = 0; termId < payload.terms.length; termId += 1) {
    fill(titleSlots, payload.terms[termId][2], termId);
    fill(bodySlots, payload.terms[termId][3], termId);
  }

  const postingsOnly = {
    documents: payload.documents.map((row) => [row[0]]),
    surface,
    lemma,
    stats: payload.stats,
    extensions: {},
  };
  const postingsPlusDocumentState = {
    documents: payload.documents.map((row, i) => [
      row[0],
      titleSlots[i],
      bodySlots[i],
      row[3],
      row[4],
      row[5],
      row[6],
    ]),
    surface,
    lemma,
    stats: payload.stats,
    extensions: {},
  };
  function artifactBytes(data) {
    return Buffer.byteLength(JSON.stringify({ ...artifact, data }));
  }
  return {
    postingsOnlyBytes: artifactBytes(postingsOnly),
    postingsPlusDocumentStateBytes: artifactBytes(postingsPlusDocumentState),
    unifiedAnalyzedIndexBytes: Buffer.byteLength(JSON.stringify(artifact)),
  };
}

async function measureActualStage1(docs, extra, queries) {
  if (typeof globalThis.gc === "function") globalThis.gc();
  const english = morphology({ lemmas: extra.lemmas || {} });
  const plugins = [english, compileConfiguredConceptPlugin({ configuredConcepts: extra.configuredConcepts || [] })];
  const options = {
    schema: SCHEMA,
    plugins,
    documentRelationships: extra.relationships || null,
    relationshipStrategy: extra.relationshipStrategy || "hybrid",
  };
  let rawJson = JSON.stringify(docs);
  const rawDocumentsBytes = Buffer.byteLength(rawJson);
  const before = process.memoryUsage();
  const compileStarted = performance.now();
  let artifact = compileLexicalIndex(docs, {
    schema: SCHEMA,
    lemma: english.lemma,
    analyzerId: english.indexIdentity,
  });
  const compileMs = performance.now() - compileStarted;
  let artifactJson = JSON.stringify(artifact);
  const lexicalIndexBytes = Buffer.byteLength(artifactJson);
  const architectureOptions = compareArtifactLayouts(artifact);
  const afterCompile = process.memoryUsage();
  rawJson = "";
  artifactJson = "";
  if (typeof globalThis.gc === "function") globalThis.gc();

  const precompiled = SearchEngine.create({ ...options, retriever: "indexed", lexicalIndex: artifact });
  const loadStarted = performance.now();
  await precompiled.index(docs);
  const loadMs = performance.now() - loadStarted;
  artifact = null;
  if (typeof globalThis.gc === "function") globalThis.gc();
  const afterLoad = process.memoryUsage();

  const fallback = SearchEngine.create({ ...options, retriever: "indexed" });
  const fallbackStarted = performance.now();
  await fallback.index(docs);
  const fallbackBuildMs = performance.now() - fallbackStarted;

  const full = SearchEngine.create({ ...options, retriever: "full-scan" });
  await full.index(docs);
  const queryRows = [];
  for (const query of queries) {
    const expected = full.searchDetailed(query, { limit: 10, relatedLimit: 5 });
    // Measure the normal result/Worker path. Public searchDetailed intentionally
    // computes a full exact diagnostic plan for candidateTitles/cycles/conflicts.
    // One-shot totals are not comparable across days/machines; p50/p90 below
    // are same-run samples after warmup.
    const actualSample = sampleSync(precompiled, query, { limit: 10, relatedLimit: 5 }, "auto");
    const exhaustiveSample = sampleSync(precompiled, query, { limit: 10, relatedLimit: 5 }, "exhaustive");
    const fallbackSample = sampleSync(fallback, query, { limit: 10, relatedLimit: 5 }, "auto");
    const actual = actualSample.last;
    const exhaustive = exhaustiveSample.last;
    const fallbackResult = fallbackSample.last;
    queryRows.push({
      query,
      exact: {
        precompiled: JSON.stringify(topIds(expected, 10)) === JSON.stringify(topIds(actual, 10)),
        fallback: JSON.stringify(topIds(expected, 10)) === JSON.stringify(topIds(fallbackResult, 10)),
        exhaustiveCompiled:
          JSON.stringify(publicSurface(actual)) === JSON.stringify(publicSurface(exhaustive)),
      },
      full: {
        C: expected.meta.candidateCount,
        retrieveMs: expected.meta.retrieveMs,
        featureMs: expected.meta.featureMs,
        rankMs: expected.meta.rankMs,
        totalMs: expected.meta.totalMs,
      },
      exhaustiveCompiled: {
        postingEntriesVisited: exhaustive.meta.postingEntriesVisited,
        documentsFullyEvaluated: exhaustive.meta.documentsFullyEvaluated,
        featureMs: exhaustiveSample.featureMs.p50,
        selectionMs: exhaustiveSample.selectionMs.p50,
        totalMs: exhaustiveSample.totalMs.p50,
        totalMsP90: exhaustiveSample.totalMs.p90,
        warmup: exhaustiveSample.warmup,
        iterations: exhaustiveSample.iterations,
      },
      precompiled: {
        matches: actual.meta.matchCount,
        C: actual.meta.candidateCount,
        signatures: actual.meta.representativeSelection?.signatures || 0,
        postingEntriesVisited: actual.meta.postingEntriesVisited,
        distinctDocumentsExamined: actual.meta.distinctDocumentsExamined,
        rawDocumentScans: actual.meta.rawDocumentScans,
        postingBlocksVisited: actual.meta.postingBlocksVisited,
        postingBlocksSkipped: actual.meta.postingBlocksSkipped,
        postingEntriesSkipped: actual.meta.postingEntriesSkipped,
        documentBlocksVisited: actual.meta.documentBlocksVisited,
        documentBlocksSkipped: actual.meta.documentBlocksSkipped,
        boundedBlocksSkipped: actual.meta.boundedBlocksSkipped,
        documentsFullyEvaluated: actual.meta.documentsFullyEvaluated,
        documentsBoundRejected: actual.meta.documentsBoundRejected,
        pruningFallbackReason: actual.meta.pruningFallbackReason,
        retrieveMs: actualSample.retrieveMs.p50,
        featureMs: actualSample.featureMs.p50,
        selectionMs: actualSample.selectionMs.p50,
        rankMs: actualSample.rankMs.p50,
        totalMs: actualSample.totalMs.p50,
        totalMsP90: actualSample.totalMs.p90,
        warmup: actualSample.warmup,
        iterations: actualSample.iterations,
      },
    });
  }

  return {
    N: docs.length,
    rawDocumentsBytes,
    lexicalIndexBytes,
    architectureOptions,
    ratio: Number((lexicalIndexBytes / Math.max(rawDocumentsBytes, 1)).toFixed(3)),
    compileMs,
    loadMs,
    fallbackBuildMs,
    memory: {
      beforeHeap: before.heapUsed,
      afterCompileHeap: afterCompile.heapUsed,
      afterLoadHeap: afterLoad.heapUsed,
      beforeRss: before.rss,
      afterLoadRss: afterLoad.rss,
    },
    queries: queryRows,
  };
}

async function suiteActualStage1(sizes) {
  const rows = [];
  const originals = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
  rows.push({
    corpus: "software-land",
    ...(await measureActualStage1(
      originals,
      {
        lemmas: load("lemmas.json"),
        configuredConcepts: load("configured-concepts.json"),
        relationships: load("relationships.json"),
        relationshipStrategy: "hybrid",
      },
      ["2", "machine l", "the"]
    )),
  });
  for (const n of sizes) {
    rows.push({
      corpus: "mixed",
      ...(await measureActualStage1(
        mixedCorpus(n),
        {
          lemmas: LEMMAS,
          configuredConcepts: CONFIGURED_CONCEPTS,
          relationships: RELATIONSHIPS,
          relationshipStrategy: "hybrid",
        },
        ["ZX9 UniqueRareTitle", "network", "the"]
      )),
    });
  }
  return rows;
}

async function main() {
  const args = parseArgs({
    options: {
      suite: { type: "string", default: "all" },
      sizes: { type: "string", default: "500,1000,2000,5000" },
      floods: { type: "string", default: "400,1000,5000" },
    },
  });
  const suite = args.values.suite;
  const sizes = String(args.values.sizes)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const floods = String(args.values.floods)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const report = { seed: SEED, candidateLimit: 200 };
  if (suite === "all" || suite === "mixed") {
    const rows = await suiteMixed(sizes);
    report.mixed = { summary: summarize(rows), rows: rows.map((r) => ({
      n: r.n, cls: r.cls, query: r.query, legitimateOrdinary: r.legitimateOrdinary,
      fullC: r.fullC, indexedC: r.indexedC, top1: r.top1, top3: r.top3, top5: r.top5, top10: r.top10,
      survival: r.survival, ordinaryPos: r.retrieval.ordinaryPos, lane: r.retrieval.lane,
      winner: r.winnerTitle, indexedTop: r.indexedWinnerTitle,
      totalMs: r.totalMs, retrieveMs: r.retrieveMs, featureMs: r.featureMs, rankMs: r.rankMs,
    })) };
  }
  if (suite === "all" || suite === "adversarial") {
    const rows = await suiteAdversarial();
    report.adversarial = { summary: summarize(rows), rows: rows.map((r) => ({
      family: r.family, distractors: r.distractors, query: r.query,
      legitimateOrdinary: r.legitimateOrdinary, ordinaryPos: r.retrieval.ordinaryPos, lane: r.retrieval.lane,
      top1: r.top1, survival: r.survival, winner: r.winnerTitle, indexedTop: r.indexedWinnerTitle,
      winnerSources: r.winnerSources, retrievalSources: r.retrieval.sources, retrievalScore: r.retrieval.retrievalScore,
    })) };
  }
  if (suite === "all" || suite === "sweep") {
    report.sweep = await suiteSweep();
  }
  if (suite === "all" || suite === "software-land") {
    report.softwareLand = await suiteSoftwareLand([0, ...floods]);
  }
  if (suite === "architecture") {
    report.architecture = await suiteArchitecture(sizes, floods);
  }
  if (suite === "artifact-estimate") {
    report.artifactEstimate = await suiteArtifactEstimate(sizes);
  }
  if (suite === "stage1") {
    report.stage1 = await suiteActualStage1(sizes);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
