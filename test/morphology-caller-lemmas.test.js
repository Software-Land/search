/**
 * morphology() has no built-in lemma table. Caller entries are the whole
 * explicit table, win over suffix heuristics, and must be the same map at
 * compile time, direct search, and Worker search.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { compileLexicalFrequency } from "../tools/search-lexical/index.js";
import { compileLexicalIndex } from "../dist/indexing/lexicalIndex.js";
import { createSearchClient, createWorkerRuntime, createLoopbackTransport } from "../dist/browser/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const FORMER_DEFAULTS = {
  libraries: "library",
  recursive: "recursion",
  recursively: "recursion",
  recursing: "recursion",
  recurses: "recursion",
  recursed: "recursion",
  authenticating: "authentication",
  authenticated: "authentication",
  authorizing: "authorization",
  authorized: "authorization",
  authorizes: "authorization",
  sharding: "shard",
  shards: "shard",
  computing: "compute",
  learning: "learn",
  learnings: "learn",
  intercepting: "interceptor",
  intercepted: "interceptor",
  intercept: "interceptor",
};

const docs = [
  { id: "edge", title: "Edge Computing", body: "Compute at the edge." },
  { id: "lib", title: "What is a Library?", body: "A reusable library." },
];

async function workerTitles(lemmas, query) {
  const runtime = createWorkerRuntime({ SearchEngine, english: morphology });
  let notify;
  const got = new Promise((resolve) => {
    notify = resolve;
  });
  const client = createSearchClient({
    worker: createLoopbackTransport(runtime),
    onResult({ result }) {
      notify({ result });
    },
    onError({ error }) {
      notify({ error });
    },
  });
  await client.init({
    documents: docs,
    schema,
    retriever: "indexed",
    englishOptions: { lemmas },
  });
  client.setQuery(query, { limit: 5, relatedLimit: 0 });
  const payload = await got;
  client.terminate();
  if (payload.error) throw new Error(String(payload.error?.message || payload.error));
  return payload.result.results.map((hit) => hit.title);
}

describe("caller-owned morphology lemmas", () => {
  test("an empty call has no canonical mappings and no lemma-table entries", () => {
    const plugin = morphology();
    expect([...plugin.lemmaTableKeys()]).toEqual([]);
    for (const word of Object.keys(FORMER_DEFAULTS)) {
      expect(plugin.canonicalLemma(word)).toBeNull();
    }
    expect(plugin.lemma("computing")).toBe("comput");
    expect(plugin.lemma("libraries")).toBe("library");
    expect(plugin.lemma("nation")).toBe("nat");
    expect(plugin.canonicalLemma("nation")).toBeNull();
  });

  test("caller mappings for previously protected words are the table", () => {
    const plugin = morphology({
      lemmas: {
        computing: "comput",
        libraries: "libz",
        recurses: "recursion",
      },
    });
    expect([...plugin.lemmaTableKeys()].sort()).toEqual(["computing", "libraries", "recurses"]);
    expect(plugin.canonicalLemma("computing")).toBe("comput");
    expect(plugin.lemma("computing")).toBe("comput");
    expect(plugin.canonicalLemma("libraries")).toBe("libz");
    expect(plugin.lemma("libraries")).toBe("libz");
    expect(plugin.canonicalLemma("recurses")).toBe("recursion");
    expect(plugin.canonicalLemma("recursive")).toBeNull();
    expect(plugin.lemma("shards")).toBe("shard");
    expect(plugin.canonicalLemma("shards")).toBeNull();
  });

  test("one explicit map agrees across frequency, lexical index, direct search, and Worker search", async () => {
    const lemmas = { computing: "compute", libraries: "library" };
    const plugin = morphology({ lemmas });
    const frequency = compileLexicalFrequency(docs, {
      lemma: plugin.lemma,
      policy: { minN: 1, maxN: 2, minCollectionCount: 1 },
    });
    expect(frequency.documents.edge.ngrams.compute).toBeGreaterThan(0);
    expect(frequency.documents.edge.ngrams.comput).toBeUndefined();
    expect(frequency.documents.lib.ngrams.library).toBeGreaterThan(0);

    const artifact = compileLexicalIndex(docs, {
      schema,
      plugins: [plugin],
    });
    const direct = SearchEngine.create({
      schema,
      plugins: [morphology({ lemmas })],
      retriever: "indexed",
      lexicalIndex: artifact,
      relationshipStrategy: "none",
    });
    await direct.index(docs);
    expect(direct.search("computing", { limit: 5, relatedLimit: 0 }).map((hit) => hit.title)).toEqual([
      "Edge Computing",
    ]);
    expect(direct.search("libraries", { limit: 5, relatedLimit: 0 }).map((hit) => hit.title)).toEqual([
      "What is a Library?",
    ]);
    expect(await workerTitles(lemmas, "computing")).toEqual(["Edge Computing"]);
    expect(await workerTitles(lemmas, "libraries")).toEqual(["What is a Library?"]);
  });

  test("a precompiled artifact compiled with a different lemma map is rejected", async () => {
    const compiled = morphology({ lemmas: { computing: "compute" } });
    const artifact = compileLexicalIndex(docs, { schema, plugins: [compiled] });
    const mismatched = SearchEngine.create({
      schema,
      plugins: [morphology({ lemmas: { computing: "comput" } })],
      retriever: "indexed",
      lexicalIndex: artifact,
      relationshipStrategy: "none",
    });
    await expect(mismatched.index(docs)).rejects.toThrow(/analyzer identity/i);
    const empty = SearchEngine.create({
      schema,
      plugins: [morphology()],
      retriever: "indexed",
      lexicalIndex: artifact,
      relationshipStrategy: "none",
    });
    await expect(empty.index(docs)).rejects.toThrow(/analyzer identity/i);
  });
});
