/**
 * Embedding provider values are validated before any Python or network work.
 * The local fake interpreter records invocation and never contacts a provider.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileSemantic, ensureSemanticEnvironment, SEMANTIC_ROOT } from "../tools/search-semantic/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../tools/search-semantic/build.mjs");
const DOCS = [
  { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security certificates" },
  { id: "vpn", title: "What is VPN?", body: "virtual private network tunnels" },
];

function writeFakePython(dir) {
  const marker = path.join(dir, "invoked.txt");
  const bin = path.join(dir, "python");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
const marker = ${JSON.stringify(marker)};
const args = process.argv.slice(2);
fs.appendFileSync(marker, args.join(" ") + "\\n");
const outputAt = args.indexOf("--output");
if (outputAt !== -1 && args[outputAt + 1] && !args[outputAt + 1].startsWith("-")) {
  fs.writeFileSync(args[outputAt + 1], JSON.stringify({ format: "search-relationships", version: 1, relationships: {} }) + "\\n");
}
`
  );
  fs.chmodSync(bin, 0o755);
  return { bin, marker };
}

function trackMkdtemp() {
  const orig = fs.mkdtempSync;
  const dirs = [];
  fs.mkdtempSync = (...args) => {
    const dir = orig.apply(fs, args);
    dirs.push(dir);
    return dir;
  };
  return {
    dirs,
    restore() {
      fs.mkdtempSync = orig;
    },
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
  });
}

describe("embedding provider validation", () => {
  let dir;
  let fake;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-provider-"));
    fake = writeFakePython(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("omitted and accepted providers stay on their documented branches without a live embedding call", async () => {
    const omittedOutput = path.join(dir, "omitted.json");
    const fastOutput = path.join(dir, "fast.json");
    const openaiOutput = path.join(dir, "openai.json");
    await compileSemantic(DOCS, { method: "lexical", pythonPath: fake.bin, outputPath: omittedOutput });
    await compileSemantic(DOCS, {
      method: "lexical",
      embeddingProvider: "fastembed",
      pythonPath: fake.bin,
      outputPath: fastOutput,
    });
    await compileSemantic(DOCS, {
      method: "lexical",
      embeddingProvider: "openai",
      pythonPath: fake.bin,
      outputPath: openaiOutput,
    });
    const invoked = fs.readFileSync(fake.marker, "utf8");
    const lines = invoked.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toContain("--embedding-provider");
    expect(lines[0]).toContain("sentence-transformers/all-MiniLM-L6-v2");
    expect(lines[1]).not.toContain("--embedding-provider");
    expect(lines[1]).toContain("sentence-transformers/all-MiniLM-L6-v2");
    expect(lines[2]).toContain("--embedding-provider openai");
    expect(lines[2]).not.toContain("all-MiniLM-L6-v2");
    const lexical = await ensureSemanticEnvironment({
      method: "lexical",
      embeddingProvider: "openai",
      pythonPath: fake.bin,
    });
    expect(lexical.venvDir).toBeNull();
    expect(fs.readFileSync(fake.marker, "utf8").trim().split("\n")).toHaveLength(3);
  });

  test("invalid providers fail before Python discovery, setup, or builder execution", async () => {
    const outputPath = path.join(dir, "kept.json");
    fs.writeFileSync(outputPath, "KEEP\n");
    const mk = trackMkdtemp();
    const venvDir = path.join(dir, "venv");
    try {
      await expect(
        compileSemantic(DOCS, {
          method: "embedding",
          embeddingProvider: "opneai",
          pythonPath: fake.bin,
          venvDir,
          outputPath,
        })
      ).rejects.toThrow(/Unsupported embedding provider "opneai"[\s\S]*fastembed[\s\S]*openai/);
      await expect(
        ensureSemanticEnvironment({
          method: "embedding",
          embeddingProvider: "opneai",
          pythonPath: fake.bin,
          venvDir,
        })
      ).rejects.toThrow(/fastembed/);
      await expect(
        compileSemantic(DOCS, { method: "lexical", embeddingProvider: "OpenAI", pythonPath: fake.bin, outputPath })
      ).rejects.toThrow(/Supported values: fastembed, openai/);
      await expect(
        compileSemantic(DOCS, { method: "lexical", embeddingProvider: "", pythonPath: fake.bin, outputPath })
      ).rejects.toThrow(/Supported values: fastembed, openai/);
      expect(fs.existsSync(fake.marker)).toBe(false);
      expect(fs.existsSync(venvDir)).toBe(false);
      expect(mk.dirs).toEqual([]);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("KEEP\n");
    } finally {
      mk.restore();
    }
  });

  test("the Node CLI rejects missing and invalid provider values and leaves an existing artifact", () => {
    const input = path.join(dir, "corpus.json");
    const output = path.join(dir, "kept.json");
    fs.writeFileSync(input, JSON.stringify(DOCS));
    fs.writeFileSync(output, "KEEP\n");
    const common = ["--input", input, "--output", output, "--method", "lexical", "--python", fake.bin];

    const invalid = runCli([...common, "--embedding-provider", "opneai"]);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toMatch(/opneai/);
    expect(invalid.stderr).toMatch(/fastembed/);
    expect(invalid.stderr).toMatch(/openai/);
    expect(fs.readFileSync(output, "utf8")).toBe("KEEP\n");

    const missing = runCli([...common, "--embedding-provider"]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/Missing value for --embedding-provider/);
    expect(missing.stderr).toMatch(/fastembed/);
    expect(missing.stderr).toMatch(/openai/);

    const nextFlag = runCli(["--embedding-provider", "--method", "lexical", ...common]);
    expect(nextFlag.status).not.toBe(0);
    expect(nextFlag.stderr).toMatch(/Missing value for --embedding-provider/);

    expect(fs.existsSync(fake.marker)).toBe(false);
    expect(fs.readFileSync(output, "utf8")).toBe("KEEP\n");

    const accepted = path.join(dir, "accepted.json");
    const openai = runCli([
      "--input",
      input,
      "--output",
      accepted,
      "--method",
      "lexical",
      "--python",
      fake.bin,
      "--embedding-provider",
      "openai",
    ]);
    expect(openai.status).toBe(0);
    expect(fs.readFileSync(fake.marker, "utf8")).toContain("--embedding-provider openai");
    const fast = runCli([
      "--input",
      input,
      "--output",
      path.join(dir, "fast.json"),
      "--method",
      "lexical",
      "--python",
      fake.bin,
      "--embedding-provider",
      "fastembed",
    ]);
    expect(fast.status).toBe(0);
    const omitted = runCli([
      "--input",
      input,
      "--output",
      path.join(dir, "omitted.json"),
      "--method",
      "lexical",
      "--python",
      fake.bin,
    ]);
    expect(omitted.status).toBe(0);
    const lines = fs.readFileSync(fake.marker, "utf8").trim().split("\n");
    expect(lines[1]).not.toContain("--embedding-provider");
    expect(lines[2]).not.toContain("--embedding-provider");
  });

  test("the Node wrapper forwards Ada without inventing dimensions", async () => {
    const input = path.join(dir, "corpus.json");
    fs.writeFileSync(input, JSON.stringify(DOCS));
    const omitted = path.join(dir, "ada-omitted.json");
    const explicit = path.join(dir, "ada-explicit.json");
    await compileSemantic(input, {
      method: "lexical",
      embeddingProvider: "openai",
      model: "text-embedding-ada-002",
      pythonPath: fake.bin,
      outputPath: omitted,
    });
    await compileSemantic(input, {
      method: "lexical",
      embeddingProvider: "openai",
      model: "text-embedding-ada-002",
      dimensions: 1536,
      pythonPath: fake.bin,
      outputPath: explicit,
    });
    const lines = fs.readFileSync(fake.marker, "utf8").trim().split("\n");
    expect(lines[0]).toContain("--model text-embedding-ada-002");
    expect(lines[0]).not.toContain("--dimensions");
    expect(lines[1]).toContain("--model text-embedding-ada-002");
    expect(lines[1]).toContain("--dimensions 1536");
  });
});

function writeEnvPython(dir) {
  const marker = path.join(dir, "child-env.json");
  const bin = path.join(dir, "python");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const outputAt = args.indexOf("--output");
if (outputAt !== -1 && args[outputAt + 1] && !args[outputAt + 1].startsWith("-")) {
  fs.writeFileSync(args[outputAt + 1], JSON.stringify({ format: "search-relationships", version: 1, relationships: {} }) + "\\n");
}
function present(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : null;
}
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  cwd: process.cwd(),
  tiktoken: present("TIKTOKEN_CACHE_DIR"),
  dataGym: present("DATA_GYM_CACHE_DIR"),
}));
`
  );
  fs.chmodSync(bin, 0o755);
  return { bin, marker };
}

describe("tokenizer cache path forwarding", () => {
  let dir;
  let fake;
  let previousCwd;
  let savedEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-tokenizer-cache-"));
    fake = writeEnvPython(dir);
    previousCwd = process.cwd();
    savedEnv = {
      TIKTOKEN_CACHE_DIR: process.env.TIKTOKEN_CACHE_DIR,
      DATA_GYM_CACHE_DIR: process.env.DATA_GYM_CACHE_DIR,
    };
    delete process.env.TIKTOKEN_CACHE_DIR;
    delete process.env.DATA_GYM_CACHE_DIR;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function recorded() {
    return JSON.parse(fs.readFileSync(fake.marker, "utf8"));
  }

  async function compile(outputName) {
    await compileSemantic(DOCS, {
      method: "lexical",
      embeddingProvider: "openai",
      pythonPath: fake.bin,
      outputPath: path.join(dir, outputName),
    });
    return recorded();
  }

  test("openai uses the caller directory captured before async setup", async () => {
    const caller = fs.mkdtempSync(path.join(dir, "caller-"));
    const elsewhere = fs.mkdtempSync(path.join(dir, "elsewhere-"));
    const mk = trackMkdtemp();
    process.chdir(caller);
    try {
      const pending = compileSemantic(DOCS, {
        method: "lexical",
        embeddingProvider: "openai",
        pythonPath: fake.bin,
        outputPath: path.join(dir, "out.json"),
      });
      process.chdir(elsewhere);
      await pending;
      const child = recorded();
      const cache = path.join(caller, "build", "search-semantic", "tokenizers");
      expect(process.cwd()).toBe(elsewhere);
      expect(process.env.TIKTOKEN_CACHE_DIR).toBeUndefined();
      expect(process.env.DATA_GYM_CACHE_DIR).toBeUndefined();
      expect(child.cwd).toBe(SEMANTIC_ROOT);
      expect(child.tiktoken).toBe(cache);
      expect(child.tiktoken.startsWith(SEMANTIC_ROOT)).toBe(false);
      expect(fs.existsSync(cache)).toBe(false);
      for (const created of mk.dirs) {
        expect(child.tiktoken.startsWith(created)).toBe(false);
      }
    } finally {
      mk.restore();
    }
  });

  test("relative, absolute, empty, and data-gym overrides keep their precedence", async () => {
    const caller = fs.mkdtempSync(path.join(dir, "caller-"));
    const absolute = path.join(dir, "absolute-cache");
    process.chdir(caller);

    process.env.TIKTOKEN_CACHE_DIR = "rel/tokens";
    process.env.DATA_GYM_CACHE_DIR = absolute;
    let child = await compile("rel.json");
    expect(child.tiktoken).toBe(path.resolve(caller, "rel/tokens"));
    expect(child.dataGym).toBe(absolute);
    expect(process.env.TIKTOKEN_CACHE_DIR).toBe("rel/tokens");

    delete process.env.TIKTOKEN_CACHE_DIR;
    process.env.DATA_GYM_CACHE_DIR = "gym-rel";
    child = await compile("gym.json");
    expect(child.tiktoken).toBeNull();
    expect(child.dataGym).toBe(path.resolve(caller, "gym-rel"));

    const elsewhere = path.join(dir, "elsewhere-dir");
    fs.mkdirSync(elsewhere);
    process.env.TIKTOKEN_CACHE_DIR = absolute;
    process.chdir(elsewhere);
    child = await compile("abs.json");
    expect(child.tiktoken).toBe(absolute);

    process.chdir(caller);
    process.env.TIKTOKEN_CACHE_DIR = "";
    process.env.DATA_GYM_CACHE_DIR = absolute;
    child = await compile("empty.json");
    expect(child.tiktoken).toBe("");
    expect(child.dataGym).toBe(absolute);
    expect(fs.existsSync(path.join(caller, "build", "search-semantic", "tokenizers"))).toBe(false);

    delete process.env.TIKTOKEN_CACHE_DIR;
    process.env.DATA_GYM_CACHE_DIR = "";
    child = await compile("empty-gym.json");
    expect(child.tiktoken).toBeNull();
    expect(child.dataGym).toBe("");
  });

  test("fastembed and lexical builds do not select a tokenizer cache", async () => {
    const caller = fs.mkdtempSync(path.join(dir, "caller-"));
    process.chdir(caller);
    await compileSemantic(DOCS, {
      method: "lexical",
      pythonPath: fake.bin,
      outputPath: path.join(dir, "lexical.json"),
    });
    expect(recorded().tiktoken).toBeNull();
    expect(recorded().dataGym).toBeNull();
    await compileSemantic(DOCS, {
      method: "lexical",
      embeddingProvider: "fastembed",
      pythonPath: fake.bin,
      outputPath: path.join(dir, "fast.json"),
    });
    expect(recorded().tiktoken).toBeNull();
    expect(fs.existsSync(path.join(caller, "build"))).toBe(false);
  });

  test("the CLI resolves overrides from its own working directory", () => {
    const caller = fs.mkdtempSync(path.join(dir, "cli-caller-"));
    const input = path.join(dir, "corpus.json");
    fs.writeFileSync(input, JSON.stringify(DOCS));
    const env = { ...process.env };
    delete env.TIKTOKEN_CACHE_DIR;
    delete env.DATA_GYM_CACHE_DIR;
    env.TIKTOKEN_CACHE_DIR = "cli-rel";
    const result = spawnSync(process.execPath, [
      CLI,
      "--input",
      input,
      "--output",
      path.join(dir, "cli.json"),
      "--method",
      "lexical",
      "--python",
      fake.bin,
      "--embedding-provider",
      "openai",
    ], { cwd: caller, env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(recorded().cwd).toBe(SEMANTIC_ROOT);
    expect(recorded().tiktoken).toBe(path.resolve(caller, "cli-rel"));
    expect(recorded().tiktoken.startsWith(SEMANTIC_ROOT)).toBe(false);
    expect(process.cwd()).toBe(previousCwd);
  });
});
