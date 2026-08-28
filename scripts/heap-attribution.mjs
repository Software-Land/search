#!/usr/bin/env node
/**
 * Approximate V8 heap ownership for mixed lexical indexes.
 *
 *   node --expose-gc scripts/heap-attribution.mjs
 *   node --expose-gc scripts/heap-attribution.mjs --n 5000
 *
 * Build structures one at a time, GC, and report deltas. These are
 * ownership estimates, not exact V8 accounts. Not a CI gate.
 */
import { parseArgs } from "node:util";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { compileLexicalIndex, loadLexicalIndex } from "../dist/lexicalIndex.js";
import { buildIndex } from "../dist/indexDocuments.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";

const SEED = 0x60d6e7ed;
const SCHEMA = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const { values } = parseArgs({
  options: {
    n: { type: "string", default: "25000" },
  },
});
const n = Math.max(1, Number(values.n) || 25000);

function mixedCorpus(size) {
  const specials = [
    { id: "rare-exact", title: "ZX9 UniqueRareTitle", body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security handshake certificate pinning" },
    { id: "vpn", title: "What is VPN?", body: "virtual private network tunnel bluetooth accessories" },
    { id: "iot", title: "What is IoT?", body: "internet of things sensors search index document" },
    { id: "io", title: "What is IO?", body: "input output streams latency throughput" },
    { id: "bluetooth", title: "Bluetooth Settings", body: "connect wireless accessories bluetooth pairing" },
    { id: "fps", title: "200FPS Canvas Notes", body: "css vs canvas rendering" },
  ];
  const rest = Math.max(0, size - specials.length);
  const settingsN = Math.floor(rest * 0.3);
  const articleN = rest - settingsN;
  return [
    ...specials,
    ...generateSettings(settingsN, SEED ^ 0x11),
    ...generateArticle(articleN, { bodyTokens: 60, seed: SEED ^ 0x22, diverse: false }),
  ];
}

function snapshot() {
  if (typeof globalThis.gc === "function") globalThis.gc();
  const mu = process.memoryUsage();
  return {
    heapUsed: mu.heapUsed,
    rss: mu.rss,
    external: mu.external,
    arrayBuffers: mu.arrayBuffers,
  };
}

function mb(bytes) {
  return Number((bytes / 1048576).toFixed(2));
}

function delta(after, before) {
  return {
    heapUsedMb: mb(after.heapUsed - before.heapUsed),
    rssMb: mb(after.rss - before.rss),
    externalMb: mb(after.external - before.external),
    arrayBuffersMb: mb(after.arrayBuffers - before.arrayBuffers),
  };
}

function retain(value) {
  return value;
}

const docs = mixedCorpus(n);
const plugins = [
  morphology({ lemmas: { searching: "search", searched: "search", searches: "search" } }),
  compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]] }] }),
];

const rows = [];
let baseline = snapshot();
rows.push({ step: "source-documents", live: true, ...delta(snapshot(), baseline) });

baseline = snapshot();
const fat = buildIndex(docs, SCHEMA, plugins);
retain(fat);
rows.push({
  step: "fat-buildIndex",
  documents: fat.documents.length,
  sampleHasSet: fat.documents[0]?.titleTokenSet instanceof Set,
  ...delta(snapshot(), baseline),
});

baseline = snapshot();
const artifact = compileLexicalIndex(docs, { schema: SCHEMA, plugins });
retain(artifact);
const artifactBytes = Buffer.byteLength(JSON.stringify(artifact));
rows.push({
  step: "compile-artifact-object",
  artifactBytes,
  artifactMb: mb(artifactBytes),
  ...delta(snapshot(), baseline),
});

baseline = snapshot();
const compact = loadLexicalIndex(artifact, docs, SCHEMA, plugins);
retain(compact);
const store = compact.documents[0]?._store;
rows.push({
  step: "compact-loadLexicalIndex",
  sampleHasSet: compact.documents[0]?.titleTokenSet instanceof Set,
  titleIdsBytes: store?.titleIds?.byteLength || 0,
  bodyIdsBytes: store?.bodyIds?.byteLength || 0,
  lemmaOfBytes: store?.lemmaOf?.byteLength || 0,
  strings: store?.strings?.length || 0,
  postingEntries: compact.compiledLexical?.postingEntries || 0,
  terms: compact.compiledLexical?.terms?.length || 0,
  ...delta(snapshot(), baseline),
});

baseline = snapshot();
const engine = SearchEngine.create({
  schema: SCHEMA,
  plugins,
  retriever: "indexed",
  lexicalIndex: artifact,
  relationshipStrategy: "none",
});
await engine.index(docs);
rows.push({
  step: "SearchEngine.index-precompiled",
  envelopeRetained: engine.lexicalIndex != null,
  ...delta(snapshot(), baseline),
});

if (store) {
  const typed =
    (store.titleIds?.byteLength || 0) +
    (store.bodyIds?.byteLength || 0) +
    (store.titleOff?.byteLength || 0) +
    (store.bodyOff?.byteLength || 0) +
    (store.lemmaOf?.byteLength || 0) +
    (store.dottedOff?.byteLength || 0) +
    (store.dottedIdx?.byteLength || 0);
  rows.push({
    step: "compact-typed-array-bytes",
    heapUsedMb: 0,
    rssMb: 0,
    note: "byteLength of packed token/offset views; lives in arrayBuffers/external more than heapUsed",
    typedArrayBytes: typed,
    typedArrayMb: mb(typed),
  });
}

const ranked = [...rows]
  .filter((row) => typeof row.heapUsedMb === "number")
  .sort((a, b) => b.heapUsedMb - a.heapUsedMb)
  .slice(0, 3)
  .map((row) => ({ step: row.step, heapUsedMb: row.heapUsedMb }));

console.log(JSON.stringify({
  ok: true,
  node: process.version,
  n,
  gc: typeof globalThis.gc === "function",
  note: "Deltas are approximate V8 ownership, not exact retained-size accounts.",
  top3HeapDeltas: ranked,
  rows,
}, null, 2));
