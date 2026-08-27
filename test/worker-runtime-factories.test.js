/**
 * createWorkerRuntime factory compatibility.
 * Packed searchWorker.js uses compileAuthoredRelevance, not this legacy dictionary path.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { createSearchClient, createWorkerRuntime, createLoopbackTransport } from "../dist/browser/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const mixedMap = {
  qa: [{ kind: "equivalent", to: { form: "testing" } }],
  hypertext: [{ kind: "related", to: { concept: "http" } }],
  appsec: [{ kind: "related", to: { form: "authentication" } }],
  "doc-a": [{ kind: "related", to: { document: "doc-b" } }],
};

const authoredDocuments = [
  { id: "qa-guide", title: "Quality Assurance Guide", body: "qa process handbook" },
  { id: "testing", title: "Testing in Software Engineering", body: "unit testing methods" },
  { id: "http-doc", title: "What is HTTP?", body: "http methods and status codes" },
  { id: "authn", title: "Login Flow", body: "password authentication cookies" },
  { id: "doc-a", title: "Krypton Primary", body: "krypton only body text" },
  { id: "doc-b", title: "Xenon Neighbor", body: "xenon only body text" },
];

const authoredEntries = [
  { key: "qa", aliases: [["quality", "assurance"]] },
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]] },
  { key: "appsec", aliases: [["application", "security"]] },
];

async function searchOnce(runtime, initPayload, query, options = {}) {
  let notify;
  let got = new Promise((resolve) => {
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
  await client.init(initPayload);
  client.setQuery(query, { limit: 10, relatedLimit: 8, explain: true, ...options });
  const payload = await got;
  client.terminate();
  if (payload.error) throw new Error(String(payload.error?.message || payload.error));
  return payload.result;
}

describe("createWorkerRuntime factory compatibility", () => {
  test("legacy dictionary factory is invoked when relationshipMap is absent", async () => {
    let calls = 0;
    const dictionaryEntries = [{ key: "zephyr", aliases: [["customhost", "token"]] }];
    const customDictionary = (opts) => {
      calls += 1;
      expect(Object.keys(opts).sort()).toEqual(["entries"]);
      expect(opts.entries).toEqual(dictionaryEntries);
      return dictionary({ entries: opts.entries });
    };
    const runtime = createWorkerRuntime({
      SearchEngine,
      english: morphology,
      dictionary: customDictionary,
    });
    const result = await searchOnce(
      runtime,
      {
        documents: [{ id: "zephyr", title: "Zephyr Target", body: "zephyr only body text" }],
        schema,
        configuredConcepts: dictionaryEntries,
        retriever: "full-scan",
      },
      "customhost token"
    );
    expect(calls).toBe(1);
    expect(result.results.map((hit) => hit.id)).toEqual(["zephyr"]);
  });

  test("packaged Worker compiler path does not use the legacy dictionary factory", async () => {
    let compileCalls = 0;
    const runtime = createWorkerRuntime({
      SearchEngine,
      english: morphology,
      compileAuthoredRelevance: (opts) => {
        compileCalls += 1;
        expect(Object.keys(opts).sort()).toEqual(["configuredConcepts", "documents", "relationshipMap"]);
        expect(opts.configuredConcepts).toEqual(authoredEntries);
        expect(opts.relationshipMap).toBeUndefined();
        expect(opts.documents).toEqual(authoredDocuments);
        return compileAuthoredRelevance(opts);
      },
    });
    const result = await searchOnce(
      runtime,
      {
        documents: authoredDocuments,
        schema,
        configuredConcepts: authoredEntries,
        retriever: "full-scan",
      },
      "qa"
    );
    expect(compileCalls).toBe(1);
    expect(result.results.map((hit) => hit.id)).toEqual(["qa-guide"]);
  });

  test("custom compileAuthoredRelevance compiles relationshipMap once for all four edge types", async () => {
    let compiles = 0;
    const compile = (opts) => {
      compiles += 1;
      return compileAuthoredRelevance(opts);
    };
    const runtime = createWorkerRuntime({
      SearchEngine,
      english: morphology,
      compileAuthoredRelevance: compile,
    });
    const published = [];
    let notify;
    let got = new Promise((resolve) => {
      notify = resolve;
    });
    const client = createSearchClient({
      worker: createLoopbackTransport(runtime),
      onResult({ result }) {
        published.push(result);
        notify();
      },
    });
    await client.init({
      documents: authoredDocuments,
      schema,
      configuredConcepts: authoredEntries,
      relationshipMap: mixedMap,
      documentRelationships: {
        format: "search-v2-relationships",
        version: 1,
        relationships: {
          "doc-a": [{ target: "qa-guide", type: "semantic", strength: 0.7, provenance: "generated" }],
        },
      },
      retriever: "full-scan",
    });
    expect(compiles).toBe(1);
    for (const row of [
      { query: "qa" },
      { query: "hypertext" },
      { query: "appsec" },
      { query: "krypton primary", options: { relationshipStrategy: "separate" } },
    ]) {
      client.setQuery(row.query, { limit: 10, relatedLimit: 8, explain: true, ...row.options });
      await got;
      got = new Promise((resolve) => {
        notify = resolve;
      });
    }
    client.terminate();
    expect(compiles).toBe(1);
    const [qa, hypertext, appsec, editorial] = published;
    expect(qa.results.map((hit) => hit.id)).toEqual(["qa-guide", "testing"]);
    expect(qa.results.some((hit) => (hit.retrievalSources || []).includes("equivalent-recall"))).toBe(true);
    expect(hypertext.results.map((hit) => hit.id)).toEqual(["http-doc"]);
    expect(appsec.results.map((hit) => hit.id)).toEqual(["authn"]);
    expect(editorial.results.map((hit) => hit.id)).toEqual(["doc-a"]);
    expect((editorial.related || []).map((hit) => hit.id)).toEqual(["doc-b", "qa-guide"]);
  });

  test("legacy dictionary factory plus relationshipMap fails closed", async () => {
    let calls = 0;
    const customDictionary = () => {
      calls += 1;
      return dictionary({ entries: authoredEntries });
    };
    const runtime = createWorkerRuntime({
      SearchEngine,
      english: morphology,
      dictionary: customDictionary,
    });
    const client = createSearchClient({
      worker: createLoopbackTransport(runtime),
    });
    await expect(
      client.init({
        documents: authoredDocuments,
        schema,
        configuredConcepts: authoredEntries,
        relationshipMap: mixedMap,
      })
    ).rejects.toThrow(/cannot compile relationshipMap/);
    expect(calls).toBe(0);
    client.terminate();
  });
});
