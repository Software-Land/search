/**
 * Occupied one-token first-form prefixes must not erase typed title-prefix
 * evidence. `integ` may still uniquely occupy IDE among configured forms;
 * a title that begins with Integrity must still rank first.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/analyze.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const dict = [{ key: "ide", aliases: [["integrated", "development", "environment"]] }];

const docs = [
  {
    id: "integrity",
    title: "Integrity Is Not Obedience",
    body: "integrity is a property of systems and people, not mere compliance",
  },
  {
    id: "framework",
    title: "Framework vs Library vs Package",
    body: "the framework may search for code and call it ide support",
  },
  {
    id: "refactoring",
    title: "What is Refactoring?",
    body: "ide tools help propagate a method rename",
  },
  {
    id: "cicd",
    title: "CI/CD",
    body: "a large codebase takes longer to index in developer ides",
  },
  {
    id: "generative",
    title: "Generative Coding",
    body: "autocomplete directly in your ide from an llm",
  },
  {
    id: "idempotency",
    title: "Idempotency Keys",
    body: "retry the same logical operation without duplicating side effects",
  },
];

const plugins = [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: dict })];

async function engine(retriever = "full-scan") {
  const e = SearchEngine.create({ schema, plugins, retriever });
  await e.index(docs);
  return e;
}

function titles(e, query, limit = 6) {
  return e.search(query, { limit }).map((row) => row.title);
}

describe("typed title prefix under one-token first-form occupancy", () => {
  test("integ still occupies IDE among configured forms", () => {
    const q = analyzeQuery("integ", { plugins });
    expect(q.tokens.map((t) => t.surfaceNormalized || t.surface)).toEqual(["integ"]);
    expect(q.configuredSequenceIntent?.key).toBe("ide");
    expect(q.configuredSequenceIntent?.matchedForm).toEqual(["integrated", "development", "environment"]);
  });

  test("a title beginning with Integrity ranks #1 for integ", async () => {
    const e = await engine();
    expect(titles(e, "integ", 1)).toEqual(["Integrity Is Not Obedience"]);
    const detailed = e.searchDetailed("integ", { limit: 6, explain: true });
    expect(detailed.results.map((row) => row.title)[0]).toBe("Integrity Is Not Obedience");
    const integrity = detailed.results[0];
    expect(integrity.id).toBe("integrity");
    expect(integrity.features.typedSurfaceTitleMatch).toBe(true);
    expect(integrity.features.titlePrefixQuality).toBeGreaterThan(0.5);
    expect(["moderate", "strong"]).toContain(integrity.directClass);
    const decoys = detailed.results.filter((row) => row.id !== "integrity");
    expect(decoys.length).toBeGreaterThan(0);
    for (const decoy of decoys) {
      expect(decoy.features.titlePrefixQuality || 0).toBeLessThan(integrity.features.titlePrefixQuality);
      expect(decoy.directClass).not.toBe("strong");
    }
  });

  test("indexed retrieval agrees with full-scan on integ", async () => {
    const full = await engine("full-scan");
    const indexed = await engine("indexed");
    expect(titles(indexed, "integ", 6)).toEqual(titles(full, "integ", 6));
  });
});
