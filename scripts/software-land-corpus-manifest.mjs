/**
 * Refresh corpus provenance fields on the Software.Land OSS fixture manifest.
 *
 * Repo-only. Does not export documents, compile artifacts, remine scenarios,
 * or change ranking. `software-land-scenarios.mjs` owns scenario counts/hashes
 * and must not be used to rewrite searchPackageVersion.
 *
 * `searchPackageVersion` is the `@software-land/search` dependency declared by
 * the Software.Land tree at `corpusSourceCommit`. It is not the OSS package
 * version running tests, and it is not `relevance-config.json`'s overlay pin.
 *
 * Usage:
 *   node scripts/software-land-corpus-manifest.mjs \
 *     --dir test/fixtures/software-land \
 *     --software-land /path/to/software.land \
 *     --corpus-source-commit 971012bf3d561a67ca8a20f03ec2128135d1fb87
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CORPUS_HASH_FILES = [
  "documents.json",
  "configured-concepts.json",
  "lemmas.json",
  "relationships.json",
  "lexical-frequency.json",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function usage() {
  return `Usage:
  node scripts/software-land-corpus-manifest.mjs \\
    --dir test/fixtures/software-land \\
    --software-land /path/to/software.land \\
    [--corpus-source-commit <sha>]`;
}

function gitShow(repo, spec) {
  return execFileSync("git", ["-C", repo, "show", spec], { encoding: "utf8" });
}

function gitRevParse(repo, rev) {
  return execFileSync("git", ["-C", repo, "rev-parse", rev], { encoding: "utf8" }).trim();
}

function declaredSearchPackageVersion(pkg) {
  const raw = pkg?.dependencies?.["@software-land/search"] ?? pkg?.devDependencies?.["@software-land/search"];
  if (!raw) throw new Error("software.land package.json does not declare @software-land/search");
  return String(raw).replace(/^[~^]/, "");
}

function sha256Bytes(filePath) {
  const buf = readFileSync(filePath);
  return {
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.dir || !args["software-land"]) {
  console.error(usage());
  process.exit(1);
}

const dir = path.resolve(args.dir);
const softwareLand = path.resolve(args["software-land"]);
const corpusSourceCommit = gitRevParse(
  softwareLand,
  args["corpus-source-commit"] || "HEAD"
);
const pkg = JSON.parse(gitShow(softwareLand, `${corpusSourceCommit}:package.json`));
const searchPackageVersion = declaredSearchPackageVersion(pkg);
const documents = JSON.parse(readFileSync(path.join(dir, "documents.json"), "utf8"));
const lemmas = JSON.parse(readFileSync(path.join(dir, "lemmas.json"), "utf8"));
const manifestPath = path.join(dir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

manifest.corpusSourceCommit = corpusSourceCommit;
manifest.searchPackageVersion = searchPackageVersion;
manifest.documentCount = Array.isArray(documents) ? documents.length : 0;
manifest.lemmaCount = lemmas && typeof lemmas === "object" ? Object.keys(lemmas).length : 0;
manifest.files = manifest.files || {};
for (const name of CORPUS_HASH_FILES) {
  manifest.files[name] = sha256Bytes(path.join(dir, name));
}
writeJson(manifestPath, manifest);

console.log(
  JSON.stringify(
    {
      corpusSourceCommit,
      searchPackageVersion,
      documentCount: manifest.documentCount,
      lemmaCount: manifest.lemmaCount,
    },
    null,
    2
  )
);
