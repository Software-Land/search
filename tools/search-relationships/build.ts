/**
 * search-relationships CLI implementation.
 * Invoked by the committed build.mjs compatibility launcher.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRelationships, compileRelationships, DecisionError } from "./lib/pipeline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(flag: string, fallback?: string | null): string | null | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function readJson(file: string | null | undefined): unknown {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function write(dir: string, name: string, obj: unknown): { name: string; bytes: number } {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  return { name, bytes: fs.statSync(file).size };
}

export function main(): void {
  const sub = ["analyze", "compile", "review", "build"].includes(process.argv[2]) ? process.argv[2] : "build";
  const input = arg("--input", path.join(HERE, ".output/corpus.json")) || path.join(HERE, ".output/corpus.json");
  const output = arg("--output", path.join(HERE, ".output")) || path.join(HERE, ".output");
  const decisionsPath = arg("--decisions", null);
  const semanticPath = arg("--semantic", null);

  if (has("--help")) {
    console.log(`Usage:
  node tools/search-relationships/build.mjs analyze --input corpus.json --output dir [--decisions decisions.json]
  node tools/search-relationships/build.mjs compile --input corpus.json --output dir [--decisions decisions.json] [--semantic semantic.json]
  node tools/search-relationships/build.mjs review --pending --output dir

Generated files never overwrite the decisions file.
`);
    process.exit(0);
  }

  if (sub === "review") {
    const inspection = readJson(path.join(output, "inspection.json")) as {
      pending?: Array<{ reviewBand?: string | null; id?: string }>;
    } | null;
    if (!inspection) {
      console.error(`No inspection.json in ${output}. Run analyze first.`);
      process.exit(1);
    }
    const items = [...(inspection.pending || [])].sort((a, b) => {
      const rank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return (rank[a.reviewBand || ""] ?? 9) - (rank[b.reviewBand || ""] ?? 9) || String(a.id).localeCompare(String(b.id));
    });
    console.log(JSON.stringify({ pending: items.length, items }, null, 2));
    process.exit(0);
  }

  if (!fs.existsSync(input)) {
    console.error(`Input file missing: ${input}`);
    process.exit(1);
  }

  let decisions = null;
  try {
    decisions = decisionsPath ? readJson(decisionsPath) : null;
  } catch (err) {
    console.error(`Failed to read decisions: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const semantic = semanticPath ? readJson(semanticPath) : null;
  const mine = !has("--no-mine");

  try {
    fs.mkdirSync(output, { recursive: true });
    if (sub === "analyze") {
      const analysis = analyzeRelationships(input, { decisions, mine });
      write(output, "inspection.json", analysis.inspection);
      console.log(JSON.stringify({ stage: "analyze", counts: analysis.inspection.counts, timings: analysis.timings }, null, 2));
      process.exit(0);
    }
    const result = compileRelationships(input, { decisions, semantic, mine });
    const written = [
      write(output, "relationships.json", result.runtime),
      write(output, "relationships-full.json", result.merged),
      write(output, "domain.json", result.domain),
      write(output, "inspection.json", result.inspection),
      write(output, "manifest.json", result.manifest),
    ];
    console.log(JSON.stringify({ stage: sub, counts: result.manifest.counts, timings: result.manifest.timings, written }, null, 2));
  } catch (err) {
    if (err instanceof DecisionError) {
      console.error(err.message);
      for (const d of err.details || []) console.error(`  - ${d}`);
      process.exit(1);
    }
    throw err;
  }
}
