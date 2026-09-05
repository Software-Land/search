import { morphology, SearchEngine } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { extractFeatures } from "../dist/features.js";
import { matchContextualTitlePrefix } from "../dist/retrieval/retrieve.js";
import { buildIndex } from "../dist/indexing/indexDocuments.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const docs = [
  { id: "api", title: "What is an API?", body: "interfaces" },
  { id: "code", title: "What is Code?", body: "source" },
  { id: "clean", title: "What is Clean Code?", body: "style" },
  { id: "container", title: "What is a Container?", body: "runtime" },
  { id: "cicd", title: "CI/CD", body: "c pipelines continuous integration c" },
  { id: "edge", title: "Edge Computing", body: "c computing at the edge c" },
  { id: "cloud", title: "What is the Cloud?", body: "hosted infrastructure" },
  { id: "migration", title: "What is Cloud Migration?", body: "moving workloads" },
  { id: "dist", title: "What are Distributed Systems?", body: "clusters" },
  { id: "data", title: "What is a Data Structure? (Set Diagram)", body: "sets" },
  { id: "ml", title: "Linear vs Logistic Regression", body: "machine learning machine learning" },
  { id: "learn", title: "LinkedIn Learning Review", body: "courses" },
];

const appsecDict = [
  {
    key: "appsec",
    aliases: [["application", "security"], ["app", "sec"],
      ["app", "security"],],
  },
];

async function engine() {
  const e = SearchEngine.create({
    schema,
    plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: appsecDict })],
    relationshipStrategy: "hybrid",
  });
  await e.index(docs.concat([{ id: "appsec", title: "App Sec", body: "application security practices" }]));
  return e;
}

describe("contextual title-sequence prefix", () => {
  test("what is an ap completes api with named explain fields", async () => {
    const e = await engine();
    const detailed = e.searchDetailed("what is an ap", { limit: 5, explain: true });
    expect(detailed.results[0].id).toBe("api");
    const api = detailed.results[0];
    expect(api.features.contextualTitlePrefix).toBe(true);
    expect(api.features.matchedPrefixTokens).toEqual(["what", "is", "an"]);
    expect(api.features.activeFinalPrefix).toBe("ap");
    expect(api.features.completedTitleToken).toBe("api");
    expect(api.features.contextualPrefixQuality).toBeGreaterThan(0);
    expect(api.explanation.contextualPrefix.activeFinalPrefix).toBe("ap");
    expect(api.directClass).not.toBe("none");
  });

  test("what is c ranks the tightest title completion first", async () => {
    const e = await engine();
    const detailed = e.searchDetailed("what is c", { limit: 12, explain: true });
    const titles = detailed.results.map((r) => r.title);
    expect(titles[0]).toBe("What is Code?");
    expect(titles.slice(0, 3)).toContain("What is Clean Code?");
    const cicdRank = titles.indexOf("CI/CD");
    const edgeRank = titles.indexOf("Edge Computing");
    expect(cicdRank).toBeGreaterThan(0);
    expect(edgeRank).toBeGreaterThan(0);

    const code = detailed.results[0];
    expect(code.features.contextualTitlePrefix).toBe(true);
    expect(code.features.completedTitleToken).toBe("code");
    expect(code.features.unmatchedTitleTokensAfter).toBe(0);
    expect(code.directClass).toBe("moderate");
    expect(code.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "contextual-title-prefix-over-unaligned", class: "absolute" }),
      ])
    );

    const clean = detailed.results.find((r) => r.title === "What is Clean Code?");
    expect(clean.features.contextualTitlePrefix).toBe(true);
    expect(clean.features.completedTitleToken).toBe("clean");
    expect(clean.features.unmatchedTitleTokensAfter).toBeGreaterThan(code.features.unmatchedTitleTokensAfter);
    expect(clean.features.contextualPrefixQuality).toBeLessThan(code.features.contextualPrefixQuality);
  });

  test("what is a c / co retrieve container without relaxing token boundaries", async () => {
    const e = await engine();
    expect(e.search("what is a c", { limit: 3 })[0].title).toBe("What is a Container?");
    expect(e.search("what is a co", { limit: 3 })[0].title).toBe("What is a Container?");
    const data = e.searchDetailed("what is a c", { limit: 5, explain: true }).results.find((r) => r.id === "data");
    expect(data?.features.contextualTitlePrefix).not.toBe(true);
  });

  test("standalone short stubs do not gain broad prefix matching", async () => {
    const e = await engine();
    for (const query of ["ap", "c", "co"]) {
      const detailed = e.searchDetailed(query, { limit: 8, explain: true });
      for (const row of detailed.results) {
        expect(row.features.contextualTitlePrefix).toBe(false);
        expect(row.features.contextualPrefixQuality || 0).toBe(0);
      }
    }
  });

  test("unrelated preceding context does not unlock a short final prefix", async () => {
    const index = buildIndex(docs, schema, [morphology()]);
    const q = analyzeQuery("machine ap", { plugins: [morphology()] });
    const api = index.documents.find((d) => d.id === "api");
    expect(matchContextualTitlePrefix(q, api)).toBeNull();
    const f = extractFeatures(q, api);
    expect(f.contextualTitlePrefix).toBe(false);

    const machineC = analyzeQuery("machine c", { plugins: [morphology()] });
    const code = index.documents.find((d) => d.id === "code");
    expect(matchContextualTitlePrefix(machineC, code)).toBeNull();
    expect(extractFeatures(machineC, code).contextualTitlePrefix).toBe(false);
  });
});

describe("compound segmentation uses vocabulary, not a hardcoded glue map", () => {
  test("configured-concept-supported app+security split survives a longer key prefix", () => {
    const q = analyzeQuery("appsecurity", {
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: appsecDict })],
    });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["app", "security"]);
    expect(q.alternatives.some((a) => a.source === "compound-segment")).toBe(true);
  });

  test("appsecurity retrieves App Sec via generic segmentation", async () => {
    const e = await engine();
    const detailed = e.searchDetailed("appsecurity", { limit: 5, explain: true });
    expect(detailed.results.map((r) => r.title)).toContain("App Sec");
    expect(detailed.results[0].title).toBe("App Sec");
  });
});
