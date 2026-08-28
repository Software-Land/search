/**
 * Worker init must compile configuredConcepts, not the pre-0.5 dictionaryEntries
 * field. A stale pack that still reads dictionaryEntries fails on relationshipMap
 * concept endpoints such as "http" and "appsec".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { createSearchClient, createWorkerRuntime, createLoopbackTransport } from "../dist/browser/index.js";
import { assertAuthoredRelevanceContract } from "./chromium-pack/authored-relevance-contract.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const documents = [
  { id: "qa-guide", title: "Quality Assurance Guide", body: "qa process handbook" },
  { id: "testing", title: "Testing in Software Engineering", body: "unit testing methods" },
  { id: "http-doc", title: "What is HTTP?", body: "http methods and status codes" },
  { id: "authn", title: "Login Flow", body: "password authentication cookies" },
  { id: "doc-a", title: "Krypton Primary", body: "krypton only body text" },
  { id: "doc-b", title: "Xenon Neighbor", body: "xenon only body text" },
];

const configuredConcepts = [
  { key: "qa", aliases: [["quality", "assurance"]] },
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]] },
  { key: "appsec", aliases: [["application", "security"]] },
];

const relationshipMap = {
  qa: [{ kind: "equivalent", to: { form: "testing" } }],
  hypertext: [{ kind: "related", to: { concept: "http" } }],
  appsec: [{ kind: "related", to: { form: "authentication" } }],
  "doc-a": [{ kind: "related", to: { document: "doc-b" } }],
};

describe("Worker configuredConcepts / relationshipMap init contract", () => {
  test("dist Worker and compiler read configuredConcepts, not dictionaryEntries", () => {
    assertAuthoredRelevanceContract(
      {
        workerRuntime: readFileSync(path.join(ROOT, "dist/browser/workerRuntime.js"), "utf8"),
        configuredConceptsModule: readFileSync(path.join(ROOT, "dist/configuredConcepts.js"), "utf8"),
      },
      "dist"
    );
  });

  test("stale dictionaryEntries Worker contract is rejected", () => {
    expect(() =>
      assertAuthoredRelevanceContract(
        {
          workerRuntime: "authored = compile({ entries: payload.dictionaryEntries || [], relationshipMap: payload.relationshipMap });",
          configuredConceptsModule: "export function compileAuthoredRelevance({ entries = [], relationshipMap, documents, } = {}) {",
        },
        "stale pack"
      )
    ).toThrow(/dictionaryEntries/);
  });

  test("default Worker runtime inits relationshipMap concept endpoints http and appsec", async () => {
    const seen = [];
    const runtime = createWorkerRuntime({
      SearchEngine,
      english: morphology,
      compileAuthoredRelevance: (opts) => {
        seen.push({
          conceptKeys: (opts.configuredConcepts || []).map((row) => row.key),
          conceptCount: (opts.configuredConcepts || []).length,
          mapSources: Object.keys(opts.relationshipMap || {}),
        });
        return compileAuthoredRelevance(opts);
      },
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
      onError({ error }) {
        notify({ __error: error });
      },
    });
    await client.init({
      documents,
      schema,
      configuredConcepts,
      relationshipMap,
      retriever: "full-scan",
    });
    expect(seen).toEqual([
      {
        conceptKeys: ["qa", "http", "appsec"],
        conceptCount: 3,
        mapSources: ["qa", "hypertext", "appsec", "doc-a"],
      },
    ]);
    for (const query of ["hypertext", "appsec"]) {
      got = new Promise((resolve) => {
        notify = resolve;
      });
      client.setQuery(query, { limit: 10, relatedLimit: 8, explain: true });
      const payload = await got;
      if (payload?.__error) throw new Error(String(payload.__error?.message || payload.__error));
    }
    client.terminate();
    const hypertext = published[0]?.results?.map((row) => row.id) || [];
    const appsec = published[1]?.results?.map((row) => row.id) || [];
    expect(hypertext[0]).toBe("http-doc");
    expect(appsec[0]).toBe("authn");
  });
});
