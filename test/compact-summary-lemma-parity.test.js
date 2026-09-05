/**
 * Compact / compiled-index summaryLemmas must use the same lemma map as
 * analyzed IndexedDocument. Summary remains phrase/configured/ranking evidence
 * only — this does not add summary unigram candidate generation.
 *
 * Lemma mapping is the supported English table entry `libraries` → `library`
 * (DEFAULT_LEMMAS and Software.Land lemmas.json).
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { compileLexicalIndex } from "../dist/indexing/lexicalIndex.js";
import { extractFeatures } from "../dist/features.js";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

const docs = [
  {
    id: "lemma-summary",
    title: "Zebulon Notes",
    summary: "software libraries",
    body: "unrelated widget remarks",
  },
  {
    id: "distractor",
    title: "Garden Primer",
    summary: "soil and water",
    body: "horticulture notes",
  },
];

const QUERY = "software library";

function createMode(mode) {
  const compiled = compileAuthoredRelevance({
    configuredConcepts: [{ key: "sl", aliases: [["software", "library"]] }],
  });
  const plugins = [morphology({ lemmas: { libraries: "library" } }), ...compiled.plugins];
  const options = {
    schema,
    plugins,
    relationshipStrategy: "none",
  };
  if (mode === "full-scan") {
    return SearchEngine.create({ ...options, retriever: "full-scan" });
  }
  if (mode === "indexed") {
    return SearchEngine.create({ ...options, retriever: "indexed" });
  }
  if (mode === "indexed-artifact") {
    const artifact = compileLexicalIndex(docs, { schema, plugins });
    return SearchEngine.create({
      ...options,
      retriever: "indexed",
      lexicalIndex: artifact,
    });
  }
  if (mode === "adaptive-indexed") {
    return SearchEngine.create({
      ...options,
      retriever: "adaptive",
      adaptive: { documentThreshold: 1 },
    });
  }
  return SearchEngine.create({ ...options, retriever: "adaptive" });
}

const MODES = ["full-scan", "indexed", "indexed-artifact", "adaptive-indexed", "adaptive"];

function publicSnapshot(engine, queryText) {
  return engine.search(queryText, { limit: 10, explain: true }).map((hit) => ({
    id: hit.id,
    title: hit.title,
    score: hit.score,
    relevanceKind: hit.relevanceKind,
    directClass: hit.directClass ?? null,
    configuredConceptFieldEvidence: hit.features?.configuredConceptFieldEvidence ?? null,
  }));
}

function relevantFeatures(engine, queryText, id) {
  const query = engine._prepareQuery(queryText);
  const doc = engine._index.byId.get(id);
  const f = extractFeatures(query, doc);
  return {
    configuredConceptMatch: f.configuredConceptMatch,
    configuredConceptFieldEvidence: f.configuredConceptFieldEvidence,
    exactTitleOrSummaryPhrase: f.exactTitleOrSummaryPhrase,
    directClass: f.directClass,
  };
}

describe("compact summary lemma parity", () => {
  const engines = {};

  beforeAll(async () => {
    for (const mode of MODES) {
      engines[mode] = createMode(mode);
      await engines[mode].index(docs);
    }
  });

  test("every mode hydrates summaryLemmas independently of summaryTokens", () => {
    for (const mode of MODES) {
      const doc = engines[mode]._index.byId.get("lemma-summary");
      expect({ mode, tokens: [...doc.summaryTokens], lemmas: [...doc.summaryLemmas] }).toEqual({
        mode,
        tokens: ["software", "libraries"],
        lemmas: ["software", "library"],
      });
      expect([...doc.summaryLemmaSet]).toEqual(["software", "library"]);
      expect(doc.title.toLowerCase()).not.toMatch(/software|librar/);
      expect(doc.body.toLowerCase()).not.toMatch(/software|librar/);
    }
  });

  test("summary is the only field providing configured-form evidence", () => {
    const baseline = relevantFeatures(engines["full-scan"], QUERY, "lemma-summary");
    expect(baseline.configuredConceptFieldEvidence).toEqual({
      title: false,
      summary: "form",
      body: false,
    });
    for (const mode of MODES) {
      expect({ mode, ...relevantFeatures(engines[mode], QUERY, "lemma-summary") }).toEqual({
        mode,
        ...baseline,
      });
      const distractor = relevantFeatures(engines[mode], QUERY, "distractor");
      expect(distractor.configuredConceptFieldEvidence).toEqual({
        title: false,
        summary: false,
        body: false,
      });
    }
  });

  test("public results are identical across full-scan, indexed, compiled artifact, and adaptive", () => {
    const baseline = publicSnapshot(engines["full-scan"], QUERY);
    for (const mode of MODES.slice(1)) {
      expect({ mode, hits: publicSnapshot(engines[mode], QUERY) }).toEqual({ mode, hits: baseline });
    }
  });
});
