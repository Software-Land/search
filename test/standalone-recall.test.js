import { SearchEngine, morphology } from "../dist/index.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { retrieveCandidates } from "../dist/retrieve.js";
import { compileStandaloneRecallLookup } from "../dist/configuredConcepts.js";
import { stage3AUnsupportedReason } from "../dist/exactBlockSkip.js";
import { configuredConceptPluginFromLegacy } from "./helpers/authored.js";

const httpDict = [
  {
    key: "http",
    aliases: [["hypertext", "transfer", "protocol"]], standaloneRecall: ["hypertext"],
  },
  { key: "https", aliases: [["hypertext", "transfer", "protocol", "secure"]]},
  { key: "html", aliases: [["hypertext", "markup", "language"]]},
];

const docs = [
  { id: "tls", title: "TLS Note", body: "hypertext appears in a tls writeup" },
  { id: "http-body", title: "Request Notes", body: "http methods and status codes" },
  { id: "rest", title: "REST Notes", body: "http rest clients" },
  { id: "html-only", title: "Markup Notes", body: "html markup language examples" },
  { id: "unrelated", title: "Unrelated", body: "protocol transfer without the key" },
];

function plugins(entries = httpDict) {
  return [morphology(), configuredConceptPluginFromLegacy(entries)];
}

async function engine(entries = httpDict, extraDocs = docs) {
  const e = SearchEngine.create({
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    plugins: plugins(entries),
  });
  await e.index(extraDocs);
  return e;
}

describe("standalone recall lookup", () => {
  test("unique reviewed tokens compile and collisions fail closed", () => {
    const lookup = compileStandaloneRecallLookup(
      new Map([
        ["http", ["hypertext"]],
        ["acid", ["atomicity"]],
        ["nist", ["institute"]],
        ["gatech", ["institute"]],
      ])
    );
    expect(lookup.get("hypertext")).toBe("http");
    expect(lookup.get("atomicity")).toBe("acid");
    expect(lookup.has("institute")).toBe(false);
  });

  test("empty, blank, and multi-token standalone values are rejected", () => {
    const plugin = configuredConceptPluginFromLegacy([
      {
        key: "http",
        aliases: [["hypertext", "transfer", "protocol"]],
        standaloneRecall: ["", "  ", "hypertext transfer", "hypertext", "hypertext"],
      },
    ]);
    expect(plugin.standaloneRecallByToken.get("hypertext")).toBe("http");
    expect(plugin.byKey.get("http")).not.toHaveProperty("standaloneRecall");
  });
});

describe("standalone recall analysis", () => {
  test("exact standalone token keeps literal identity and attaches recall metadata", () => {
    const q = analyzeQuery("hypertext", { plugins: plugins() });
    expect(q.tokens.map((t) => t.surface)).toEqual(["hypertext"]);
    expect(q.tokens.map((t) => t.normalized)).toEqual(["hypertext"]);
    expect(q.lexicalTokens.map((t) => t.normalized)).toEqual(["hypertext"]);
    expect(q.lexicalPhraseKey).toBe("hypertext");
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.contextualCompletion).toBeNull();
    expect(q.concepts.some((c) => c.kind === "configured-concept")).toBe(false);
    expect(q.concepts.every((c) => c.kind !== "acronym")).toBe(true);
    expect(q.concepts.some((c) => c.kind === "term" && c.forms.includes("hypertext"))).toBe(true);
    expect(q.standaloneRecall).toMatchObject({ key: "http", sourceToken: "hypertext" });
    expect(stage3AUnsupportedReason(q)).toBe("token-count");
  });

  test("legacy primary does not activate standalone recall", () => {
    const q = analyzeQuery("interface", {
      plugins: plugins([
        { key: "api", aliases: [["application", "programming", "interface"]] },
      ]),
    });
    expect(q.standaloneRecall ?? null).toBeNull();
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.concepts.some((c) => c.kind === "configured-concept")).toBe(false);
  });

  test("prefixes and follow-on tokens do not inherit standalone recall", () => {
    for (const raw of ["hypert", "hyper", "hypertext t", "hypertext m", "atomicity"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.standaloneRecall ?? null).toBeNull();
    }
  });

  test("configured key still owns the query", () => {
    const q = analyzeQuery("http", { plugins: plugins() });
    expect(q.configuredSequenceIntent?.key).toBe("http");
    expect(q.standaloneRecall ?? null).toBeNull();
    expect(q.concepts.some((c) => c.kind === "configured-concept" && c.id === "http")).toBe(true);
  });
});

describe("standalone recall retrieval and ranking", () => {
  test("unions literal candidates with owning configured retrieval and keeps literal first", async () => {
    const e = await engine();
    const hyper = e._prepareQuery("hypertext");
    const http = e._prepareQuery("http");
    const hyperHits = retrieveCandidates(hyper, e._index);
    const httpHits = retrieveCandidates(http, e._index);
    const hyperIds = hyperHits.map((h) => h.document.id).sort();
    const httpIds = httpHits.map((h) => h.document.id).sort();
    expect(hyperIds).toEqual(["http-body", "rest", "tls"]);
    expect(httpIds).toEqual(["http-body", "rest"]);
    expect(httpIds.every((id) => hyperIds.includes(id))).toBe(true);

    const tls = hyperHits.find((h) => h.document.id === "tls");
    const request = hyperHits.find((h) => h.document.id === "http-body");
    expect(tls.retrievalSources).toEqual(expect.arrayContaining(["body-lexical"]));
    expect(request.retrievalSources).toContain("standalone-recall");
    expect(request.retrievalSources).not.toContain("configured-concept");
    expect(hyperHits.some((h) => h.document.id === "unrelated")).toBe(false);
    expect(hyperHits.some((h) => h.document.id === "html-only")).toBe(false);

    const detailed = e.searchDetailed("hypertext", { limit: 10, explain: true });
    expect(detailed.results[0].id).toBe("tls");
    expect(detailed.results.length).toBeGreaterThan(1);
    expect(detailed.results[0].explanation.query.configuredSequenceIntent).toBeNull();
    expect(detailed.results[0].explanation.query.standaloneRecall).toEqual({
      key: "http",
      sourceToken: "hypertext",
    });
    expect(detailed.results[0].explanation.query.concepts.some((c) => c.kind === "configured-concept")).toBe(false);
    expect(detailed.results[0].explanation.query.concepts.every((c) => c.kind !== "acronym")).toBe(true);
    const recallOnly = detailed.results.find((row) => row.id === "http-body");
    expect(recallOnly.retrievalSources).toContain("standalone-recall");
    expect(recallOnly.features.directClass).toBe("none");
    expect(recallOnly.features.standaloneRecallMatch).toBe(true);
    expect(recallOnly.features.queryCoverage).toBe(0);
    expect(recallOnly.features.bodyLexicalMatch).toBe(0);
    expect(detailed.results[0].features.standaloneRecallMatch).toBe(false);
    expect(detailed.results[0].features.bodyLexicalMatch).toBeGreaterThan(0);

    const httpSearchIds = e.search("http").map((row) => row.id);
    expect(httpSearchIds.every((id) => e.search("hypertext").some((row) => row.id === id))).toBe(true);
  });

  test("search and searchDetailed public ids match", async () => {
    const e = await engine();
    expect(e.search("hypertext").map((row) => row.id)).toEqual(
      e.searchDetailed("hypertext").results.map((row) => row.id)
    );
  });

  test("indexed and full-scan agree", async () => {
    const make = (retriever) =>
      SearchEngine.create({
        schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
        plugins: plugins(),
        retriever,
      });
    const full = make("full-scan");
    const indexed = make("indexed");
    await full.index(docs);
    await indexed.index(docs);
    expect(indexed.search("hypertext").map((row) => row.id)).toEqual(full.search("hypertext").map((row) => row.id));
  });

  test("follow-on tokens leave the HTTP and HTML configured paths", async () => {
    const e = await engine();
    for (const raw of ["hypertext t", "hypertext tr", "hypertext transfer", "hypertext m"]) {
      const q = e._prepareQuery(raw);
      expect(q.standaloneRecall ?? null).toBeNull();
    }
    expect(e._prepareQuery("hypertext t").standaloneRecall ?? null).toBeNull();
    expect(e._prepareQuery("hypertext m").concepts.some((c) => c.id === "html")).toBe(true);
    expect(e._prepareQuery("hypertext transfer protocol").configuredSequenceIntent?.key).toBe("http");
    expect(e._prepareQuery("hypertext transfer protocol s").configuredSequenceIntent?.key).toBe("https");
    expect(e._prepareQuery("hypertext transfer protocol secure").configuredSequenceIntent?.key).toBe("https");
  });

  test("negative one-token queries do not activate standalone recall", () => {
    for (const raw of [
      "atomicity",
      "frames",
      "application",
      "machine",
      "interface",
      "programming",
      "latency",
      "datagram",
      "institute",
    ]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.standaloneRecall ?? null).toBeNull();
    }
  });
});
