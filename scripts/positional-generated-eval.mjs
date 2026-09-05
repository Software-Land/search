#!/usr/bin/env node
/** Deterministic positional eval: collector off vs on vs oracle #1. */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokenize } from "../dist/text/text.js";
import { COMPLETE_INTERPRETATION_COLLECTOR } from "../dist/completeInterpretationCollector.js";
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { loadSoftwareLandRelevanceInputs, loadSoftwareLandJson } from "../test/helpers/software-land-fixture.js";
import { buildQueryPlan } from "../dist/query/queryPlan.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputs = loadSoftwareLandRelevanceInputs();
const compiled = compileAuthoredRelevance({
  configuredConcepts: inputs.configuredConcepts,
  relationshipMap: inputs.relationshipMap,
});
const engine = SearchEngine.create({
  schema: inputs.schema,
  plugins: [morphology({ lemmas: inputs.lemmas }), ...compiled.plugins],
  documentRelationships: inputs.relationships,
  relationshipStrategy: "hybrid",
  retriever: "full-scan",
});
await engine.index(attachLexicalFrequency(inputs.documents, inputs.lexicalFrequency));

function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

const set = new Set();
const historical = inputs.historical.rows.map((r) => r.query).filter(Boolean);
for (const q of historical) if (tokenize(q).length >= 2) set.add(q);
for (const doc of inputs.documents) {
  const title = tokenize(doc.title || "");
  if (title.length >= 2) {
    set.add(title.join(" "));
    const last = title[title.length - 1];
    for (const n of [1, 2, 3]) if (last.length > n) set.add([...title.slice(0, -1), last.slice(0, n)].join(" "));
  }
  const body = tokenize(doc.body || "").slice(0, 40);
  for (let n = 2; n <= Math.min(3, body.length); n++) {
    for (const g of ngrams(body, n).slice(0, 8)) set.add(g);
  }
}
for (const q of [
  "object oriented programming vs functional",
  "js vs python",
  "remote procedure call",
  "tls 1.2",
  "a practical guide to building high-frame-r",
]) set.add(q);

const oracle = Object.fromEntries((loadSoftwareLandJson("query-result-oracle.json").rows || []).map((r) => [r.query, r.results?.[0]?.title]));
let numberOneOffOracle = 0;
let cohortOffOn = 0;
const samples = [];
for (const q of set) {
  const off = engine.search(q, { limit: 5 }).map((h) => h.title);
  const on = engine.search(q, { limit: 5, resultCollector: COMPLETE_INTERPRETATION_COLLECTOR }).map((h) => h.title);
  const old = oracle[q];
  if (old && off[0] !== old) numberOneOffOracle += 1;
  if (JSON.stringify(off) !== JSON.stringify(on)) {
    cohortOffOn += 1;
    if (samples.length < 12) samples.push({ q, off: off.slice(0, 3), on: on.slice(0, 3) });
  }
}
console.log(JSON.stringify({ compared: set.size, numberOneOffVsOracle: numberOneOffOracle, collectorChangesCohort: cohortOffOn, collectorSamples: samples }, null, 2));
