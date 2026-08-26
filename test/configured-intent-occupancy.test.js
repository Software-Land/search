/**
 * Generic configured-intent occupancy: morphology lemmas may occupy exact
 * keys, unique n≥2 expansion prefixes become whole-query intent, and
 * ambiguous first-expansion prefixes disambiguate by unique longest expansion.
 */
import { SearchEngine, morphology, dictionary } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import {
  resolveConfiguredPrefixSpans,
  resolveConfiguredSequence,
  resolveConfiguredSpans,
  tokenAlignsConfiguredKey,
} from "../dist/configuredSequence.js";
import { dictionaryFromLegacy } from "./helpers/authored.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const apiAppsecDict = [
  {
    key: "api",
    aliases: [["application", "programming", "interface"], ["app", "programming", "interface"]],
  },
  {
    key: "appsec",
    aliases: [["application", "security"], ["app", "sec"],
      ["app", "security"],
      ["application", "sec"],],
    topicalRecall: [["authentication"], ["authorization"]],
  },
];

const sameLengthDict = [
  { key: "appsec", aliases: [["application", "security"]], topicalRecall: [["authentication"]] },
  { key: "appsvr", aliases: [["application", "server"]]},
];

const widgetDict = [{ key: "widget", aliases: [["user", "interface", "control"]]}];

function plugins(entries) {
  return [morphology(), dictionary(dictionaryFromLegacy(entries))];
}

function acronymIds(q) {
  return q.concepts.filter((c) => c.kind === "acronym").map((c) => c.id);
}

describe("canonical lemma occupies exact configured key", () => {
  test("plural surface occupies the singular configured key without rewriting surface", () => {
    const q = analyzeQuery("apis", { plugins: plugins(apiAppsecDict) });
    expect(q.tokens[0].surface).toBe("apis");
    expect(q.tokens[0].normalized).toBe("apis");
    expect(q.tokens[0].lemma).toBe("api");
    expect(tokenAlignsConfiguredKey(q.tokens[0], "api")).toBe(true);
    expect(q.configuredSequenceIntent?.key).toBe("api");
    expect(q.configuredSequenceIntent?.matchedKinds).toContain("key");
    expect(acronymIds(q)).toEqual(["api"]);
    expect(q.concepts.find((c) => c.id === "api").provenance).toBe("key");
  });

  test("synthetic plural lemma occupies a different configured key", () => {
    const q = analyzeQuery("widgets", { plugins: plugins(widgetDict) });
    expect(q.tokens[0].surface).toBe("widgets");
    expect(q.tokens[0].lemma).toBe("widget");
    expect(q.configuredSequenceIntent?.key).toBe("widget");
  });

  test("wrapped plural occupies the key span and preserves typed identity", () => {
    const q = analyzeQuery("what are widgets", { plugins: plugins(widgetDict) });
    expect(q.tokens.map((t) => t.surface)).toEqual(["what", "are", "widgets"]);
    expect(q.tokens[2].surface).toBe("widgets");
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredSpans).toEqual([{ key: "widget", start: 2, end: 3, matchedKinds: ["key"] }]);
    expect(acronymIds(q)).toEqual(["widget"]);
  });

  test("https-like keys stay on the typed key rather than a trailing-s lemma", () => {
    const dict = [
      { key: "http", aliases: [["hypertext", "transfer", "protocol"]]},
      { key: "https", aliases: [["hypertext", "transfer", "protocol", "secure"]]},
    ];
    const q = analyzeQuery("https", { plugins: plugins(dict) });
    expect(q.tokens[0].surface).toBe("https");
    expect(q.configuredSequenceIntent?.key).toBe("https");
    expect(acronymIds(q)).toEqual(["https"]);
    expect(q.configuredSpans.map((s) => s.key)).toEqual(["https"]);
  });

  test("lemma does not occupy a different key inside another exact expansion", () => {
    const dict = [
      { key: "rbac", aliases: [["role", "based", "access", "control"]]},
      { key: "base", aliases: [["base", "case"]]},
    ];
    const q = analyzeQuery("role based access control", { plugins: plugins(dict) });
    expect(q.configuredSequenceIntent?.key).toBe("rbac");
    expect(q.configuredSpans.some((s) => s.key === "base")).toBe(false);
  });

  test("synonym and near-edit forms do not occupy a configured key", () => {
    const q = analyzeQuery("sprocket", {
      plugins: [
        morphology(),
        dictionary({ entries: widgetDict }),
        { name: "synonyms", expand: (token) => (token === "sprocket" ? [{ form: "widget" }] : []) },
      ],
    });
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredSpans).toEqual([]);
    expect(acronymIds(q)).toEqual([]);
  });
});

describe("first-token configured prefix disambiguation", () => {
  test("ambiguous first-token prefix occupies the unique longest expansion", () => {
    for (const raw of ["appl", "appli", "applic", "applica"]) {
      const q = analyzeQuery(raw, { plugins: plugins(apiAppsecDict) });
      expect(q.tokens[0].surface).toBe(raw);
      expect(q.tokens[0].surfaceNormalized).toBe(raw);
      expect(q.configuredSequenceIntent?.key).toBe("api");
      expect(acronymIds(q)).toEqual(["api"]);
      expect(q.topicalRecall ?? null).toBeNull();
      expect(q.configuredPrefixSpans).toEqual([]);
    }
  });

  test("an exact first expansion word does not steal a different first-token prefix", () => {
    const dict = [
      { key: "oauth", aliases: [["open", "authorization"]]},
      { key: "oidc", aliases: [["openid", "connect"]]},
    ];
    const q = analyzeQuery("open", { plugins: plugins(dict) });
    expect(q.configuredSequenceIntent).toBeNull();
    expect(acronymIds(q)).toEqual([]);
    expect(q.configuredPrefixSpans).toEqual([]);
  });

  test("same-length first-token prefixes fail closed and do not activate topical recall", () => {
    for (const raw of ["appl", "appli", "applic"]) {
      const q = analyzeQuery(raw, { plugins: plugins(sameLengthDict) });
      expect(q.configuredSequenceIntent).toBeNull();
      expect(acronymIds(q)).toEqual([]);
      expect(q.topicalRecall ?? null).toBeNull();
      expect(resolveConfiguredPrefixSpans(q.tokens, plugins(sameLengthDict)[1])).toEqual([]);
    }
  });

  test("additional typed tokens immediately narrow the candidate set", () => {
    const se = analyzeQuery("application se", { plugins: plugins(apiAppsecDict) });
    expect(se.configuredSequenceIntent?.key).toBe("appsec");
    expect(se.topicalRecall?.key).toBe("appsec");
    const pr = analyzeQuery("application pr", { plugins: plugins(apiAppsecDict) });
    expect(pr.configuredSequenceIntent?.key).toBe("api");
    expect(pr.topicalRecall ?? null).toBeNull();
  });

  test("exact configured span is stronger than a first-token prefix", () => {
    const q = analyzeQuery("app sec", { plugins: plugins(apiAppsecDict) });
    expect(q.configuredSequenceIntent?.key).toBe("appsec");
    expect(q.configuredSpans.length).toBeGreaterThan(0);
    expect(q.configuredPrefixSpans).toEqual([]);
    expect(q.topicalRecall?.key).toBe("appsec");
  });

  test("wrapped stop remainder reuses the same first-token occupancy", () => {
    const q = analyzeQuery("what is an appl", { plugins: plugins(apiAppsecDict) });
    expect(q.tokens.map((t) => t.surface)).toEqual(["what", "is", "an", "appl"]);
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredPrefixSpans).toEqual([
      { key: "api", start: 3, end: 4, matchedKinds: ["expansion"], usedPrefix: true },
    ]);
    expect(acronymIds(q)).toEqual(["api"]);
    expect(q.topicalRecall ?? null).toBeNull();
  });

  test("generic application prefix does not activate AppSec topical recall", () => {
    for (const raw of ["appl", "applic", "what is an applic"]) {
      const q = analyzeQuery(raw, { plugins: plugins(apiAppsecDict) });
      expect(acronymIds(q)).toEqual(["api"]);
      expect(q.topicalRecall ?? null).toBeNull();
    }
  });

  test("specific AppSec forms still occupy AppSec and topical recall", () => {
    for (const raw of ["appsec", "app sec", "application security", "application se", "what is an app sec"]) {
      const q = analyzeQuery(raw, { plugins: plugins(apiAppsecDict) });
      expect(acronymIds(q)).toEqual(["appsec"]);
      expect(q.topicalRecall?.key).toBe("appsec");
    }
  });
});

describe("partial expansion projects configured sequence intent", () => {
  test("unique n>=2 left prefix occupies intent without a one-token special case", () => {
    const q = analyzeQuery("application programming", { plugins: plugins(apiAppsecDict) });
    expect(q.configuredSequenceIntent?.key).toBe("api");
    expect(q.lexicalPhraseKey).toBe(
      analyzeQuery("api", { plugins: plugins(apiAppsecDict) }).lexicalPhraseKey
    );
    expect(acronymIds(q)).toEqual(["api"]);
    expect(q.tokens.map((t) => t.surface)).toEqual(["application", "programming"]);
  });
});

describe("unknown-token repair stays isolated from configured prefixes", () => {
  const lexicon = ["application", "programming", "interface", "security"];
  const apiPlugins = plugins([{ key: "api", aliases: [["application", "programming", "interface"]]}]);

  test("glued API queries still occupy API", () => {
    for (const raw of ["applicationprogramming interface", "application programminginterface"]) {
      const q = analyzeQuery(raw, { plugins: apiPlugins, lexicon });
      expect(q.configuredSequenceIntent?.key).toBe("api");
      expect(q.tokens.map((t) => t.surface)).toEqual(["application", "programming", "interface"]);
    }
  });

  test("appl remains a configured prefix, not an unknown-token typo repair", () => {
    const q = analyzeQuery("appl", {
      plugins: plugins(apiAppsecDict),
      lexicon,
      prefixLexicon: lexicon,
    });
    expect(q.tokens[0].surface).toBe("appl");
    expect(q.tokens[0].surfaceNormalized).toBe("appl");
    expect(q.tokens[0].sources).not.toContain("typo-correction");
    expect(q.alternatives.some((a) => a.source === "compound-segment")).toBe(false);
    expect(q.configuredSequenceIntent?.key).toBe("api");
  });
});

describe("configured occupancy retrieval", () => {
  const docs = [
    {
      id: "api",
      title: "What is an API?",
      body: "An application programming interface lets clients talk to a service.",
    },
    { id: "appsec", title: "App Sec", body: "application security authentication authorization" },
    { id: "server", title: "Application Server", body: "application server runtime" },
    { id: "widget", title: "What is a Widget?", body: "user interface control widget" },
  ];

  async function engine(entries = apiAppsecDict, retriever = "full-scan") {
    const e = SearchEngine.create({ schema, plugins: plugins(entries), retriever });
    await e.index(docs);
    return e;
  }

  test("plural configured key retrieves the canonical document first", async () => {
    const e = await engine(widgetDict);
    expect(e.search("what are widgets", { limit: 3 })[0].id).toBe("widget");
  });

  test("API prefix ranks the canonical API document first", async () => {
    const e = await engine();
    for (const raw of ["appl", "what is an appl", "application programming"]) {
      expect(e.search(raw, { limit: 3 })[0].id).toBe("api");
    }
  });

  test("AppSec specific forms still rank App Sec first", async () => {
    const e = await engine();
    for (const raw of ["appsec", "app sec", "application security", "application se"]) {
      expect(e.search(raw, { limit: 3 })[0].id).toBe("appsec");
    }
  });

  test("indexed and full-scan agree on occupancy queries", async () => {
    const full = await engine(apiAppsecDict, "full-scan");
    const indexed = await engine(apiAppsecDict, "indexed");
    for (const raw of ["widgets", "what are apis", "appl", "application programming", "app sec", "application se"]) {
      expect(indexed.search(raw).map((row) => row.id)).toEqual(full.search(raw).map((row) => row.id));
    }
  });
});
