/**
 * Failing contract: unique configured-sequence alignment at any token
 * position, with stable public result IDs/order across equivalent forms.
 *
 * Production behavior is intentionally unchanged. These tests capture the
 * desired generic property, not an appsec-specific exception.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { analyzeQuery } from "../dist/analyze.js";
import { stage3AUnsupportedReason } from "../dist/exactBlockSkip.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const dict = [
  {
    key: "appsec",
    aliases: [["application", "security"], ["app", "sec"],
      ["app", "security"],
      ["application", "sec"],],
  },
  {
    key: "appsvr",
    aliases: [["application", "server"]]},
];

const docs = [
  {
    id: "appsec",
    title: "App Sec",
    body: "application security app sec notes application security application security",
    lexicalFrequency: {
      "application security": 3,
      "app sec": 1,
      application: 3,
      security: 3,
      app: 1,
      sec: 1,
    },
  },
  {
    id: "appsvr",
    title: "Application Server",
    body: "application server runtime application server",
    lexicalFrequency: { "application server": 2, application: 2, server: 2 },
  },
  {
    id: "zts",
    title: "Zero-Trust Security",
    body: "zero trust security model security notes",
    lexicalFrequency: { security: 2, trust: 1 },
  },
  {
    id: "authz",
    title: "Authorization Middleware",
    body: "authorization middleware for an application",
    lexicalFrequency: { application: 1, authorization: 1 },
  },
  {
    id: "thread",
    title: "Process vs Thread",
    body: "operating system process and thread",
  },
];

const plugins = [morphology(), dictionary({ entries: dict })];

const EXACT_EQUIVALENT_QUERIES = [
  "appsec",
  "app sec",
  "app security",
  "application sec",
  "application security",
];

const PREFIX_UNIQUE_QUERIES = [
  "app secu",
  "app secur",
  "app securi",
  "app securit",
  "appl security",
  "appli security",
  "applic security",
  "applica security",
  "applicat security",
  "applicati security",
  "applicatio security",
];

const AMBIGUOUS_QUERIES = ["appl s", "application s"];
const TOO_SHORT_PREFIX_QUERIES = ["a security", "ap security"];

function engine(retriever = "full-scan") {
  const e = SearchEngine.create({ schema, plugins, retriever });
  return e.index(docs).then(() => e);
}

function analyze(raw) {
  return analyzeQuery(raw, { plugins });
}

function acronymIds(q) {
  return q.concepts.filter((c) => c.kind === "acronym").map((c) => c.id);
}

function typedSurfaces(raw) {
  return String(raw).trim().split(/\s+/);
}

describe("configured sequence alignment and result stability", () => {
  let e;

  beforeAll(async () => {
    e = await engine();
  });

  test("exact equivalent forms share public IDs/order with baseline app sec", () => {
    const baselineIds = e.searchDetailed("app sec", { limit: 5, explain: true }).results.map((r) => r.id);
    expect(baselineIds[0]).toBe("appsec");
    for (const raw of EXACT_EQUIVALENT_QUERIES) {
      const q = analyze(raw);
      expect(acronymIds(q)).toEqual(["appsec"]);
      expect(q.tokens.map((t) => t.surface)).toEqual(typedSurfaces(raw));
      expect(q.configuredSequenceIntent).toMatchObject({ key: "appsec" });
      expect(q.lexicalPhraseKey).toBe(analyze("application security").lexicalPhraseKey);
      const detailed = e.searchDetailed(raw, { limit: 5, explain: true });
      expect(e.search(raw, { limit: 5 }).map((r) => r.id)).toEqual(detailed.results.map((r) => r.id));
      expect(detailed.results.map((r) => r.id)).toEqual(baselineIds);
    }
  });

  test("unique non-final prefixes attach appsec without rewriting typed surfaces", () => {
    for (const raw of PREFIX_UNIQUE_QUERIES) {
      const q = analyze(raw);
      expect(q.tokens.map((t) => t.surface)).toEqual(typedSurfaces(raw));
      expect(q.tokens.some((t) => t.sources?.includes("configured-concept"))).toBe(false);
      expect(acronymIds(q)).toEqual(["appsec"]);
    }
  });

  test("unique prefix forms inherit baseline app sec IDs/order", () => {
    const baselineIds = e.searchDetailed("app sec", { limit: 5, explain: true }).results.map((r) => r.id);
    for (const raw of PREFIX_UNIQUE_QUERIES) {
      const detailed = e.searchDetailed(raw, { limit: 5, explain: true });
      expect(detailed.results[0].id).toBe("appsec");
      expect(detailed.results.map((r) => r.id)).toEqual(baselineIds);
    }
  });

  test("same-concept multi-sequence matches are not treated as ambiguity", () => {
    const q = analyze("app security");
    expect(acronymIds(q)).toEqual(["appsec"]);
    expect(q.tokens.map((t) => t.surface)).toEqual(["app", "security"]);
  });

  test("application-security vs application-server prefixes fail closed", () => {
    for (const raw of AMBIGUOUS_QUERIES) {
      const q = analyze(raw);
      expect(q.tokens.map((t) => t.surface)).toEqual(typedSurfaces(raw));
      expect(acronymIds(q)).toEqual([]);
      expect(q.contextualCompletion).toBeNull();
      const ids = e.search(raw, { limit: 5 }).map((r) => r.id);
      expect(ids[0]).not.toBe("appsec");
    }
  });

  test("unsafe short first-token prefixes do not hijack appsec", () => {
    for (const raw of TOO_SHORT_PREFIX_QUERIES) {
      const q = analyze(raw);
      expect(q.tokens.map((t) => t.surface)).toEqual(typedSurfaces(raw));
      expect(acronymIds(q)).toEqual([]);
      expect(q.contextualCompletion).toBeNull();
    }
  });

  test("standalone generic security is not forced through appsec", () => {
    const q = analyze("security");
    expect(acronymIds(q)).toEqual([]);
    expect(q.configuredSequenceIntent).toBeNull();
    expect(e.search("security", { limit: 3 })[0].id).not.toBe("appsec");
  });

  test("configured sequence intent fail-closes Stage 3A", () => {
    const q = analyze("app sec");
    expect(q.configuredSequenceIntent.key).toBe("appsec");
    expect(stage3AUnsupportedReason(q)).toBe("acronym");
  });

  test("full-scan and indexed retrievers stay equivalent on the contract queries", async () => {
    const full = await engine("full-scan");
    const indexed = await engine("indexed");
    for (const raw of ["app sec", "app security", "appl security", "application security", "application s", "security"]) {
      expect(indexed.search(raw, { limit: 5 }).map((r) => r.id)).toEqual(
        full.search(raw, { limit: 5 }).map((r) => r.id)
      );
    }
  });
});
