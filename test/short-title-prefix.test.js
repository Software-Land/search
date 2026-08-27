import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { analyzeQuery } from "../dist/analyze.js";
import {
  retrieveCandidates,
  shortTitleTokenPrefixStub,
} from "../dist/retrieve.js";
import { stage3AUnsupportedReason } from "../dist/exactBlockSkip.js";
import { allowPrefixMatch, DEFAULT_STOP } from "../dist/text.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { dictionaryFromLegacy } from "./helpers/authored.js";

const dict = [
  {
    key: "appsec",
    aliases: [["application", "security"], ["app", "sec"]],
    topicalRecall: [["authentication"], ["authorization"]],
  },
  {
    key: "api",
    aliases: [["application", "programming", "interface"], ["application", "programming", "interface"]],
  },
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]], standaloneRecall: ["hypertext"] },
  { key: "ml", aliases: [["machine", "learning"]]},
];

const docs = [
  { id: "api", title: "What is an API?", body: "interfaces and contracts" },
  { id: "rest", title: "REST API vs GraphQL", body: "graphql endpoints" },
  { id: "apis", title: "Working with APIs", body: "client libraries" },
  { id: "appsec", title: "App Sec", body: "application security overview" },
  { id: "body-only", title: "Garden Notes", body: "api app application appsec" },
  { id: "perf", title: "Database Performance", body: "query tuning" },
  { id: "open", title: "Open Protocol", body: "notes without a title prefix from ap" },
  { id: "devops", title: "Dev Ops Guide", body: "development operations workflow" },
  { id: "authn", title: "Login Flow", body: "password authentication cookies" },
  { id: "http-body", title: "Request Notes", body: "http methods and status codes" },
  { id: "code", title: "What is Code?", body: "source" },
];

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

function plugins(entries = dict) {
  return [morphology(), dictionaryFromLegacy(entries)];
}

async function engine(retriever) {
  const e = SearchEngine.create({
    schema,
    plugins: plugins(),
    ...(retriever ? { retriever } : {}),
  });
  await e.index(docs);
  return e;
}

function ids(results) {
  return results.map((row) => row.id);
}

function queryIdentity(q) {
  return {
    surfaces: q.tokens.map((t) => t.surface),
    normalized: q.tokens.map((t) => t.normalized),
    lexical: (q.lexicalTokens || q.tokens).map((t) => t.normalized),
    lexicalPhraseKey: q.lexicalPhraseKey,
    configuredSequenceIntent: q.configuredSequenceIntent ?? null,
    configuredSpans: q.configuredSpans || [],
    configuredPrefixSpans: q.configuredPrefixSpans || [],
    contextualCompletion: q.contextualCompletion ?? null,
    topicalRecall: q.topicalRecall ?? null,
    standaloneRecall: q.standaloneRecall ?? null,
    acronyms: (q.concepts || []).filter((c) => c.kind === "acronym").map((c) => c.id),
  };
}

describe("short title-token prefix admission", () => {
  test("activates only for a 2-char final token with DEFAULT_STOP remainder", () => {
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is an ap", { plugins: plugins() }))).toBe("ap");
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is ap", { plugins: plugins() }))).toBe("ap");
    expect(shortTitleTokenPrefixStub(analyzeQuery("an ap", { plugins: plugins() }))).toBe("ap");
    expect(shortTitleTokenPrefixStub(analyzeQuery("the ap", { plugins: plugins() }))).toBe("ap");
    expect(shortTitleTokenPrefixStub(analyzeQuery("ap", { plugins: plugins() }))).toBe("ap");
    expect(shortTitleTokenPrefixStub(analyzeQuery("io", { plugins: plugins() }))).toBe("io");
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is a co", { plugins: plugins() }))).toBe("co");

    expect(shortTitleTokenPrefixStub(analyzeQuery("ap performance", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("ap security", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("ap database", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is ap performance", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("compare ap api", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("dev op", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("machine le", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("internet of th", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is an a", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("a", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("c", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("d", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("m", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("12", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is an in", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is a to", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is a as", { plugins: plugins() }))).toBeNull();
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is a vs", { plugins: plugins() }))).toBeNull();
    for (const query of ["in", "to", "as", "vs", "an", "is", "of"]) {
      expect(shortTitleTokenPrefixStub(analyzeQuery(query, { plugins: plugins() }))).toBeNull();
    }
    expect(DEFAULT_STOP.has("what")).toBe(true);
    expect(DEFAULT_STOP.has("in")).toBe(true);
    expect(DEFAULT_STOP.has("dev")).toBe(false);
  });

  test("admits title-token prefixes without rewriting query identity", async () => {
    const e = await engine();
    const detailed = e.searchDetailed("what is an ap", { limit: 10, explain: true });
    const q = detailed.results[0].explanation.query;
    expect(queryIdentity(q)).toMatchObject({
      surfaces: ["what", "is", "an", "ap"],
      normalized: ["what", "is", "an", "ap"],
      lexical: ["what", "is", "an", "ap"],
      lexicalPhraseKey: "ap",
      configuredSequenceIntent: null,
      configuredSpans: [],
      configuredPrefixSpans: [],
      contextualCompletion: null,
      topicalRecall: null,
      standaloneRecall: null,
    });
    expect(queryIdentity(q).acronyms).not.toContain("appsec");
    expect(ids(detailed.results).slice(0, 1)).toEqual(["api"]);
    expect(ids(detailed.results)).toEqual(expect.arrayContaining(["api", "rest", "appsec"]));
    expect(ids(detailed.results)).not.toContain("body-only");
    const appsec = detailed.results.find((row) => row.id === "appsec");
    expect(appsec.retrievalSources).toContain("title-token-prefix");
    expect(appsec.retrievalSources).not.toContain("topical-recall");
    expect(appsec.retrievalSources).not.toContain("configured-equivalence");
    expect(appsec.retrievalSources.some((source) => source === "indexed-lexical" || source === "body-lexical")).toBe(
      false
    );
    expect(stage3AUnsupportedReason(analyzeQuery("what is an ap", { plugins: plugins() }))).toBe("term-concept-count");
  });

  test("full-title and contextual prefix still outrank token-prefix-only neighbors", async () => {
    const e = await engine();
    const titles = e.search("what is an ap", { limit: 5 }).map((row) => row.title);
    expect(titles[0]).toBe("What is an API?");
    expect(titles.slice(0, 4)).toContain("App Sec");
    const ranked = e.searchDetailed("what is an ap", { limit: 5, explain: true }).results;
    const api = ranked.find((row) => row.id === "api");
    const appsec = ranked.find((row) => row.id === "appsec");
    expect(api.features.contextualTitlePrefix || api.retrievalSources.includes("title-prefix")).toBe(true);
    expect(appsec.features.contextualTitlePrefix).toBeFalsy();
    expect(allowPrefixMatch("ap", "app")).toBe(false);
    expect(allowPrefixMatch("ap", "api")).toBe(false);
  });

  test("non-stop companion tokens block special 2-char admission", async () => {
    const e = await engine();
    for (const query of ["ap performance", "ap security", "ap database", "what is ap performance", "compare ap api"]) {
      expect(shortTitleTokenPrefixStub(analyzeQuery(query, { plugins: plugins() }))).toBeNull();
    }
    expect(ids(e.search("ap performance", { limit: 10 }))).not.toContain("appsec");
    expect(ids(e.search("ap database", { limit: 10 }))).not.toContain("appsec");
    expect(ids(e.search("what is ap performance", { limit: 10 }))).not.toContain("appsec");
    const securityHits = retrieveCandidates(analyzeQuery("ap security", { plugins: plugins() }), e._index);
    const appsec = securityHits.find((hit) => hit.document.id === "appsec");
    if (appsec) {
      expect(appsec.retrievalSources).not.toContain("title-token-prefix");
    }
    expect(ids(e.search("compare ap api", { limit: 10 }))).not.toContain("appsec");
  });

  test("one-character queries do not gain title-token prefix admission", async () => {
    const e = await engine();
    for (const query of ["a", "c", "d", "m"]) {
      expect(shortTitleTokenPrefixStub(analyzeQuery(query, { plugins: plugins() }))).toBeNull();
    }
    const hits = retrieveCandidates(analyzeQuery("c", { plugins: plugins() }), e._index);
    expect(hits.map((hit) => hit.document.id)).not.toEqual(expect.arrayContaining(["api", "rest", "apis", "appsec"]));
    expect(hits.every((hit) => !hit.retrievalSources.includes("title-token-prefix"))).toBe(true);
  });

  test("body-only ap* tokens are not admitted", async () => {
    const e = await engine();
    const hits = retrieveCandidates(analyzeQuery("what is an ap", { plugins: plugins() }), e._index);
    expect(hits.map((hit) => hit.document.id)).not.toContain("body-only");
    expect(hits.every((hit) => !hit.retrievalSources.includes("body-lexical") || hit.document.id !== "body-only")).toBe(
      true
    );
  });

  test("existing >=3 title-token prefix behavior is unchanged", async () => {
    const e = await engine();
    expect(allowPrefixMatch("api", "apis")).toBe(true);
    const detailed = e.searchDetailed("api", { limit: 10, explain: true });
    expect(ids(detailed.results)).toEqual(expect.arrayContaining(["api", "rest", "apis"]));
    expect(shortTitleTokenPrefixStub(analyzeQuery("api", { plugins: plugins() }))).toBeNull();
  });

  test("dev op remainder is non-stop so Open Protocol is not sprayed", async () => {
    const e = await engine();
    expect(ids(e.search("dev op", { limit: 10 }))).not.toContain("open");
    expect(ids(e.search("dev op", { limit: 10 }))).toContain("devops");
  });

  test("indexed and full-scan IDs match and search() equals searchDetailed().results", async () => {
    const full = await engine("full-scan");
    const indexed = await engine("indexed");
    for (const query of ["what is an ap", "ap", "the ap", "an ap", "what is ap", "dev op"]) {
      const fullIds = ids(full.search(query, { limit: 20 }));
      const indexedIds = ids(indexed.search(query, { limit: 20 }));
      const detailedIds = ids(indexed.searchDetailed(query, { limit: 20 }).results);
      expect(indexedIds).toEqual(fullIds);
      expect(detailedIds).toEqual(indexedIds);
    }
  });

  test("wrapper variants share the same candidate mechanism without hardcoded phrases", async () => {
    for (const query of ["what is an ap", "what is ap", "an ap", "the ap", "ap"]) {
      const q = analyzeQuery(query, { plugins: plugins() });
      expect(shortTitleTokenPrefixStub(q)).toBe("ap");
      expect(q.tokens[q.tokens.length - 1].normalized).toBe("ap");
      expect(q.configuredSequenceIntent ?? null).toBeNull();
      expect(q.topicalRecall ?? null).toBeNull();
    }
  });

  test("stopword finals do not use the special 2-char title-prefix path", () => {
    for (const query of ["what is an in", "what is a to", "what is a as", "what is a vs", "in", "to", "as", "vs"]) {
      expect(shortTitleTokenPrefixStub(analyzeQuery(query, { plugins: plugins() }))).toBeNull();
    }
  });
});

describe("short title-token prefix on Software.Land fixture", () => {
  const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "software-land");
  const load = (name) => JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8"));
  let full;
  let indexed;
  let fixturePlugins;

  beforeAll(async () => {
    fixturePlugins = [
      morphology({ lemmas: load("lemmas.json") }),
      dictionary({ entries: load("dictionary.json") }),
    ];
    const documents = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
    const opts = {
      schema,
      plugins: fixturePlugins,
      documentRelationships: load("relationships.json"),
      relationshipStrategy: "hybrid",
    };
    full = SearchEngine.create({ ...opts, retriever: "full-scan" });
    indexed = SearchEngine.create({ ...opts, retriever: "indexed" });
    await full.index(documents);
    await indexed.index(documents);
  });

  test("what is an ap keeps API first and App Sec in historical topN", () => {
    const q = analyzeQuery("what is an ap", { plugins: fixturePlugins });
    expect(shortTitleTokenPrefixStub(q)).toBe("ap");
    const titles = full.search("what is an ap", { limit: 3 }).map((row) => row.title);
    expect(titles[0]).toBe("What is an API?");
    expect(titles).toContain("App Sec");
    expect(ids(indexed.search("what is an ap", { limit: 20 }))).toEqual(ids(full.search("what is an ap", { limit: 20 })));
  });

  test("io keeps What is IO? first", () => {
    const q = analyzeQuery("io", { plugins: fixturePlugins });
    expect(q.configuredSequenceIntent?.key).toBe("io");
    expect(shortTitleTokenPrefixStub(q)).toBeNull();
    expect(full.search("io", { limit: 1 })[0].title).toBe("What is IO?");
    expect(full.search("io", { limit: 10 }).map((row) => row.title)).toEqual(
      full.search("input output", { limit: 10 }).map((row) => row.title)
    );
  });

  test("what is a co keeps What is a Container? first", () => {
    expect(shortTitleTokenPrefixStub(analyzeQuery("what is a co", { plugins: fixturePlugins }))).toBe("co");
    expect(full.search("what is a co", { limit: 1 })[0].title).toBe("What is a Container?");
  });
});
