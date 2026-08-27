/**
 * search-corpus CLI implementation.
 * Invoked by the committed build.mjs compatibility launcher.
 *
 *   node tools/search-corpus/build.mjs analyze --input corpus.json --output dir [--decisions file]
 *   node tools/search-corpus/build.mjs compile --input corpus.json --output dir --decisions file
 *   node tools/search-corpus/build.mjs review --pending --output dir
 *   node tools/search-corpus/build.mjs --input corpus.json --output dir
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeCorpus, compileCorpus } from "./lib/pipeline.js";
import { DecisionError } from "./lib/decisions.js";
import type { InspectionDoc, ReviewerRow } from "./types.js";

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
  const decisionsPath = arg("--decisions", arg("--overrides", null));
  const previousPath = arg("--previous", path.join(output, "inspection.json"));

  if (has("--help")) {
    console.log(`Usage:
  node tools/search-corpus/build.mjs analyze --input corpus.json --output dir [--decisions decisions.json]
  node tools/search-corpus/build.mjs compile --input corpus.json --output dir [--decisions decisions.json]
  node tools/search-corpus/build.mjs review --pending --output dir [--type equivalence|synonym] [--priority high|medium|low]
  node tools/search-corpus/build.mjs --input corpus.json --output dir [--decisions decisions.json]

Generated files never overwrite the decisions file.
`);
    process.exit(0);
  }

  if (sub === "review") {
    const inspection = readJson(path.join(output, "inspection.json")) as InspectionDoc | null;
    if (!inspection) {
      console.error(`No inspection.json in ${output}. Run analyze first.`);
      process.exit(1);
    }
    const typeFilter = (arg("--type", "") || "").toLowerCase();
    const priorityFilter = (arg("--priority", "") || "").toUpperCase();
    let items: ReviewerRow[] = inspection.reviewQueue || [
      ...(inspection.pending || []),
      ...(inspection.synonymPending || []),
    ];
    if (typeFilter === "equivalence") {
      items = items.filter((p) => p.key && p.expansion);
    } else if (typeFilter === "synonym") {
      items = items.filter((p) => p.type === "synonym-candidate" || (p.terms && !p.key));
    }
    if (priorityFilter === "HIGH" || priorityFilter === "MEDIUM" || priorityFilter === "LOW") {
      items = items.filter((p) => p.reviewBand === priorityFilter);
    }
    console.log(
      JSON.stringify(
        {
          pending: items.length,
          queueStats: inspection.queueStats || null,
          delta: inspection.delta?.summary || null,
          items: items.map((p) => ({
            id: p.id,
            reviewBand: p.reviewBand,
            reviewScore: p.reviewScore,
            reviewContributions: p.reviewContributions,
            familyId: p.familyId,
            familyRole: p.familyRole,
            recommendation: p.recommendation,
            lifecycle: p.lifecycle,
            relation: p.relation,
            key: p.key,
            expansionPhrase: p.expansionPhrase,
            terms: p.terms,
            reasons: p.reasons,
            evidence: p.evidence,
            examples: p.examples,
            decisionSkeleton: p.decisionSkeleton,
          })),
        },
        null,
        2
      )
    );
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

  const previousInspection =
    sub === "analyze" || sub === "build" || sub === "compile" ? readJson(previousPath) : null;

  try {
    fs.mkdirSync(output, { recursive: true });

    if (sub === "analyze") {
      const analysis = analyzeCorpus(input, { decisions, previousInspection: previousInspection as InspectionDoc | null });
      const written = [
        write(output, "inspection.json", analysis.inspection),
        write(output, "delta.json", analysis.inspection.delta),
      ];
      console.log(
        JSON.stringify(
          {
            stage: "analyze",
            documents: analysis.documents,
            counts: analysis.inspection.counts,
            delta: analysis.inspection.delta?.summary || null,
            timings: analysis.timings,
            written,
          },
          null,
          2
        )
      );
      process.exit(0);
    }

    const result = compileCorpus(input, { decisions, previousInspection: previousInspection as InspectionDoc | null });
    const written = [
      write(output, "equivalences.json", result.equivalences),
      write(output, "relationship-map.json", result.relationshipMap),
      write(output, "vocabulary.json", result.vocabulary),
      write(output, "spelling-terms.json", { format: "search-corpus-spelling-terms", version: 1, terms: result.spellingTerms }),
      write(output, "inspection.json", result.inspection),
      write(output, "manifest.json", result.manifest),
      write(output, "delta.json", result.inspection.delta),
    ];
    console.log(
      JSON.stringify(
        {
          stage: sub,
          documents: result.documents,
          counts: result.inspection.counts,
          delta: result.inspection.delta?.summary || null,
          timings: result.timings,
          warnings: result.compileWarnings,
          written,
        },
        null,
        2
      )
    );
  } catch (err) {
    if (err instanceof DecisionError) {
      console.error(err.message);
      for (const d of err.details || []) console.error(`  - ${d}`);
      process.exit(1);
    }
    throw err;
  }
}
