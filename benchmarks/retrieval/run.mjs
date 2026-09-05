#!/usr/bin/env node
/**
 * Retrieval-mode envelope at corpus scale.
 *
 * Measures candidate C and search-side timings for full-scan / indexed /
 * adaptive. Software.Land cannot prove N >> candidateLimit.
 *
 *   node benchmarks/retrieval/run.mjs
 *   node benchmarks/retrieval/run.mjs --n 1000,5000
 *   node benchmarks/retrieval/run.mjs --n 25000 --skip-full-scan
 *
 * Not packed. Not a search-quality claim. Not a CI latency gate.
 */

import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { SearchEngine, morphology } from "../../dist/index.js";
import { compileConfiguredConceptPlugin } from "../../dist/relationships/configuredConcepts.js";
import { generateArticle, generateSettings } from "../memory/lib/generate.mjs";
const SCHEMA = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const SEED = 0x51e07e11;

const QUERIES = [
  { cls: "rare-exact-title", q: "ZX9 UniqueRareTitle" },
  { cls: "common-one-token", q: "search" },
  { cls: "multi-token", q: "virtual private network" },
  { cls: "broad-stop-ish", q: "the" },
  { cls: "prefix", q: "virt" },
  { cls: "typo", q: "blutooth" },
  { cls: "morphology", q: "searching" },
  { cls: "configured-concept", q: "tls" },
  { cls: "version", q: "1.2" },
  { cls: "dotted-span", q: "tls 1.2" },
  { cls: "relationship", q: "vpn" },
  { cls: "short-literal", q: "io" },
];

function parseSizes(raw, fallback) {
  const sizes = String(raw || fallback)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!sizes.length) throw new Error("expected a comma-separated list of positive integers");
  return sizes;
}

function generateMixed(n, seed = SEED) {
  const specials = [
    { id: "rare-exact", title: "ZX9 UniqueRareTitle", body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security handshake certificate pinning" },
    { id: "vpn", title: "What is VPN?", body: "virtual private network tunnel bluetooth accessories" },
    { id: "iot", title: "What is IoT?", body: "internet of things sensors search index document" },
    { id: "io", title: "What is IO?", body: "input output streams latency throughput" },
    { id: "bluetooth", title: "Bluetooth Settings", body: "connect wireless accessories bluetooth pairing" },
  ];
  const rest = Math.max(0, n - specials.length);
  const settingsN = Math.floor(rest * 0.35);
  const articleN = rest - settingsN;
  const settings = generateSettings(settingsN, seed ^ 0x111);
  const articles = generateArticle(articleN, { bodyTokens: 80, seed: seed ^ 0x222, diverse: false });
  return [...specials, ...settings, ...articles].slice(0, n);
}

const RELATIONSHIPS = {
  format: "search-v2-relationships",
  version: 1,
  relationships: {
    tls: [{ target: "vpn", type: "editorial", strength: 1, provenance: "manual" }],
    vpn: [{ target: "tls", type: "editorial", strength: 1, provenance: "manual" }],
  },
};

const LEMMAS = { searching: "search", searched: "search", searches: "search" };
const CONFIGURED_CONCEPTS = [{ key: "tls", aliases: [["transport", "layer", "security"]] }];

async function createEngine(retriever, docs, extra = {}) {
  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins: [morphology({ lemmas: LEMMAS }), compileConfiguredConceptPlugin({ configuredConcepts: CONFIGURED_CONCEPTS })],
    documentRelationships: RELATIONSHIPS,
    relationshipStrategy: "hybrid",
    retriever,
    candidateLimit: 200,
    ...extra,
  });
  await engine.index(docs);
  return engine;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function pct(values, p) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

function measure(engine, query, repeats) {
  const rows = [];
  engine.searchDetailed(query, { limit: 10, relatedLimit: 5 });
  for (let i = 0; i < repeats; i += 1) {
    const detailed = engine.searchDetailed(query, { limit: 10, relatedLimit: 5 });
    rows.push({
      C: detailed.meta.candidateCount,
      retrieveMs: detailed.meta.retrieveMs,
      featureMs: detailed.meta.featureMs,
      rankMs: detailed.meta.rankMs,
      totalMs: detailed.meta.totalMs,
      topId: detailed.results[0]?.id ?? null,
      topTitle: detailed.results[0]?.title ?? null,
    });
  }
  const totals = rows.map((r) => r.totalMs);
  return {
    C: rows[0].C,
    retrieveMs: Number(median(rows.map((r) => r.retrieveMs)).toFixed(3)),
    featureMs: Number(median(rows.map((r) => r.featureMs)).toFixed(3)),
    rankMs: Number(median(rows.map((r) => r.rankMs)).toFixed(3)),
    totalMs: Number(median(totals).toFixed(3)),
    totalMsP90: Number(pct(totals, 0.9).toFixed(3)),
    warmup: 1,
    iterations: repeats,
    topId: rows[0].topId,
    topTitle: rows[0].topTitle,
  };
}

async function main() {
  const args = parseArgs({
    options: {
      n: { type: "string", default: "1000,5000,25000" },
      repeats: { type: "string", default: "3" },
      "skip-full-scan": { type: "boolean", default: false },
      "full-scan-max-n": { type: "string", default: "5000" },
    },
  });
  const sizes = parseSizes(args.values.n, "1000,5000,25000");
  const repeats = Number(args.values.repeats);
  const fullScanMaxN = Number(args.values["full-scan-max-n"]);
  const skipFull = Boolean(args.values["skip-full-scan"]);
  const report = [];

  for (const n of sizes) {
    const docs = generateMixed(n);
    const modes = ["indexed", "adaptive"];
    const runFull = !skipFull && n <= fullScanMaxN;
    if (runFull) modes.unshift("full-scan");
    const engines = {};
    for (const mode of modes) {
      const t0 = performance.now();
      engines[mode] = await createEngine(mode, docs);
      engines[mode]._indexMs = performance.now() - t0;
    }
    if (n >= 100 && n <= 1500) {
      for (const threshold of [100, 250, 500, 1000, 1500]) {
        if (threshold >= n) continue;
        const name = `adaptive@${threshold}`;
        engines[name] = await createEngine("adaptive", docs, { adaptive: { documentThreshold: threshold } });
        modes.push(name);
      }
    }

    for (const { cls, q } of QUERIES) {
      const row = { n, cls, query: q };
      let fullTop = null;
      for (const mode of modes) {
        const stats = measure(engines[mode], q, repeats);
        row[mode] = stats;
        if (mode === "full-scan") fullTop = stats.topId;
      }
      if (fullTop != null) {
        for (const mode of modes) {
          if (mode === "full-scan") continue;
          row[mode].topMatchesFullScan = row[mode].topId === fullTop;
        }
      }
      report.push(row);
    }
  }

  const summary = report.map((row) => {
    const out = { n: row.n, cls: row.cls, query: row.query };
    for (const key of Object.keys(row)) {
      if (key === "n" || key === "cls" || key === "query") continue;
      const s = row[key];
      out[key] = {
        C: s.C,
        retrieveMs: s.retrieveMs,
        featureMs: s.featureMs,
        rankMs: s.rankMs,
        totalMs: s.totalMs,
        totalMsP90: s.totalMsP90,
        warmup: s.warmup,
        iterations: s.iterations,
        topId: s.topId,
        topMatchesFullScan: s.topMatchesFullScan ?? null,
      };
    }
    return out;
  });
  console.log(JSON.stringify({ ok: true, seed: SEED, candidateLimit: 200, rows: summary }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
