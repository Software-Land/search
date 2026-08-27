/**
 * Stop-tolerant configured expansion alignment: interior typed stops may be
 * skipped, the last typed content token may prefix, and a unique ≥3-content
 * suffix may occupy. Typed surface is never rewritten. Bare interior fragments
 * and non-stop gaps fail closed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { analyzeQuery } from "../dist/analyze.js";
import { resolveConfiguredSequence } from "../dist/configuredSequence.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const nistFamily = [
  { key: "nist", aliases: [["national", "institute", "standards", "technology"]]},
  { key: "gatech", aliases: [["georgia", "institute", "of", "technology"]]},
  { key: "api", aliases: [["application", "programming", "interface"]]},
  { key: "vpn", aliases: [["virtual", "private", "network"]]},
  { key: "rbac", aliases: [["role", "based", "access", "control"]]},
  { key: "appsec", aliases: [["application", "security"], ["app", "sec"]] },
  { key: "techdebt", aliases: [["tech", "debt"]]},
  { key: "iot", aliases: [["internet", "things"], ["internet", "of", "things"]] },
];

function plugins(entries = nistFamily) {
  return [morphology(), dictionary({ entries })];
}

function analyze(raw, entries) {
  return analyzeQuery(raw, { plugins: plugins(entries) });
}

function acronymIds(q) {
  return q.concepts.filter((c) => c.kind === "configured-concept").map((c) => c.id);
}

describe("stop-tolerant configured expansion alignment", () => {
  test("typed stops are skipped so the full spoken expansion occupies the key", () => {
    const q = analyze("national institute of standards and technology");
    expect(q.tokens.map((t) => t.surface)).toEqual([
      "national",
      "institute",
      "of",
      "standards",
      "and",
      "technology",
    ]);
    expect(q.configuredSequenceIntent?.key).toBe("nist");
    expect(q.configuredSequenceIntent?.matchedKinds).toContain("expansion");
    expect(resolveConfiguredSequence(q.tokens, plugins()[1])).toMatchObject({
      status: "unique",
      alignment: "full",
      usedPrefix: false,
    });
    expect(acronymIds(q)).toEqual(["nist"]);
  });

  test("content-token order remains fixed", () => {
    const q = analyze("national standards institute technology");
    expect(q.configuredSequenceIntent).toBeNull();
    expect(resolveConfiguredSequence(q.tokens, plugins()[1]).status).toBe("none");
  });

  test("non-stop gaps are rejected", () => {
    for (const raw of ["role access control", "institute technology", "national standards technology"]) {
      const q = analyze(raw);
      expect(q.configuredSequenceIntent).toBeNull();
      expect(resolveConfiguredSequence(q.tokens, plugins()[1]).status).toBe("none");
    }
  });

  test("the last typed content token may be a prefix of the current expansion token", () => {
    const cases = [
      ["national institute of stan", "left-prefix", true],
      ["national institute of standards and tec", "full", true],
      ["national institute of standard", "left-prefix", true],
    ];
    for (const [raw, alignment, usedPrefix] of cases) {
      const q = analyze(raw);
      expect(q.tokens.map((t) => t.surface).join(" ")).toBe(raw);
      expect(q.configuredSequenceIntent?.key).toBe("nist");
      expect(resolveConfiguredSequence(q.tokens, plugins()[1])).toMatchObject({
        status: "unique",
        alignment,
        usedPrefix,
      });
      expect(acronymIds(q)).toEqual(["nist"]);
    }
  });

  test("exact full alignment beats a last-token prefix of a different key", () => {
    const dict = [
      { key: "ab", aliases: [["alpha", "beta"]]},
      { key: "ax", aliases: [["alpha", "betamax"]]},
    ];
    const q = analyze("alpha beta", dict);
    expect(q.configuredSequenceIntent?.key).toBe("ab");
    expect(resolveConfiguredSequence(q.tokens, plugins(dict)[1])).toMatchObject({
      status: "unique",
      usedPrefix: false,
      alignment: "full",
    });
  });

  test("ambiguous same-coverage suffixes fail closed", () => {
    const dict = [
      { key: "nist", aliases: [["national", "institute", "standards", "technology"]]},
      { key: "wist", aliases: [["western", "institute", "standards", "technology"]]},
    ];
    const q = analyze("institute of standards and technology", dict);
    expect(q.configuredSequenceIntent).toBeNull();
    expect(resolveConfiguredSequence(q.tokens, plugins(dict)[1]).status).toBe("none");
  });

  test("a unique multi-token suffix occupies when it includes the final expansion token", () => {
    const q = analyze("institute of standards and technology");
    expect(q.tokens.map((t) => t.surface)).toEqual([
      "institute",
      "of",
      "standards",
      "and",
      "technology",
    ]);
    expect(q.configuredSequenceIntent?.key).toBe("nist");
    expect(resolveConfiguredSequence(q.tokens, plugins()[1])).toMatchObject({
      status: "unique",
      alignment: "suffix",
      usedPrefix: false,
    });
    expect(acronymIds(q)).toEqual(["nist"]);
  });

  test("two-token interior fragments fail closed", () => {
    for (const raw of ["institute standards", "private network", "programming interface"]) {
      const q = analyze(raw);
      expect(q.configuredSequenceIntent).toBeNull();
      expect(resolveConfiguredSequence(q.tokens, plugins()[1]).status).toBe("none");
    }
  });

  test("one-token ambiguous interior fragments fail closed", () => {
    for (const raw of ["institute", "standards", "technology", "national", "programming", "application"]) {
      const q = analyze(raw);
      expect(q.configuredSequenceIntent?.key).not.toBe("nist");
      expect(q.configuredSequenceIntent?.key).not.toBe("gatech");
      if (raw === "institute" || raw === "standards" || raw === "technology" || raw === "national") {
        expect(q.configuredSequenceIntent).toBeNull();
      }
    }
  });

  test("typed surface is preserved while occupancy uses canonical expansion intent", () => {
    const raw = "national institute of standards and technology";
    const q = analyze(raw);
    expect(q.originalSurface).toEqual(["national", "institute", "of", "standards", "and", "technology"]);
    expect(q.tokens.map((t) => t.surface)).toEqual(q.originalSurface);
    expect(q.configuredSequenceIntent?.expansion).toEqual([
      "national",
      "institute",
      "standards",
      "technology",
    ]);
  });

  test("generic fragments do not accidentally occupy configured keys", () => {
    for (const raw of [
      "standards",
      "technology",
      "national",
      "institute technology",
      "security technology",
      "programming interface",
      "role access control",
      "private network",
      "programming",
      "application",
    ]) {
      const q = analyze(raw);
      expect(q.configuredSequenceIntent).toBeNull();
    }
  });

  test("leading wrapper stops are not skipped for whole-query occupancy", () => {
    const q = analyze("what is an app sec");
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.tokens.map((t) => t.surface)).toEqual(["what", "is", "an", "app", "sec"]);
    expect(acronymIds(q)).toEqual(["appsec"]);
  });

  test("existing equal-length controls still occupy", () => {
    expect(analyze("internet of things").configuredSequenceIntent?.key).toBe("iot");
    expect(analyze("virtual private network").configuredSequenceIntent?.key).toBe("vpn");
    expect(analyze("role based access control").configuredSequenceIntent?.key).toBe("rbac");
    expect(analyze("application programming").configuredSequenceIntent?.key).toBe("api");
    expect(analyze("nist").configuredSequenceIntent?.key).toBe("nist");
  });

  test("trailing stub of a longer spoken form does not keep a competing one-token acronym", () => {
    const q = analyze("national institute of standards and tec");
    expect(q.configuredSequenceIntent?.key).toBe("nist");
    expect(acronymIds(q)).toEqual(["nist"]);
    expect(acronymIds(q)).not.toContain("techdebt");
  });

  test("compound configured identity occupies as configured-concept, not acronym", () => {
    const q = analyze("tech debt");
    expect(q.configuredSequenceIntent?.key).toBe("techdebt");
    expect(acronymIds(q)).toEqual(["techdebt"]);
    expect(q.concepts.find((c) => c.id === "techdebt")?.kind).toBe("configured-concept");
    expect(q.concepts.every((c) => c.kind !== "acronym")).toBe(true);
  });
});

describe("explicit exact 1-token configured aliases", () => {
  const nistAliases = [
    {
      key: "nist",
      aliases: [["national", "institute", "standards", "technology"], ["institute"], ["institute", "standards"]],
    },
    { key: "gatech", aliases: [["georgia", "institute", "of", "technology"]]},
    { key: "appsec", aliases: [["application", "security"], ["app", "sec"]] },
  ];

  test("a unique exact 1-token expansion-word alias occupies whole-query intent", () => {
    const q = analyze("institute", nistAliases);
    expect(q.tokens.map((t) => t.surface)).toEqual(["institute"]);
    expect(q.configuredSequenceIntent?.key).toBe("nist");
    expect(q.configuredSequenceIntent?.matchedKinds).toEqual(["alias"]);
    expect(q.configuredSequenceIntent?.expansion).toEqual([
      "national",
      "institute",
      "standards",
      "technology",
    ]);
    expect(resolveConfiguredSequence(q.tokens, plugins(nistAliases)[1])).toMatchObject({
      status: "unique",
      alignment: "full",
      usedPrefix: false,
    });
    expect(acronymIds(q)).toEqual(["nist"]);
  });

  test("an explicit 2-token alias occupies without prefixing unrelated institute queries", () => {
    const q = analyze("institute standards", nistAliases);
    expect(q.configuredSequenceIntent?.key).toBe("nist");
    expect(q.configuredSequenceIntent?.matchedKinds).toContain("alias");
    for (const raw of ["institute technology", "institute programming", "institute security"]) {
      expect(analyze(raw, nistAliases).configuredSequenceIntent).toBeNull();
    }
  });

  test("a prefix of a 1-token alias does not occupy", () => {
    for (const raw of ["inst", "instit", "institu"]) {
      expect(analyze(raw, nistAliases).configuredSequenceIntent?.key).not.toBe("nist");
    }
  });

  test("colliding 1-token aliases fail closed", () => {
    const dict = [
      { key: "nist", aliases: [["national", "institute"], ["institute"]] },
      { key: "gatech", aliases: [["georgia", "institute"], ["institute"]] },
    ];
    const q = analyze("institute", dict);
    expect(q.configuredSequenceIntent).toBeNull();
    expect(resolveConfiguredSequence(q.tokens, plugins(dict)[1]).status).toBe("ambiguous");
  });

  test("bare expansion words still fail closed without an explicit 1-token alias", () => {
    expect(analyze("institute").configuredSequenceIntent).toBeNull();
    expect(analyze("security").configuredSequenceIntent).toBeNull();
    expect(analyze("standards").configuredSequenceIntent).toBeNull();
  });
});

describe("NIST spoken forms on the Software.Land fixture", () => {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const FIXTURE = path.join(ROOT, "fixtures", "software-land");
  const loadJson = (name) => JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));

  let engine;
  let full;
  let indexed;

  beforeAll(async () => {
    const documents = attachLexicalFrequency(loadJson("documents.json"), loadJson("lexical-frequency.json"));
    const pluginsForEngine = [
      morphology({ lemmas: loadJson("lemmas.json") }),
      dictionary({ entries: loadJson("dictionary.json") }),
    ];
    engine = SearchEngine.create({ schema, plugins: pluginsForEngine, retriever: "full-scan" });
    await engine.index(documents);
    full = engine;
    indexed = SearchEngine.create({ schema, plugins: pluginsForEngine, retriever: "indexed" });
    await indexed.index(documents);
  });

  test("nist and safely resolvable spoken forms rank TLS 1.2 Vulnerability first", () => {
    const queries = [
      "nist",
      "national institute of standards and technology",
      "national institute of stan",
      "national institute of standards and tec",
      "national institute of standard",
      "institute of standards and technology",
    ];
    for (const raw of queries) {
      const q = full._prepareQuery(raw);
      expect(q.configuredSequenceIntent?.key).toBe("nist");
      expect(full.search(raw, { limit: 5 })[0].title).toBe("TLS 1.2 Vulnerability");
    }
  });

  test("bare institute and two-token institute standards stay fail-closed", () => {
    expect(full._prepareQuery("institute").configuredSequenceIntent).toBeNull();
    expect(full._prepareQuery("institute standards").configuredSequenceIntent).toBeNull();
    expect(full.search("institute", { limit: 1 })[0].title).toBe("Udacity Review");
  });

  test("indexed and full-scan agree on NIST spoken forms", () => {
    for (const raw of [
      "nist",
      "national institute of standards and technology",
      "national institute of stan",
      "national institute of standards and tec",
      "institute of standards and technology",
      "institute",
    ]) {
      expect(indexed.search(raw).map((row) => row.id)).toEqual(full.search(raw).map((row) => row.id));
    }
  });
});
