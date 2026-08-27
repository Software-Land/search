/**
 * Generic 1/3 vs 2/3 vs 3/3 configured-expansion evidence class.
 * Independent of Software.Land / FPS.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { analyzeQuery } from "../dist/analyze.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const plugins = [
  morphology(),
  dictionary({
    entries: [
      { key: "xyz", aliases: [["alpha", "beta", "gamma"]] },
      { key: "abc", aliases: [["alpha", "delta", "epsilon"]] },
    ],
  }),
];

const docs = [
  { id: "xyz-key", title: "XYZ", body: "key document" },
  { id: "xyz-full", title: "Alpha Beta Gamma", body: "full expansion title" },
  { id: "xyz-prefix-title", title: "Alpha Beta Notes", body: "two expansion tokens in the title" },
  { id: "xyz-body", title: "Unrelated Heading", body: "mentions alpha beta gamma in the body" },
  { id: "xyz-key-body", title: "Key Only Body", body: "mentions xyz without the expansion phrase" },
  { id: "alpha-only", title: "Alpha Only", body: "alpha without the rest of either expansion" },
];

function hit(engine, query, id) {
  return engine.searchDetailed(query, { limit: 10, explain: true }).results.find((row) => row.id === id);
}

describe("configured expansion prefix evidence class", () => {
  let engine;

  beforeAll(async () => {
    engine = SearchEngine.create({ schema, plugins, retriever: "full-scan" });
    await engine.index(docs);
  });

  test("1/3 of a three-token expansion does not occupy or grant moderate configured evidence", () => {
    const q = analyzeQuery("alpha", { plugins });
    expect(q.concepts.some((c) => c.kind === "configured-concept")).toBe(false);
    const only = hit(engine, "alpha", "alpha-only");
    expect(only).toBeTruthy();
    expect(only.directClass).not.toBe("moderate");
    const body = hit(engine, "alpha", "xyz-body");
    if (body) expect(body.directClass).not.toBe("moderate");
  });

  test("2/3 exact left prefix uniquely occupies xyz and is moderate on prefix-title and body evidence", () => {
    const q = analyzeQuery("alpha beta", { plugins });
    const xyz = q.concepts.find((c) => c.kind === "configured-concept" && c.id === "xyz");
    expect(xyz).toMatchObject({
      provenance: "partial-expansion",
      matchedExpansionTokens: 2,
      expansionTokenCount: 3,
      expansionCoverage: 0.6667,
    });
    expect(q.concepts.some((c) => c.id === "abc")).toBe(false);

    const prefixTitle = hit(engine, "alpha beta", "xyz-prefix-title");
    expect(prefixTitle).toBeTruthy();
    expect(prefixTitle.directClass).toBe("moderate");
    expect(prefixTitle.features.expansionEvidence).toBeGreaterThanOrEqual(2 / 3);
    expect(prefixTitle.features.configuredExpansionCoverage).toBe(0.6667);

    const body = hit(engine, "alpha beta", "xyz-body");
    expect(body).toBeTruthy();
    expect(body.directClass).toBe("moderate");
    expect(body.features.configuredConceptMatch).toBe(false);
    expect(body.features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(body.features.configuredExpansionCoverage).toBe(0.6667);
    expect(body.features.configuredExpansionBodyMatch).toBe(true);
    expect(body.features.bodyLexicalMatch).toBeGreaterThan(0);

    const keyOnly = hit(engine, "alpha beta", "xyz-key-body");
    if (keyOnly) {
      expect(keyOnly.features.configuredExpansionBodyMatch).toBe(false);
      expect(keyOnly.directClass).not.toBe("moderate");
    }
  });

  test("3/3 exact expansion keeps existing stronger title-expansion classification", () => {
    const q = analyzeQuery("alpha beta gamma", { plugins });
    const xyz = q.concepts.find((c) => c.kind === "configured-concept" && c.id === "xyz");
    expect(xyz.expansionCoverage).toBe(1);
    expect(xyz.kind).toBe("configured-concept");
    expect(q.concepts.every((c) => c.kind !== "acronym")).toBe(true);
    const full = hit(engine, "alpha beta gamma", "xyz-full");
    expect(full).toBeTruthy();
    expect(full.features.configuredConceptMatch).toBe("expansion");
    expect(full.features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(["moderate", "strong"]).toContain(full.directClass);
    expect(full.directClass).not.toBe("weak");
    const key = hit(engine, "xyz", "xyz-key");
    expect(key.features.configuredConceptMatch).toBe("key-in-title");
    expect(key.features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(key.directClass).toBe("strong");
  });
});
