/**
 * Node launcher for the optional Python semantic compiler.
 * Search Core and the browser Worker never import this module.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SEMANTIC_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SEMANTIC_BUILDER = path.join(SEMANTIC_ROOT, "build.py");
export const SEMANTIC_REQUIREMENTS = path.join(SEMANTIC_ROOT, "requirements.txt");
export const SEMANTIC_REQUIREMENTS_EMBED = path.join(SEMANTIC_ROOT, "requirements-embed.txt");

export const DEFAULT_METHOD = "combined";
export const DEFAULT_REPRESENTATION = "title_struct";
export const DEFAULT_TOP_K = 5;
export const DEFAULT_MIN_SCORE = 0.3;
export const DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2";

/** @typedef {"lexical" | "embedding" | "combined"} SemanticMethod */

/**
 * @typedef {object} EnsureSemanticEnvironmentOptions
 * @property {SemanticMethod} [method]
 * @property {string} [pythonPath]
 * @property {string} [venvDir]
 */

/**
 * @typedef {object} CompileSemanticOptions
 * @property {SemanticMethod} [method]
 * @property {string} [representation]
 * @property {number} [topK]
 * @property {number} [minScore]
 * @property {number} [lexicalMinScore]
 * @property {number} [embeddingMinScore]
 * @property {string} [model]
 * @property {string} [pythonPath]
 * @property {string} [venvDir]
 * @property {string} [cacheDir]
 * @property {string} [outputPath]
 * @property {string} [reportPath]
 * @property {boolean} [precisionGate]
 * @property {boolean} [mutual]
 */

/**
 * @typedef {object} CompileSemanticResult
 * @property {Record<string, unknown>} artifact
 * @property {Record<string, unknown> | null} report
 * @property {string} outputPath
 * @property {string} stdout
 */

export function semanticRoot() {
  return SEMANTIC_ROOT;
}

export function semanticBuilderPath() {
  return SEMANTIC_BUILDER;
}

/** @param {SemanticMethod} method */
function needsEmbedExtras(method) {
  return method === "embedding" || method === "combined";
}

/** @param {string} venvDir */
function venvPython(venvDir) {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, inheritStderr?: boolean }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd || SEMANTIC_ROOT,
      env: opts.env || process.env,
      stdio: ["ignore", "pipe", opts.inheritStderr ? "inherit" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited ${code}${stderr ? `\n${stderr}` : ""}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function findPython(explicitPath) {
  if (explicitPath) return explicitPath;
  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      await run(cmd, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"]);
      return cmd;
    } catch {
      continue;
    }
  }
  throw new Error("Python 3.10+ is required to run @software-land/search/semantic");
}

/**
 * @param {EnsureSemanticEnvironmentOptions} [opts]
 */
export async function ensureSemanticEnvironment(opts = {}) {
  const method = opts.method || DEFAULT_METHOD;
  const basePython = await findPython(opts.pythonPath);
  if (!needsEmbedExtras(method)) {
    return { python: basePython, venvDir: null };
  }
  const venvDir = opts.venvDir || path.join(os.tmpdir(), "software-land-search-semantic-venv");
  const python = venvPython(venvDir);
  const marker = path.join(venvDir, ".requirements-embed.sha256");
  const reqHash = createHash("sha256").update(fs.readFileSync(SEMANTIC_REQUIREMENTS_EMBED)).digest("hex");
  const ready = fs.existsSync(python) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === reqHash;
  if (!ready) {
    fs.mkdirSync(venvDir, { recursive: true });
    await run(basePython, ["-m", "venv", venvDir], { inheritStderr: true });
    await run(python, ["-m", "pip", "install", "-U", "pip", "wheel", "setuptools"], { inheritStderr: true });
    await run(python, ["-m", "pip", "install", "-r", SEMANTIC_REQUIREMENTS_EMBED], { inheritStderr: true });
    fs.writeFileSync(marker, `${reqHash}\n`);
  }
  return { python, venvDir };
}

/**
 * @param {unknown} input
 * @param {string} tmpDir
 */
function writeInput(input, tmpDir) {
  if (typeof input === "string") return path.resolve(input);
  const file = path.join(tmpDir, "corpus.json");
  const payload = Array.isArray(input) ? { format: "search-semantic-corpus", version: 1, documents: input } : input;
  fs.writeFileSync(file, `${JSON.stringify(payload)}\n`);
  return file;
}

/**
 * @param {unknown} input
 * @param {CompileSemanticOptions} [opts]
 * @returns {Promise<CompileSemanticResult>}
 */
export async function compileSemantic(input, opts = {}) {
  const method = opts.method || DEFAULT_METHOD;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "search-semantic-"));
  try {
    const { python } = await ensureSemanticEnvironment({
      method,
      pythonPath: opts.pythonPath,
      venvDir: opts.venvDir,
    });
    const inputPath = writeInput(input, tmp);
    const outputPath = opts.outputPath || path.join(tmp, "relationships.json");
    const reportPath = opts.reportPath || path.join(tmp, "report.json");
    const cacheDir = opts.cacheDir || path.join(tmp, "cache");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });

    /** @type {string[]} */
    const args = [
      SEMANTIC_BUILDER,
      "--input",
      inputPath,
      "--output",
      outputPath,
      "--method",
      method,
      "--representation",
      opts.representation || DEFAULT_REPRESENTATION,
      "--top-k",
      String(opts.topK ?? DEFAULT_TOP_K),
      "--min-score",
      String(opts.minScore ?? DEFAULT_MIN_SCORE),
      "--model",
      opts.model || DEFAULT_MODEL,
      "--cache-dir",
      cacheDir,
      "--report",
      reportPath,
    ];
    if (opts.lexicalMinScore != null) args.push("--lexical-min-score", String(opts.lexicalMinScore));
    if (opts.embeddingMinScore != null) args.push("--embedding-min-score", String(opts.embeddingMinScore));
    if (opts.precisionGate) args.push("--precision-gate");
    if (opts.mutual) args.push("--mutual");

    const env = {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      FASTEMBED_CACHE_PATH: path.join(cacheDir, "fastembed"),
      HF_HOME: path.join(cacheDir, "hf"),
    };
    const { stdout } = await run(python, args, { env, inheritStderr: true });
    const artifact = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if (!artifact || artifact.format !== "search-v2-relationships" || artifact.version !== 1) {
      throw new Error("semantic compiler did not emit search-v2-relationships v1");
    }
    if (Object.prototype.hasOwnProperty.call(artifact, "vectors") || Object.prototype.hasOwnProperty.call(artifact, "embeddings")) {
      throw new Error("semantic compiler must not write vectors into the relationship artifact");
    }
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
    return { artifact, report, outputPath, stdout };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
