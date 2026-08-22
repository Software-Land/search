#!/usr/bin/env node
/**
 * Memory benchmark for SearchEngine index + search.
 *
 * RSS is process resident size, not retained index size. Prefer heapUsed
 * after forced GC for retained V8-heap figures. Packed constraint edges are
 * Uint32Array chunks: include external / arrayBuffers, not only heapUsed.
 *
 *   node --expose-gc benchmarks/memory/run.mjs --mode routine
 *
 * Public SearchEngine API only. No ranking internals.
 */

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import { morphology, SearchEngine } from "../../dist/index.js";
import { corpusStats, generateCorpus } from "./lib/generate.mjs";
import { deltaMb, hasExposeGc, snap } from "./lib/measure.mjs";

const SCHEMA = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const MODES = {
  routine: [
    { shape: "settings", n: 1000, retriever: "full-scan", query: "wifi" },
    { shape: "article", n: 1000, retriever: "full-scan", query: "virtual private" },
  ],
  large: [{ shape: "settings", n: 10000, retriever: "full-scan", query: "bluetooth settings" }],
  "oom-probe": [{ shape: "article", n: 25000, retriever: "full-scan", query: "tls" }],
};

export async function runOne({
  shape,
  n,
  retriever = "full-scan",
  query = null,
  dropSource = true,
} = {}) {
  const stages = [];
  stages.push(snap("before", { gc: true }));

  const tGen0 = performance.now();
  const docs = generateCorpus(shape, n);
  const genMs = performance.now() - tGen0;
  const stats = corpusStats(docs);
  stages.push(snap("after-source-corpus", { gc: true }));

  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins: [morphology()],
    retriever,
    relationshipStrategy: "none",
  });
  const tIdx0 = performance.now();
  const indexInfo = await engine.index(docs);
  const indexMs = performance.now() - tIdx0;
  stages.push(snap("after-index-pre-gc", { gc: false }));
  stages.push(snap("after-index-post-gc", { gc: true }));

  if (dropSource) {
    docs.length = 0;
    stages.push(snap("after-drop-source-post-gc", { gc: true }));
  }

  let search = null;
  if (query != null && query !== "") {
    if (typeof global.gc === "function") global.gc();
    const beforeSearch = snap("search-before", { gc: false });
    const t0 = performance.now();
    const detailed = engine.searchDetailed(query, { limit: 10 });
    const ms = performance.now() - t0;
    const afterPreGc = snap("search-after-pre-gc", { gc: false });
    const afterPostGc = snap("search-after-post-gc", { gc: true });
    const meta = detailed.meta || {};
    const candidateCount = meta.candidateCount ?? null;
    search = {
      query,
      resultCount: detailed.results.length,
      topIds: detailed.results.map((r) => r.id),
      ms: +ms.toFixed(2),
      candidateCount,
      pairComparisons:
        typeof candidateCount === "number" ? (candidateCount * (candidateCount - 1)) / 2 : null,
      retrieveMs: meta.retrieveMs ?? null,
      featureMs: meta.featureMs ?? null,
      rankMs: meta.rankMs ?? null,
      before: {
        heapUsedMb: beforeSearch.heapUsedMb,
        heapTotalMb: beforeSearch.heapTotalMb,
        externalMb: beforeSearch.externalMb,
        arrayBuffersMb: beforeSearch.arrayBuffersMb,
        rssMb: beforeSearch.rssMb,
      },
      afterPreGc: {
        heapUsedMb: afterPreGc.heapUsedMb,
        heapTotalMb: afterPreGc.heapTotalMb,
        externalMb: afterPreGc.externalMb,
        arrayBuffersMb: afterPreGc.arrayBuffersMb,
        rssMb: afterPreGc.rssMb,
      },
      afterPostGc: {
        heapUsedMb: afterPostGc.heapUsedMb,
        heapTotalMb: afterPostGc.heapTotalMb,
        externalMb: afterPostGc.externalMb,
        arrayBuffersMb: afterPostGc.arrayBuffersMb,
        rssMb: afterPostGc.rssMb,
      },
      heapUsedDeltaMb: deltaMb(afterPreGc, beforeSearch, "heapUsedMb"),
      heapTotalDeltaMb: deltaMb(afterPreGc, beforeSearch, "heapTotalMb"),
      externalDeltaMb: deltaMb(afterPreGc, beforeSearch, "externalMb"),
      arrayBuffersDeltaMb: deltaMb(afterPreGc, beforeSearch, "arrayBuffersMb"),
      rssDeltaMb: deltaMb(afterPreGc, beforeSearch, "rssMb"),
      afterGcHeapUsedMb: afterPostGc.heapUsedMb,
      afterGcRssMb: afterPostGc.rssMb,
    };
    stages.push(afterPostGc);
  }

  const byLabel = Object.fromEntries(stages.map((s) => [s.label, s]));
  return {
    ok: true,
    node: process.version,
    exposeGc: hasExposeGc(),
    execArgv: process.execArgv,
    shape,
    n,
    retriever,
    query,
    corpus: stats,
    genMs: +genMs.toFixed(1),
    indexMs: +indexMs.toFixed(1),
    indexInfo,
    note: "RSS is process resident size, not retained index size. Use heapUsed after GC for retained figures.",
    stages: byLabel,
    search,
  };
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string" },
      shape: { type: "string" },
      n: { type: "string" },
      retriever: { type: "string", default: "full-scan" },
      query: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

function jobsFromCli(values) {
  if (values.mode) {
    const jobs = MODES[values.mode];
    if (!jobs) throw new Error(`unknown --mode ${values.mode} (routine | large | oom-probe)`);
    return jobs;
  }
  if (!values.shape || !values.n) {
    throw new Error("pass --mode routine|large|oom-probe, or --shape and --n");
  }
  return [
    {
      shape: values.shape,
      n: Number(values.n),
      retriever: values.retriever,
      query: values.query ?? null,
    },
  ];
}

function formatHuman(report) {
  const idx = report.stages["after-index-post-gc"];
  const src = report.stages["after-source-corpus"];
  const drop = report.stages["after-drop-source-post-gc"] || idx;
  const lines = [
    `@software-land/search memory benchmark`,
    `shape=${report.shape} n=${report.n} retriever=${report.retriever} node=${report.node} exposeGc=${report.exposeGc}`,
    `indexMs=${report.indexMs}  sourceHeap=${src.heapUsedMb}MB  retainedHeap=${drop.heapUsedMb}MB  rss=${drop.rssMb}MB`,
    `note: ${report.note}`,
  ];
  if (report.search) {
    const s = report.search;
    lines.push(
      `search q=${JSON.stringify(s.query)} candidates=${s.candidateCount} pairs=${s.pairComparisons} rankMs=${s.rankMs != null ? Number(s.rankMs).toFixed(1) : "n/a"}`,
      `  before    heapUsed=${s.before.heapUsedMb}MB heapTotal=${s.before.heapTotalMb}MB external=${s.before.externalMb}MB arrayBuffers=${s.before.arrayBuffersMb}MB rss=${s.before.rssMb}MB`,
      `  after     heapUsed=${s.afterPreGc.heapUsedMb}MB heapTotal=${s.afterPreGc.heapTotalMb}MB external=${s.afterPreGc.externalMb}MB arrayBuffers=${s.afterPreGc.arrayBuffersMb}MB rss=${s.afterPreGc.rssMb}MB`,
      `  Δ         heapUsed=${s.heapUsedDeltaMb}MB heapTotal=${s.heapTotalDeltaMb}MB external=${s.externalDeltaMb}MB arrayBuffers=${s.arrayBuffersDeltaMb}MB rss=${s.rssDeltaMb}MB`,
      `  postGc    heapUsed=${s.afterPostGc.heapUsedMb}MB heapTotal=${s.afterPostGc.heapTotalMb}MB external=${s.afterPostGc.externalMb}MB arrayBuffers=${s.afterPostGc.arrayBuffersMb}MB rss=${s.afterPostGc.rssMb}MB`,
      `topIds=${s.topIds.join(",")}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  if (!hasExposeGc()) {
    process.stderr.write("warning: run with node --expose-gc so post-GC retained heap is meaningful\n");
  }
  const values = parseCli(argv);
  const jobs = jobsFromCli(values);
  const reports = [];
  for (const job of jobs) {
    reports.push(await runOne(job));
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`);
  } else {
    for (const report of reports) process.stdout.write(formatHuman(report));
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMain()) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
