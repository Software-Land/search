import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SearchEngine,
  morphology,
} from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { extractFeatures } from "../dist/features.js";
import {
  compileLexicalIndex,
  loadLexicalIndex,
  parseLexicalIndex,
} from "../dist/lexicalIndex.js";
import { stableFingerprint } from "../dist/stableHash.js";
import {
  attachLexicalFrequency,
  compileLexicalIndex as compilePublicLexicalIndex,
} from "../tools/search-lexical/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "software-land");
const load = (name) => JSON.parse(fs.readFileSync(path.join(fixture, name), "utf8"));
const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function refreshIntegrity(artifact) {
  artifact.integrity = stableFingerprint({
    compatibility: artifact.compatibility,
    corpus: artifact.corpus,
    data: artifact.data,
  });
  return artifact;
}

describe("search-v2-lexical-index v1", () => {
  const documents = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
  const lemmas = load("lemmas.json");
  const configuredConcepts = load("configured-concepts.json");
  const queries = load("query-result-oracle.json").rows.map((row) => row.query);
  let english;
  let plugins;
  let artifact;

  beforeAll(() => {
    english = morphology({ lemmas });
    plugins = [english, compileConfiguredConceptPlugin({ configuredConcepts: configuredConcepts })];
    artifact = compileLexicalIndex(documents, { schema, plugins });
  });

  test("compiler is byte-stable and the public lexical surface emits the same artifact", () => {
    const second = compileLexicalIndex(documents, { schema, plugins });
    const publicArtifact = compilePublicLexicalIndex(documents, {
      schema,
      lemma: english.lemma,
      analyzerId: english.indexIdentity,
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(artifact));
    expect(JSON.stringify(publicArtifact)).toBe(JSON.stringify(artifact));
    expect(artifact.format).toBe("search-v2-lexical-index");
    expect(artifact.version).toBe(1);
    expect(artifact.corpus.documentCount).toBe(122);
    expect(artifact.data.extensions["exact-pruning-v1"]).toEqual({
      revision: 1,
      unit: "document-ordinal",
      blockSize: 128,
      boundaries: [0, 122],
    });
    expect(artifact.data.documents.every((row) =>
      row.length === 7 &&
      typeof row[0] === "string" &&
      typeof row[1] === "number" &&
      typeof row[2] === "number"
    )).toBe(true);
    expect(artifact.data.documents.some((row) => row.some((value) =>
      value && typeof value === "object" && !Array.isArray(value)
    ))).toBe(false);
  });

  test("loaded documents reconstruct every current FeatureVector exactly", async () => {
    const rawEngine = SearchEngine.create({
      schema,
      plugins,
      documentRelationships: load("relationships.json"),
      retriever: "full-scan",
    });
    await rawEngine.index(documents);
    const compiledIndex = loadLexicalIndex(JSON.parse(JSON.stringify(artifact)), documents, schema, plugins);
    expect(compiledIndex.documents.every((doc) => doc.body === "" && doc.raw.body === "")).toBe(true);

    for (const queryText of queries) {
      const query = rawEngine._prepareQuery(queryText);
      for (let i = 0; i < rawEngine._index.documents.length; i += 1) {
        const raw = rawEngine._index.documents[i];
        const compiled = compiledIndex.documents[i];
        expect(compiled.id).toBe(raw.id);
        expect(extractFeatures(query, compiled)).toEqual(extractFeatures(query, raw));
      }
    }
  }, 120_000);

  test("SearchEngine accepts a supplied artifact and preserves full-scan output", async () => {
    const options = {
      schema,
      plugins,
      documentRelationships: load("relationships.json"),
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    };
    const raw = SearchEngine.create(options);
    const compiled = SearchEngine.create({ ...options, lexicalIndex: artifact });
    await raw.index(documents);
    await compiled.index(documents);
    expect(compiled.lexicalIndex).toBeNull();
    await expect(compiled.index(documents)).resolves.toMatchObject({ documentCount: 122 });
    await expect(compiled.index(
      documents.map((doc, i) => i === 0 ? { ...doc, body: `${doc.body} changed` } : doc)
    )).rejects.toThrow(/consumed lexical index/i);
    for (const query of queries) {
      const actual = compiled.searchDetailed(query, { limit: 10, relatedLimit: 5, explain: true });
      const expected = raw.searchDetailed(query, { limit: 10, relatedLimit: 5, explain: true });
      expect({ results: actual.results, related: actual.related }).toEqual({
        results: expected.results,
        related: expected.related,
      });
      expect({
        candidateCount: actual.meta.candidateCount,
        candidateTitles: actual.meta.candidateTitles,
        relatedCount: actual.meta.relatedCount,
        constraintCycles: actual.meta.constraintCycles,
        constraintConflicts: actual.meta.constraintConflicts,
      }).toEqual({
        candidateCount: expected.meta.candidateCount,
        candidateTitles: expected.meta.candidateTitles,
        relatedCount: expected.meta.relatedCount,
        constraintCycles: expected.meta.constraintCycles,
        constraintConflicts: expected.meta.constraintConflicts,
      });
    }
  }, 120_000);

  test("duplicate ids use the same deterministic last-document-wins rule", () => {
    const docs = [
      { id: "same", title: "old", body: "old body" },
      { id: "other", title: "other", body: "" },
      { id: "same", title: "new", body: "new body" },
    ];
    const built = compileLexicalIndex(docs, { schema });
    const loaded = loadLexicalIndex(built, docs, schema);
    expect(loaded.documents.map((doc) => [doc.id, doc.title])).toEqual([
      ["other", "other"],
      ["same", "new"],
    ]);
  });

  test("reserved extensions do not change the exact v1 base representation", () => {
    const extended = JSON.parse(JSON.stringify(artifact));
    extended.data.extensions["future-block-bounds"] = {
      termOrdinal: 0,
      field: "title",
      rowOffsets: [0],
    };
    refreshIntegrity(extended);
    const loaded = loadLexicalIndex(extended, documents, schema, plugins);
    expect(loaded.documents.map((doc) => doc.id)).toEqual(
      documents.map((doc) => String(doc.id)).sort()
    );
  });

  test("artifact hydration does not invoke document lemma analysis", async () => {
    const docs = [{ id: "mice", title: "Mice Tools", body: "mice utility" }];
    const compilerPlugin = {
      name: "test-lemma",
      indexIdentity: "test-lemma-v1",
      lemma(token) {
        return token === "mice" ? "mouse" : token;
      },
    };
    const built = compileLexicalIndex(docs, { schema, plugins: [compilerPlugin] });
    const loaded = loadLexicalIndex(built, docs, schema, [{
      ...compilerPlugin,
      lemma() {
        throw new Error("artifact load must not call lemma");
      },
    }]);
    expect(loaded.documents[0].titleLemmas).toEqual(["mouse", "tools"]);
    expect(loaded.documents[0].bodyLemmas).toEqual(["mouse", "utility"]);

    const runtimeOnly = SearchEngine.create({
      schema,
      plugins: [{
        name: "unidentified-runtime-lemma",
        lemma: compilerPlugin.lemma,
      }],
      retriever: "indexed",
      relationshipStrategy: "none",
    });
    await runtimeOnly.index(docs);
    expect(runtimeOnly.search("mouse", { limit: 1 })[0].id).toBe("mice");
  });

  test("supplied artifacts fail closed for corpus, analyzer, schema, version, integrity, and posting corruption", () => {
    expect(() => loadLexicalIndex(artifact, documents.slice(0, -1), schema, plugins)).toThrow(/document count/i);
    expect(() =>
      loadLexicalIndex(
        artifact,
        documents.map((doc, i) => i === 0 ? { ...doc, body: `${doc.body} changed` } : doc),
        schema,
        plugins
      )
    ).toThrow(/corpus fingerprint/i);
    expect(() => loadLexicalIndex(artifact, documents, schema, [])).toThrow(/analyzer identity/i);
    expect(() => loadLexicalIndex(artifact, documents, schema, [{
      name: "unidentified-custom",
      lemma: (token) => token,
    }])).toThrow(/indexIdentity/i);
    expect(() =>
      loadLexicalIndex(artifact, documents, {
        heading: { type: "text", role: "title" },
        body: { type: "text", role: "body" },
      }, plugins)
    ).toThrow(/schema/i);

    const unsupported = JSON.parse(JSON.stringify(artifact));
    unsupported.version = 2;
    expect(() => parseLexicalIndex(unsupported)).toThrow(/unsupported/i);

    const corrupted = JSON.parse(JSON.stringify(artifact));
    corrupted.data.documents[0][3] += "-tampered";
    expect(() => parseLexicalIndex(corrupted)).toThrow(/integrity/i);

    const badOffset = JSON.parse(JSON.stringify(artifact));
    const term = badOffset.data.terms.find((row) => row[2].length || row[3].length);
    const postings = term[2].length ? term[2] : term[3];
    postings[0] = badOffset.corpus.documentCount + 5;
    refreshIntegrity(badOffset);
    expect(() => loadLexicalIndex(badOffset, documents, schema, plugins)).toThrow(/document offset/i);
  });

  test("v1 corpus fingerprint ignores summary; consumed re-index does not", async () => {
    const summarySchema = {
      title: { type: "text", role: "title" },
      summary: { type: "text", role: "summary" },
      body: { type: "text", role: "body" },
    };
    const english = morphology();
    const docsA = [{ id: "edge", title: "CloudFront", summary: "two layer authorization", body: "cdn cookies" }];
    const docsB = [{ id: "edge", title: "CloudFront", summary: "signed cookie primer", body: "cdn cookies" }];
    const artifactA = compileLexicalIndex(docsA, { schema: summarySchema, plugins: [english] });
    const artifactB = compileLexicalIndex(docsB, { schema: summarySchema, plugins: [english] });
    expect(artifactA.version).toBe(1);
    expect(artifactA.corpus.fingerprint).toBe(artifactB.corpus.fingerprint);
    expect(JSON.stringify(artifactA.data.documents[0])).not.toContain("two layer");
    expect(JSON.stringify(artifactA.data.documents[0])).not.toContain("authorization");

    const engine = SearchEngine.create({
      schema: summarySchema,
      plugins: [english],
      retriever: "indexed",
      lexicalIndex: JSON.parse(JSON.stringify(artifactA)),
    });
    await engine.index(docsA);
    expect(engine._index.documents[0].summary).toBe("two layer authorization");
    await engine.index(docsA);
    expect(engine._index.documents[0].summary).toBe("two layer authorization");
    try {
      await engine.index(docsB);
      throw new Error("expected stale-summary re-index to reject");
    } catch (err) {
      expect(err.name).toBe("ArtifactValidationError");
      expect(err.field).toBe("hydration.fingerprint");
    }

    const fresh = SearchEngine.create({
      schema: summarySchema,
      plugins: [english],
      retriever: "indexed",
      lexicalIndex: JSON.parse(JSON.stringify(artifactA)),
    });
    await fresh.index(docsB);
    expect(fresh._index.documents[0].summary).toBe("signed cookie primer");
    expect(fresh.search("signed cookie primer", { limit: 5 }).map((hit) => hit.id)).toEqual(["edge"]);
    expect(fresh.search("two layer authorization", { limit: 5 })).toEqual([]);
  });

  test("title/body-only re-index ignores a summary property change", async () => {
    const english = morphology();
    const docsA = [{ id: "edge", title: "CloudFront", summary: "two layer authorization", body: "cdn cookies" }];
    const docsB = [{ id: "edge", title: "CloudFront", summary: "signed cookie primer", body: "cdn cookies" }];
    const artifact = compileLexicalIndex(docsA, { schema, plugins: [english] });
    const engine = SearchEngine.create({
      schema,
      plugins: [english],
      retriever: "indexed",
      lexicalIndex: JSON.parse(JSON.stringify(artifact)),
    });
    await engine.index(docsA);
    await engine.index(docsB);
    expect(engine._index.documents[0].summary).toBe("");
  });
});
