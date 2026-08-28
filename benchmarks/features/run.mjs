#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../../dist/index.js";
import { compileConfiguredConceptPlugin } from "../../dist/configuredConcepts.js";
import { attachLexicalFrequency } from "../../tools/search-lexical/index.js";
import { startFeatureProfile, lastFeatureProfile, stopFeatureProfile, extractFeatures } from "../../dist/features.js";
import { extractFeaturesOracle } from "../../build/test/oracles/featuresOracle.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const QUERY = "rankprobe";

function generateHomogeneous(c) {
  const docs = [];
  for (let i = 0; i < c; i += 1) {
    docs.push({ id: `d${String(i).padStart(5, "0")}`, title: `Note ${i} ${QUERY}`, body: `${QUERY} body` });
  }
  return docs;
}

function generateFewBuckets(c) {
  const exactN = Math.max(1, Math.floor(c * 0.1));
  const docs = [];
  for (let i = 0; i < c; i += 1) {
    if (i < exactN) docs.push({ id: `e${String(i).padStart(5, "0")}`, title: QUERY, body: `${QUERY} exact` });
    else docs.push({ id: `d${String(i).padStart(5, "0")}`, title: `Note ${i} ${QUERY}`, body: `${QUERY} body` });
  }
  return docs;
}

function generateMixed(c) {
  const docs = [];
  for (let i = 0; i < c; i += 1) {
    const id = `m${String(i).padStart(5, "0")}`;
    const kind = i % 7;
    if (kind === 0) docs.push({ id, title: QUERY, body: `${QUERY} exact title` });
    else if (kind === 1) docs.push({ id, title: `TLS 1.${i % 9} ${QUERY}`, body: `${QUERY} version` });
    else if (kind === 2) docs.push({ id, title: `${QUERY} companion extra words here`, body: `${QUERY} long` });
    else if (kind === 3) docs.push({ id, title: `200FPS ${QUERY}`, body: `${QUERY} literal` });
    else if (kind === 4) docs.push({ id, title: `Related neighbor ${i} ${QUERY}`, body: `unrelated body ${i}` });
    else if (kind === 5) docs.push({ id, title: `${QUERY} ${QUERY} ${QUERY}`, body: `${QUERY} ${QUERY} phrase` });
    else docs.push({ id, title: `Note ${i} ${QUERY}`, body: `${QUERY} weak` });
  }
  return docs;
}

async function measure(kind, docs, query) {
  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins: [morphology()],
    retriever: "full-scan",
    relationshipStrategy: "none",
  });
  await engine.index(docs);
  engine.searchDetailed(query, { limit: 10 });
  stopFeatureProfile();
  const t0 = performance.now();
  const detailed = engine.searchDetailed(query, { limit: 10 });
  const wall = performance.now() - t0;
  startFeatureProfile();
  engine.searchDetailed(query, { limit: 10 });
  const profile = lastFeatureProfile() || {};
  stopFeatureProfile();
  const rows = Object.entries(profile)
    .map(([name, v]) => ({ name, ms: v.ms, calls: v.calls }))
    .sort((a, b) => b.ms - a.ms);
  return {
    kind,
    C: detailed.meta.candidateCount,
    retrieveMs: detailed.meta.retrieveMs,
    featureMs: detailed.meta.featureMs,
    rankMs: detailed.meta.rankMs,
    wallMs: wall,
    profile: rows,
  };
}

function timeExtractors(engine, queryText, rounds = 5) {
  const query = engine._prepareQuery(queryText);
  const docs = engine._index.documents;
  extractFeatures(query, docs[0]);
  extractFeaturesOracle(query, docs[0]);
  let oldMs = Infinity;
  let newMs = Infinity;
  let equal = true;
  const actual = extractFeatures(query, docs[0]);
  const expected = extractFeaturesOracle(query, docs[0]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) equal = false;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    for (const doc of docs) extractFeaturesOracle(query, doc);
    oldMs = Math.min(oldMs, performance.now() - t0);
    const t1 = performance.now();
    for (const doc of docs) extractFeatures(query, doc);
    newMs = Math.min(newMs, performance.now() - t1);
  }
  return {
    C: docs.length,
    oldFeatureMs: oldMs,
    newFeatureMs: newMs,
    speedup: newMs > 0 ? oldMs / newMs : null,
    equal,
  };
}

const sizes = [100, 200, 500, 1000];
const out = [];
for (const c of sizes) {
  out.push(await measure("homogeneous", generateHomogeneous(c), QUERY));
  out.push(await measure("few-buckets", generateFewBuckets(c), QUERY));
  out.push(await measure("mixed", generateMixed(c), QUERY));
}

const fixture = path.join(ROOT, "test", "fixtures", "software-land");
const load = (n) => JSON.parse(readFileSync(path.join(fixture, n), "utf8"));
const slEngine = SearchEngine.create({
  schema: SCHEMA,
  plugins: [morphology({ lemmas: load("lemmas.json") }), compileConfiguredConceptPlugin({ configuredConcepts: load("configured-concepts.json") })],
  documentRelationships: load("relationships.json"),
  relationshipStrategy: "hybrid",
  retriever: "full-scan",
});
await slEngine.index(attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json")));
for (const query of ["2", "tls", "sort recurses", "machine learning", "object oriented programming"]) {
  slEngine.searchDetailed(query, { limit: 10 });
  stopFeatureProfile();
  const t0 = performance.now();
  const detailed = slEngine.searchDetailed(query, { limit: 10 });
  const wall = performance.now() - t0;
  startFeatureProfile();
  slEngine.searchDetailed(query, { limit: 10 });
  const profile = lastFeatureProfile() || {};
  stopFeatureProfile();
  const rows = Object.entries(profile)
    .map(([name, v]) => ({ name, ms: v.ms, calls: v.calls }))
    .sort((a, b) => b.ms - a.ms);
  out.push({
    kind: `software-land:${query}`,
    C: detailed.meta.candidateCount,
    retrieveMs: detailed.meta.retrieveMs,
    featureMs: detailed.meta.featureMs,
    rankMs: detailed.meta.rankMs,
    wallMs: wall,
    profile: rows,
  });
}

for (const row of out) {
  console.log(`\n${row.kind} C=${row.C} retrieve=${row.retrieveMs.toFixed(2)} feature=${row.featureMs.toFixed(2)} rank=${row.rankMs.toFixed(2)}`);
  for (const p of row.profile.slice(0, 12)) {
    console.log(`  ${p.name}\t${p.ms.toFixed(3)}ms\t${p.calls} calls`);
  }
}

console.log("\n=== old oracle vs new extractFeatures (min of 5) ===");
stopFeatureProfile();
for (const c of sizes) {
  for (const [kind, docs] of [
    ["homogeneous", generateHomogeneous(c)],
    ["few-buckets", generateFewBuckets(c)],
    ["mixed", generateMixed(c)],
  ]) {
    const engine = SearchEngine.create({
      schema: SCHEMA,
      plugins: [morphology()],
      retriever: "full-scan",
      relationshipStrategy: "none",
    });
    await engine.index(docs);
    const cmp = timeExtractors(engine, QUERY);
    const speed = cmp.speedup == null ? "?" : cmp.speedup.toFixed(2);
    console.log(
      `${kind} C=${cmp.C} old=${cmp.oldFeatureMs.toFixed(2)} new=${cmp.newFeatureMs.toFixed(2)} speedup=${speed}x equal=${cmp.equal}`
    );
  }
}
const slCmp = timeExtractors(slEngine, "sort recurses");
console.log(
  `software-land:sort recurses C=${slCmp.C} old=${slCmp.oldFeatureMs.toFixed(2)} new=${slCmp.newFeatureMs.toFixed(2)} speedup=${slCmp.speedup.toFixed(2)}x equal=${slCmp.equal}`
);
const slCmp2 = timeExtractors(slEngine, "2");
console.log(
  `software-land:2 C=${slCmp2.C} old=${slCmp2.oldFeatureMs.toFixed(2)} new=${slCmp2.newFeatureMs.toFixed(2)} speedup=${slCmp2.speedup.toFixed(2)}x equal=${slCmp2.equal}`
);
