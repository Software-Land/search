#!/usr/bin/env node
/**
 * Indexed candidate-budget investigation.
 *
 * Authoritative ranking: full-scan retrieve → current extractFeatures → sparse ranker.
 * Indexed: candidateLimit ordinary hits, same features and ranker.
 *
 *   node scripts/budget-pressure.mjs
 *   node scripts/budget-pressure.mjs --suite adversarial
 *
 * Not packed. Does not change production defaults.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SearchEngine, morphology, dictionary } from "../dist/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { retrieveCandidates } from "../dist/retrieve.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "software-land");
const UNBOUNDED = new Set(["exact-title", "configured-equivalence", "version"]);
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

function exactPrefix(a, b, n) {
  const left = a.slice(0, n);
  const right = b.slice(0, n);
  if (left.length !== right.length) return false;
  return left.every((id, i) => id === right[i]);
}

function createEngine(retriever, docs, extra = {}) {
  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins: extra.plugins || [morphology({ lemmas: extra.lemmas || {} }), dictionary({ entries: extra.dictionary || [] })],
    relationships: extra.relationships || null,
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
    return a.document.id.localeCompare(b.document.id);
  });
  const titlePrefixKept = titlePrefix.slice(0, PREFIX_CAP);
  for (const h of titlePrefix.slice(PREFIX_CAP)) rest.push(h);
  rest.sort((a, b) => (b.retrievalScore || 0) - (a.retrievalScore || 0) || a.document.id.localeCompare(b.document.id));
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
  { cls: "configured-equivalence", q: "tls" },
  { cls: "version", q: "1.2" },
  { cls: "dotted-span", q: "tls 1.2" },
  { cls: "short-literal", q: "io" },
  { cls: "relationship", q: "vpn" },
  { cls: "high-df", q: "the" },
  { cls: "mixed-title-body", q: "network" },
];

const LEMMAS = { searching: "search", searched: "search", searches: "search" };
const DICTIONARY = [{ key: "tls", expansion: ["transport", "layer", "security"] }];
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
    const extra = { lemmas: LEMMAS, dictionary: DICTIONARY, relationships: RELATIONSHIPS, relationshipStrategy: "hybrid" };
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
    const extra = { relationshipStrategy: "none", dictionary: [{ key: "ml", expansion: ["machine", "learning"] }] };
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
  const docs = adversarialShortLiteral(400);
  const extra = { relationshipStrategy: "none" };
  const full = await createEngine("full-scan", docs, extra);
  const indexed = await createEngine("indexed", docs, { ...extra, candidateLimit: 1000 });
  const ks = [50, 100, 150, 200, 300, 500, 1000];
  return ks.map((k) => {
    const row = compareQuery(full, indexed, "zz", { k, topN: 10 });
    return {
      k,
      top1: row.top1,
      top3: row.top3,
      top5: row.top5,
      top10: row.top10,
      survivalTop1: row.survival.top1,
      ordinaryPos: row.retrieval.ordinaryPos,
      legitimateOrdinary: row.legitimateOrdinary,
      indexedC: row.indexedC,
      featureMs: row.featureMs,
      rankMs: row.rankMs,
      totalMs: row.totalMs,
      winner: row.winnerTitle,
      indexedTop: row.indexedWinnerTitle,
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
    dictionary: load("dictionary.json"),
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

async function main() {
  const args = parseArgs({
    options: {
      suite: { type: "string", default: "all" },
      sizes: { type: "string", default: "500,1000,2000,5000" },
    },
  });
  const suite = args.values.suite;
  const sizes = String(args.values.sizes)
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
    report.softwareLand = await suiteSoftwareLand([0, 400, 1000]);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
