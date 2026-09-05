/**
 * Public summary contract: phrase / configured / ranking evidence, not a
 * third unigram posting field.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { COMPLETE_INTERPRETATION_COLLECTOR } from "../dist/execution/completeInterpretationCollector.js";
import { buildQueryPlan } from "../dist/query/queryPlan.js";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

const docs = [
  {
    id: "a",
    title: "Unrelated Title Alpha",
    summary: "zebulon",
    body: "Unrelated body text about widgets.",
  },
  {
    id: "b",
    title: "Unrelated Title Beta",
    summary: "completely different abstract",
    body: "Also unrelated.",
  },
  {
    id: "phrase-summary",
    title: "Unrelated Title Gamma",
    summary: "keldor vinta plomex",
    body: "No phrase here.",
  },
  {
    id: "configured-summary",
    title: "Unrelated Title Delta",
    summary: "appsec",
    body: "No configured key in body or title.",
  },
];

const MODES = ["full-scan", "indexed", "adaptive"];

function titles(engine, q, extra = {}) {
  return engine.search(q, { limit: 10, ...extra }).map((h) => h.id);
}

describe("summary is not a unigram posting field", () => {
  const engines = {};

  beforeAll(async () => {
    const compiled = compileAuthoredRelevance({
      configuredConcepts: [{ key: "appsec", aliases: [["application", "security"]] }],
    });
    const plugins = [morphology(), ...compiled.plugins];
    for (const retriever of MODES) {
      const engine = SearchEngine.create({
        schema,
        plugins,
        retriever,
        relationshipStrategy: "none",
      });
      await engine.index(docs);
      engines[retriever] = engine;
    }
  });

  test.each(MODES)("%s does not retrieve a summary-only unigram", (mode) => {
    const engine = engines[mode];
    const ids = titles(engine, "zebulon");
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
    const plan = buildQueryPlan(engine._prepareQuery("zebulon"), engine._index);
    expect(plan.exactHits).toEqual([]);
    expect(plan.typedTokens).toEqual(["zebulon"]);
  });

  test.each(MODES)("%s retrieves a summary-only multi-token exact phrase", (mode) => {
    const engine = engines[mode];
    expect(titles(engine, "keldor vinta plomex")).toContain("phrase-summary");
    const plan = buildQueryPlan(engine._prepareQuery("keldor vinta plomex"), engine._index);
    expect(plan.exactHits.map((h) => h.document.id)).toContain("phrase-summary");
    expect(plan.exactHits.find((h) => h.document.id === "phrase-summary").summaryFrequency).toBeGreaterThan(0);
  });

  test.each(MODES)("%s does not retrieve a summary-only configured key unigram", (mode) => {
    const engine = engines[mode];
    expect(titles(engine, "appsec")).not.toContain("configured-summary");
  });

  test.each(MODES)("%s collector still cannot mint a summary-only unigram", (mode) => {
    const engine = engines[mode];
    const ids = titles(engine, "zebulon", { resultCollector: COMPLETE_INTERPRETATION_COLLECTOR });
    expect(ids).not.toContain("a");
  });
});
