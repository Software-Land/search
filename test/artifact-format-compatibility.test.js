import { ARTIFACT_FORMATS, SearchEngine, parseRelationships } from "../dist/index.js";
import { assertArtifact } from "../dist/artifacts.js";
import {
  LEXICAL_FREQUENCY_FORMAT,
  LEXICAL_INDEX_FORMAT,
  attachLexicalFrequency,
  compileLexicalFrequency,
  compileLexicalIndex,
} from "../tools/search-lexical/index.js";
import { CONFIGURED_CONCEPT_FORMAT, compileCorpus, parseConfiguredConcepts } from "../tools/search-corpus/index.js";
import { spellingTerms } from "../tools/search-corpus/lib/vocabulary.js";
import { compileRelationships } from "../tools/search-relationships/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const docs = [
  { id: "alpha", title: "Alpha guide", body: "alpha appears here" },
  { id: "beta", title: "Beta notes", body: "neighbor text" },
];

const conceptArtifact = {
  format: "search-configured-concepts",
  version: 1,
  entries: [{ key: "alpha", aliases: [["guide"]] }],
  compileWarnings: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withoutTimings(value) {
  if (Array.isArray(value)) return value.map(withoutTimings);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith("Ms")) continue;
      out[key] = withoutTimings(child);
    }
    return out;
  }
  return value;
}

function explained(engine, query) {
  return withoutTimings(engine.searchDetailed(query, { limit: 5, relatedLimit: 5, explain: true }));
}

describe("artifact format identifiers", () => {
  test("writers emit canonical identifiers and schema version 1", () => {
    const lexical = compileLexicalIndex(docs, { schema });
    const frequency = compileLexicalFrequency(docs);
    const corpus = compileCorpus({ documents: docs });
    const relationships = compileRelationships({ documents: docs });
    expect(lexical.format).toBe("search-lexical-index");
    expect(lexical.format).toBe(LEXICAL_INDEX_FORMAT);
    expect(lexical.version).toBe(1);
    expect(frequency.format).toBe("search-lexical-frequency");
    expect(frequency.format).toBe(LEXICAL_FREQUENCY_FORMAT);
    expect(frequency.version).toBe(1);
    expect(corpus.configuredConceptArtifact.format).toBe("search-configured-concepts");
    expect(corpus.configuredConceptArtifact.format).toBe(CONFIGURED_CONCEPT_FORMAT);
    expect(corpus.configuredConceptArtifact.version).toBe(1);
    expect(corpus.vocabulary.format).toBe("search-vocabulary");
    expect(corpus.vocabulary.version).toBe(1);
    expect(relationships.runtime.format).toBe("search-relationships");
    expect(relationships.runtime.version).toBe(1);
    expect(ARTIFACT_FORMATS).toEqual({
      relationships: "search-relationships",
      corpusStats: "search-corpus-stats",
      lexicalIndex: "search-lexical-index",
    });
  });

  test("relationship readers accept both spellings and leave the caller object unchanged", () => {
    const payload = {
      relationships: {
        alpha: [{ target: "beta", type: "editorial", strength: 1, provenance: "manual" }],
      },
    };
    const canonical = { format: "search-relationships", version: 1, ...clone(payload) };
    const legacy = { format: "search-v2-relationships", version: 1, ...clone(payload) };
    const parsedCanonical = parseRelationships(canonical);
    const parsedLegacy = parseRelationships(legacy);
    expect(parsedCanonical).toEqual(parsedLegacy);
    expect(parsedLegacy.format).toBe("search-relationships");
    expect(parsedLegacy.version).toBe(1);
    expect(legacy.format).toBe("search-v2-relationships");
    expect(canonical.format).toBe("search-relationships");
    expect(() => parseRelationships({ format: "search-relationships", relationships: {} })).toThrow(/version/);
    expect(() => parseRelationships({ format: "search-v2-relationships", relationships: {} })).toThrow(/version/);
    expect(() => parseRelationships({ format: "search-relationships", version: 2, relationships: {} })).toThrow(/schema version/);
    expect(() => parseRelationships({ format: "search-v2-relationships", version: 2, relationships: {} })).toThrow(/schema version/);
    expect(() => parseRelationships({ format: "search-relationships-domain", version: 1, relationships: {} })).toThrow(/format/);
    expect(() => parseRelationships({ format: "search-equivalences", version: 1, relationships: {} })).toThrow(/format/);
    expect(() => parseRelationships({ format: "search-v2-equivalences", version: 1, relationships: {} })).toThrow(/format/);
    expect(() => parseRelationships({ format: "search-synonyms", version: 1, relationships: {} })).toThrow(/format/);
    expect(() => parseRelationships({ format: "not-an-artifact", version: 1, relationships: {} })).toThrow(/format/);
  });

  test("configured-concept readers accept both spellings and reject removed families", () => {
    const legacy = { ...clone(conceptArtifact), format: "search-v2-configured-concepts" };
    const parsedCanonical = parseConfiguredConcepts(conceptArtifact);
    const parsedLegacy = parseConfiguredConcepts(legacy);
    expect(parsedCanonical).toEqual(parsedLegacy);
    expect(parsedLegacy.format).toBe("search-configured-concepts");
    expect(legacy.format).toBe("search-v2-configured-concepts");
    for (const format of ["search-configured-concepts", "search-v2-configured-concepts"]) {
      expect(() => parseConfiguredConcepts({ format, version: 2, entries: [] })).toThrow(/schema version/);
      expect(() =>
        parseConfiguredConcepts({
          format,
          version: 1,
          entries: [{ key: "alpha", expansion: ["guide"] }],
        })
      ).toThrow(/expansion/);
    }
    for (const format of ["search-v2-equivalences", "search-equivalences", "search-v2-synonyms", "search-synonyms"]) {
      expect(() => parseConfiguredConcepts({ format, version: 1, entries: [] })).toThrow(new RegExp(format));
    }
    expect(() => parseConfiguredConcepts({ format: "search-concepts", version: 1, entries: [] })).toThrow(/format/);
  });

  test("lexical-index, frequency, vocabulary, and corpus-stats aliases keep the same payload behavior", async () => {
    const lexical = compileLexicalIndex(docs, { schema });
    const legacyLexical = { ...clone(lexical), format: "search-v2-lexical-index" };
    const relationships = {
      format: "search-relationships",
      version: 1,
      relationships: {
        alpha: [{ target: "beta", type: "editorial", strength: 1, provenance: "manual" }],
      },
    };
    async function engineFor(lexicalIndex, documentRelationships) {
      const engine = SearchEngine.create({
        schema,
        lexicalIndex,
        documentRelationships,
        retriever: "indexed",
      });
      await engine.index(docs);
      return engine;
    }
    const canonicalEngine = await engineFor(lexical, relationships);
    const mixedEngine = await engineFor(legacyLexical, relationships);
    const legacyEngine = await engineFor(legacyLexical, { ...clone(relationships), format: "search-v2-relationships" });
    expect(legacyLexical.format).toBe("search-v2-lexical-index");
    for (const query of ["alpha", "guide", "beta"]) {
      expect(explained(mixedEngine, query)).toEqual(explained(canonicalEngine, query));
      expect(explained(legacyEngine, query)).toEqual(explained(canonicalEngine, query));
      expect(mixedEngine.search(query, { limit: 5, relatedLimit: 5 })).toEqual(
        canonicalEngine.search(query, { limit: 5, relatedLimit: 5 })
      );
    }
    await expect(
      engineFor({ ...clone(lexical), version: 2 }, null)
    ).rejects.toThrow(/schema version/);
    await expect(
      engineFor({ ...clone(legacyLexical), version: 2 }, null)
    ).rejects.toThrow(/schema version/);
    await expect(
      engineFor({ ...clone(lexical), integrity: "" }, null)
    ).rejects.toThrow(/integrity/);

    const frequency = compileLexicalFrequency(docs);
    const legacyFrequency = { ...clone(frequency), format: "search-v2-lexical-frequency" };
    const attachedCanonical = attachLexicalFrequency(clone(docs), frequency);
    const attachedLegacy = attachLexicalFrequency(clone(docs), legacyFrequency);
    expect(attachedCanonical).toEqual(attachedLegacy);
    expect(legacyFrequency.format).toBe("search-v2-lexical-frequency");
    expect(frequency.format).toBe("search-lexical-frequency");

    const vocabulary = compileCorpus({ documents: docs }).vocabulary;
    const legacyVocabulary = { ...clone(vocabulary), format: "search-v2-vocabulary" };
    expect(spellingTerms(vocabulary)).toEqual(spellingTerms(legacyVocabulary));
    expect(legacyVocabulary.format).toBe("search-v2-vocabulary");

    const stats = { format: "search-corpus-stats", version: 1, stats: { documents: 2 } };
    const legacyStats = { format: "search-v2-corpus-stats", version: 1, stats: { documents: 2 } };
    const readStats = assertArtifact(stats, ARTIFACT_FORMATS.corpusStats);
    const readLegacyStats = assertArtifact(legacyStats, ARTIFACT_FORMATS.corpusStats);
    expect(readStats.format).toBe("search-corpus-stats");
    expect(readLegacyStats.format).toBe("search-corpus-stats");
    expect(readStats.stats).toEqual(readLegacyStats.stats);
    expect(legacyStats.format).toBe("search-v2-corpus-stats");
    expect(() => assertArtifact({ ...stats, version: 2 }, ARTIFACT_FORMATS.corpusStats)).toThrow(/schema version/);
    expect(() => assertArtifact({ ...legacyStats, version: 2 }, ARTIFACT_FORMATS.corpusStats)).toThrow(/schema version/);
    expect(() => assertArtifact({ format: "search-v2-equivalences", version: 1 }, ARTIFACT_FORMATS.corpusStats)).toThrow(/format/);
  });
});
