/**
 * Policy C: suffix-heuristic lemmas are exact-equivalence only.
 * They must not generate ordinary lexical prefix evidence.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { extractFeatures } from "../dist/features.js";
import {
  conceptMatchesBody,
  formAllowsOrdinaryLexicalPrefix,
  heuristicLemmaOnlyForms,
} from "../dist/retrieve.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { loadSoftwareLandRelevanceInputs } from "./helpers/software-land-fixture.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

describe("heuristic lemma prefix capability", () => {
  test("nation keeps heuristic lemma for exact matching but not prefix", () => {
    const plugins = [morphology()];
    const q = analyzeQuery("nation", { plugins });
    expect(q.tokens[0].normalized).toBe("nation");
    expect(q.tokens[0].lemma).toBe("nat");
    expect(q.concepts.find((c) => c.kind === "term").forms).toEqual(expect.arrayContaining(["nation", "nat"]));
    expect([...heuristicLemmaOnlyForms(q)]).toEqual(["nat"]);
    expect(formAllowsOrdinaryLexicalPrefix(q, "nation")).toBe(true);
    expect(formAllowsOrdinaryLexicalPrefix(q, "nat")).toBe(false);
  });

  test("canonical computing lemma remains prefix-capable via rewritten normalized", () => {
    const plugins = [morphology()];
    const q = analyzeQuery("computing", { plugins });
    expect(q.tokens[0].normalized).toBe("compute");
    expect(q.tokens[0].lemma).toBe("compute");
    expect(formAllowsOrdinaryLexicalPrefix(q, "computing")).toBe(true);
    expect(formAllowsOrdinaryLexicalPrefix(q, "compute")).toBe(true);
    expect(heuristicLemmaOnlyForms(q).size).toBe(0);
  });

  test("heuristic stem does not retrieve an unrelated body prefix", async () => {
    const plugins = [morphology()];
    const docs = [
      { id: "hit", title: "Nation Notes", body: "a nation's breadth of work" },
      { id: "prefix", title: "Nature Notes", body: "the nature of this website" },
      { id: "typed-prefix", title: "National Notes", body: "national news" },
    ];
    for (const retriever of ["full-scan", "indexed"]) {
      const e = SearchEngine.create({ schema, plugins, retriever });
      await e.index(docs);
      const titles = e.search("nation", { limit: 10, relatedLimit: 0 }).map((row) => row.title);
      expect(titles).toContain("Nation Notes");
      expect(titles).toContain("National Notes");
      expect(titles).not.toContain("Nature Notes");
      const nature = e._index.documents.find((d) => d.id === "prefix");
      const q = e._prepareQuery("nation");
      expect(conceptMatchesBody(q.concepts.find((c) => c.kind === "term"), nature, q)).toBe(false);
      expect(extractFeatures(q, nature).bodyLexicalMatch).toBe(0);
    }
  });

  test("exact heuristic lemma equality is preserved for operations", async () => {
    const plugins = [morphology()];
    const e = SearchEngine.create({ schema, plugins, retriever: "full-scan" });
    await e.index([
      { id: "exact", title: "Ops", body: "the operation completed" },
      { id: "prefix", title: "Runtime", body: "operational concerns only" },
    ]);
    const q = e._prepareQuery("operations");
    expect(q.tokens[0].lemma).toBe("operation");
    expect(q.tokens[0].normalized).toBe("operations");
    const titles = e.search("operations", { limit: 10, relatedLimit: 0 }).map((row) => row.title);
    expect(titles).toEqual(["Ops"]);
  });

  test("canonical morphology still matches compute from computing", async () => {
    const plugins = [morphology()];
    const e = SearchEngine.create({ schema, plugins, retriever: "indexed" });
    await e.index([{ id: "edge", title: "Edge Computing", body: "Compute at the edge." }]);
    expect(e.search("computing", { limit: 5, relatedLimit: 0 })[0].title).toBe("Edge Computing");
  });

  test("canonical libraries still matches library", async () => {
    const plugins = [morphology()];
    const e = SearchEngine.create({ schema, plugins, retriever: "full-scan" });
    await e.index([{ id: "lib", title: "What is a Library?", body: "A reusable library." }]);
    expect(e.search("libraries", { limit: 5, relatedLimit: 0 })[0].title).toBe("What is a Library?");
  });

  test("unique vocab completion is still prefix-capable", async () => {
    const plugins = [morphology()];
    const e = SearchEngine.create({ schema, plugins, retriever: "full-scan" });
    await e.index([{ id: "nat", title: "National Notes", body: "national institute mention" }]);
    const q = e._prepareQuery("nationa");
    expect(q.tokens[0].completedToken).toBe("national");
    expect(formAllowsOrdinaryLexicalPrefix(q, "national")).toBe(true);
    expect(e.search("nationa", { limit: 5, relatedLimit: 0 })[0].title).toBe("National Notes");
  });
});

describe("Software.Land nation family after heuristic-prefix restriction", () => {
  const inputs = loadSoftwareLandRelevanceInputs();
  const engines = {};

  function createEngine(retriever) {
    const compiled = compileAuthoredRelevance({
      configuredConcepts: inputs.configuredConcepts,
      relationshipMap: inputs.relationshipMap,
    });
    return SearchEngine.create({
      schema: inputs.schema,
      plugins: [morphology({ lemmas: inputs.lemmas }), ...compiled.plugins],
      documentRelationships: inputs.relationships,
      relationshipStrategy: "hybrid",
      retriever,
    });
  }

  beforeAll(async () => {
    const docs = attachLexicalFrequency(inputs.documents, inputs.lexicalFrequency);
    engines.indexed = createEngine();
    engines.fullScan = createEngine("full-scan");
    await engines.indexed.index(docs);
    await engines.fullScan.index(docs);
  });

  function titles(engine, raw) {
    return engine.search(raw, { limit: inputs.documents.length, relatedLimit: 0 }).map((row) => row.title);
  }

  for (const retriever of ["indexed", "fullScan"]) {
    test(`${retriever}: nation drops nature/native spray and keeps NIST TLS`, () => {
      const e = engines[retriever];
      const q = e._prepareQuery("nation");
      expect(q.tokens[0].lemma).toBe("nat");
      expect(q.configuredPrefixRecall?.key).toBe("nist");
      expect(formAllowsOrdinaryLexicalPrefix(q, "nat")).toBe(false);
      const got = titles(e, "nation");
      expect(got).toEqual([
        "Software Engineer vs Software Developer",
        "Information Asymmetry",
        "TLS 1.2 Vulnerability",
      ]);
      expect(got).not.toContain("RBAC (Role Based Access Control)");
    });

    test(`${retriever}: natio / nationa / national / national institute unchanged`, () => {
      const e = engines[retriever];
      expect(titles(e, "natio")).toEqual([
        "Software Engineer vs Software Developer",
        "Information Asymmetry",
        "TLS 1.2 Vulnerability",
      ]);
      expect(titles(e, "nationa")).toEqual(["Information Asymmetry", "TLS 1.2 Vulnerability"]);
      expect(titles(e, "national")).toEqual(["Information Asymmetry", "TLS 1.2 Vulnerability"]);
      expect(titles(e, "national institute")).toEqual(["TLS 1.2 Vulnerability"]);
    });
  }

  test("indexed and full-scan nation results match", () => {
    expect(titles(engines.indexed, "nation")).toEqual(titles(engines.fullScan, "nation"));
  });
});
