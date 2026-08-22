import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJudgments } from "../benchmarks/relevance/lib/validate.mjs";
import { formatJson, runEvaluation } from "../benchmarks/relevance/run.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "benchmarks/relevance/run.mjs");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function runCli(args) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("relevance toy fixture and runner", () => {
  test("toy corpus and judgments are exhaustive and valid", () => {
    const corpus = JSON.parse(
      fs.readFileSync(path.join(root, "benchmarks/relevance/corpora/toy/documents.json"), "utf8")
    );
    const judgments = JSON.parse(
      fs.readFileSync(path.join(root, "benchmarks/relevance/judgments/toy.json"), "utf8")
    );
    expect(corpus.id).toBe("toy");
    expect(validateJudgments(judgments, corpus).queryIds.sort()).toEqual([
      "toy-alpha",
      "toy-background",
      "toy-none",
    ]);
  });

  test("package.json files list does not include benchmark datasets", () => {
    expect(pkg.files.some((entry) => String(entry).includes("benchmarks"))).toBe(false);
  });

  test("runner uses only the public SearchEngine entry", () => {
    const src = fs.readFileSync(runner, "utf8");
    expect(src).toMatch(/from "\.\.\/\.\.\/dist\/index\.js"/);
    expect(src).not.toMatch(/rank\.js|features\.js|constraints\.js|analyze\.js|retrieve\.js/);
  });

  test("evaluates the toy corpus through SearchEngine and reports eligibility", async () => {
    const report = await runEvaluation({ corpusId: "toy" });
    expect(report.ok).toBe(true);
    expect(report.toy).toBe(true);
    expect(report.warning).toMatch(/not a search-quality benchmark/);
    expect(report.queries.map((q) => q.id)).toEqual(["toy-alpha", "toy-background", "toy-none"]);
    expect(report.totalQueries).toBe(3);
    expect(report.queriesWithRelevantDocuments).toBe(1);
    expect(report.queriesWithNoRelevantDocuments).toBe(2);
    expect(report.metrics.mrrAt5.eligible).toBe(1);
    expect(report.metrics.recallAt5.eligible).toBe(1);
    expect(report.metrics.ndcgAt5.eligible).toBe(2);
    const byId = Object.fromEntries(report.queries.map((q) => [q.id, q]));
    expect(byId["toy-alpha"].rankedIds[0]).toBe("alpha");
    expect(byId["toy-alpha"].mrrAt5).toBe(1);
    expect(byId["toy-background"].mrrAt5).toBeNull();
    expect(byId["toy-background"].ndcgAt5).not.toBeNull();
    expect(byId["toy-none"].ndcgAt5).toBeNull();
  });

  test("JSON output is deterministic across two CLI runs", () => {
    const a = runCli(["--corpus", "toy", "--json"]);
    const b = runCli(["--corpus", "toy", "--json"]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toBe(formatJson(JSON.parse(a.stdout)));
    const parsed = JSON.parse(a.stdout);
    expect(parsed.warning).toMatch(/not a search-quality benchmark/);
    expect(parsed.queries.map((q) => q.id)).toEqual(["toy-alpha", "toy-background", "toy-none"]);
  });

  test("human output labels the toy fixture", () => {
    const result = runCli(["--corpus", "toy"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/WARNING: Toy fixture is not a search-quality benchmark/);
    expect(result.stdout).toMatch(/toy-alpha/);
  });

  test("--query filters by stable id substring", async () => {
    const report = await runEvaluation({ corpusId: "toy", query: "toy-alpha" });
    expect(report.queries.map((q) => q.id)).toEqual(["toy-alpha"]);
    expect(report.totalQueries).toBe(1);
    expect(report.queriesWithRelevantDocuments).toBe(1);
  });

  test("--worst lists lowest NDCG@10 ids among eligible queries", async () => {
    const report = await runEvaluation({ corpusId: "toy", worst: 1 });
    expect(report.worstQueries).toHaveLength(1);
    expect(["toy-alpha", "toy-background"]).toContain(report.worstQueries[0]);
  });
});
