/**
 * Policy C: non-canonical lemmas are exact-equivalence only.
 * They must not generate ordinary lexical prefix evidence.
 * Built-in English suffix-heuristic stems are one producer; custom
 * SearchPlugin.lemma() without canonicalLemma is another.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { extractFeatures } from "../dist/features.js";
import {
  conceptMatchesBody,
  conceptMatchesTitle,
  formAllowsOrdinaryLexicalPrefix,
  nonCanonicalLemmaOnlyForms,
} from "../dist/retrieval/retrieve.js";
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
    expect([...nonCanonicalLemmaOnlyForms(q)]).toEqual(["nat"]);
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
    expect(nonCanonicalLemmaOnlyForms(q).size).toBe(0);
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

function miceLemmaPlugin(canonical) {
  return {
    name: "mice-lemma",
    indexIdentity: canonical ? "mice-lemma-canonical" : "mice-lemma-only",
    lemma(token) {
      return token === "mice" ? "mouse" : token;
    },
    ...(canonical
      ? {
          canonicalLemma(token) {
            return token === "mice" ? "mouse" : null;
          },
        }
      : {}),
  };
}

const miceDocs = [
  { id: "exact", title: "Field Mouse", body: "a mouse in the field" },
  { id: "title-prefix", title: "Mousepad Guide", body: "unrelated desk copy" },
  { id: "body-prefix", title: "Desk Notes", body: "a mousepad on the desk" },
];

describe("custom plugin lemma vs canonicalLemma prefix capability", () => {
  test("non-canonical custom lemma is exact-only", async () => {
    const plugins = [miceLemmaPlugin(false)];
    const q = analyzeQuery("mice", { plugins });
    const tok = q.tokens[0];
    expect(tok.surface).toBe("mice");
    expect(tok.surfaceNormalized).toBe("mice");
    expect(tok.normalized).toBe("mice");
    expect(tok.lemma).toBe("mouse");
    expect([...nonCanonicalLemmaOnlyForms(q)]).toEqual(["mouse"]);
    expect(formAllowsOrdinaryLexicalPrefix(q, "mice")).toBe(true);
    expect(formAllowsOrdinaryLexicalPrefix(q, "mouse")).toBe(false);

    for (const retriever of ["full-scan", "indexed"]) {
      const e = SearchEngine.create({ schema, plugins, retriever });
      await e.index(miceDocs);
      const prepared = e._prepareQuery("mice");
      expect(prepared.tokens[0].normalized).toBe("mice");
      expect(prepared.tokens[0].lemma).toBe("mouse");
      const exact = e._index.documents.find((d) => d.id === "exact");
      const titlePrefix = e._index.documents.find((d) => d.id === "title-prefix");
      const bodyPrefix = e._index.documents.find((d) => d.id === "body-prefix");
      const term = prepared.concepts.find((c) => c.kind === "term");
      expect(conceptMatchesTitle(term, exact, prepared)).toBeTruthy();
      expect(conceptMatchesTitle(term, exact, prepared)).not.toBe("prefix");
      expect(conceptMatchesTitle(term, titlePrefix, prepared)).toBeNull();
      expect(conceptMatchesBody(term, exact, prepared)).toBe(true);
      expect(conceptMatchesBody(term, bodyPrefix, prepared)).toBe(false);
      expect(extractFeatures(prepared, titlePrefix).bodyLexicalMatch).toBe(0);
      const ids = e.search("mice", { limit: 10, relatedLimit: 0 }).map((row) => row.id);
      expect(ids).toContain("exact");
      expect(ids).not.toContain("title-prefix");
      expect(ids).not.toContain("body-prefix");
    }
  });

  test("canonicalLemma remains prefix-capable via rewritten normalized", async () => {
    const plugins = [miceLemmaPlugin(true)];
    const q = analyzeQuery("mice", { plugins });
    const tok = q.tokens[0];
    expect(tok.surface).toBe("mice");
    expect(tok.surfaceNormalized).toBe("mice");
    expect(tok.normalized).toBe("mouse");
    expect(tok.lemma).toBe("mouse");
    expect(nonCanonicalLemmaOnlyForms(q).size).toBe(0);
    expect(formAllowsOrdinaryLexicalPrefix(q, "mice")).toBe(true);
    expect(formAllowsOrdinaryLexicalPrefix(q, "mouse")).toBe(true);

    for (const retriever of ["full-scan", "indexed"]) {
      const e = SearchEngine.create({ schema, plugins, retriever });
      await e.index(miceDocs);
      const prepared = e._prepareQuery("mice");
      expect(prepared.tokens[0].surface).toBe("mice");
      expect(prepared.tokens[0].surfaceNormalized).toBe("mice");
      expect(prepared.tokens[0].normalized).toBe("mouse");
      expect(prepared.tokens[0].lemma).toBe("mouse");
      const exact = e._index.documents.find((d) => d.id === "exact");
      const titlePrefix = e._index.documents.find((d) => d.id === "title-prefix");
      const bodyPrefix = e._index.documents.find((d) => d.id === "body-prefix");
      const term = prepared.concepts.find((c) => c.kind === "term");
      expect(conceptMatchesTitle(term, exact, prepared)).toBeTruthy();
      expect(conceptMatchesTitle(term, titlePrefix, prepared)).toBe("prefix");
      expect(conceptMatchesBody(term, bodyPrefix, prepared)).toBe(true);
      const ids = e.search("mice", { limit: 10, relatedLimit: 0 }).map((row) => row.id);
      expect(ids).toContain("exact");
      expect(ids).toContain("title-prefix");
      expect(ids).toContain("body-prefix");
    }
  });
});
