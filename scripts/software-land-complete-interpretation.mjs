#!/usr/bin/env node
/**
 * Software.Land product harness. NOT Core policy.
 *
 * This script enables the complete-interpretation collector for named product
 * probes. Core does not decide by token count, trailing stops, or corpus id.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SL = process.env.SOFTWARE_LAND_ROOT;
if (!SL) {
  console.error("software-land-complete-interpretation.mjs requires SOFTWARE_LAND_ROOT (optional local product harness).");
  process.exit(1);
}

const { SearchEngine, morphology, compileAuthoredRelevance } = await import(pathToFileURL(path.join(ROOT, "dist/index.js")).href);
const { attachLexicalFrequency } = await import(pathToFileURL(path.join(ROOT, "tools/search-lexical/index.js")).href);
const { buildQueryPlan } = await import(pathToFileURL(path.join(ROOT, "dist/query/queryPlan.js")).href);
const { collectCompleteInterpretations, COMPLETE_INTERPRETATION_COLLECTOR } = await import(
  pathToFileURL(path.join(ROOT, "dist/execution/completeInterpretationCollector.js")).href
);
const { tokenize, allowPrefixMatch } = await import(pathToFileURL(path.join(ROOT, "dist/text/text.js")).href);
const { buildTokenGraph } = await import(pathToFileURL(path.join(ROOT, "dist/query/configuredFormGraph.js")).href);
const { loadSoftwareLandRelevanceInputs } = await import(
  pathToFileURL(path.join(ROOT, "test/helpers/software-land-fixture.js")).href
);

const inputs = loadSoftwareLandRelevanceInputs();
const compiled = compileAuthoredRelevance({
  configuredConcepts: inputs.configuredConcepts,
  relationshipMap: inputs.relationshipMap,
});

function loadDescriptions() {
  const blog = path.join(SL, "content/blog");
  const byTitle = new Map();
  for (const dir of readdirSync(blog)) {
    let text;
    try {
      text = readFileSync(path.join(blog, dir, "index.md"), "utf8");
    } catch {
      continue;
    }
    const title = text.match(/^title:\s*"([^"]+)"/m)?.[1];
    const description = text.match(/^description:\s*"([^"]+)"/m)?.[1];
    if (title && description) byTitle.set(title, description);
  }
  return byTitle;
}

const descriptions = loadDescriptions();
const docs = attachLexicalFrequency(
  inputs.documents.map((doc) => ({ ...doc, summary: descriptions.get(doc.title) || "" })),
  inputs.lexicalFrequency
);

const engine = SearchEngine.create({
  schema: {
    title: { type: "text", role: "title" },
    summary: { type: "text", role: "summary" },
    body: { type: "text", role: "body" },
  },
  plugins: [morphology({ lemmas: inputs.lemmas }), ...compiled.plugins],
  documentRelationships: inputs.relationships,
  relationshipStrategy: "hybrid",
  retriever: "full-scan",
});
await engine.index(docs);

function probe(q, enableCollector) {
  const analyzed = engine._prepareQuery(q);
  const plan = buildQueryPlan(analyzed, engine._index);
  const collector = collectCompleteInterpretations({
    occupancy: Boolean(plan.structuredKey),
    version: plan.versionIntent,
    exactHits: plan.exactHits,
    prefixHits: plan.prefixHits,
    configuredContentIdentity: Boolean(plan.configuredContentIdentity),
  });
  const graph = buildTokenGraph(analyzed);
  const opts = enableCollector ? { limit: 10, resultCollector: COMPLETE_INTERPRETATION_COLLECTOR } : { limit: 10 };
  return {
    q,
    occupancy: analyzed.configuredSequenceIntent?.key || null,
    version: plan.versionIntent,
    typed: plan.typedTokens,
    graph: {
      configuredEdges: graph.configuredEdgeCount,
      maxFanout: graph.maxFanout,
      edges: graph.edges.map((e) => ({ from: e.from, to: e.to, tokens: e.tokens, source: e.source })),
    },
    exact: plan.exactHits.map((h) => h.document.title),
    prefix: plan.prefixHits.map((h) => h.document.title),
    collector,
    complete: engine.search(q, opts).map((h) => h.title),
    unconstrained: engine.search(q, { limit: 5 }).map((h) => h.title),
    stats: plan.executionStats,
    lastAllow: (() => {
      const last = tokenize(q).at(-1);
      return { last, globalAllowVsRate: last ? allowPrefixMatch(last, "rate") : null };
    })(),
  };
}

const PRODUCT_ENABLE = true;
const out = {
  note: "Collector enablement is this harness, not Core.",
  hfr: [
    "a practical guide to building high-frame-rate",
    "a practical guide to building high-frame-ra",
    "a practical guide to building high-frame-r",
  ].map((q) => probe(q, PRODUCT_ENABLE)),
  idempotency: [
    "duplicate request prevention request fingerprinting storage",
    "duplicate request prevention request fingerprinting storag",
    "covering safe retries, duplicate request prevention request fingerprinting",
    "covering safe retries, duplicate request prevention request finger",
  ].map((q) => probe(q, PRODUCT_ENABLE)),
  rate: [probe("rate limit", PRODUCT_ENABLE)],
  oop: [probe("object oriented programming vs functional", PRODUCT_ENABLE)],
  twoLayer: [probe("two-layer authorization", PRODUCT_ENABLE)],
  structured: [
    "remote procedure call",
    "cross site scripting",
    "simple queue service",
    "command line interface",
    "application programming interface",
    "tls 1.2",
  ].map((q) => probe(q, PRODUCT_ENABLE)),
  falseComposition: [
    "styling and",
    "tasks in",
    "not being",
    "code rising",
    "graphql and",
    "grpc and",
    "ci and",
    "ui for",
    "apis and",
  ].map((q) => probe(q, PRODUCT_ENABLE)),
};
console.log(JSON.stringify(out, null, 2));
