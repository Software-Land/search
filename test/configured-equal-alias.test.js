/**
 * Equal-alias architecture: aliases are unordered peers.
 * Alias array order has no search semantic effect.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/analyze.js";
import { resolveConfiguredSequence } from "../dist/configuredSequence.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

function plugins(entries) {
  return [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: entries })];
}

function permutations(arr) {
  if (arr.length <= 1) return [arr.map((item) => (Array.isArray(item) ? [...item] : item))];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) out.push([arr[i], ...perm]);
  }
  return out;
}

function occupancyOf(raw, entries) {
  const plug = plugins(entries);
  const q = analyzeQuery(raw, { plugins: plug });
  const concept = q.concepts.find((c) => c.kind === "configured-concept");
  return {
    key: q.configuredSequenceIntent?.key ?? null,
    matchedKinds: [...(q.configuredSequenceIntent?.matchedKinds || [])].sort(),
    provenance: concept?.provenance ?? null,
    matchedForm: q.configuredSequenceIntent?.expansion || [],
    expansionCoverage: concept?.expansionCoverage ?? null,
    spanKinds: (q.configuredSpans || []).flatMap((s) => s.matchedKinds).sort(),
    prefixSpanKinds: (q.configuredPrefixSpans || []).flatMap((s) => s.matchedKinds).sort(),
  };
}

function publicView(engine, analyzePlugins, raw, limit = 20) {
  const analyzed = analyzeQuery(raw, { plugins: analyzePlugins });
  const detailed = engine.searchDetailed(raw, { limit, relatedLimit: 8, explain: true });
  const occupied = analyzed.concepts.find((c) => c.kind === "configured-concept");
  return {
    key: analyzed.configuredSequenceIntent?.key ?? null,
    candidateIds: detailed.meta.candidateIds || detailed.results.map((h) => h.id),
    ids: detailed.results.map((h) => h.id),
    scores: detailed.results.map((h) => h.score),
    relevanceKind: detailed.results.map((h) => h.relevanceKind),
    directClass: detailed.results.map((h) => h.directClass),
    relatedIds: (detailed.related || []).map((h) => h.id),
    retrievalSources: detailed.results.map((h) => [...(h.retrievalSources || [])].sort()),
    expansionEvidence: detailed.results.map((h) => h.features?.expansionEvidence ?? null),
    configuredConceptMatch: detailed.results.map((h) => h.features?.configuredConceptMatch ?? null),
    configuredExpansionCoverage: occupied?.expansionCoverage ?? null,
  };
}

function expectSameSemantic(a, b) {
  expect(b.key).toEqual(a.key);
  expect(b.candidateIds).toEqual(a.candidateIds);
  expect(b.ids).toEqual(a.ids);
  expect(b.scores).toEqual(a.scores);
  expect(b.relevanceKind).toEqual(a.relevanceKind);
  expect(b.directClass).toEqual(a.directClass);
  expect(b.relatedIds).toEqual(a.relatedIds);
  expect(b.retrievalSources).toEqual(a.retrievalSources);
}

const apiPeers = {
  key: "api",
  aliases: [
    ["application", "programming", "interface"],
    ["application", "program", "interface"],
  ],
};

describe("peer-alias parity", () => {
  const docs = [
    { id: "api-programming", title: "Application Programming Interface", body: "application programming interface notes" },
    { id: "api-program", title: "Application Program Interface", body: "application program interface notes" },
    { id: "api-key", title: "API", body: "the letters api" },
    { id: "noise", title: "Authorization", body: "oauth tokens" },
  ];

  async function engineFor(aliases, retriever = "full-scan") {
    const entries = [{ key: "api", aliases }];
    const plug = plugins(entries);
    const engine = SearchEngine.create({ schema, plugins: plug, retriever });
    await engine.index(docs);
    return { engine, plug, entries };
  }

  test("application programming interface and application program interface occupy api", () => {
    const entries = [apiPeers];
    expect(occupancyOf("application programming interface", entries).key).toBe("api");
    expect(occupancyOf("application program interface", entries).key).toBe("api");
    expect(occupancyOf("application programming", entries).key).toBe("api");
    expect(occupancyOf("application program", entries).key).toBe("api");
  });

  test("eligible prefixes of peer forms share occupancy and ranked results", async () => {
    const { engine, plug } = await engineFor(apiPeers.aliases);
    const programming = publicView(engine, plug, "application programming interface");
    const program = publicView(engine, plug, "application program interface");
    expectSameSemantic(programming, program);
    const prefixA = publicView(engine, plug, "application programming");
    const prefixB = publicView(engine, plug, "application program");
    expect(prefixA.key).toBe("api");
    expect(prefixB.key).toBe("api");
    expectSameSemantic(prefixA, prefixB);
  });

  test("javascript / ecmascript are peer exact queries with one-token prefix safety", async () => {
    const entries = [{ key: "js", aliases: [["javascript"], ["ecmascript"]] }];
    const docsJs = [
      { id: "js-doc", title: "JavaScript", body: "ecmascript language" },
      { id: "java-trap", title: "Java", body: "jvm" },
    ];
    const plug = plugins(entries);
    const engine = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
    await engine.index(docsJs);
    expect(occupancyOf("javascript", entries).key).toBe("js");
    expect(occupancyOf("ecmascript", entries).key).toBe("js");
    expect(occupancyOf("java", entries).key).toBeNull();
    expect(occupancyOf("ecma", entries).key).toBeNull();
    const a = publicView(engine, plug, "javascript");
    const b = publicView(engine, plug, "ecmascript");
    expectSameSemantic(a, b);
  });

  test("exhaustive alias permutations preserve occupancy and ranked results", async () => {
    const base = apiPeers.aliases;
    const queries = [
      "api",
      "application programming interface",
      "application program interface",
      "application programming",
      "application program",
    ];
    const first = await engineFor(base);
    const baseline = Object.fromEntries(queries.map((q) => [q, { occ: occupancyOf(q, first.entries), view: publicView(first.engine, first.plug, q) }]));
    for (const aliases of permutations(base)) {
      const { engine, plug, entries } = await engineFor(aliases);
      for (const q of queries) {
        expect(occupancyOf(q, entries)).toEqual(baseline[q].occ);
        expectSameSemantic(baseline[q].view, publicView(engine, plug, q));
      }
    }
  });
});

describe("key vs alias recognition vs post-occupancy ranking", () => {
  test("A. exact key outranks a foreign one-token alias of the same typed form", () => {
    const entries = [
      { key: "ai", aliases: [["artificial", "intelligence"]] },
      { key: "aid", aliases: [["aid", "system"], ["ai"]] },
    ];
    expect(occupancyOf("ai", entries).key).toBe("ai");
    const res = resolveConfiguredSequence(analyzeQuery("ai", { plugins: plugins(entries) }).tokens, compileConfiguredConceptPlugin({ configuredConcepts: entries }));
    expect(res.status).toBe("unique");
    expect(res.intent.key).toBe("ai");
    expect(res.intent.matchedKinds).toContain("key");
  });

  test("B. once the same concept is occupied through key or alias, concept-level ranking matches", async () => {
    const entries = [{ key: "ai", aliases: [["artificial", "intelligence"], ["machine", "intellect"]] }];
    const docs = [
      { id: "ai-long", title: "Artificial Intelligence", body: "machine intellect research" },
      { id: "ai-short", title: "AI", body: "the letters a and i" },
      { id: "noise", title: "Authorization", body: "oauth" },
    ];
    const plug = plugins(entries);
    const engine = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
    await engine.index(docs);
    const key = publicView(engine, plug, "ai");
    const aliasA = publicView(engine, plug, "artificial intelligence");
    const aliasB = publicView(engine, plug, "machine intellect");
    expect(key.key).toBe("ai");
    expectSameSemantic(key, aliasA);
    expectSameSemantic(key, aliasB);
  });
});

describe("adversarial fail-closed ambiguity", () => {
  test("same-prefix peer forms of different concepts fail closed", () => {
    const entries = [
      { key: "ci", aliases: [["continuous", "integration"]] },
      { key: "cd", aliases: [["continuous", "delivery"]] },
    ];
    expect(occupancyOf("continuous", entries).key).toBeNull();
    expect(occupancyOf("cont", entries).key).toBeNull();
  });

  test("one-token alias inside a longer peer form is exact-only", () => {
    const entries = [{ key: "appsec", aliases: [["application", "security"], ["security"]] }];
    expect(occupancyOf("security", entries).key).toBe("appsec");
    expect(occupancyOf("sec", entries).key).toBeNull();
    expect(occupancyOf("application sec", entries).key).toBe("appsec");
  });

  test("aliases shared across concepts fail closed", () => {
    const entries = [
      { key: "aid", aliases: [["aid", "system"], ["helper"]] },
      { key: "aim", aliases: [["aim", "model"], ["helper"]] },
    ];
    const res = resolveConfiguredSequence(analyzeQuery("helper", { plugins: plugins(entries) }).tokens, compileConfiguredConceptPlugin({ configuredConcepts: entries }));
    expect(res.status).toBe("ambiguous");
    expect(res.keys).toEqual(["aid", "aim"]);
    expect(occupancyOf("helper", entries).key).toBeNull();
  });

  test("stop-tolerant prefix that two concepts share at the same coverage fails closed", () => {
    const entries = [
      { key: "tos", aliases: [["terms", "of", "service"]] },
      { key: "toa", aliases: [["terms", "of", "agreement"]] },
    ];
    expect(occupancyOf("terms of", entries).key).toBeNull();
  });

  test("contextual completion of ambiguous peer endings fails closed", () => {
    const entries = [
      { key: "api", aliases: [["application", "programming", "interface"], ["application", "programming", "internship"]] },
    ];
    const q = analyzeQuery("application programming i", { plugins: plugins(entries) });
    expect(q.configuredSequenceIntent?.key).toBe("api");
    expect(q.contextualCompletion?.completedToken ?? null).toBeNull();
  });

  test("alias author order never selects the winner", () => {
    const a = [
      { key: "x", aliases: [["shared", "prefix", "alpha"], ["shared", "prefix", "beta"]] },
    ];
    const b = [
      { key: "x", aliases: [["shared", "prefix", "beta"], ["shared", "prefix", "alpha"]] },
    ];
    expect(occupancyOf("shared prefix", a)).toEqual(occupancyOf("shared prefix", b));
    expect(occupancyOf("shared prefix a", a)).toEqual(occupancyOf("shared prefix a", b));
  });
});

describe("fixture multi-alias exhaustive permutation occupancy", () => {
  const fixture = JSON.parse(
    readFileSync(path.join(ROOT, "fixtures", "software-land", "configured-concepts.json"), "utf8")
  );
  const multi = fixture.filter((e) => Array.isArray(e.aliases) && e.aliases.length >= 2);

  test("fixture has multi-alias concepts with small alias cardinalities", () => {
    expect(multi.length).toBeGreaterThan(0);
    expect(Math.max(...multi.map((e) => e.aliases.length))).toBeLessThanOrEqual(5);
  });

  test.each(multi.map((e) => [e.key, e.aliases.length]))(
    "exhaustive permutations of %s (%s aliases) preserve occupancy of key, exact aliases, and eligible prefixes",
    (key, _n) => {
      const concept = fixture.find((e) => e.key === key);
      const others = fixture.filter((e) => e.key !== key);
      const queries = [key];
      for (const alias of concept.aliases) {
        queries.push(alias.join(" "));
        if (alias.length >= 3) queries.push(alias.slice(0, 2).join(" "));
      }
      const uniq = [...new Set(queries)];
      const baseline = Object.fromEntries(uniq.map((q) => [q, occupancyOf(q, fixture)]));
      for (const aliases of permutations(concept.aliases)) {
        const entries = [...others, { ...concept, aliases }];
        for (const q of uniq) {
          expect(occupancyOf(q, entries)).toEqual(baseline[q]);
        }
      }
    }
  );
});

describe("occupied ranking features are alias-order independent", () => {
  test("extractFeatures for a uniquely occupied concept does not depend on alias order", async () => {
    const docs = [
      { id: "api-programming", title: "Application Programming Interface", body: "application programming interface notes" },
      { id: "api-program", title: "Application Program Interface", body: "application program interface notes" },
    ];
    const queries = ["api", "application programming interface", "application program interface"];
    const perms = permutations(apiPeers.aliases);
    const firstEntries = [{ key: "api", aliases: perms[0] }];
    const firstPlug = plugins(firstEntries);
    const engine = SearchEngine.create({ schema, plugins: firstPlug, retriever: "full-scan" });
    await engine.index(docs);
    const detailed = engine.searchDetailed("api", { limit: 10, explain: true });
    const baseRows = detailed.results.map((h) => ({
      id: h.id,
      score: h.score,
      expansionEvidence: h.features?.expansionEvidence,
      configuredConceptMatch: h.features?.configuredConceptMatch,
      phraseAdjacency: h.features?.phraseAdjacency,
    }));
    for (const aliases of perms.slice(1)) {
      const entries = [{ key: "api", aliases }];
      const plug = plugins(entries);
      const next = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
      await next.index(docs);
      for (const q of queries) {
        const rows = next.searchDetailed(q, { limit: 10, explain: true }).results.map((h) => ({
          id: h.id,
          score: h.score,
          expansionEvidence: h.features?.expansionEvidence,
          configuredConceptMatch: h.features?.configuredConceptMatch,
          phraseAdjacency: h.features?.phraseAdjacency,
        }));
        expect(rows.map((r) => r.id)).toEqual(baseRows.map((r) => r.id));
        expect(rows.map((r) => r.score)).toEqual(baseRows.map((r) => r.score));
        expect(rows.map((r) => r.expansionEvidence)).toEqual(baseRows.map((r) => r.expansionEvidence));
        expect(rows.map((r) => r.configuredConceptMatch)).toEqual(baseRows.map((r) => r.configuredConceptMatch));
        expect(rows.map((r) => r.phraseAdjacency)).toEqual(baseRows.map((r) => r.phraseAdjacency));
      }
    }
  });
});
