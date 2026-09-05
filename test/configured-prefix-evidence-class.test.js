/**
 * Generic 1/3 vs 2/3 vs 3/3 configured-expansion evidence class.
 * Independent of Software.Land / FPS.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const plugins = [
  morphology(),
  compileConfiguredConceptPlugin({ configuredConcepts: [
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

  test("2/3 exact left prefix uniquely occupies xyz with matched-form coverage 2/3", () => {
    const q = analyzeQuery("alpha beta", { plugins });
    const xyz = q.concepts.find((c) => c.kind === "configured-concept" && c.id === "xyz");
    expect(xyz).toMatchObject({
      provenance: "partial-form",
      matchedFormTokens: 2,
      formTokenCount: 3,
      formCoverage: 0.6667,
    });
    expect(q.concepts.some((c) => c.id === "abc")).toBe(false);

    const keyHit = hit(engine, "alpha beta", "xyz-key");
    const fullHit = hit(engine, "alpha beta gamma", "xyz-key");
    expect(keyHit).toBeTruthy();
    expect(fullHit).toBeTruthy();
    expect(keyHit.features.configuredConceptMatch).toBe("key-in-title");
    expect(keyHit.features.configuredFormCoverage).toBe(0.6667);

    const prefixTitle = hit(engine, "alpha beta", "xyz-prefix-title");
    expect(prefixTitle).toBeTruthy();
    expect(prefixTitle.features.configuredFormEvidence).toBeGreaterThanOrEqual(2 / 3);
    expect(prefixTitle.features.configuredFormCoverage).toBe(0.6667);

    const body = hit(engine, "alpha beta", "xyz-body");
    expect(body).toBeTruthy();
    expect(body.features.configuredConceptMatch).toBe(false);
    expect(body.features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(body.features.configuredFormCoverage).toBe(0.6667);
    expect(body.features.bodyLexicalMatch).toBeGreaterThan(0);
  });

  test("3/3 exact expansion keeps existing stronger title-expansion classification", () => {
    const q = analyzeQuery("alpha beta gamma", { plugins });
    const xyz = q.concepts.find((c) => c.kind === "configured-concept" && c.id === "xyz");
    expect(xyz.formCoverage).toBe(1);
    expect(xyz.kind).toBe("configured-concept");
    expect(q.concepts.every((c) => c.kind !== "acronym")).toBe(true);
    const full = hit(engine, "alpha beta gamma", "xyz-full");
    expect(full).toBeTruthy();
    expect(full.features.configuredConceptMatch).toBe("form");
    expect(full.features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(["moderate", "strong"]).toContain(full.directClass);
    expect(full.directClass).not.toBe("weak");
    const key = hit(engine, "xyz", "xyz-key");
    expect(key.features.configuredConceptMatch).toBe("key-in-title");
    expect(key.features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(key.directClass).toBe("strong");
  });
});
