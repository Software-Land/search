/**
 * search-relationships CLI implementation.
 * Invoked by the committed build.mjs compatibility launcher.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileRelationships, DecisionError } from "./lib/pipeline.js";

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
  const sub = process.argv[2];
  if (sub && !["compile", "build", "--help"].includes(sub) && !sub.startsWith("--")) {
    console.error(`Unknown command "${sub}". Use compile.`);
    process.exit(1);
  }

  const input = arg("--input", path.join(HERE, ".output/corpus.json")) || path.join(HERE, ".output/corpus.json");
  const output = arg("--output", path.join(HERE, ".output")) || path.join(HERE, ".output");
  const decisionsPath = arg("--decisions", null);
  const semanticPath = arg("--semantic", null);

  if (has("--help") || sub === "--help") {
    console.log(`Usage:
  node tools/search-relationships/build.mjs compile --input corpus.json --output dir [--decisions decisions.json] [--semantic semantic.json]

Generated files never overwrite the decisions file.
`);
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

  try {
    fs.mkdirSync(output, { recursive: true });
    const result = compileRelationships(input, { decisions, semantic });
    const written = [
      write(output, "relationships.json", result.runtime),
      write(output, "relationships-full.json", result.merged),
      write(output, "domain.json", result.domain),
      write(output, "manifest.json", result.manifest),
    ];
    console.log(JSON.stringify({ stage: "compile", counts: result.manifest.counts, written }, null, 2));
  } catch (err) {
    if (err instanceof DecisionError) {
      console.error(err.message);
      for (const d of err.details || []) console.error(`  - ${d}`);
      process.exit(1);
    }
    throw err;
  }
}
