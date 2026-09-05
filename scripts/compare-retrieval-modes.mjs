#!/usr/bin/env node
/**
 * Compare full-scan vs indexed vs adaptive on all 215 Software.Land rows.
 * Does not rewrite the query-result oracle. Run after `npm run build`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "software-land");

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

const documents = load("documents.json");
const historical = load("historical-scenarios.json");
const oracle = load("query-result-oracle.json");
const contracts = load("v2-contracts.json");
const regressions = load("regression-scenarios.json");
const RESULT_LIMIT = documents.length;
const RELATED_LIMIT = documents.length;

const UNBOUNDED = new Set(["exact-title", "configured-concept", "version"]);
const CONTEXTUAL = "contextual-title-prefix";

function createEngine(retriever, extra = {}) {
  return SearchEngine.create({
    schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
    plugins: [
      morphology({ lemmas: load("lemmas.json") }),
      compileConfiguredConceptPlugin({ configuredConcepts: load("configured-concepts.json") }),
    ],
    documentRelationships: load("relationships.json"),
    relationshipStrategy: "hybrid",
    retriever,
    ...extra,
  });
}

function serializeHits(hits) {
  return hits.map((hit) => ({
    id: hit.id,
    title: hit.title,
    rank: hit.rank,
    score: hit.score,
    relevanceKind: hit.relevanceKind,
    directClass: hit.directClass ?? null,
  }));
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function dist(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: pct(sorted, 50),
    p75: pct(sorted, 75),
    p90: pct(sorted, 90),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? Number((sorted.reduce((s, n) => s + n, 0) / sorted.length).toFixed(2)) : 0,
  };
}

function classifyHit(sources) {
  const src = sources || [];
  if (src.some((s) => UNBOUNDED.has(s))) {
    if (src.includes("exact-title")) return "exact-title";
    if (src.includes("configured-concept")) return "configured-concept";
    if (src.includes("version")) return "version";
  }
  if (src.includes(CONTEXTUAL)) return "contextual-prefix";
  if (src.includes("relationship") && src.every((s) => s === "relationship")) return "relationship-added";
  return "ordinary";
}

function classifyMismatch({ missing, extra, missingSources, extraSources }) {
  const miss = new Set(missingSources.flat());
  const add = new Set(extraSources.flat());
  if (missing.length && miss.has("exact-title")) return "exact-title path";
  if (missing.length && (miss.has("title-token") || miss.has("title-token-prefix") || miss.has("title-prefix"))) {
    return "title-token posting / prefix semantics";
  }
  if (missing.length && miss.has("body-lexical")) return "body posting";
  if (missing.length && miss.has("morphology")) return "morphology path";
  if (missing.length && miss.has("version")) return "version / dotted-span path";
  if (missing.length && miss.has("configured-concept")) return "configured-concept path";
  if (missing.length && miss.has("equivalent-recall")) return "equivalent-recall path";
  if (missing.length && miss.has("standalone-recall")) return "standalone-recall path";
  if (missing.length && miss.has("topical-recall")) return "topical-recall path";
  if (missing.length && miss.has(CONTEXTUAL)) return "contextual prefix";
  if (missing.length && miss.has("relationship")) return "relationship path";
  if (missing.length && extraSources.length === 0) return "missing retrieval provenance";
  if (!missing.length && extra.length) {
    if ([...add].some((s) => s === "indexed-lexical" || s === "body-lexical" || s === "title-token-prefix")) {
      return "additional indexed posting (full-scan-only selectivity)";
    }
    return "additional candidates";
  }
  if (missing.length && extra.length) return "retrieve-set mismatch (mixed)";
  return "order/score difference with equal retrieve ids";
}

function firstChangedRank(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return i + 1;
    if (
      left.id !== right.id ||
      left.score !== right.score ||
      left.relevanceKind !== right.relevanceKind ||
      left.directClass !== right.directClass
    ) {
      return i + 1;
    }
  }
  return null;
}

function survival(current, candidateTitles) {
  const top = (n) => current.slice(0, n).every((hit) => candidateTitles.has(hit.title));
  return {
    top1: current[0] ? candidateTitles.has(current[0].title) : true,
    top3: top(3),
    top5: top(5),
    top10: top(10),
  };
}

async function main() {
  const full = createEngine("full-scan");
  const indexed = createEngine("indexed");
  const adaptive = createEngine("adaptive");
  const docs = attachLexicalFrequency(documents, load("lexical-frequency.json"));
  await full.index(docs);
  await indexed.index(docs);
  await adaptive.index(docs);

  const rows = [];
  const changed = [];
  const adaptiveChanged = [];
  const fullCs = [];
  const indexedCs = [];
  const adaptiveCs = [];
  const indexedRetrieveCs = [];
  const mustKeep = {
    ordinary: [],
    "exact-title": [],
    "configured-concept": [],
    version: [],
    "contextual-prefix": [],
    "relationship-added": [],
  };

  for (const frozen of oracle.rows) {
    const fullD = full.searchDetailed(frozen.query, { limit: RESULT_LIMIT, relatedLimit: RELATED_LIMIT, explain: true });
    const idxD = indexed.searchDetailed(frozen.query, { limit: RESULT_LIMIT, relatedLimit: RELATED_LIMIT, explain: true });
    const adD = adaptive.searchDetailed(frozen.query, { limit: RESULT_LIMIT, relatedLimit: RELATED_LIMIT, explain: true });
    const noneIdx = indexed.searchDetailed(frozen.query, {
      limit: RESULT_LIMIT,
      relatedLimit: 0,
      relationshipStrategy: "none",
      explain: true,
    });

    const fullSer = { results: serializeHits(fullD.results), related: serializeHits(fullD.related) };
    const idxSer = { results: serializeHits(idxD.results), related: serializeHits(idxD.related) };
    const adSer = { results: serializeHits(adD.results), related: serializeHits(adD.related) };
    const oracleSer = { results: frozen.results, related: frozen.related };

    const fullOracleEq =
      JSON.stringify(fullSer) === JSON.stringify(oracleSer) && fullD.meta.candidateCount === frozen.candidateCount;
    const indexedEq = JSON.stringify(idxSer) === JSON.stringify(fullSer);
    const adaptiveEq = JSON.stringify(adSer) === JSON.stringify(fullSer);

    const retrieveHits = noneIdx.results;
    const fullTitles = new Set(fullD.meta.candidateTitles);
    const idxTitles = new Set(idxD.meta.candidateTitles);
    const missingTitles = [...fullTitles].filter((t) => !idxTitles.has(t));
    const extraTitles = [...idxTitles].filter((t) => !fullTitles.has(t));
    const missingSrc = fullD.results
      .concat(fullD.related)
      .filter((h) => missingTitles.includes(h.title))
      .map((h) => h.retrievalSources || []);
    const extraSrc = idxD.results
      .concat(idxD.related)
      .filter((h) => extraTitles.includes(h.title))
      .map((h) => h.retrievalSources || []);

    const counts = { ordinary: 0, "exact-title": 0, "configured-concept": 0, version: 0, "contextual-prefix": 0 };
    for (const hit of retrieveHits) {
      const lane = classifyHit(hit.retrievalSources);
      if (lane !== "relationship-added") counts[lane] = (counts[lane] || 0) + 1;
    }
    const relationshipAdded = Math.max(0, (idxD.meta.candidateCount || 0) - retrieveHits.length);
    counts["relationship-added"] = relationshipAdded;
    for (const [k, v] of Object.entries(counts)) mustKeep[k].push(v);

    const surv = survival(fullSer.results, idxTitles);

    const rec = {
      index: frozen.index,
      query: frozen.query,
      disposition: frozen.disposition,
      fullOracleEq,
      indexedEq,
      adaptiveEq,
      fullC: fullD.meta.candidateCount,
      indexedC: idxD.meta.candidateCount,
      adaptiveC: adD.meta.candidateCount,
      indexedRetrieveC: retrieveHits.length,
      retrieveMs: {
        full: Number(fullD.meta.retrieveMs.toFixed(3)),
        indexed: Number(idxD.meta.retrieveMs.toFixed(3)),
        adaptive: Number(adD.meta.retrieveMs.toFixed(3)),
      },
      featureMs: {
        full: Number(fullD.meta.featureMs.toFixed(3)),
        indexed: Number(idxD.meta.featureMs.toFixed(3)),
      },
      rankMs: {
        full: Number(fullD.meta.rankMs.toFixed(3)),
        indexed: Number(idxD.meta.rankMs.toFixed(3)),
      },
      totalMs: {
        full: Number(fullD.meta.totalMs.toFixed(3)),
        indexed: Number(idxD.meta.totalMs.toFixed(3)),
      },
      missingTitles,
      extraTitles,
      firstChangedRank: indexedEq ? null : firstChangedRank(fullSer.results, idxSer.results),
      relatedChanged: JSON.stringify(fullSer.related) !== JSON.stringify(idxSer.related),
      cause: indexedEq ? null : classifyMismatch({ missing: missingTitles, extra: extraTitles, missingSources: missingSrc, extraSources: extraSrc }),
      missingSources: [...new Set(missingSrc.flat())],
      extraSources: [...new Set(extraSrc.flat())],
      survival: surv,
      lanes: counts,
    };
    rows.push(rec);
    fullCs.push(rec.fullC);
    indexedCs.push(rec.indexedC);
    adaptiveCs.push(rec.adaptiveC);
    indexedRetrieveCs.push(rec.indexedRetrieveC);
    if (!rec.indexedEq) changed.push(rec);
    if (!rec.adaptiveEq) adaptiveChanged.push(rec);
  }

  const query2 = rows.find((r) => r.query === "2");
  const query2Full = full.search("2", { limit: 2 }).map((h) => h.title);
  const query2Idx = indexed.search("2", { limit: 2 }).map((h) => h.title);
  const expected2 = ["200FPS: CSS vs Canvas vs WebGL vs WebGPU", "TLS 1.2 Vulnerability"];

function titlesOf(engine, query, limit = 10) {
  return engine.search(query, { limit }).map((hit) => hit.title);
}

function indexOfTitle(titles, wanted) {
  return titles.findIndex((title) => title === wanted);
}

function assertCase(engine, row) {
  const titles = titlesOf(engine, row.query);
  if (row.exactFirst && titles[0] !== row.exactFirst) return `${row.name}: expected #1 ${row.exactFirst}, got ${titles[0]}`;
  for (const req of row.requiredWithin || []) {
    const idx = indexOfTitle(titles, req.title);
    if (idx < 0 || idx + 1 > req.topN) return `${row.name}: ${req.title} not within ${req.topN}`;
  }
  for (const req of row.requiredAnyWithin || []) {
    const idx = indexOfTitle(titles, req.title);
    if (idx < 0 || idx + 1 > req.topN) return `${row.name}: ${req.title} not within ${req.topN}`;
  }
  if (row.requiredAnyTop) {
    const window = titles.slice(0, row.requiredAnyTop.topN);
    for (const title of row.requiredAnyTop.titles) {
      if (!window.includes(title)) return `${row.name}: missing ${title} in top ${row.requiredAnyTop.topN}`;
    }
  }
  if (row.titlePrefix) {
    const topN = row.titlePrefixTopN ?? 10;
    for (const title of titles.slice(0, topN)) {
      if (!title.startsWith(row.titlePrefix)) return `${row.name}: ${title} missing prefix ${row.titlePrefix}`;
    }
  }
  if (row.mustNotDominate?.primary) {
    const primaryIdx = indexOfTitle(titles, row.mustNotDominate.primary);
    if (primaryIdx < 0) return `${row.name}: missing primary`;
    for (const forbidden of row.mustNotDominate.titles) {
      const idx = indexOfTitle(titles, forbidden);
      if (idx >= 0 && idx <= primaryIdx) return `${row.name}: ${forbidden} dominated`;
    }
  }
  if (row.requiredRelatedAny) {
    const window = titles.slice(0, row.requiredRelatedAny.topN || 10);
    const matched = row.requiredRelatedAny.titles.filter((title) => window.includes(title));
    if (matched.length < (row.requiredRelatedAny.minCount || 1)) return `${row.name}: related miss`;
  }
  if (row.relationship) {
    const detailed = engine.searchDetailed(row.query, { limit: 10, explain: true });
    const hit = detailed.results.find((item) => item.title === row.relationship.title);
    if (!hit) return `${row.name}: missing related ${row.relationship.title}`;
    if (hit.relevanceKind !== row.relationship.relevanceKind) return `${row.name}: relevanceKind`;
    if (hit.relationship?.type !== row.relationship.type) return `${row.name}: rel type`;
    if (!hit.retrievalSources?.includes("relationship")) return `${row.name}: missing relationship source`;
  }
  return null;
}

function contractPass(engine, cases) {
  const fail = [];
  for (const row of cases) {
    const err = assertCase(engine, row);
    if (err) fail.push(err);
  }
  return { pass: cases.length - fail.length, fail, n: cases.length };
}

  const strictFull = contractPass(full, contracts.cases);
  const strictIdx = contractPass(indexed, contracts.cases);
  const regFull = contractPass(full, regressions.cases);
  const regIdx = contractPass(indexed, regressions.cases);

  const byDisposition = {};
  for (const rec of rows) {
    byDisposition[rec.disposition] ??= { n: 0, changed: 0 };
    byDisposition[rec.disposition].n += 1;
    if (!rec.indexedEq) byDisposition[rec.disposition].changed += 1;
  }

  const summary = {
    documentCount: documents.length,
    rows: 215,
    distinctQueries: new Set(oracle.rows.map((r) => r.query)).size,
    fullScanMatchesOracle: rows.filter((r) => r.fullOracleEq).length,
    indexedExact: 215 - changed.length,
    indexedChanged: changed.length,
    adaptiveExact: 215 - adaptiveChanged.length,
    adaptiveChanged: adaptiveChanged.length,
    changedQueries: changed.map((c) => ({
      index: c.index,
      query: c.query,
      disposition: c.disposition,
      firstChangedRank: c.firstChangedRank,
      fullC: c.fullC,
      indexedC: c.indexedC,
      missingTitles: c.missingTitles,
      extraTitles: c.extraTitles,
      missingSources: c.missingSources,
      extraSources: c.extraSources,
      cause: c.cause,
      relatedChanged: c.relatedChanged,
      survival: c.survival,
    })),
    byDisposition,
    survival: {
      top1: rows.filter((r) => r.survival.top1).length,
      top3: rows.filter((r) => r.survival.top3).length,
      top5: rows.filter((r) => r.survival.top5).length,
      top10: rows.filter((r) => r.survival.top10).length,
    },
    candidateDistribution: {
      fullScan: dist(fullCs),
      indexed: dist(indexedCs),
      indexedRetrieve: dist(indexedRetrieveCs),
      adaptive: dist(adaptiveCs),
    },
    mustKeep: Object.fromEntries(Object.entries(mustKeep).map(([k, v]) => [k, dist(v)])),
    query2: {
      full: query2Full,
      indexed: query2Idx,
      expected: expected2,
      fullOk: JSON.stringify(query2Full) === JSON.stringify(expected2),
      indexedOk: JSON.stringify(query2Idx) === JSON.stringify(expected2),
      rowExact: query2?.indexedEq ?? null,
    },
    strict: { full: strictFull, indexed: strictIdx },
    regressions: { full: regFull, indexed: regIdx },
    softwareLandPerf: {
      full: {
        retrieveMs: dist(rows.map((r) => r.retrieveMs.full)),
        featureMs: dist(rows.map((r) => r.featureMs.full)),
        rankMs: dist(rows.map((r) => r.rankMs.full)),
        totalMs: dist(rows.map((r) => r.totalMs.full)),
      },
      indexed: {
        retrieveMs: dist(rows.map((r) => r.retrieveMs.indexed)),
        featureMs: dist(rows.map((r) => r.featureMs.indexed)),
        rankMs: dist(rows.map((r) => r.rankMs.indexed)),
        totalMs: dist(rows.map((r) => r.totalMs.indexed)),
      },
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

export { classifyMismatch };

function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
