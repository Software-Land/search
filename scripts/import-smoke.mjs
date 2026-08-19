/**
 * Resolve public package exports from this directory without npm pack.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function resolveExport(subpath) {
  const exp = pkg.exports[subpath];
  if (!exp || typeof exp !== "object" || !exp.import) {
    throw new Error(`missing export ${subpath}`);
  }
  const file = path.join(root, exp.import);
  const types = path.join(root, exp.types);
  return { file, types, url: pathToFileURL(file).href };
}

const rootExp = resolveExport(".");
const browserExp = resolveExport("./browser");
const corpusExp = resolveExport("./corpus");
const relExp = resolveExport("./relationships");
const semanticExp = resolveExport("./semantic");

const runtime = await import(rootExp.url);
const browser = await import(browserExp.url);
const corpus = await import(corpusExp.url);
const relationships = await import(relExp.url);
const semantic = await import(semanticExp.url);

if (typeof runtime.SearchEngine?.create !== "function") throw new Error("root SearchEngine missing");
if (typeof browser.createSearchClient !== "function") throw new Error("browser createSearchClient missing");
if (typeof browser.searchWorkerUrl !== "function") throw new Error("browser searchWorkerUrl missing");
if (typeof corpus.compileCorpus !== "function") throw new Error("corpus compileCorpus missing");
if (typeof relationships.compileRelationships !== "function") throw new Error("relationships compileRelationships missing");
if (typeof semantic.compileSemantic !== "function") throw new Error("semantic compileSemantic missing");
if ("compileSemantic" in runtime) throw new Error("runtime must not export compileSemantic");

const extra = Object.keys(runtime).filter((k) => k !== "__esModule" && !runtime.PUBLIC_EXPORTS.includes(k));
if (extra.length) throw new Error(`unexpected root exports: ${extra.join(", ")}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      name: pkg.name,
      private: pkg.private,
      exports: Object.keys(pkg.exports),
      publicExports: [...runtime.PUBLIC_EXPORTS],
      workerUrl: String(browser.searchWorkerUrl()),
      resolved: {
        ".": rootExp.file,
        "./browser": browserExp.file,
        "./corpus": corpusExp.file,
        "./relationships": relExp.file,
        "./semantic": semanticExp.file,
      },
    },
    null,
    2
  )
);
