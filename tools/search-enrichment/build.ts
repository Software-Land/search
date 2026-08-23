/**
 * search-enrichment CLI.
 *
 *   node tools/search-enrichment/build.mjs enrich --input corpus.json --output dir
 *     [--decisions file] [--provider function|openai-compat] [--provider-module path]
 *     [--base-url url] [--model name] [--api-key key] [--timeout-ms n]
 *     [--cache-dir dir] [--auto-accept-verified]
 *
 * Generated files never overwrite a decisions file.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EnrichmentError } from "./lib/errors.js";
import { enrichCorpus } from "./lib/enrich.js";
import { createFunctionProvider } from "./lib/functionProvider.js";
import { createOpenAICompatibleProvider } from "./lib/openaiCompat.js";

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

export async function main(): Promise<void> {
  if (has("--help") || process.argv[2] === "help") {
    console.log(`Usage:
  node tools/search-enrichment/build.mjs enrich --input corpus.json --output dir
    [--decisions decisions.json]
    [--provider function|openai-compat]
    [--provider-module path-to-module.js]
    [--base-url url] [--model name] [--api-key key]
    [--timeout-ms 15000] [--cache-dir dir]
    [--auto-accept-verified]

Does not write or modify decisions.json. Default auto-accept is off.
HTTP provider: pass --base-url and --model. Pass --api-key explicitly if the server requires auth.
API keys are not read from the environment.
`);
    process.exit(0);
  }

  const input = arg("--input");
  const output = arg("--output");
  if (!input || !output) {
    console.error("enrich requires --input and --output");
    process.exit(1);
  }

  const decisionsPath = arg("--decisions");
  const providerName = (arg("--provider", "function") || "function").toLowerCase();
  let provider;
  try {
    if (providerName === "openai-compat") {
      provider = createOpenAICompatibleProvider({
        baseUrl: arg("--base-url") || "",
        model: arg("--model") || "",
        apiKey: arg("--api-key") || undefined,
        timeoutMs: Number(arg("--timeout-ms", "15000")) || 15000,
      });
    } else {
      const modulePath = arg("--provider-module");
      if (!modulePath) {
        console.error("function provider requires --provider-module pointing at a module with default/infer export");
        process.exit(1);
      }
      const mod = await import(pathToFileURL(path.resolve(modulePath)).href);
      const fn = mod.default || mod.infer;
      if (typeof fn !== "function") {
        console.error("provider module must export default or infer function");
        process.exit(1);
      }
      provider = createFunctionProvider(fn);
    }

    const result = await enrichCorpus(readJson(input) || input, {
      decisions: decisionsPath ? readJson(decisionsPath) : null,
      provider,
      cacheDir: arg("--cache-dir") || undefined,
      autoAcceptVerified: has("--auto-accept-verified"),
      timeoutMs: Number(arg("--timeout-ms", "0")) || 0,
    });
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "inspection.json"), `${JSON.stringify(result.inspection, null, 2)}\n`);
    fs.writeFileSync(path.join(output, "proposals.json"), `${JSON.stringify(result.proposals, null, 2)}\n`);
    fs.writeFileSync(
      path.join(output, "enrichment.json"),
      `${JSON.stringify({ cacheStats: result.cacheStats, autoAcceptVerified: has("--auto-accept-verified") }, null, 2)}\n`
    );
    console.log(
      JSON.stringify(
        {
          stage: "enrich",
          proposals: result.proposals.length,
          autoAccepted: result.proposals.filter((p) => p.autoAccepted).length,
          cacheStats: result.cacheStats,
          written: ["inspection.json", "proposals.json", "enrichment.json"],
        },
        null,
        2
      )
    );
  } catch (err) {
    if (err instanceof EnrichmentError) {
      console.error(err.message);
      for (const d of err.details || []) console.error(`  - ${d}`);
      process.exit(1);
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
