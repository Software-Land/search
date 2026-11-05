/**
 * Install a freshly packed tarball and run the documented offline commands.
 * The OpenAI call is a local mock. This does not publish the package.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKENIZER_URL = "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken";
const TOKENIZER_NAME = createHash("sha1").update(TOKENIZER_URL).digest("hex");
if (TOKENIZER_NAME !== "9b5ad71b2ce5302211f9c61530b329a4922fc6a4") {
  throw new Error(`tokenizer cache name changed: ${TOKENIZER_NAME}`);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = [
  { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security certificates https encryption" },
  { id: "vpn", title: "What is VPN?", body: "virtual private network tunnels encrypted traffic tls" },
  { id: "noise", title: "About this Blog", body: "welcome to the site navigation footer" },
];

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd || ROOT,
    env: opts.env || process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (opts.allowFailure) return result;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function walkJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) walkJs(file, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(file);
  }
  return out;
}

function startMockServer(logFile) {
  const serverFile = path.join(path.dirname(logFile), "mock-embeddings-server.mjs");
  fs.writeFileSync(serverFile, `import { createServer } from "node:http";
import fs from "node:fs";
const logFile = process.argv[2];
function embeddingFor(text, dimensions) {
  const values = new Array(dimensions).fill(0);
  if (text.includes("TLS")) values[0] = 1;
  else if (text.includes("VPN")) { values[0] = 0.99; values[1] = 0.01; }
  else values[1] = 1;
  return values;
}
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    fs.appendFileSync(logFile, JSON.stringify({ path: req.url, inputs: payload.input.length, dimensions: payload.dimensions }) + "\\n");
    const rows = payload.input.map((text, index) => ({ index, embedding: embeddingFor(text, payload.dimensions) }));
    rows.reverse();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: payload.model, data: rows, usage: { prompt_tokens: 9, total_tokens: 9 } }));
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));
`);
  const child = spawn(process.execPath, [serverFile, logFile], { stdio: ["ignore", "pipe", "inherit"] });
  const port = new Promise((resolve, reject) => {
    let text = "";
    let settled = false;
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
      if (text.trim() && !settled) {
        settled = true;
        resolve(text.trim());
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!settled) reject(new Error(`mock server exited ${code}`));
    });
  });
  return { child, port };
}

function snapshotTree(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      const relative = path.relative(dir, file);
      if (stat.isSymbolicLink()) {
        out.set(relative, `symlink:${fs.readlinkSync(file)}`);
      } else if (stat.isDirectory()) {
        walk(file);
      } else if (stat.isFile()) {
        out.set(relative, createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
      }
    }
  };
  walk(dir);
  return out;
}

function assertSameSnapshot(before, after, label) {
  if (before.size !== after.size) {
    throw new Error(`${label} file count changed from ${before.size} to ${after.size}`);
  }
  for (const [relative, hash] of before) {
    if (after.get(relative) !== hash) throw new Error(`${label} changed: ${relative}`);
  }
}

function lockTree(dir) {
  const modes = [];
  const walk = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) walk(path.join(current, name));
    }
    modes.push([current, stat.mode]);
    fs.chmodSync(current, stat.mode & ~0o222);
  };
  walk(dir);
  return () => {
    for (const [file, mode] of modes.reverse()) {
      try {
        fs.chmodSync(file, mode);
      } catch {
        // Restoration is best-effort so a failed check can still clean up.
      }
    }
  };
}

function downloadCount(logFile) {
  if (!fs.existsSync(logFile)) return 0;
  return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
}

function tokenizerFile(directory) {
  return path.join(directory, TOKENIZER_NAME);
}

const prepareEnv = { ...process.env };
delete prepareEnv.TIKTOKEN_CACHE_DIR;
delete prepareEnv.DATA_GYM_CACHE_DIR;
delete prepareEnv.OPENAI_API_KEY;
run("python3", ["tools/search-semantic/prepare_tokenizer.py"], { cwd: ROOT, env: prepareEnv });
const warmed = path.join(ROOT, "build", "search-semantic", "tokenizers", TOKENIZER_NAME);
if (!fs.existsSync(warmed)) throw new Error(`prepare did not write ${warmed}`);
run("git", ["check-ignore", "-q", "--", warmed], { cwd: ROOT });
const warmedStatus = run("git", ["status", "--porcelain", "--", "build/search-semantic/tokenizers"], { cwd: ROOT });
if (warmedStatus.stdout.trim()) throw new Error(`tokenizer cache is not ignored:\n${warmedStatus.stdout}`);

const packed = run("npm", ["pack", "--json", "--pack-destination", os.tmpdir()]);
const tarball = JSON.parse(packed.stdout).at(-1).filename;
const tarballPath = path.join(os.tmpdir(), tarball);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "search-openai-pack-"));
const consumer = path.join(work, "consumer");
fs.mkdirSync(consumer);
fs.writeFileSync(
  path.join(consumer, "package.json"),
  `${JSON.stringify({ name: "search-openai-pack-consumer", private: true, type: "module" }, null, 2)}\n`
);
run("npm", ["install", "--omit=dev", tarballPath], { cwd: consumer });

const installed = path.join(consumer, "node_modules", "@software-land", "search");
const pkg = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
if (pkg.version !== "0.8.0") throw new Error(`packed version ${pkg.version}`);
for (const relative of [
  "tools/search-semantic/build.py",
  "tools/search-semantic/build.mjs",
  "tools/search-semantic/lib/embedding.py",
  "tools/search-semantic/lib/openai_embeddings.py",
  "tools/search-semantic/requirements-openai.txt",
  "tools/search-semantic/requirements-embed.txt",
]) {
  if (!fs.existsSync(path.join(installed, relative))) throw new Error(`tarball missing ${relative}`);
}
const packedListing = run("tar", ["-tzf", tarballPath]).stdout;
const packedNames = packedListing.split("\n");
if (packedNames.some((line) => (
  line.includes(".tiktoken")
  || line.includes("cl100k_base")
  || line.includes("/.cache/")
  || line.includes("build/search-semantic/tokenizers")
  || line.endsWith(TOKENIZER_NAME)
))) {
  throw new Error("tarball contains tokenizer data or a cache");
}
function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) walkFiles(file, out);
    else out.push(file);
  }
  return out;
}
for (const file of walkFiles(installed)) {
  const relative = path.relative(installed, file);
  if (relative.endsWith(".tiktoken") || relative.includes(`${path.sep}.cache${path.sep}`) || relative.includes("cl100k_base")) {
    throw new Error(`installed package contains tokenizer data or a cache: ${relative}`);
  }
}
for (const file of [...walkJs(path.join(installed, "dist")), ...walkJs(path.join(installed, "dist", "browser"))]) {
  const text = fs.readFileSync(file, "utf8");
  if (
    text.includes("openai") ||
    text.includes("OPENAI_API_KEY") ||
    text.includes("api.openai.com") ||
    text.includes("tiktoken")
  ) {
    throw new Error(`runtime file mentions OpenAI: ${path.relative(installed, file)}`);
  }
}

const packageBefore = snapshotTree(installed);
const restorePackage = lockTree(installed);
process.on("exit", restorePackage);

const corpus = path.join(work, "corpus.json");
fs.writeFileSync(corpus, JSON.stringify({ format: "search-semantic-corpus", version: 1, documents: DOCS }));
const sourceLexical = path.join(work, "source-lexical.json");
const packedLexical = path.join(work, "packed-lexical.json");
run(process.execPath, [
  path.join(ROOT, "tools/search-semantic/build.mjs"),
  "--input", corpus,
  "--output", sourceLexical,
  "--method", "lexical",
  "--representation", "title_lead",
  "--top-k", "2",
  "--min-score", "0.05",
]);
const cli = path.join(installed, "tools/search-semantic/build.mjs");
run(process.execPath, [
  cli,
  "--input", corpus,
  "--output", packedLexical,
  "--method", "lexical",
  "--representation", "title_lead",
  "--top-k", "2",
  "--min-score", "0.05",
], { cwd: consumer });
const sourceArtifact = fs.readFileSync(sourceLexical, "utf8");
if (sourceArtifact !== fs.readFileSync(packedLexical, "utf8")) {
  throw new Error("packed default lexical artifact differs from the source compiler");
}

const probe = path.join(consumer, "probe.mjs");
fs.writeFileSync(probe, `import { compileSemantic, DEFAULT_EMBEDDING_PROVIDER, OPENAI_EMBEDDING_DIMENSIONS, OPENAI_EMBEDDING_MODEL } from "@software-land/search/semantic";
import * as runtime from "@software-land/search";
if (DEFAULT_EMBEDDING_PROVIDER !== "fastembed") throw new Error("default provider changed");
if (OPENAI_EMBEDDING_MODEL !== "text-embedding-3-large") throw new Error("openai model changed");
if (OPENAI_EMBEDDING_DIMENSIONS !== 3072) throw new Error("openai dimensions changed");
if ("compileSemantic" in runtime || "embeddingProvider" in runtime) throw new Error("runtime exports the semantic compiler");
const outputPath = ${JSON.stringify(path.join(work, "probe-lexical.json"))};
const result = await compileSemantic(${JSON.stringify(DOCS)}, {
  method: "lexical",
  representation: "title_lead",
  topK: 2,
  minScore: 0.05,
  outputPath,
});
if (result.artifact.format !== "search-relationships") throw new Error("probe artifact format");
if (JSON.stringify(result.artifact) !== ${JSON.stringify(JSON.stringify(JSON.parse(sourceArtifact)))}) throw new Error("probe artifact drifted");
console.log("probe-ok");
`);
if (fs.readFileSync(probe, "utf8").includes("tools/search-semantic/lib") || fs.readFileSync(probe, "utf8").includes("openai_embeddings")) {
  throw new Error("consumer probe depends on a private semantic module");
}
run(process.execPath, [probe], { cwd: consumer });

const pathCaller = path.join(work, "path-caller");
fs.mkdirSync(pathCaller);
const fakePython = path.join(work, "fake-python.mjs");
const fakeEnvPath = path.join(work, "fake-python-env.json");
fs.writeFileSync(fakePython, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const outputAt = args.indexOf("--output");
if (outputAt !== -1 && args[outputAt + 1]) {
  fs.writeFileSync(args[outputAt + 1], JSON.stringify({ format: "search-relationships", version: 1, relationships: {} }) + "\\n");
}
function present(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : null;
}
fs.writeFileSync(${JSON.stringify(fakeEnvPath)}, JSON.stringify({
  cwd: process.cwd(),
  tiktoken: present("TIKTOKEN_CACHE_DIR"),
  dataGym: present("DATA_GYM_CACHE_DIR"),
}));
`);
fs.chmodSync(fakePython, 0o755);
const cacheProbe = path.join(consumer, "cache-probe.mjs");
fs.writeFileSync(cacheProbe, `import { compileSemantic } from "@software-land/search/semantic";
await compileSemantic([{ id: "a", title: "A", body: "b" }], {
  method: "lexical",
  embeddingProvider: "openai",
  pythonPath: ${JSON.stringify(fakePython)},
  outputPath: process.argv[2],
});
`);
const installedSemantic = path.join(installed, "tools", "search-semantic");
function probeCache(caller, env, label) {
  const childEnv = { ...process.env, ...env };
  if (!Object.prototype.hasOwnProperty.call(env, "TIKTOKEN_CACHE_DIR")) delete childEnv.TIKTOKEN_CACHE_DIR;
  if (!Object.prototype.hasOwnProperty.call(env, "DATA_GYM_CACHE_DIR")) delete childEnv.DATA_GYM_CACHE_DIR;
  run(process.execPath, [cacheProbe, path.join(work, `${label}.json`)], { cwd: caller, env: childEnv });
  return JSON.parse(fs.readFileSync(fakeEnvPath, "utf8"));
}
let child = probeCache(pathCaller, {}, "default-path");
if (child.cwd !== installedSemantic) throw new Error(`python cwd ${child.cwd} is not the installed package`);
if (child.tiktoken !== path.join(pathCaller, "build", "search-semantic", "tokenizers")) {
  throw new Error(`default tokenizer cache resolved to ${child.tiktoken}`);
}
if (child.tiktoken.startsWith(installed)) throw new Error("default cache is inside the installed package");
if (fs.existsSync(child.tiktoken)) throw new Error("path probe created tokenizer storage");
child = probeCache(pathCaller, { TIKTOKEN_CACHE_DIR: "rel/tokens", DATA_GYM_CACHE_DIR: path.join(work, "unused-absolute") }, "relative-path");
if (child.tiktoken !== path.resolve(pathCaller, "rel/tokens")) throw new Error(`relative override resolved to ${child.tiktoken}`);
if (child.tiktoken.startsWith(installedSemantic)) throw new Error("relative override resolved inside the package");
const absoluteCache = path.join(work, "absolute-cache");
child = probeCache(pathCaller, { TIKTOKEN_CACHE_DIR: absoluteCache, DATA_GYM_CACHE_DIR: "ignored-gym" }, "absolute-path");
if (child.tiktoken !== absoluteCache) throw new Error(`absolute override resolved to ${child.tiktoken}`);
child = probeCache(pathCaller, { DATA_GYM_CACHE_DIR: "gym-rel" }, "gym-path");
if (child.tiktoken !== null || child.dataGym !== path.resolve(pathCaller, "gym-rel")) {
  throw new Error(`DATA_GYM precedence failed: ${JSON.stringify(child)}`);
}
child = probeCache(pathCaller, { TIKTOKEN_CACHE_DIR: "", DATA_GYM_CACHE_DIR: absoluteCache }, "empty-tiktoken");
if (child.tiktoken !== "") throw new Error(`empty TIKTOKEN_CACHE_DIR became ${JSON.stringify(child.tiktoken)}`);
child = probeCache(pathCaller, { DATA_GYM_CACHE_DIR: "" }, "empty-gym");
if (child.tiktoken !== null || child.dataGym !== "") throw new Error(`empty DATA_GYM_CACHE_DIR fell through: ${JSON.stringify(child)}`);
child = probeCache(consumer, {}, "consumer-default");
if (child.tiktoken !== path.join(consumer, "build", "search-semantic", "tokenizers")) {
  throw new Error(`consumer default cache resolved to ${child.tiktoken}`);
}
if (fs.existsSync(path.join(pathCaller, "build")) || fs.existsSync(path.join(consumer, "build"))) {
  throw new Error("tokenizer path probes created a build directory");
}

const requestLog = path.join(work, "requests.jsonl");
const downloadLog = path.join(work, "tokenizer-downloads.log");
fs.writeFileSync(requestLog, "");
fs.writeFileSync(downloadLog, "");
const blockDir = path.join(work, "tokenizer-block");
fs.mkdirSync(blockDir);
fs.writeFileSync(path.join(blockDir, "sitecustomize.py"), `import os
import urllib.request
def urlopen(request, timeout=None, *args, **kwargs):
    url = getattr(request, "full_url", str(request))
    if "cl100k_base.tiktoken" not in url:
        raise OSError("unexpected urlopen %s" % url)
    with open(os.environ["TOKENIZER_DOWNLOAD_LOG"], "a", encoding="utf-8") as handle:
        handle.write(url + "\\n")
    data = open(os.environ["TOKENIZER_FIXTURE"], "rb").read()
    class Response:
        def read(self):
            return data
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
    return Response()
urllib.request.urlopen = urlopen
`);
function pythonEnv(overrides = {}) {
  const env = {
    ...process.env,
    OPENAI_API_KEY: "sk-pack-test",
    PYTHONPATH: `${blockDir}${path.delimiter}${process.env.PYTHONPATH || ""}`,
    TOKENIZER_FIXTURE: warmed,
    TOKENIZER_DOWNLOAD_LOG: downloadLog,
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "OPENAI_API_BASE")) delete env.OPENAI_API_BASE;
  if (!Object.prototype.hasOwnProperty.call(overrides, "TIKTOKEN_CACHE_DIR")) delete env.TIKTOKEN_CACHE_DIR;
  if (!Object.prototype.hasOwnProperty.call(overrides, "DATA_GYM_CACHE_DIR")) delete env.DATA_GYM_CACHE_DIR;
  return env;
}
const mock = startMockServer(requestLog);
process.on("exit", () => {
  try {
    mock.child.kill();
  } catch {
    // The server has already exited.
  }
});
const port = await mock.port;
const apiBase = `http://127.0.0.1:${port}/v1`;
const kept = path.join(work, "kept.json");
fs.writeFileSync(kept, "KEEP\n");
const denied = run(process.execPath, [
  cli,
  "--input", corpus,
  "--output", kept,
  "--method", "embedding",
  "--embedding-provider", "openai",
  "--model", "text-embedding-3-large",
  "--dimensions", "3072",
  "--cache-dir", path.join(work, "unused-cache"),
  "--venv-dir", path.join(work, "venv"),
], {
  cwd: consumer,
  allowFailure: true,
  env: pythonEnv({ OPENAI_API_KEY: "", OPENAI_API_BASE: apiBase }),
});
if (denied.status === 0) throw new Error("missing OpenAI credentials succeeded");
if (fs.readFileSync(kept, "utf8") !== "KEEP\n") throw new Error("failed OpenAI build replaced the existing artifact");
if (fs.readFileSync(requestLog, "utf8").trim()) throw new Error("missing credentials called the API");
if (downloadCount(downloadLog) !== 0) throw new Error("missing credentials downloaded tokenizer ranks");

const graph = path.join(work, "openai.json");
const report = path.join(work, "openai-report.json");
const cacheDir = path.join(work, "openai-cache");
const venvDir = path.join(work, "venv");
const openaiArgs = [
  cli,
  "--input", corpus,
  "--output", graph,
  "--report", report,
  "--method", "embedding",
  "--representation", "title",
  "--embedding-provider", "openai",
  "--model", "text-embedding-3-large",
  "--dimensions", "3072",
  "--top-k", "1",
  "--min-score", "0.5",
  "--cache-dir", cacheDir,
  "--venv-dir", venvDir,
  "--openai-api-base", apiBase,
];
const env = pythonEnv();
run(process.execPath, openaiArgs, { cwd: consumer, env });
const consumerTokenizer = tokenizerFile(path.join(consumer, "build", "search-semantic", "tokenizers"));
if (!fs.existsSync(consumerTokenizer)) throw new Error(`tokenizer was not acquired at ${consumerTokenizer}`);
if (!fs.readFileSync(consumerTokenizer).equals(fs.readFileSync(warmed))) {
  throw new Error("acquired tokenizer bytes do not match the verified fixture");
}
if (downloadCount(downloadLog) !== 1) throw new Error(`expected one mocked tokenizer download, saw ${downloadCount(downloadLog)}`);
const tokenizerStat = fs.statSync(consumerTokenizer);
run(process.execPath, openaiArgs, { cwd: consumer, env });
if (downloadCount(downloadLog) !== 1) throw new Error("cached embedding vectors downloaded the tokenizer again");
const tokenizerAfterReuse = fs.statSync(consumerTokenizer);
if (tokenizerAfterReuse.mtimeMs !== tokenizerStat.mtimeMs || tokenizerAfterReuse.ino !== tokenizerStat.ino) {
  throw new Error("tokenizer cache did not survive compilation cleanup");
}
if (walkFiles(cacheDir).some((file) => path.basename(file) === TOKENIZER_NAME || file.endsWith(".tiktoken"))) {
  throw new Error("tokenizer data was written into the embedding-vector cache");
}
if (walkFiles(installed).some((file) => path.basename(file) === TOKENIZER_NAME || file.includes(`${path.sep}tokenizers${path.sep}`))) {
  throw new Error("tokenizer data was written inside the installed package");
}

const artifact = JSON.parse(fs.readFileSync(graph, "utf8"));
const generated = JSON.parse(fs.readFileSync(report, "utf8"));
if (artifact.format !== "search-relationships" || artifact.vectors || artifact.embeddings) {
  throw new Error("OpenAI artifact is not a relationship graph");
}
const targets = new Set((artifact.relationships.tls || []).map((edge) => edge.target));
if (!targets.has("vpn") || targets.has("noise")) throw new Error(`unexpected tls neighbors: ${[...targets].join(",")}`);
if (JSON.stringify(artifact).includes("sk-pack-test") || JSON.stringify(generated).includes("sk-pack-test")) {
  throw new Error("credential was written to an artifact or report");
}
if (generated.embedding?.provider !== "openai") throw new Error("report did not record the OpenAI provider");
if (generated.embedding?.dimensionality !== 3072) throw new Error("report dimensions");
if (generated.embedding?.cacheHits !== 3 || generated.embedding?.apiCalls !== 0) {
  throw new Error(`second run did not reuse the cache: ${JSON.stringify(generated.embedding)}`);
}
const requests = fs.readFileSync(requestLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
if (requests.length !== 1 || requests[0].inputs !== 3 || requests[0].dimensions !== 3072 || requests[0].path !== "/v1/embeddings") {
  throw new Error(`unexpected API calls: ${JSON.stringify(requests)}`);
}

function runInstalledOpenAI(cwd, cacheName, outputName, overrides) {
  const output = path.join(work, outputName);
  const cache = path.join(work, cacheName);
  const before = downloadCount(downloadLog);
  run(process.execPath, [
    cli,
    "--input", corpus,
    "--output", output,
    "--method", "embedding",
    "--representation", "title",
    "--embedding-provider", "openai",
    "--model", "text-embedding-3-large",
    "--dimensions", "3072",
    "--top-k", "1",
    "--min-score", "0.5",
    "--cache-dir", cache,
    "--venv-dir", venvDir,
    "--openai-api-base", apiBase,
  ], { cwd, env: pythonEnv(overrides) });
  return { before, downloads: downloadCount(downloadLog), cache };
}

const relativeRun = runInstalledOpenAI(consumer, "rel-vectors", "rel.json", { TIKTOKEN_CACHE_DIR: "rel-tokens" });
const relativeTokenizer = path.join(consumer, "rel-tokens", TOKENIZER_NAME);
if (!fs.existsSync(relativeTokenizer)) throw new Error(`relative override did not acquire ${relativeTokenizer}`);
if (relativeRun.downloads !== relativeRun.before + 1) throw new Error("relative override did not download into its own cache");
if (fs.existsSync(path.join(installedSemantic, "rel-tokens"))) throw new Error("relative override wrote inside the package");
if (walkFiles(relativeRun.cache).some((file) => path.basename(file) === TOKENIZER_NAME)) {
  throw new Error("relative override stored the tokenizer in the vector cache");
}

const absoluteDir = path.join(work, "abs-tokens");
const absoluteRun = runInstalledOpenAI(pathCaller, "abs-vectors", "abs.json", { TIKTOKEN_CACHE_DIR: absoluteDir });
if (!fs.existsSync(tokenizerFile(absoluteDir))) throw new Error("absolute override was not used");
if (absoluteRun.downloads !== absoluteRun.before + 1) throw new Error("absolute override did not acquire tokenizer data");
if (absoluteDir.startsWith(installed)) throw new Error("absolute cache is inside the package");

const precedenceDir = path.join(consumer, "prec-tokens");
const gymDir = path.join(work, "gym-tokens");
fs.mkdirSync(precedenceDir);
fs.mkdirSync(gymDir);
fs.copyFileSync(warmed, tokenizerFile(precedenceDir));
fs.writeFileSync(tokenizerFile(gymDir), Buffer.from("other-cache"));
const precedenceRun = runInstalledOpenAI(consumer, "prec-vectors", "prec.json", {
  TIKTOKEN_CACHE_DIR: "prec-tokens",
  DATA_GYM_CACHE_DIR: gymDir,
});
if (precedenceRun.downloads !== precedenceRun.before) throw new Error("seeded TIKTOKEN_CACHE_DIR downloaded ranks");
if (fs.readFileSync(tokenizerFile(gymDir)).toString() !== "other-cache") {
  throw new Error("DATA_GYM_CACHE_DIR was used ahead of TIKTOKEN_CACHE_DIR");
}

const preserved = fs.statSync(consumerTokenizer);
const emptyRun = runInstalledOpenAI(consumer, "empty-vectors", "empty.json", {
  TIKTOKEN_CACHE_DIR: "",
  DATA_GYM_CACHE_DIR: gymDir,
});
if (emptyRun.downloads !== emptyRun.before + 1) throw new Error("disabled tokenizer cache skipped the download");
if (fs.statSync(consumerTokenizer).ino !== preserved.ino) throw new Error("empty override rewrote the project tokenizer cache");
if (fs.readFileSync(tokenizerFile(gymDir)).toString() !== "other-cache") {
  throw new Error("empty TIKTOKEN_CACHE_DIR fell through to DATA_GYM_CACHE_DIR");
}

const altCaller = path.join(work, "alt-caller");
fs.mkdirSync(altCaller);
const consumerInode = fs.statSync(consumerTokenizer).ino;
const altRun = runInstalledOpenAI(altCaller, "alt-vectors", "alt.json", {});
const altTokenizer = tokenizerFile(path.join(altCaller, "build", "search-semantic", "tokenizers"));
if (!fs.existsSync(altTokenizer)) throw new Error(`caller directory did not acquire ${altTokenizer}`);
if (altRun.downloads !== altRun.before + 1) throw new Error("alternate caller reused another project's tokenizer download");
if (altTokenizer.startsWith(installed)) throw new Error("alternate caller wrote inside the installed package");
if (fs.statSync(consumerTokenizer).ino !== consumerInode) throw new Error("alternate caller rewrote the consumer tokenizer cache");
if (fs.existsSync(path.join(installedSemantic, "build"))) throw new Error("installed package gained a build directory");

assertSameSnapshot(packageBefore, snapshotTree(installed), "installed package");
mock.child.kill();
restorePackage();
fs.rmSync(tarballPath, { force: true });
console.log(JSON.stringify({
  ok: true,
  version: pkg.version,
  lexicalBytes: sourceArtifact.length,
  openaiEdges: Object.values(artifact.relationships).reduce((sum, edges) => sum + edges.length, 0),
  apiCalls: requests.length,
  cacheHits: generated.embedding.cacheHits,
}, null, 2));
