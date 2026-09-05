/**
 * Slice 5 characterization: public result rows and explanation.query shape.
 * Serializes raw AnalyzedQuery diagnostics; does not collapse them through
 * querySemanticFacts.
 */
import { SearchEngine, morphology, ARTIFACT_FORMATS, ARTIFACT_VERSION } from "../dist/index.js";
import { synonyms } from "../dist/query/synonyms.js";
import { compileLexicalIndex } from "../dist/indexing/lexicalIndex.js";
import { configuredConceptPluginFromLegacy } from "./helpers/authored.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const dict = [
  { key: "nist", aliases: [["national", "institute", "standards", "technology"]] },
  { key: "rpc", aliases: [["remote", "procedure", "call"]] },
  { key: "ml", aliases: [["machine", "learning"]] },
  { key: "api", aliases: [["application", "programming", "interface"]] },
  { key: "qa", aliases: [["quality", "assurance"]] },
];

const docs = [
  { id: "notes", title: "Information Notes", body: "request notes about open interface interceptor internet" },
  { id: "rpc", title: "Remote Procedure Call", body: "rpc notes" },
  { id: "ml", title: "Machine Learning", body: "models" },
  { id: "nist", title: "National Institute", body: "standards technology" },
  { id: "api", title: "What is an API?", body: "programming interface" },
  { id: "tls", title: "TLS 1.2 Vulnerability", body: "information notes" },
  { id: "qa", title: "Quality Assurance", body: "testing" },
  { id: "load", title: "Load Testing", body: "performance load testing notes" },
  { id: "neighbor", title: "Neighbor Notes", body: "related without the typed phrase" },
];

const graph = {
  format: ARTIFACT_FORMATS.relationships,
  version: ARTIFACT_VERSION,
  relationships: {
    ml: [{ target: "neighbor", type: "semantic", strength: 0.7, provenance: "test" }],
  },
};

function plugins() {
  return [morphology(), configuredConceptPluginFromLegacy(dict), synonyms({ qa: ["testing"] })];
}

async function compiledEngine(extra = {}) {
  const compiledPlugins = plugins();
  const lexicalIndex = compileLexicalIndex(docs, { schema, plugins: compiledPlugins });
  const e = SearchEngine.create({
    schema,
    plugins: compiledPlugins,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: extra.relationshipStrategy || "none",
    documentRelationships: extra.documentRelationships || undefined,
  });
  await e.index(docs);
  return e;
}

function publicRow(row) {
  return {
    id: row.id,
    title: row.title,
    rank: row.rank,
    score: row.score,
    relevanceKind: row.relevanceKind,
    directClass: row.directClass,
    relationship: row.relationship
      ? {
          sourceId: row.relationship.sourceId,
          sourceTitle: row.relationship.sourceTitle,
          type: row.relationship.type,
          strength: row.relationship.strength,
          provenance: row.relationship.provenance,
          rank: row.relationship.rank,
        }
      : undefined,
  };
}

function queryKeys(explanation) {
  return Object.keys(explanation.query).sort();
}

describe("explanation and public result assembly shape", () => {
  test("ordinary lexical explanation keeps raw analyzer diagnostics", async () => {
    const engine = await compiledEngine();
    const detailed = engine.searchDetailed("information notes", { limit: 5, relatedLimit: 0, explain: true });
    const row = detailed.results[0];
    expect(row.explanation.query.raw).toBe("information notes");
    expect(row.explanation.query.configuredSequenceIntent).toBeNull();
    expect(row.explanation.query.configuredContentIdentity).toBeNull();
    expect(row.explanation.query.configuredPrefixRecall).toBeNull();
    expect(row.explanation.query.prefixCompletion).toBeNull();
    expect(row.explanation.query.contextualCompletion).toBeNull();
    expect(row.explanation.query.standaloneRecall).toBeNull();
    expect(row.explanation.query.topicalRecall).toBeNull();
    expect(row.explanation.query).not.toHaveProperty("equivalentRecall");
    expect(row.explanation.query.tokens.map((t) => t.normalized)).toEqual(["information", "notes"]);
    expect(row.explanation.query.lexicalTokens).toEqual(expect.any(Array));
    expect(typeof row.explanation.query.lexicalPhraseKey).toBe("string");
    expect(row.explanation.query.originalSurface).toEqual(["information", "notes"]);
    expect(queryKeys(row.explanation)).toEqual(
      [
        "alternatives",
        "configuredContentIdentity",
        "configuredPrefixRecall",
        "configuredPrefixRecallGroup",
        "configuredPrefixSpans",
        "configuredSequenceIntent",
        "configuredSpans",
        "contextualCompletion",
        "concepts",
        "lexicalPhraseKey",
        "lexicalTokens",
        "normalizedQueryPhrase",
        "originalSurface",
        "prefixCompletion",
        "raw",
        "standaloneRecall",
        "tokens",
        "topicalRecall",
      ].sort()
    );
    expect(row.explanation.features.exactTitleMatch).toBe(true);
    expect(row.explanation.lexical?.normalizedQueryPhrase).toEqual(expect.any(String));
    expect(row.explanation.contextualPrefix).toBeUndefined();
    expect(Array.isArray(detailed.meta.constraintCycles)).toBe(true);
    expect(detailed.meta.query.raw).toBe("information notes");
  });

  test("occupancy, identity, prefix recall, and completion keep distinct diagnostic payloads", async () => {
    const engine = await compiledEngine();

    const occupied = engine.searchDetailed("machine learning", { limit: 5, relatedLimit: 0, explain: true }).results[0];
    expect(occupied.explanation.query.configuredSequenceIntent?.key).toBe("ml");
    expect(occupied.explanation.query.configuredContentIdentity?.key).toBe("ml");
    expect(occupied.explanation.query.configuredPrefixRecall).toBeNull();

    const identity = engine.searchDetailed("what is rpc", { limit: 5, relatedLimit: 0, explain: true }).results[0];
    expect(identity.explanation.query.configuredSequenceIntent).toBeNull();
    expect(identity.explanation.query.configuredContentIdentity?.key).toBe("rpc");

    const weak = engine.searchDetailed("national", { limit: 5, relatedLimit: 0, explain: true }).results[0];
    expect(weak.explanation.query.configuredPrefixRecall?.key).toBe("nist");
    expect(weak.explanation.query.configuredSequenceIntent).toBeNull();
    expect(weak.explanation.query.configuredPrefixRecall.form).toEqual([
      "national",
      "institute",
      "standards",
      "technology",
    ]);

    const bound = engine.searchDetailed("machine l", { limit: 5, relatedLimit: 0, explain: true }).results[0];
    expect(bound.explanation.query.contextualCompletion?.source).toBe("configured-form-prefix");
    expect(bound.explanation.query.tokens.at(-1).surface).toMatch(/^l/);

    const prefix = engine.searchDetailed("open interfa", { limit: 5, relatedLimit: 0, explain: true }).results[0];
    expect(prefix.explanation.query.prefixCompletion?.activePrefix).toBe("interfa");
    expect(prefix.explanation.query.alternatives.length).toBeGreaterThan(0);
  });

  test("relationship, version, and equivalent-recall diagnostics stay on explanation.query", async () => {
    const relatedEngine = await compiledEngine({
      relationshipStrategy: "hybrid",
      documentRelationships: graph,
    });
    const related = relatedEngine.searchDetailed("machine learning", { limit: 5, relatedLimit: 5, explain: true });
    const neighbor = related.related.find((row) => row.id === "neighbor") || related.results.find((row) => row.id === "neighbor");
    expect(neighbor).toBeTruthy();
    expect(neighbor.relevanceKind).toBe("related");
    expect(neighbor.relationship.sourceId).toBe("ml");
    expect(neighbor.explanation.relationship.sourceId).toBe("ml");
    expect(neighbor.retrievalSources).toEqual(expect.any(Array));

    const dotted = relatedEngine.searchDetailed("1.2 vulnerability", { limit: 5, relatedLimit: 0, explain: true }).results[0];
    expect(dotted.explanation.query.raw).toBe("1.2 vulnerability");
    expect(dotted.explanation.query.tokens.map((t) => t.normalized)).toEqual(["1", "2", "vulnerability"]);

    const equivalent = relatedEngine.searchDetailed("qa", { limit: 5, relatedLimit: 0, explain: true });
    const recalled = equivalent.results.find((row) => row.id === "load");
    expect(recalled.explanation.query.equivalentRecall).toEqual([{ source: "qa", target: "testing" }]);
    expect(recalled.explanation.query.concepts.some((concept) => concept.provenance === "equivalent-recall")).toBe(true);
    expect(recalled.explanation.query.concepts.every((concept) => concept.provenance !== "synonym")).toBe(true);
  });

  test("packed public rows match diagnostic searchDetailed without explanation payloads", async () => {
    const engine = await compiledEngine();
    const packed = engine.search("information notes", { limit: 5, relatedLimit: 0 });
    expect(engine.lastSearchMeta.rankingEvidence).toBe("packed");
    const detailed = engine.searchDetailed("information notes", { limit: 5, relatedLimit: 0, explain: true });
    expect(engine.lastSearchMeta.rankingEvidence).not.toBe("packed");
    expect(packed.map(publicRow)).toEqual(detailed.results.map(publicRow));
    expect(packed[0].explanation).toBeUndefined();
    expect(packed[0].features).toBeUndefined();
    expect(detailed.results[0].explanation.query.raw).toBe("information notes");
    expect(detailed.results[0].features.exactTitleMatch).toBe(true);
    const asyncRows = await engine.searchAsync("information notes", { limit: 5, relatedLimit: 0 });
    expect(asyncRows.map(publicRow)).toEqual(packed.map(publicRow));
  });

  test("limit/related slicing and meta timing keys stay present", async () => {
    const engine = await compiledEngine({
      relationshipStrategy: "hybrid",
      documentRelationships: graph,
    });
    const detailed = engine.searchDetailed("machine learning", { limit: 1, relatedLimit: 1, explain: true });
    expect(detailed.results).toHaveLength(1);
    expect(detailed.related.length).toBeLessThanOrEqual(1);
    expect(detailed.results[0].rank).toBe(1);
    for (const key of [
      "retrieveMs",
      "featureMs",
      "relationshipMs",
      "selectionMs",
      "rankMs",
      "totalMs",
      "indexBuildMs",
      "candidateCount",
      "matchCount",
      "relatedCount",
      "constraintCycles",
      "constraintConflicts",
      "relationshipStrategy",
      "retriever",
      "query",
    ]) {
      expect(detailed.meta).toHaveProperty(key);
    }
    expect(typeof detailed.meta.retrieveMs).toBe("number");
    expect(typeof detailed.meta.totalMs).toBe("number");
  });
});
