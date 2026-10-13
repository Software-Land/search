/**
 * Refresh corpus provenance fields on the Software.Land OSS fixture manifest.
 *
 * Repo-only. Does not export documents, compile artifacts, remine scenarios,
 * or change ranking. `software-land-scenarios.mjs` owns scenario counts/hashes
 * and must not be used to rewrite searchPackageVersion.
 *
 * `searchPackageVersion` and a `file:` tarball are read from the same source
 * state. A clean requested commit is read entirely from that commit. A dirty
 * worktree is an intentional snapshot of HEAD: both inputs come from the
 * worktree, and the base commit plus changed paths are recorded. Mixing a
 * non-HEAD commit with a dirty worktree is rejected.
 *
 * `uncommittedDiffAlgorithm` names how `uncommittedDiffSha256` was produced.
 * `git-diff-text-v1` is the SHA-256 of `git diff HEAD` text. The captured
 * fixture digest uses that algorithm and must keep its label. New exports
 * write `worktree-bytes-v1`: dirty porcelain status, path, and file bytes,
 * including untracked files, deletions, renames, and binaries. `contentTree`
 * remains the committed `content/blog` tree of the selected commit.
 *
 * Usage:
 *   node scripts/software-land-corpus-manifest.mjs \
 *     --dir test/fixtures/software-land \
 *     --software-land /path/to/software.land \
 *     --corpus-source-commit 971012bf3d561a67ca8a20f03ec2128135d1fb87
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** SHA-256 of `git diff HEAD` text. The captured fixture digest uses this. */
export const GIT_DIFF_TEXT_FINGERPRINT = "git-diff-text-v1";
/** SHA-256 of dirty status, path, and bytes. Newly written manifests use this. */
export const WORKTREE_BYTES_FINGERPRINT = "worktree-bytes-v1";

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

function gitRevParse(repo, rev) {
  return execFileSync("git", ["-C", repo, "rev-parse", rev], { encoding: "utf8" }).trim();
}

function gitShowBuffer(repo, spec) {
  return execFileSync("git", ["-C", repo, "show", spec], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function commitContains(repo, rev, relPath) {
  try {
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${rev}:${relPath}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parsePorcelainZ(buffer) {
  const chunks = buffer.toString("utf8").split("\0");
  if (chunks.length && chunks[chunks.length - 1] === "") chunks.pop();
  const records = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const head = chunks[i];
    if (head.length < 4) continue;
    const xy = head.slice(0, 2);
    const filePath = head.slice(3);
    const renamed = xy.includes("R") || xy.includes("C");
    let oldPath = "";
    if (renamed) {
      i += 1;
      oldPath = chunks[i] || "";
    }
    records.push({ xy, path: filePath, oldPath });
  }
  return records;
}

function worktreeRecords(repo) {
  const raw = execFileSync("git", ["-C", repo, "status", "--porcelain=v1", "-z", "-uall"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parsePorcelainZ(raw).sort(
    (a, b) => a.path.localeCompare(b.path) || a.oldPath.localeCompare(b.oldPath) || a.xy.localeCompare(b.xy)
  );
}

function hashFileBytes(hash, absPath) {
  const buf = readFileSync(absPath);
  hash.update("bytes");
  hash.update("\0");
  hash.update(String(buf.length));
  hash.update("\0");
  hash.update(buf);
  hash.update("\0");
}

/** Historical fingerprint: SHA-256 of `git diff HEAD` text. Untracked bytes are omitted. */
export function gitDiffTextFingerprint(repo) {
  const diff = execFileSync("git", ["-C", repo, "diff", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return createHash("sha256").update(diff).digest("hex");
}

/** Status, path, and bytes of every dirty input. Untracked files and binaries are included. */
export function fingerprintWorktree(repo) {
  const hash = createHash("sha256");
  for (const entry of worktreeRecords(repo)) {
    hash.update(entry.xy);
    hash.update("\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.oldPath);
    hash.update("\0");
    const absPath = path.resolve(repo, entry.path);
    if (!existsSync(absPath)) {
      hash.update("absent");
      hash.update("\0");
      continue;
    }
    hashFileBytes(hash, absPath);
  }
  return hash.digest("hex");
}

function packageVersionFromTarball(bytes) {
  const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const packed = execFileSync("tar", [gzip ? "-xzOf" : "-xOf", "-", "package/package.json"], {
    input: bytes,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const version = JSON.parse(packed).version;
  if (!version) throw new Error("file dependency tarball has no package version");
  return String(version);
}

function dependencyVersion(spec, readBytes) {
  if (!spec.startsWith("file:")) return spec.replace(/^[~^]/, "");
  const rel = spec.slice("file:".length).split(path.sep).join("/");
  return packageVersionFromTarball(readBytes(rel));
}

/**
 * Resolve `@software-land/search` from one source state.
 * A dirty worktree may only be paired with HEAD.
 */
export function readSearchPackageSource(repo, requestedRev = "HEAD") {
  const head = gitRevParse(repo, "HEAD");
  const selected = gitRevParse(repo, requestedRev);
  const records = worktreeRecords(repo);
  const dirty = records.length > 0;
  if (dirty && selected !== head) {
    throw new Error(
      `refusing to read commit ${selected} from a dirty worktree at ${head}; commit both inputs or snapshot HEAD`
    );
  }
  const pkgBytes = dirty
    ? readFileSync(path.join(repo, "package.json"))
    : gitShowBuffer(repo, `${selected}:package.json`);
  const pkg = JSON.parse(pkgBytes.toString("utf8"));
  const raw = pkg?.dependencies?.["@software-land/search"] ?? pkg?.devDependencies?.["@software-land/search"];
  if (!raw) throw new Error("software.land package.json does not declare @software-land/search");
  const spec = String(raw);
  const version = dependencyVersion(spec, (rel) => {
    if (dirty) {
      const abs = path.resolve(repo, rel);
      if (!existsSync(abs)) throw new Error(`dirty worktree is missing file dependency ${rel}`);
      return readFileSync(abs);
    }
    if (!commitContains(repo, selected, rel)) {
      throw new Error(`commit ${selected} does not contain file dependency ${rel}`);
    }
    return gitShowBuffer(repo, `${selected}:${rel}`);
  });
  return {
    spec,
    version,
    commit: selected,
    baseCommit: head,
    dirty,
    inputs: records,
  };
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

function porcelainLines(repo) {
  return execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export function refreshCorpusManifest({ dir, softwareLand, corpusSourceCommit }) {
  const source = readSearchPackageSource(softwareLand, corpusSourceCommit || "HEAD");
  const documents = JSON.parse(readFileSync(path.join(dir, "documents.json"), "utf8"));
  const lemmas = JSON.parse(readFileSync(path.join(dir, "lemmas.json"), "utf8"));
  const concepts = JSON.parse(readFileSync(path.join(dir, "configured-concepts.json"), "utf8"));
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const uncommittedInputs = porcelainLines(softwareLand);

  if (manifest.corpusSourceCommit && manifest.corpusSourceCommit !== source.commit) {
    manifest.previousCorpusSourceCommit = manifest.corpusSourceCommit;
  }
  manifest.corpusSourceCommit = source.commit;
  manifest.corpusWorktreeClean = !source.dirty;
  manifest.uncommittedInputs = uncommittedInputs;
  manifest.contentTree = gitRevParse(softwareLand, `${source.commit}:content/blog`);
  manifest.uncommittedDiffAlgorithm = WORKTREE_BYTES_FINGERPRINT;
  manifest.uncommittedDiffSha256 = fingerprintWorktree(softwareLand);
  manifest.searchPackageDependency = source.spec;
  manifest.searchPackageVersion = source.version;
  manifest.documentCount = Array.isArray(documents) ? documents.length : 0;
  manifest.configuredConceptCount = Array.isArray(concepts) ? concepts.length : 0;
  manifest.lemmaCount = lemmas && typeof lemmas === "object" ? Object.keys(lemmas).length : 0;
  delete manifest.dictionaryAcronymMapSoftwareLandCommit;
  manifest.files = manifest.files || {};
  for (const name of Object.keys(manifest.files)) {
    const filePath = path.join(dir, name);
    if (!existsSync(filePath)) throw new Error(`manifest lists missing fixture file ${name}`);
    manifest.files[name] = sha256Bytes(filePath);
  }
  writeJson(manifestPath, manifest);
  return {
    corpusSourceCommit: source.commit,
    corpusWorktreeClean: manifest.corpusWorktreeClean,
    uncommittedInputs,
    contentTree: manifest.contentTree,
    uncommittedDiffAlgorithm: manifest.uncommittedDiffAlgorithm,
    uncommittedDiffSha256: manifest.uncommittedDiffSha256,
    searchPackageDependency: source.spec,
    searchPackageVersion: source.version,
    documentCount: manifest.documentCount,
    configuredConceptCount: manifest.configuredConceptCount,
    lemmaCount: manifest.lemmaCount,
    previousCorpusSourceCommit: manifest.previousCorpusSourceCommit,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args["software-land"]) {
    console.error(usage());
    process.exit(1);
  }
  const summary = refreshCorpusManifest({
    dir: path.resolve(args.dir),
    softwareLand: path.resolve(args["software-land"]),
    corpusSourceCommit: args["corpus-source-commit"],
  });
  console.log(JSON.stringify(summary, null, 2));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main();
