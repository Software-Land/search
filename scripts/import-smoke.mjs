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
const lexicalExp = resolveExport("./lexical");

const runtime = await import(rootExp.url);
const browser = await import(browserExp.url);
const corpus = await import(corpusExp.url);
const relationships = await import(relExp.url);
const semantic = await import(semanticExp.url);
const lexical = await import(lexicalExp.url);

if (typeof runtime.SearchEngine?.create !== "function") throw new Error("root SearchEngine missing");
if (typeof runtime.morphology !== "function") throw new Error("root morphology missing");
if ("english" in runtime) throw new Error("root english() must not remain a public export");
if ("lang" in runtime) throw new Error("unreleased lang() must not remain a root export");
if (typeof browser.createSearchClient !== "function") throw new Error("browser createSearchClient missing");
if (typeof browser.searchWorkerUrl !== "function") throw new Error("browser searchWorkerUrl missing");
if (typeof corpus.compileCorpus !== "function") throw new Error("corpus compileCorpus missing");
if (typeof relationships.compileRelationships !== "function") throw new Error("relationships compileRelationships missing");
if (typeof semantic.compileSemantic !== "function") throw new Error("semantic compileSemantic missing");
if (typeof lexical.compileLexicalFrequency !== "function") throw new Error("lexical compileLexicalFrequency missing");
if (typeof corpus.parseConfiguredConcepts !== "function") throw new Error("corpus parseConfiguredConcepts missing");
if (typeof corpus.reconcileExternalConfiguredConcepts !== "function") {
  throw new Error("corpus reconcileExternalConfiguredConcepts missing");
}
if ("normalizeExternalConfiguredConcepts" in corpus) {
  throw new Error("corpus normalizeExternalConfiguredConcepts must not remain a public export");
}
if ("classifyExpansionRelation" in corpus) {
  throw new Error("corpus classifyExpansionRelation must not remain a public export");
}
if ("normalizeExternalEquivalences" in corpus) {
  throw new Error("corpus normalizeExternalEquivalences must not remain a public export");
}
if ("ExternalEquivalenceError" in corpus) {
  throw new Error("corpus ExternalEquivalenceError must not remain a public export");
}
if ("normalizeSearchEquivalences" in runtime) throw new Error("root normalizeSearchEquivalences must not remain a public export");
if ("parseEquivalences" in runtime) throw new Error("root parseEquivalences must not remain a public export");
if ("compileRelationshipMap" in runtime) throw new Error("root compileRelationshipMap must not remain a public export");
if ("configuredConceptsFromEquivalences" in corpus) {
  throw new Error("corpus configuredConceptsFromEquivalences must not remain a public export");
}
if ("synonyms" in runtime) throw new Error("root synonyms() must not remain a public export");
if ("dictionary" in runtime) throw new Error("root dictionary() must not remain a public export");
if ("parseSynonyms" in runtime) throw new Error("root parseSynonyms must not remain a public export");
if (typeof runtime.compileAuthoredRelevance !== "function") throw new Error("root compileAuthoredRelevance missing");
if (typeof runtime.mergeRelationships !== "function") throw new Error("root mergeRelationships missing");
if ("mergeEditorialRelationships" in runtime) throw new Error("root mergeEditorialRelationships must not remain a public export");
if (runtime.ARTIFACT_FORMATS && "synonyms" in runtime.ARTIFACT_FORMATS) {
  throw new Error("ARTIFACT_FORMATS must not list synonyms");
}
if (runtime.ARTIFACT_FORMATS && "equivalences" in runtime.ARTIFACT_FORMATS) {
  throw new Error("ARTIFACT_FORMATS must not list equivalences");
}
if ("compileSemantic" in runtime) throw new Error("runtime must not export compileSemantic");
if ("compileLexicalFrequency" in runtime) throw new Error("runtime must not export compileLexicalFrequency");

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
        "./lexical": lexicalExp.file,
      },
    },
    null,
    2
  )
);
