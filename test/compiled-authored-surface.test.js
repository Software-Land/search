/**
 * Canonical compileAuthoredRelevance aggregate surface:
 *   plugins: [morphology(), ...authored.plugins]
 *   documentRelationships: authored.documentRelationships
 * Public result keys are only plugins and documentRelationships.
 */
import {
  SearchEngine,
  morphology,
  compileAuthoredRelevance,
  mergeRelationships,
} from "../dist/index.js";
import { compileRelationshipMap } from "../dist/relationshipMap.js";
import { synonyms as synonymsPrimitive } from "../dist/query/synonyms.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const entries = [
  { key: "qa", aliases: [["quality", "assurance"]] },
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]] },
  { key: "appsec", aliases: [["application", "security"]] },
];

const relationshipMap = {
  qa: [{ kind: "equivalent", to: { form: "testing" } }],
  hypertext: [{ kind: "related", to: { concept: "http" } }],
  appsec: [{ kind: "related", to: { form: "authentication" } }],
  "doc-a": [{ kind: "related", to: { document: "doc-b" } }],
};

const documents = [
  { id: "qa-guide", title: "Quality Assurance Guide", body: "qa process handbook" },
  { id: "testing", title: "Testing in Software Engineering", body: "unit testing methods" },
  { id: "http-doc", title: "What is HTTP?", body: "http methods and status codes" },
  { id: "authn", title: "Login Flow", body: "password authentication cookies" },
  { id: "doc-a", title: "Krypton Primary", body: "krypton only body text" },
  { id: "doc-b", title: "Xenon Neighbor", body: "xenon only body text" },
];

const semantic = {
  format: "search-v2-relationships",
  version: 1,
  relationships: {
    "doc-a": [{ target: "qa-guide", type: "semantic", strength: 0.7, provenance: "generated" }],
  },
};

function snapshot(engine, query, retriever) {
  const detailed = engine.searchDetailed(query, { limit: 10, relatedLimit: 8, explain: true });
  return {
    retriever,
    query,
    ids: detailed.results.map((row) => row.id),
    kinds: detailed.results.map((row) => row.relevanceKind),
    classes: detailed.results.map((row) => row.directClass),
    sources: detailed.results.map((row) => [...(row.retrievalSources || [])].sort()),
    related: detailed.related.map((row) => ({
      id: row.id,
      type: row.relationship?.type,
      provenance: row.relationship?.provenance,
    })),
    concepts: detailed.explanation?.query?.concepts?.map((c) => ({
      id: c.id,
      kind: c.kind,
      provenance: c.provenance,
    })),
  };
}

async function engineFrom(plugins, relationships, retriever) {
  const engine = SearchEngine.create({
    schema,
    plugins,
    documentRelationships: relationships,
    retriever,
    relationshipStrategy: "hybrid",
  });
  await engine.index(documents);
  return engine;
}

function pluginByName(authored, name) {
  return authored.plugins.find((plugin) => plugin.name === name);
}

describe("compileAuthoredRelevance aggregate surface", () => {
  const authored = compileAuthoredRelevance({ configuredConcepts: entries, relationshipMap, documents });
  const map = compileRelationshipMap(relationshipMap, { concepts: entries, documents });

  test("public result keys are only plugins and documentRelationships", () => {
    expect(Object.keys(authored).sort()).toEqual(["documentRelationships", "plugins"]);
    expect(authored).not.toHaveProperty("dictionary");
    expect(authored).not.toHaveProperty("synonyms");
    expect(authored).not.toHaveProperty("synonymMap");
    expect(authored).not.toHaveProperty("editorialRelationships");
    expect(authored).not.toHaveProperty("relationships");
  });

  test("plugins are compiler-owned and ordered", () => {
    expect(authored.plugins).toHaveLength(2);
    expect(authored.plugins.map((plugin) => plugin.name)).toEqual(["configured-concepts", "synonyms"]);
    expect(pluginByName(authored, "configured-concepts").standaloneRecallByToken.get("hypertext")).toBe("http");
    expect(pluginByName(authored, "configured-concepts").topicalRecallByKey.get("appsec")).toEqual([["authentication"]]);
    expect(pluginByName(authored, "synonyms").expand("qa").map((row) => row.form)).toEqual(["testing"]);
  });

  test("empty equivalent map still includes the compiled recall plugin", () => {
    const relatedOnly = compileAuthoredRelevance({ configuredConcepts: [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]] }],
      relationshipMap: { hypertext: [{ kind: "related", to: { concept: "http" } }] },
    });
    expect(relatedOnly.plugins.map((plugin) => plugin.name)).toEqual(["configured-concepts", "synonyms"]);
    expect(pluginByName(relatedOnly, "synonyms").expand("hypertext")).toEqual([]);
    expect(relatedOnly.documentRelationships).toBeNull();
  });

  test("documentRelationships is the editorial artifact or null", () => {
    expect(authored.documentRelationships).toEqual(
      mergeRelationships(null, {
        format: "search-v2-relationships",
        version: 1,
        relationships: map.editorialRelationships,
      })
    );
    expect(authored.documentRelationships.format).toBe("search-v2-relationships");
    expect(authored.documentRelationships.relationships["doc-a"]).toEqual([
      { target: "doc-b", type: "editorial", strength: 1, provenance: "manual" },
    ]);
    const none = compileAuthoredRelevance({ configuredConcepts: [{ key: "qa", aliases: [["quality", "assurance"]] }],
    });
    expect(none.documentRelationships).toBeNull();
  });

  test("mergeRelationships composes semantic and authored artifacts", () => {
    const original = JSON.parse(JSON.stringify(semantic));
    const merged = mergeRelationships(semantic, authored.documentRelationships);
    expect(semantic).toEqual(original);
    expect(merged.relationships["doc-a"]).toEqual([
      { target: "qa-guide", type: "semantic", strength: 0.7, provenance: "generated" },
      { target: "doc-b", type: "editorial", strength: 1, provenance: "manual" },
    ]);
  });

  test.each(["full-scan", "indexed"])(
    "%s aggregate path matches compileRelationshipMap + equivalent primitive",
    async (retriever) => {
      const explicit = await engineFrom(
        [morphology(), authored.plugins[0], synonymsPrimitive(map.synonymMap)],
        mergeRelationships(null, authored.documentRelationships),
        retriever
      );
      const aggregate = await engineFrom(
        [morphology(), ...authored.plugins],
        authored.documentRelationships,
        retriever
      );
      const queries = ["qa", "testing", "hypertext", "application security", "krypton"];
      for (const query of queries) {
        expect(snapshot(aggregate, query, retriever)).toEqual(snapshot(explicit, query, retriever));
      }
    }
  );

  test("empty synonyms plugin does not change related-only occupancy", async () => {
    const relatedOnly = compileAuthoredRelevance({ configuredConcepts: [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]] }],
      relationshipMap: { hypertext: [{ kind: "related", to: { concept: "http" } }] },
    });
    const without = await engineFrom([morphology(), relatedOnly.plugins[0]], null, "full-scan");
    const withPlugin = await engineFrom([morphology(), ...relatedOnly.plugins], relatedOnly.documentRelationships, "full-scan");
    expect(snapshot(withPlugin, "hypertext", "full-scan")).toEqual(snapshot(without, "hypertext", "full-scan"));
  });
});
