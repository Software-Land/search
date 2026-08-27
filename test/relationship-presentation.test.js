import { morphology, SearchEngine } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { classifyDirect } from "../dist/features.js";
import { analyzeQuery } from "../dist/analyze.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const docs = [
  { id: "tls-config", title: "TLS Configuration", body: "tls certificates" },
  { id: "vpn", title: "VPN Settings", body: "virtual private network" },
  { id: "noise", title: "Process vs Thread", body: "tls is mentioned once in passing" },
  { id: "unrelated", title: "Monotonic Stack", body: "stack algorithm" },
];

const graph = {
  format: "search-v2-relationships",
  version: 1,
  relationships: {
    "tls-config": [{ target: "vpn", type: "semantic", strength: 0.8, provenance: "test" }],
  },
};

const plugins = [morphology(), dictionary({ entries: [{ key: "tls", aliases: [["transport", "layer", "security"]]}] })];

describe("direct classes", () => {
  test("exact title is strong; body-only is weak; related is none", async () => {
    const engine = SearchEngine.create({ schema, plugins, documentRelationships: graph });
    await engine.index(docs);
    const { results, related } = engine.searchDetailed("TLS Configuration", { limit: 10, explain: true });
    expect(results[0].directClass).toBe("strong");
    expect(results[0].relevanceKind).toBe("direct");
    const noise = results.find((r) => r.id === "noise") || related.find((r) => r.id === "noise");
    if (noise && noise.relevanceKind === "direct") {
      expect(["weak", "moderate"]).toContain(noise.directClass);
    }
  });

  test("classifyDirect is named-feature based, not a float", () => {
    expect(
      classifyDirect({
        exactTitleMatch: true,
        queryCoverage: 1,
        titlePrefixQuality: 1,
      })
    ).toBe("strong");
    expect(
      classifyDirect({
        exactTitleMatch: false,
        bodyLexicalMatch: 1,
        queryCoverage: 0,
        titlePrefixQuality: 0,
      })
    ).toBe("weak");
  });
});

describe("relationship presentation", () => {
  async function engine() {
    const e = SearchEngine.create({ schema, plugins, documentRelationships: graph });
    await e.index(docs);
    return e;
  }

  test("search() remains an array and default hybrid includes related", async () => {
    const e = await engine();
    const results = e.search("tls", { limit: 10, explain: true });
    expect(Array.isArray(results)).toBe(true);
    expect(results[0].title).toBe("TLS Configuration");
    expect(results.find((r) => r.id === "vpn")?.relevanceKind).toBe("related");
  });

  test("separate channel keeps related out of results", async () => {
    const e = await engine();
    const { results, related } = e.searchDetailed("tls", { limit: 10, explain: true, relationshipStrategy: "separate", relatedLimit: 5 });
    expect(results[0].title).toBe("TLS Configuration");
    expect(results.every((r) => r.relevanceKind !== "related")).toBe(true);
    expect(related.some((r) => r.id === "vpn")).toBe(true);
    expect(related[0].explanation.relationship.sourceTitle).toBe("TLS Configuration");
    expect(related[0].explanation.relationship.rank).toBe(1);
  });

  test("hybrid lets related outrank a weak body-only direct", async () => {
    const e = await engine();
    const { results } = e.searchDetailed("tls", { limit: 10, explain: true, relationshipStrategy: "hybrid" });
    expect(results[0].title).toBe("TLS Configuration");
    expect(results[0].relevanceKind).toBe("direct");
    const vpnRank = results.findIndex((r) => r.id === "vpn");
    const noiseRank = results.findIndex((r) => r.id === "noise");
    expect(vpnRank).toBeGreaterThan(0);
    if (noiseRank !== -1) expect(vpnRank).toBeLessThan(noiseRank);
  });

  test("zero graph still works", async () => {
    const e = SearchEngine.create({ schema, plugins });
    await e.index(docs);
    const { results, related } = e.searchDetailed("tls", { relationshipStrategy: "hybrid" });
    expect(results[0].title).toBe("TLS Configuration");
    expect(related).toEqual([]);
  });

  test("relationships are not synonyms", () => {
    const q = analyzeQuery("tls", { plugins });
    expect(q.concepts.some((c) => (c.forms || []).includes("vpn"))).toBe(false);
  });
});
