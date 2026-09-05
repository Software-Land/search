/**
 * Equal-alias architecture: aliases are unordered peers.
 * Alias array order has no search semantic effect.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { resolveConfiguredSequence } from "../dist/query/configuredSequence.js";

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
    matchedForm: q.configuredSequenceIntent?.matchedForm || [],
    formCoverage: concept?.formCoverage ?? null,
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
    configuredFormEvidence: detailed.results.map((h) => h.features?.configuredFormEvidence ?? null),
    configuredConceptMatch: detailed.results.map((h) => h.features?.configuredConceptMatch ?? null),
    configuredFormCoverage: occupied?.formCoverage ?? null,
    configuredFormBodyMatch: detailed.results.map((h) => h.features?.configuredFormBodyMatch ?? null),
    phraseAdjacency: detailed.results.map((h) => h.features?.phraseAdjacency ?? null),
    queryTokenCount: detailed.results.map((h) => h.features?.queryTokenCount ?? null),
    titlePrefixQuality: detailed.results.map((h) => h.features?.titlePrefixQuality ?? null),
    titleCoverage: detailed.results.map((h) => h.features?.titleCoverage ?? null),
    exactTitleTokenMatch: detailed.results.map((h) => h.features?.exactTitleTokenMatch ?? null),
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
  expect(b.configuredFormEvidence).toEqual(a.configuredFormEvidence);
  expect(b.configuredConceptMatch).toEqual(a.configuredConceptMatch);
  expect(b.configuredFormCoverage).toEqual(a.configuredFormCoverage);
  expect(b.configuredFormBodyMatch).toEqual(a.configuredFormBodyMatch);
  expect(b.phraseAdjacency).toEqual(a.phraseAdjacency);
  expect(b.queryTokenCount).toEqual(a.queryTokenCount);
  expect(b.titlePrefixQuality).toEqual(a.titlePrefixQuality);
  expect(b.titleCoverage).toEqual(a.titleCoverage);
  expect(b.exactTitleTokenMatch).toEqual(a.exactTitleTokenMatch);
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

  test("peer-form completeness is distinct from occupancy and is symmetric", async () => {
    const entries = [apiPeers];
    const { engine, plug } = await engineFor(apiPeers.aliases);
    const fullA = occupancyOf("application programming interface", entries);
    const fullB = occupancyOf("application program interface", entries);
    const prefixA = occupancyOf("application programming", entries);
    const prefixB = occupancyOf("application program", entries);
    expect(fullA.key).toBe("api");
    expect(fullB.key).toBe("api");
    expect(fullA.formCoverage).toBe(1);
    expect(fullB.formCoverage).toBe(1);
    expect(prefixA.formCoverage).toBe(0.6667);
    expect(prefixB.formCoverage).toBe(0.6667);
    expect(prefixA.formCoverage).toBe(prefixB.formCoverage);
    const fullViewA = publicView(engine, plug, "application programming interface");
    const prefixViewA = publicView(engine, plug, "application programming");
    expect(fullViewA.configuredFormCoverage).toBe(1);
    expect(prefixViewA.configuredFormCoverage).toBe(0.6667);
    expect(prefixViewA.configuredFormCoverage).toBeLessThan(fullViewA.configuredFormCoverage);
    for (const aliases of permutations(apiPeers.aliases)) {
      expect(occupancyOf("application programming", [{ key: "api", aliases }]).formCoverage).toBe(0.6667);
      expect(occupancyOf("application program", [{ key: "api", aliases }]).formCoverage).toBe(0.6667);
      expect(occupancyOf("application programming interface", [{ key: "api", aliases }]).formCoverage).toBe(1);
    }
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

  test("fixture has 17 multi-alias concepts with max 5 aliases", () => {
    expect(multi.length).toBe(17);
    expect(Math.max(...multi.map((e) => e.aliases.length))).toBe(5);
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
      configuredFormEvidence: h.features?.configuredFormEvidence,
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
          configuredFormEvidence: h.features?.configuredFormEvidence,
          configuredConceptMatch: h.features?.configuredConceptMatch,
          phraseAdjacency: h.features?.phraseAdjacency,
        }));
        expect(rows.map((r) => r.id)).toEqual(baseRows.map((r) => r.id));
        expect(rows.map((r) => r.score)).toEqual(baseRows.map((r) => r.score));
        expect(rows.map((r) => r.configuredFormEvidence)).toEqual(baseRows.map((r) => r.configuredFormEvidence));
        expect(rows.map((r) => r.configuredConceptMatch)).toEqual(baseRows.map((r) => r.configuredConceptMatch));
        expect(rows.map((r) => r.phraseAdjacency)).toEqual(baseRows.map((r) => r.phraseAdjacency));
      }
    }
  });
});

function rankingQueriesFor(concept) {
  const queries = [concept.key];
  for (const alias of concept.aliases) {
    queries.push(alias.join(" "));
    if (alias.length >= 3) queries.push(alias.slice(0, 2).join(" "));
  }
  return [...new Set(queries)];
}

function docsForConcept(concept) {
  const docs = [{ id: `${concept.key}-key`, title: String(concept.key).toUpperCase(), body: `${concept.key} key document` }];
  concept.aliases.forEach((alias, i) => {
    docs.push({
      id: `${concept.key}-form-${i}`,
      title: alias.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      body: alias.join(" "),
    });
  });
  docs.push({ id: "noise", title: "Unrelated Noise", body: "zzzz" });
  return docs;
}

describe("fixture multi-alias exhaustive ranking permutation", () => {
  const fixture = JSON.parse(
    readFileSync(path.join(ROOT, "fixtures", "software-land", "configured-concepts.json"), "utf8")
  );
  const multi = fixture.filter((e) => Array.isArray(e.aliases) && e.aliases.length >= 2);

  test.each(multi.map((e) => [e.key, e.aliases.length]))(
    "exhaustive permutations of %s (%s aliases) preserve occupied ranking",
    async (key) => {
      const concept = fixture.find((e) => e.key === key);
      const docs = docsForConcept(concept);
      const queries = rankingQueriesFor(concept).filter((q) => occupancyOf(q, [concept]).key === key);
      expect(queries.length).toBeGreaterThan(0);
      const firstPlug = plugins([concept]);
      const first = SearchEngine.create({ schema, plugins: firstPlug, retriever: "full-scan" });
      await first.index(docs);
      const baseline = Object.fromEntries(queries.map((q) => [q, publicView(first, firstPlug, q)]));
      for (const aliases of permutations(concept.aliases)) {
        const entries = [{ ...concept, aliases }];
        const plug = plugins(entries);
        const engine = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
        await engine.index(docs);
        for (const q of queries) {
          expectSameSemantic(baseline[q], publicView(engine, plug, q));
        }
      }
    }
  );
});

describe("alias-cardinality stability", () => {
  const docs = [
    { id: "alpha", title: "Alpha Widget", body: "alpha widget notes" },
    { id: "beta", title: "Beta Gadget", body: "beta gadget notes" },
    { id: "noise", title: "Unrelated", body: "noise document" },
  ];

  async function viewFor(aliases, raw) {
    const entries = [{ key: "aw", aliases }];
    const plug = plugins(entries);
    const engine = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
    await engine.index(docs);
    return publicView(engine, plug, raw);
  }

  test("unused peer form with zero corpus evidence does not dilute existing matches", async () => {
    const one = [["alpha", "widget"]];
    const twoMatching = [["alpha", "widget"], ["beta", "gadget"]];
    const unused = [["alpha", "widget"], ["beta", "gadget"], ["zeta", "quorum"]];
    const unusedLong = [["alpha", "widget"], ["beta", "gadget"], ["zeta", "quorum", "unused", "peer"]];
    const duplicate = [["alpha", "widget"], ["alpha", "widget"]];
    const baseline = await viewFor(one, "alpha widget");
    const expanded = await viewFor(twoMatching, "alpha widget");
    const unusedView = await viewFor(unused, "alpha widget");
    const unusedLongView = await viewFor(unusedLong, "alpha widget");
    const keyExpanded = await viewFor(twoMatching, "aw");
    const unusedKey = await viewFor(unused, "aw");
    const unusedLongKey = await viewFor(unusedLong, "aw");
    const duplicateView = await viewFor(duplicate, "alpha widget");
    expect(baseline.key).toBe("aw");
    expect(expanded.ids).toEqual(expect.arrayContaining(["alpha", "beta"]));
    expect(baseline.ids).toContain("alpha");
    expectSameSemantic(expanded, unusedView);
    expectSameSemantic(keyExpanded, unusedKey);
    expectSameSemantic(baseline, duplicateView);
    expect(unusedLongView.ids).toEqual(expanded.ids);
    expect(unusedLongView.scores).toEqual(expanded.scores);
    expect(unusedLongView.relevanceKind).toEqual(expanded.relevanceKind);
    expect(unusedLongView.directClass).toEqual(expanded.directClass);
    expect(unusedLongView.configuredFormEvidence).toEqual(expanded.configuredFormEvidence);
    expect(unusedLongKey.ids).toEqual(keyExpanded.ids);
    expect(unusedLongKey.scores).toEqual(keyExpanded.scores);
  });
});

describe("stopword and false-friend evidence", () => {
  test("internet of things does not rank an unrelated title for of", async () => {
    const entries = [{ key: "iot", aliases: [["internet", "of", "things"]] }];
    const docs = [
      { id: "iot", title: "Internet of Things", body: "iot notes" },
      { id: "of-trap", title: "Staying Ahead of the AI Revolution", body: "unrelated of title" },
    ];
    const plug = plugins(entries);
    const engine = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
    await engine.index(docs);
    const detailed = engine.searchDetailed("internet of things", { limit: 10, explain: true });
    const trap = detailed.results.find((h) => h.id === "of-trap");
    const hit = detailed.results.find((h) => h.id === "iot");
    expect(hit).toBeTruthy();
    expect(hit.features.configuredConceptMatch).toBe("form");
    if (trap) {
      expect(trap.features.configuredConceptMatch).not.toBe("form");
      expect(trap.features.configuredFormEvidence).toBe(0);
      expect(trap.rank).toBeGreaterThan(hit.rank);
    }
    expect((detailed.meta.candidateIds || []).includes("of-trap")).toBe(false);
  });

  test("platform as a service does not rank unrelated titles for as/a", async () => {
    const entries = [{ key: "paas", aliases: [["platform", "as", "a", "service"]] }];
    const docs = [
      { id: "paas", title: "Platform as a Service", body: "paas notes" },
      { id: "as-trap", title: "As a Matter of Fact", body: "unrelated as a title" },
    ];
    const plug = plugins(entries);
    const engine = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
    await engine.index(docs);
    const detailed = engine.searchDetailed("platform as a service", { limit: 10, explain: true });
    const trap = detailed.results.find((h) => h.id === "as-trap");
    const hit = detailed.results.find((h) => h.id === "paas");
    expect(hit).toBeTruthy();
    if (trap) {
      expect(trap.features.configuredConceptMatch).not.toBe("form");
      expect(trap.features.configuredFormEvidence).toBe(0);
    }
    expect((detailed.meta.candidateIds || []).includes("as-trap")).toBe(false);
  });

  test("development operations is not developer-title evidence; devops in a title is", async () => {
    const entries = [{ key: "devop", aliases: [["development", "operations"], ["devops"]] }];
    const docs = [
      { id: "devops", title: "What is DevOps?", body: "devops culture" },
      { id: "developer", title: "Software Engineer vs Software Developer", body: "career comparison" },
    ];
    const plug = plugins(entries);
    const engine = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
    await engine.index(docs);
    const ops = engine.searchDetailed("development operations", { limit: 10, explain: true });
    const key = engine.searchDetailed("devop", { limit: 10, explain: true });
    const devopsHit = ops.results.find((h) => h.id === "devops");
    const developer = ops.results.find((h) => h.id === "developer");
    expect(devopsHit).toBeTruthy();
    expect(devopsHit.features.configuredFormEvidence).toBeGreaterThan(0);
    expect(["form", "key-in-title"]).toContain(devopsHit.features.configuredConceptMatch);
    if (developer) {
      expect(developer.features.configuredConceptMatch).not.toBe("form");
      expect(developer.features.configuredFormEvidence).toBe(0);
      expect(developer.score).toBeLessThan(devopsHit.score);
    }
    expectSameSemantic(publicView(engine, plug, "development operations"), publicView(engine, plug, "devops"));
    expectSameSemantic(publicView(engine, plug, "devop"), publicView(engine, plug, "devops"));
    expect(key.results.find((h) => h.id === "devops").features.configuredFormEvidence).toBeGreaterThan(0);
  });
});

