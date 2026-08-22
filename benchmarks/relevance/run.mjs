#!/usr/bin/env node
/**
 * Relevance-evaluation runner (Phase 1).
 *
 * Public SearchEngine API only. No ranking internals, network, models, or embeddings.
 *
 *   node benchmarks/relevance/run.mjs --corpus toy
 *   node benchmarks/relevance/run.mjs --corpus toy --json
 *   node benchmarks/relevance/run.mjs --corpus toy --query toy-alpha
 *   node benchmarks/relevance/run.mjs --corpus toy --worst 2
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { morphology, SearchEngine } from "../../dist/index.js";
import { aggregateQueryMetrics, queryMetrics } from "./lib/metrics.mjs";
import { validateJudgments } from "./lib/validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEARCH_LIMIT = 10;
const TOY_WARNING =
  "Toy fixture is not a search-quality benchmark. Do not cite these numbers as ranking quality.";

const SCHEMA = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

export function compareQueryIds(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function corpusPaths(corpusId) {
  if (!CORPUS_ID_RE.test(corpusId)) {
    throw new Error(`invalid corpus id ${JSON.stringify(corpusId)}`);
  }
  return {
    corpusPath: path.join(HERE, "corpora", corpusId, "documents.json"),
    judgmentsPath: path.join(HERE, "judgments", `${corpusId}.json`),
  };
}

function parseWorst(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--worst must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function queryMatches(q, substring) {
  if (substring == null || substring === "") return true;
  const needle = substring.toLowerCase();
  return q.id.toLowerCase().includes(needle) || q.query.toLowerCase().includes(needle);
}

function metricBlock(agg) {
  return {
    mrrAt5: agg.mrrAt5,
    mrrAt10: agg.mrrAt10,
    ndcgAt5: agg.ndcgAt5,
    ndcgAt10: agg.ndcgAt10,
    recallAt5: agg.recallAt5,
    recallAt10: agg.recallAt10,
  };
}

function queryRow(q, rankedIds, metrics) {
  return {
    id: q.id,
    query: q.query,
    rankedIds,
    relevantCount: metrics.relevantCount,
    eligibleMrrRecall: metrics.eligibleMrrRecall,
    eligibleNdcgAt5: metrics.eligibleNdcgAt5,
    eligibleNdcgAt10: metrics.eligibleNdcgAt10,
    mrrAt5: metrics.mrrAt5,
    mrrAt10: metrics.mrrAt10,
    ndcgAt5: metrics.ndcgAt5,
    ndcgAt10: metrics.ndcgAt10,
    recallAt5: metrics.recallAt5,
    recallAt10: metrics.recallAt10,
  };
}

export async function runEvaluation({
  corpusId,
  query: queryFilter = null,
  worst = null,
} = {}) {
  if (!corpusId) throw new Error("--corpus is required");
  const { corpusPath, judgmentsPath } = corpusPaths(corpusId);
  if (!fs.existsSync(corpusPath)) {
    throw new Error(`corpus file not found: ${corpusPath}`);
  }
  if (!fs.existsSync(judgmentsPath)) {
    throw new Error(`judgments file not found: ${judgmentsPath}`);
  }

  const corpus = loadJson(corpusPath);
  const judgments = loadJson(judgmentsPath);
  validateJudgments(judgments, corpus);

  const selected = judgments.queries
    .filter((q) => queryMatches(q, queryFilter))
    .slice()
    .sort((a, b) => compareQueryIds(a.id, b.id));

  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins: [morphology()],
  });
  await engine.index(
    corpus.documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      body: doc.body,
    }))
  );

  const queries = [];
  for (const q of selected) {
    const results = engine.search(q.query, { limit: SEARCH_LIMIT });
    const rankedIds = results.map((row) => row.id);
    const metrics = queryMetrics(rankedIds, q.judgments);
    queries.push(queryRow(q, rankedIds, metrics));
  }

  const aggregates = aggregateQueryMetrics(queries);
  let worstQueries = null;
  if (worst != null) {
    worstQueries = queries
      .filter((row) => row.ndcgAt10 != null)
      .slice()
      .sort((a, b) => {
        if (a.ndcgAt10 !== b.ndcgAt10) return a.ndcgAt10 - b.ndcgAt10;
        return compareQueryIds(a.id, b.id);
      })
      .slice(0, worst)
      .map((row) => row.id);
  }

  return {
    ok: true,
    corpus: corpus.id,
    toy: corpus.id === "toy",
    warning: corpus.id === "toy" ? TOY_WARNING : null,
    totalQueries: aggregates.totalQueries,
    queriesWithRelevantDocuments: aggregates.queriesWithRelevantDocuments,
    queriesWithNoRelevantDocuments: aggregates.queriesWithNoRelevantDocuments,
    metrics: metricBlock(aggregates),
    queries,
    worstQueries,
  };
}

function fmtMetric(entry) {
  if (!entry || entry.eligible === 0 || entry.value == null) {
    return `n/a  (eligible 0)`;
  }
  return `${entry.value.toFixed(6)}  (eligible ${entry.eligible})`;
}

function fmtQueryMetric(value) {
  if (value == null) return "n/a";
  return value.toFixed(6);
}

export function formatHuman(report) {
  const lines = [
    "@software-land/search relevance evaluation",
    `Corpus: ${report.corpus}`,
  ];
  if (report.warning) {
    lines.push(`WARNING: ${report.warning}`);
  }
  lines.push(
    "",
    `Queries: ${report.totalQueries} total; ${report.queriesWithRelevantDocuments} with relevant documents (grade >= 2); ${report.queriesWithNoRelevantDocuments} with no relevant documents`,
    "",
    `MRR@5      ${fmtMetric(report.metrics.mrrAt5)}`,
    `MRR@10     ${fmtMetric(report.metrics.mrrAt10)}`,
    `NDCG@5     ${fmtMetric(report.metrics.ndcgAt5)}`,
    `NDCG@10    ${fmtMetric(report.metrics.ndcgAt10)}`,
    `Recall@5   ${fmtMetric(report.metrics.recallAt5)}`,
    `Recall@10  ${fmtMetric(report.metrics.recallAt10)}`,
    "",
    "Queries (by id)"
  );
  for (const q of report.queries) {
    lines.push(
      `  ${q.id}  query=${JSON.stringify(q.query)}  ranked=[${q.rankedIds.join(", ")}]`,
      `    MRR@5=${fmtQueryMetric(q.mrrAt5)}  MRR@10=${fmtQueryMetric(q.mrrAt10)}  NDCG@5=${fmtQueryMetric(q.ndcgAt5)}  NDCG@10=${fmtQueryMetric(q.ndcgAt10)}  Recall@5=${fmtQueryMetric(q.recallAt5)}  Recall@10=${fmtQueryMetric(q.recallAt10)}`
    );
  }
  if (report.worstQueries) {
    lines.push("", `Worst NDCG@10 query ids: ${report.worstQueries.join(", ") || "(none eligible)"}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function formatJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: "string" },
      json: { type: "boolean", default: false },
      worst: { type: "string" },
      query: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    corpusId: values.corpus,
    json: Boolean(values.json),
    query: values.query ?? null,
    worst: parseWorst(values.worst),
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const report = await runEvaluation(options);
  process.stdout.write(options.json ? formatJson(report) : formatHuman(report));
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
