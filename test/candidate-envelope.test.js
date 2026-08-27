/**
 * Indexed candidate assembly envelope.
 *
 * Ordinary hits are budgeted by candidateLimit. Exact-title, configured-equivalence,
 * and version bypass that budget without a cap. Contextual title-prefix and
 * full-query title-prefix are capped must-keeps. Relationship expansion happens
 * after retrieval and can add one-hop neighbors.
 *
 * These tests stop at retrieve() / candidateCount. They do not send thousands of
 * candidates through pairwise ranking.
 */
import { morphology, SearchEngine } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { analyzeQuery } from "../dist/analyze.js";
import { buildIndex } from "../dist/indexDocuments.js";
import { retrieveCandidates } from "../dist/retrieve.js";
import { createIndexedLexicalRetriever, createAdaptiveRetriever } from "../dist/retrievers.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

function indexedRetrieve(docs, queryText, { plugins = [morphology()], candidateLimit = 3, prefixCap = 2 } = {}) {
  const index = buildIndex(docs, schema, plugins);
  const retriever = createIndexedLexicalRetriever({ candidateLimit, prefixCap });
  retriever.prepare(index);
  const query = analyzeQuery(queryText, { plugins });
  return { index, query, hits: retriever.retrieve(query, index) };
}

describe("indexed ordinary pool is budgeted", () => {
  test("body-lexical hits are capped at candidateLimit", () => {
    const docs = [];
    for (let i = 0; i < 24; i += 1) {
      docs.push({ id: `b${i}`, title: `Unrelated ${i}`, body: "zzunique token here" });
    }
    const { hits } = indexedRetrieve(docs, "zzunique", { candidateLimit: 5, prefixCap: 1 });
    expect(hits).toHaveLength(5);
    expect(hits.every((h) => h.retrievalSources.includes("body-lexical"))).toBe(true);
  });

  test("title-token hits are capped at candidateLimit", () => {
    const docs = [];
    for (let i = 0; i < 24; i += 1) {
      docs.push({ id: `t${i}`, title: `Notes zzunique ${i}`, body: "x" });
    }
    const { hits } = indexedRetrieve(docs, "zzunique", { candidateLimit: 5, prefixCap: 1 });
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  test("duplicate document ids collapse before ranking", () => {
    const docs = [
      { id: "dup", title: "Probe Title", body: "probe body probe" },
      { id: "dup", title: "Probe Title", body: "probe body probe" },
    ];
    const { hits } = indexedRetrieve(docs, "probe", { candidateLimit: 10 });
    expect(hits.map((h) => h.document.id)).toEqual(["dup"]);
  });
});

describe("indexed unbounded must-keep lanes", () => {
  test("exact-title duplicates bypass candidateLimit", () => {
    const docs = [];
    for (let i = 0; i < 18; i += 1) {
      docs.push({ id: `e${i}`, title: "Same Title", body: "x" });
    }
    docs.push({ id: "noise", title: "Other", body: "same title filler" });
    const { hits } = indexedRetrieve(docs, "same title", { candidateLimit: 2, prefixCap: 1 });
    const exact = hits.filter((h) => h.retrievalSources.includes("exact-title"));
    expect(exact).toHaveLength(18);
  });

  test("configured-equivalence title matches bypass candidateLimit", () => {
    const plugins = [morphology(), dictionary({ entries: [{ key: "ml", aliases: [["machine", "learning"]]}] })];
    const docs = [];
    for (let i = 0; i < 18; i += 1) {
      docs.push({ id: `c${i}`, title: `ML notes ${i}`, body: "x" });
    }
    const { hits } = indexedRetrieve(docs, "ml", { plugins, candidateLimit: 2, prefixCap: 1 });
    const kept = hits.filter((h) => h.retrievalSources.includes("configured-equivalence"));
    expect(kept).toHaveLength(18);
  });

  test("version matches bypass candidateLimit", () => {
    const docs = [];
    for (let i = 0; i < 18; i += 1) {
      docs.push({ id: `v${i}`, title: `TLS 1.2 note ${i}`, body: "x" });
    }
    const { hits } = indexedRetrieve(docs, "1.2", { candidateLimit: 2, prefixCap: 1 });
    const kept = hits.filter((h) => h.retrievalSources.includes("version"));
    expect(kept).toHaveLength(18);
  });
});

describe("full-scan and adaptive ignore a hard ranker envelope", () => {
  test("full-scan retrieve ignores candidateLimit and can return every match", () => {
    const docs = [];
    for (let i = 0; i < 30; i += 1) {
      docs.push({ id: `f${i}`, title: `Unrelated ${i}`, body: "zzunique token here" });
    }
    const plugins = [morphology()];
    const index = buildIndex(docs, schema, plugins);
    const query = analyzeQuery("zzunique", { plugins });
    const hits = retrieveCandidates(query, index);
    expect(hits).toHaveLength(30);
  });

  test("SearchEngine full-scan still ranks every retrieved match when candidateLimit is set", async () => {
    const docs = [];
    for (let i = 0; i < 20; i += 1) {
      docs.push({ id: `f${i}`, title: `Unrelated ${i}`, body: "zzunique token here" });
    }
    const e = SearchEngine.create({
      schema,
      plugins: [morphology()],
      retriever: "full-scan",
      candidateLimit: 4,
      relationshipStrategy: "none",
    });
    await e.index(docs);
    const detailed = e.searchDetailed("zzunique", { limit: 10, candidateLimit: 4 });
    expect(detailed.meta.retriever).toBe("full-scan");
    expect(detailed.meta.candidateCount).toBe(20);
  });

  test("adaptive uses full-scan at or below the document threshold", () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, title: `Doc ${i}`, body: "zzunique" }));
    const plugins = [morphology()];
    const index = buildIndex(docs, schema, plugins);
    const retriever = createAdaptiveRetriever({
      documentThreshold: 1500,
      indexedOptions: { candidateLimit: 2 },
    });
    retriever.prepare(index);
    expect(retriever.stats().active).toBe("full-scan");
    const hits = retriever.retrieve(analyzeQuery("zzunique", { plugins }), index, { candidateLimit: 2 });
    expect(hits).toHaveLength(8);
  });

  test("adaptive switches to exact compiled retrieval above the document threshold", () => {
    const docs = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, title: `Unrelated ${i}`, body: "zzunique" }));
    const plugins = [morphology()];
    const index = buildIndex(docs, schema, plugins);
    const retriever = createAdaptiveRetriever({
      documentThreshold: 3,
      indexedOptions: { candidateLimit: 2, prefixCap: 1 },
    });
    retriever.prepare(index);
    expect(retriever.stats().active).toBe("indexed-lexical");
    const hits = retriever.retrieve(analyzeQuery("zzunique", { plugins }), index);
    expect(hits).toHaveLength(6);
    expect(retriever.stats().pruning).toBe("none");
    expect(retriever.stats().rawDocumentScans).toBe(0);
  });
});

describe("relationship expansion after retrieval", () => {
  test("one-hop related documents are added after the indexed budget", async () => {
    const neighborCount = 12;
    const docs = [{ id: "primary", title: "AlphaProbe", body: "unique primary" }];
    const edges = [];
    for (let i = 0; i < neighborCount; i += 1) {
      docs.push({ id: `r${i}`, title: `Neighbor ${i}`, body: "unrelated" });
      edges.push({ target: `r${i}`, type: "editorial", strength: 1, provenance: "manual" });
    }
    const e = SearchEngine.create({
      schema,
      plugins: [morphology()],
      retriever: "indexed",
      candidateLimit: 1,
      relationshipStrategy: "hybrid",
      documentRelationships: {
        format: "search-v2-relationships",
        version: 1,
        relationships: { primary: edges },
      },
    });
    await e.index(docs);
    const detailed = e.searchDetailed("alphaprobe", { limit: 20, explain: true });
    expect(detailed.meta.candidateCount).toBe(1 + neighborCount);
    expect(detailed.meta.relationshipExpanded).toBe(neighborCount);
    expect(detailed.results.some((row) => row.id === "primary")).toBe(true);
    expect(detailed.results.filter((row) => row.retrievalSources?.includes("relationship")).length).toBeGreaterThan(0);
  });
});

describe("indexed title-prefix capped must-keep", () => {
  test("title-prefix survives a high-TF body flood beyond candidateLimit", () => {
    const docs = [
      {
        id: "winner-short-literal",
        title: "Zzwinner unique ranking title analog",
        body: "unrelated body without the query token repeated",
      },
    ];
    for (let i = 0; i < 250; i += 1) {
      docs.push({
        id: `flood-${i}`,
        title: `Unrelated filler ${i}`,
        body: Array.from({ length: 24 }, () => "zz").join(" "),
      });
    }
    for (let i = 0; i < 80; i += 1) {
      docs.push({
        id: `bg-${i}`,
        title: `Background document ${i}`,
        body: "lorem ipsum dolor sit amet unrelated content",
      });
    }
    const { hits } = indexedRetrieve(docs, "zz", { candidateLimit: 200, prefixCap: 800 });
    const winner = hits.find((h) => h.document.id === "winner-short-literal");
    expect(winner).toBeTruthy();
    expect(winner.retrievalSources).toContain("title-prefix");
    expect(hits.length).toBeLessThanOrEqual(200 + 800);
  });

  test("title-prefix must-keep is capped; overflow stays budget-eligible", () => {
    const docs = [];
    for (let i = 0; i < 12; i += 1) {
      docs.push({
        id: `p${String(i).padStart(4, "0")}`,
        title: `Zzprefix ${"q".repeat(i)} extra extra extra`,
        body: "body",
      });
    }
    docs.push({
      id: "overflow-strong",
      title: "Zzprefix qqqqqqqqqq extra extra extra extra extra extra extra",
      body: "zzprefix zzprefix zzprefix zzprefix zzprefix zzprefix zzprefix zzprefix",
    });
    const { hits } = indexedRetrieve(docs, "zzprefix", { candidateLimit: 4, prefixCap: 2 });
    const ids = hits.map((h) => h.document.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(hits.some((h) => h.retrievalSources.includes("title-prefix"))).toBe(true);
    const overflow = hits.find((h) => h.document.id === "overflow-strong");
    expect(overflow).toBeTruthy();
    expect(overflow.retrievalSources).toContain("title-prefix");
  });
});
