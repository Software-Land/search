import { SearchEngine, morphology } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { retrieveCandidates, unboundTypedTokens } from "../dist/retrieve.js";
import {
  resolveConfiguredPrefixSpans,
  resolveConfiguredSequence,
  resolveConfiguredSpans,
} from "../dist/configuredSequence.js";
import { stage3AUnsupportedReason } from "../dist/exactBlockSkip.js";
import { configuredConceptPluginFromLegacy } from "./helpers/authored.js";

const dict = [
  {
    key: "appsec",
    aliases: [["application", "security"], ["app", "sec"],
      ["application", "security"],
      ["security"],],
    topicalRecall: [
      ["authentication"],
      ["authorization"],
      ["bearer", "token"],
      ["oauth"],
    ],
  },
  {
    key: "api",
    aliases: [["application", "programming", "interface"], ["application", "programming", "interface"]],
  },
  { key: "spa", aliases: [["single", "page", "application"]]},
  {
    key: "oauth",
    aliases: [["open", "authorization"]], topicalRecall: [["openid"], ["redirect"]],
  },
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]], standaloneRecall: ["hypertext"] },
  { key: "tls", aliases: [["transport", "layer", "security"]]},
  { key: "ml", aliases: [["machine", "learning"]]},
  { key: "fps", aliases: [["frames", "per", "second"]]},
  { key: "ab", aliases: [["alpha", "bravo"]]},
  { key: "bc", aliases: [["bravo", "charlie"]]},
  { key: "graphql", aliases: [["graph", "query", "language"]]},
  { key: "gql", aliases: [["graph", "query", "language"]]},
  { key: "qa", aliases: [["quality", "assurance"]]},
  { key: "testing", aliases: [["quality", "assurance"]]},
  { key: "proto", aliases: [["protocol", "buffer"]]},
  { key: "protobuf", aliases: [["protocol", "buffer"]]},
  {
    key: "cicd",
    aliases: [["continuous", "integration"], ["ci"], ["cd"], ["ci", "cd"]],
  },
  { key: "devops", aliases: [["development", "operations"], ["dev"], ["ops"]] },
];

const docs = [
  { id: "direct", title: "App Sec", body: "application security overview app sec notes" },
  { id: "zts", title: "Zero-Trust Security", body: "zero trust security model" },
  { id: "authn", title: "Login Flow", body: "password authentication cookies" },
  { id: "phrase", title: "Token Primer", body: "send a bearer token header" },
  { id: "oauth-doc", title: "OAuth Dance", body: "oauth authorization code" },
  { id: "api-doc", title: "What is an API?", body: "application programming interface notes" },
  { id: "ml-doc", title: "Model Notes", body: "machine learning models" },
  { id: "fps-doc", title: "Frame Budget", body: "frames per second budget" },
  { id: "http-body", title: "Request Notes", body: "http methods and status codes" },
  { id: "unrelated", title: "Unrelated", body: "gardening tips" },
];

function plugins(entries = dict) {
  return [morphology(), configuredConceptPluginFromLegacy(entries)];
}

async function engine(retriever) {
  const e = SearchEngine.create({
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    plugins: plugins(),
    ...(retriever ? { retriever } : {}),
  });
  await e.index(docs);
  return e;
}

function surfaces(q) {
  return q.tokens.map((t) => t.surface);
}

function acronyms(q) {
  return q.concepts.filter((c) => c.kind === "configured-concept").map((c) => c.id);
}

describe("configured prefix span resolver", () => {
  test("n>=2 unique non-final prefix resolves and stays off exact spans", () => {
    const q = analyzeQuery("what is an applicatio security", { plugins: plugins() });
    expect(resolveConfiguredSequence(q.tokens, plugins()[1]).status).toBe("none");
    expect(resolveConfiguredSpans(q.tokens, plugins()[1])).toEqual([]);
    expect(resolveConfiguredPrefixSpans(q.tokens, plugins()[1])).toEqual([
      { key: "appsec", start: 3, end: 5, matchedKinds: ["expansion"], usedPrefix: true },
    ]);
  });

  test("last-token prefix works generically for n>=2", () => {
    const q = analyzeQuery("what is application s", { plugins: plugins() });
    expect(resolveConfiguredSpans(q.tokens, plugins()[1])).toEqual([]);
    expect(resolveConfiguredPrefixSpans(q.tokens, plugins()[1])).toEqual([
      { key: "appsec", start: 2, end: 4, matchedKinds: ["expansion"], usedPrefix: true },
    ]);
  });

  test("unsafe short one-token prefixes never become prefix spans", () => {
    for (const raw of ["what is c", "what is a c", "what is dev", "c", "dev", "what is an ap"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(resolveConfiguredPrefixSpans(q.tokens, plugins()[1])).toEqual([]);
    }
  });

  test("unique longest first-expansion prefix occupies the longer configured entry", () => {
    for (const raw of ["appl", "appli", "applic", "applica", "what is an appl", "what is an applica"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      const spans = resolveConfiguredPrefixSpans(q.tokens, plugins()[1]);
      if (raw.split(/\s+/).length === 1) {
        expect(resolveConfiguredSequence(q.tokens, plugins()[1])).toMatchObject({
          status: "unique",
          intent: { key: "api" },
        });
        expect(q.configuredSequenceIntent?.key).toBe("api");
        expect(q.configuredPrefixSpans).toEqual([]);
      } else {
        expect(q.configuredSequenceIntent).toBeNull();
        expect(spans).toEqual([
          expect.objectContaining({ key: "api", usedPrefix: true }),
        ]);
        expect(q.configuredPrefixSpans).toEqual(spans);
      }
      expect(q.topicalRecall ?? null).toBeNull();
      expect(q.tokens.map((t) => t.surface)).toEqual(raw.split(/\s+/));
    }
  });

  test("same-window distinct keys fail closed", () => {
    for (const raw of ["what is graph query langu", "what is quality assura", "what is protocol buffe"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(resolveConfiguredPrefixSpans(q.tokens, plugins()[1])).toEqual([]);
      expect(q.configuredPrefixSpans).toEqual([]);
      expect(q.configuredSequenceIntent).toBeNull();
    }
  });

  test("exact configured windows stay on configuredSpans", () => {
    const q = analyzeQuery("what is an app sec", { plugins: plugins() });
    expect(q.configuredSpans).toEqual([{ key: "appsec", start: 3, end: 5, matchedKinds: ["alias"] }]);
    expect(resolveConfiguredPrefixSpans(q.tokens, plugins()[1])).toEqual([]);
    expect(q.configuredPrefixSpans).toEqual([]);
  });
});

describe("wrapped configured prefix activation", () => {
  test("stopword remainder occupies only the prefix window without rewriting identity", () => {
    const q = analyzeQuery("what is an applicatio security", { plugins: plugins() });
    const baseline = analyzeQuery("what is an applicatio security", {
      plugins: plugins(dict.map((entry) => ({ ...entry, topicalRecall: [] }))),
    });
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredSpans).toEqual([]);
    expect(q.configuredPrefixSpans).toEqual([
      { key: "appsec", start: 3, end: 5, matchedKinds: ["expansion"], usedPrefix: true },
    ]);
    expect(q.topicalRecall ?? null).toBeNull();
    expect(q.standaloneRecall ?? null).toBeNull();
    expect(surfaces(q)).toEqual(["what", "is", "an", "applicatio", "security"]);
    expect(q.tokens.map((t) => t.normalized)).toEqual(["what", "is", "an", "applicatio", "security"]);
    expect(q.lexicalPhraseKey).toBe("applicatio security");
    expect(q.tokens[3].surfaceNormalized).toBe("applicatio");
    expect(q.tokens[3].sources).not.toContain("typo-correction");
    expect(acronyms(q)).toEqual(["appsec"]);
    expect(q.concepts.filter((c) => c.kind === "term").map((c) => c.id)).toEqual([]);
    const appsec = q.concepts.find((c) => c.id === "appsec");
    expect(appsec.kind).toBe("configured-concept");
    expect(appsec.provenance).toBe("partial-expansion");
    expect(unboundTypedTokens(q).map((t) => t.surface)).toEqual(["what", "is", "an", "applicatio", "security"]);
    expect(q.lexicalPhraseKey).toBe(baseline.lexicalPhraseKey);
    expect(stage3AUnsupportedReason(q)).toBe("configured-concept");
  });

  test("prefix spans do not trigger topical recall", () => {
    for (const raw of [
      "what is an applicatio security",
      "what is application s",
      "what is app s",
      "what is machine l",
      "what is frames per s",
    ]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.configuredSequenceIntent).toBeNull();
      expect(q.configuredSpans.filter((s) => ["appsec", "ml", "fps"].includes(s.key))).toEqual([]);
      expect(q.configuredPrefixSpans.length).toBe(1);
      expect(q.topicalRecall ?? null).toBeNull();
    }
  });

  test("whole-query prefix alignment still uses sequence intent, not prefix spans", () => {
    const q = analyzeQuery("applicatio security", { plugins: plugins() });
    expect(q.configuredSequenceIntent?.key).toBe("appsec");
    expect(q.configuredPrefixSpans).toEqual([]);
    expect(q.configuredSpans).toEqual([]);
    expect(q.topicalRecall?.key).toBe("appsec");
  });

  test("non-stop remainders do not activate prefix spans", () => {
    for (const raw of [
      "explain applicatio security",
      "learn applicatio security",
      "applicatio security tutorial",
      "compare applicatio security with oauth",
      "not applicatio security",
      "application s performance",
    ]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.configuredPrefixSpans).toEqual([]);
      expect(q.configuredSequenceIntent).toBeNull();
      expect(q.topicalRecall ?? null).toBeNull();
    }
  });

  test("multiple inferred spans fail closed", () => {
    for (const raw of ["machine l app sec", "application s oauth", "hypertext t tls", "frames per s api"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.configuredPrefixSpans).toEqual([]);
      expect(q.configuredSequenceIntent).toBeNull();
      expect(q.topicalRecall ?? null).toBeNull();
    }
  });

  test("standalone recall stays exact one-token whole-query", () => {
    const hyper = analyzeQuery("hypertext", { plugins: plugins() });
    expect(hyper.standaloneRecall).toMatchObject({ key: "http", sourceToken: "hypertext" });
    expect(hyper.configuredPrefixSpans).toEqual([]);
    const wrapped = analyzeQuery("what is hypertext", { plugins: plugins() });
    expect(wrapped.standaloneRecall ?? null).toBeNull();
    expect(wrapped.configuredPrefixSpans).toEqual([]);
  });
});

describe("wrapped configured prefix retrieval", () => {
  test("configured concept ranks the canonical document first without topical recall", async () => {
    const e = await engine();
    const q = e._prepareQuery("what is an applicatio security");
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredPrefixSpans).toEqual([
      { key: "appsec", start: 3, end: 5, matchedKinds: ["expansion"], usedPrefix: true },
    ]);
    expect(q.topicalRecall ?? null).toBeNull();
    const hits = retrieveCandidates(q, e._index);
    expect(hits.every((h) => !(h.retrievalSources || []).includes("topical-recall"))).toBe(true);
    const detailed = e.searchDetailed("what is an applicatio security", { limit: 10, explain: true });
    expect(detailed.results[0].id).toBe("direct");
    expect(detailed.results[0].features.configuredConceptMatch).toBeTruthy();
    expect(detailed.results[0].explanation.query.configuredSequenceIntent).toBeNull();
    expect(detailed.results[0].explanation.query.configuredPrefixSpans).toEqual([
      { key: "appsec", start: 3, end: 5, matchedKinds: ["expansion"], usedPrefix: true },
    ]);
    expect(detailed.results[0].explanation.query.topicalRecall).toBeNull();
    expect(detailed.results[0].explanation.query.tokens.map((t) => t.surface)).toEqual([
      "what",
      "is",
      "an",
      "applicatio",
      "security",
    ]);
    const appsec = detailed.results.find((row) => row.id === "direct");
    const zts = detailed.results.find((row) => row.id === "zts");
    expect(appsec.features.queryCoverage).toBe(1);
    expect(zts.features.typedSurfaceTitleMatch).toBe(true);
    expect(e.search("what is an applicatio security").map((row) => row.id)).toEqual(
      detailed.results.map((row) => row.id)
    );
  });

  test("exact wrapped topical path is unchanged", async () => {
    const e = await engine();
    const detailed = e.searchDetailed("what is an app sec", { limit: 10, explain: true });
    expect(detailed.results[0].id).toBe("direct");
    expect(detailed.results[0].explanation.query.configuredPrefixSpans).toEqual([]);
    expect(detailed.results[0].explanation.query.configuredSpans).toEqual([
      { key: "appsec", start: 3, end: 5, matchedKinds: ["alias"] },
    ]);
    expect(detailed.results[0].explanation.query.topicalRecall.key).toBe("appsec");
    const ids = retrieveCandidates(e._prepareQuery("what is an app sec"), e._index).map((h) => h.document.id);
    expect(ids).toContain("authn");
    expect(ids).toContain("phrase");
  });

  test("one-token wrapped prefixes stay outside this mechanism", async () => {
    const e = await engine();
    const q = e._prepareQuery("what is an ap");
    expect(q.configuredPrefixSpans).toEqual([]);
    expect(q.configuredSequenceIntent).toBeNull();
    expect(acronyms(q).includes("appsec")).toBe(false);
  });

  test("indexed and full-scan agree", async () => {
    const full = await engine("full-scan");
    const indexed = await engine("indexed");
    for (const raw of [
      "what is an applicatio security",
      "what is an app sec",
      "what is an ap",
      "what is c",
      "explain applicatio security",
      "application s oauth",
    ]) {
      expect(indexed.search(raw).map((row) => row.id)).toEqual(full.search(raw).map((row) => row.id));
      expect(indexed.search(raw).map((row) => row.id)).toEqual(
        indexed.searchDetailed(raw).results.map((row) => row.id)
      );
    }
  });
});
