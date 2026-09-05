#!/usr/bin/env node
/**
 * Feature-profile a compact phrase query. Internal harness only.
 *
 *   node --expose-gc scripts/phrase-profile.mjs --n 5000
 */
import { parseArgs } from "node:util";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { compileLexicalIndex } from "../dist/indexing/lexicalIndex.js";
import { startFeatureProfile, lastFeatureProfile, stopFeatureProfile } from "../dist/features/features.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";

const SEED = 0x60d6e7ed;
const SCHEMA = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const { values } = parseArgs({
  options: {
    n: { type: "string", default: "5000" },
    query: { type: "string", default: "virtual private network" },
  },
});
const n = Math.max(1, Number(values.n) || 5000);

function mixedCorpus(size) {
  const specials = [
    { id: "rare-exact", title: "ZX9 UniqueRareTitle", body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security handshake certificate pinning" },
    { id: "vpn", title: "What is VPN?", body: "virtual private network tunnel bluetooth accessories" },
    { id: "iot", title: "What is IoT?", body: "internet of things sensors search index document" },
    { id: "io", title: "What is IO?", body: "input output streams latency throughput" },
    { id: "bluetooth", title: "Bluetooth Settings", body: "connect wireless accessories bluetooth pairing" },
    { id: "fps", title: "200FPS Canvas Notes", body: "css vs canvas rendering" },
    { id: "probezz", title: "The Probezz", body: "notes" },
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

const plugins = [
  morphology({ lemmas: { searching: "search", searched: "search", searches: "search" } }),
  compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]] }] }),
];
const docs = mixedCorpus(n);
const artifact = compileLexicalIndex(docs, { schema: SCHEMA, plugins });
const engine = SearchEngine.create({
  schema: SCHEMA,
  plugins,
  lexicalIndex: artifact,
  retriever: "indexed",
  relationshipStrategy: "none",
});
await engine.index(docs);
engine.search(values.query, { limit: 10, relatedLimit: 0 });
startFeatureProfile();
const detailed = engine._searchDetailedSync(values.query, { limit: 10, relatedLimit: 0 }, false);
const profile = lastFeatureProfile() || {};
stopFeatureProfile();
const rows = Object.entries(profile)
  .map(([name, bucket]) => ({
    name,
    ms: Number(bucket.ms.toFixed(3)),
    calls: bucket.calls,
    usPerCall: bucket.calls ? Number(((bucket.ms * 1000) / bucket.calls).toFixed(3)) : 0,
  }))
  .sort((a, b) => b.ms - a.ms);
const featureSum = rows.reduce((sum, row) => sum + row.ms, 0);
console.log(JSON.stringify({
  ok: true,
  n,
  query: values.query,
  matches: detailed.meta.matchCount,
  documentsFullyEvaluated: detailed.meta.documentsFullyEvaluated,
  retrieveMs: detailed.meta.retrieveMs,
  featureMs: detailed.meta.featureMs,
  totalMs: detailed.meta.totalMs,
  profiledFeatureSumMs: Number(featureSum.toFixed(3)),
  buckets: rows,
}, null, 2));
