import { jest } from "@jest/globals";
import { SearchEngine, english, dictionary, isAbortError } from "../src/index.js";
import { analyzeQuery, suggestTypoForms } from "../src/analyze.js";
import { buildIndex } from "../src/indexDocuments.js";
import { pickPrimariesForExpansion } from "../src/relationships.js";
import { retrieveCandidates } from "../src/retrieve.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const plugins = [english(), dictionary({ entries: [] })];

const reversedPrimaryDocs = [
  { id: "a-guide", title: "Bluetooth Guide", body: "A longer guide to bluetooth setup." },
  { id: "z-exact", title: "Bluetooth", body: "A short-range wireless protocol." },
  { id: "a-neighbor", title: "Guide Neighbor", body: "Only related from the guide." },
  { id: "z-neighbor", title: "Exact Neighbor", body: "Only related from the exact title." },
];

const reversedPrimaryGraph = {
  format: "search-v2-relationships",
  version: 1,
  relationships: {
    "a-guide": [{ target: "a-neighbor", type: "editorial", strength: 1, provenance: "manual" }],
    "z-exact": [{ target: "z-neighbor", type: "editorial", strength: 1, provenance: "manual" }],
  },
};

async function reversedPrimaryEngine(opts = {}) {
  const engine = SearchEngine.create({
    schema,
    plugins,
    relationships: reversedPrimaryGraph,
    relationshipStrategy: "separate",
    ...opts,
  });
  await engine.index(reversedPrimaryDocs);
  return engine;
}

function relatedSourceIds(detailed) {
  return [...detailed.results, ...detailed.related]
    .filter((row) => row.relationship)
    .map((row) => row.relationship.sourceId);
}

describe("relationship primary selection", () => {
  test("top1-strong uses Search Core ranking, not document-id order", () => {
    const aGuide = {
      document: { id: "a-guide", title: "Bluetooth Guide" },
      features: {
        relevanceKind: "direct",
        directClass: "strong",
        exactTitleMatch: false,
        queryCoverage: 1,
        titlePrefixQuality: 0.8,
      },
    };
    const zExact = {
      document: { id: "z-exact", title: "Bluetooth" },
      features: {
        relevanceKind: "direct",
        directClass: "strong",
        exactTitleMatch: true,
        queryCoverage: 1,
        titlePrefixQuality: 1,
      },
    };
    const picked = pickPrimariesForExpansion([aGuide, zExact], { sourcePolicy: "top1-strong" });
    expect(picked.map((h) => h.document.id)).toEqual(["z-exact"]);
  });

  test("exact-title outranks reversed ids for relationship source (sync and async)", async () => {
    const engine = await reversedPrimaryEngine();
    const opts = { limit: 10, relatedLimit: 5, relationshipStrategy: "separate" };

    const sync = engine.searchDetailed("bluetooth", opts);
    expect(sync.results[0].id).toBe("z-exact");
    expect(sync.meta.primaryId).toBe("z-exact");
    expect(relatedSourceIds(sync)).toEqual(["z-exact"]);
    expect(sync.related.map((r) => r.id)).toEqual(["z-neighbor"]);
    expect(sync.related.map((r) => r.id)).not.toContain("a-neighbor");

    const asyncd = await engine.searchDetailedAsync("bluetooth", opts);
    expect(asyncd.results[0].id).toBe("z-exact");
    expect(asyncd.meta.primaryId).toBe("z-exact");
    expect(relatedSourceIds(asyncd)).toEqual(["z-exact"]);
    expect(asyncd.related.map((r) => r.id)).toEqual(["z-neighbor"]);
    expect(asyncd.meta.primaryIds).toEqual(sync.meta.primaryIds);
  });

  test("all-strong / top-n-strong preserve Search Core order, not id order", async () => {
    const engine = await reversedPrimaryEngine();
    const all = engine.searchDetailed("bluetooth", {
      relationshipStrategy: "separate",
      sourcePolicy: "all-strong",
      relatedLimit: 5,
    });
    expect(all.meta.primaryIds[0]).toBe("z-exact");
    expect(new Set(all.meta.primaryIds)).toEqual(new Set(["z-exact", "a-guide"]));

    const topn = engine.searchDetailed("bluetooth", {
      relationshipStrategy: "separate",
      sourcePolicy: "top-n-strong",
      relatedLimit: 5,
    });
    expect(topn.meta.primaryIds[0]).toBe("z-exact");
  });
});

describe("typo tie determinism", () => {
  test("equal-distance vocabulary candidates use a stable lexical tie-break", () => {
    const token = "planex";
    const a = suggestTypoForms(token, ["planet", "planes"]);
    const b = suggestTypoForms(token, ["planes", "planet"]);
    expect(a.map((s) => s.form)).toEqual(b.map((s) => s.form));
    expect(a.find((s) => s.provenance === "edit-distance").form).toBe("planes");
  });

  test("equal-distance corpus permutations produce identical correction and results", async () => {
    const docsAlohaFirst = [
      { id: "aloha-doc", title: "Aloha Guide", body: "greeting" },
      { id: "alpha-doc", title: "Alpha Guide", body: "first letter" },
    ];
    const docsAlphaFirst = [
      { id: "alpha-doc", title: "Alpha Guide", body: "first letter" },
      { id: "aloha-doc", title: "Aloha Guide", body: "greeting" },
    ];
    const noMorphology = [];
    const a = SearchEngine.create({ schema, plugins: noMorphology });
    const b = SearchEngine.create({ schema, plugins: noMorphology });
    await a.index(docsAlphaFirst);
    await b.index(docsAlohaFirst);

    const qa = analyzeQuery("altha", { plugins: noMorphology, lexicon: a._index.titleTokenSet });
    const qb = analyzeQuery("altha", { plugins: noMorphology, lexicon: b._index.titleTokenSet });
    const correction = (q) => q.alternatives.find((alt) => alt.source === "typo-correction")?.tokens || [];
    expect(correction(qa)).toEqual(correction(qb));
    expect(correction(qa)).toEqual(["aloha"]);

    const ra = a.searchDetailed("altha");
    const rb = b.searchDetailed("altha");
    expect(ra.results.map((r) => r.id)).toEqual(rb.results.map((r) => r.id));
    expect(ra.results[0].id).toBe("aloha-doc");
  });
});

describe("duplicate-id stale vocabulary", () => {
  test("title vocabulary reflects last-document-wins, not discarded inputs", async () => {
    const docs = [
      { id: "dup", title: "Xylophone Manual", body: "first version" },
      { id: "dup", title: "Bluetooth", body: "final version" },
    ];
    const index = buildIndex(docs, schema, plugins);
    expect(index.documents).toHaveLength(1);
    expect(index.documents[0].title).toBe("Bluetooth");
    expect(index.titleTokenSet.has("xylophone")).toBe(false);
    expect(index.titleTokenSet.has("bluetooth")).toBe(true);

    const engine = SearchEngine.create({ schema, plugins });
    await engine.index(docs);
    const q = analyzeQuery("xylophane", { plugins, lexicon: engine._index.titleTokenSet });
    expect(q.tokens[0].normalized).toBe("xylophane");
    expect(q.alternatives.some((alt) => alt.source === "typo-correction")).toBe(false);
    expect(engine.search("xylophane").some((r) => r.title.toLowerCase().includes("xylophone"))).toBe(false);
  });
});

describe("retrieve-only custom retriever", () => {
  test("search works and searchAsync falls back to retrieve()", async () => {
    const retriever = {
      name: "retrieve-only",
      retrieve(query, index, opts = {}) {
        return retrieveCandidates(query, index, { signal: opts.signal });
      },
    };
    const engine = SearchEngine.create({ schema, plugins, retriever });
    await engine.index([
      { id: "bluetooth", title: "Bluetooth", body: "wireless" },
      { id: "wifi", title: "Wi-Fi", body: "radio" },
    ]);

    expect(typeof engine.retriever.retrieveAsync).toBe("undefined");
    const sync = engine.search("bluetooth");
    expect(sync[0].id).toBe("bluetooth");

    const asyncd = await engine.searchAsync("bluetooth");
    expect(asyncd.map((r) => r.id)).toEqual(sync.map((r) => r.id));

    const detailed = await engine.searchDetailedAsync("bluetooth");
    expect(detailed.results[0].id).toBe("bluetooth");
  });

  test("retrieve-only async path still honors AbortSignal around fallback", async () => {
    const retriever = {
      name: "retrieve-only",
      retrieve(query, index, opts = {}) {
        return retrieveCandidates(query, index, { signal: opts.signal });
      },
    };
    const engine = SearchEngine.create({ schema, plugins, retriever });
    await engine.index([{ id: "bluetooth", title: "Bluetooth", body: "wireless" }]);
    const ac = new AbortController();
    ac.abort();
    try {
      await engine.searchAsync("bluetooth", { signal: ac.signal });
      throw new Error("expected AbortError");
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
    }
  });
});

describe("relationshipMs", () => {
  test("relationship expansion is measured separately from featureMs", async () => {
    let now = 0;
    const spy = jest.spyOn(performance, "now").mockImplementation(() => {
      now += 1;
      return now;
    });
    try {
      const engine = await reversedPrimaryEngine();
      const detailed = engine.searchDetailed("bluetooth", {
        relationshipStrategy: "separate",
        relatedLimit: 5,
      });
      expect(detailed.meta.relationshipExpanded).toBeGreaterThan(0);
      expect(typeof detailed.meta.relationshipMs).toBe("number");
      expect(detailed.meta.relationshipMs).toBeGreaterThan(0);
      expect(detailed.meta.featureMs).toBeGreaterThan(0);

      const none = engine.searchDetailed("bluetooth", { relationshipStrategy: "none" });
      expect(none.meta.relationshipMs).toBe(0);

      const asyncd = await engine.searchDetailedAsync("bluetooth", {
        relationshipStrategy: "separate",
        relatedLimit: 5,
      });
      expect(asyncd.meta.relationshipExpanded).toBeGreaterThan(0);
      expect(asyncd.meta.relationshipMs).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});
