import {
  SearchEngine,
  morphology,
  parseRelationships,
  compileAuthoredRelevance,
} from "../dist/index.js";
import { parseConfiguredConcepts } from "../tools/search-corpus/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { compareConstraint, detectConstraintCycles, DEFAULT_CONSTRAINTS } from "../dist/ranking/constraints.js";
import { RelationshipGraph } from "../dist/relationships/relationships.js";
import { rankCandidates } from "../dist/ranking/rank.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function blankFeatures(over = {}) {
  return {
    exactTitleMatch: false,
    exactTitleTokenMatch: false,
    titleCoverage: 0,
    queryCoverage: 0,
    titlePrefixQuality: 0,
    configuredConceptMatch: false,
    morphologyMatch: false,
    typoDistance: 0,
    versionMatch: false,
    shortLiteralLeadMatch: false,
    phraseAdjacency: 0,
    bodyLexicalMatch: 0,
    titleTokenCount: 3,
    configuredFormEvidence: 0,
    canonicalKeyTitle: false,
    relationshipStrength: 0,
    relationshipType: null,
    relationshipSourceId: null,
    relevanceKind: "direct",
    ...over,
  };
}

describe("constraint composition", () => {
  test("stronger class wins and records the weaker disagreement", () => {
    const a = {
      document: { id: "a" },
      features: blankFeatures({ exactTitleMatch: true, shortLiteralLeadMatch: false, queryCoverage: 1 }),
    };
    const b = {
      document: { id: "b" },
      features: blankFeatures({ exactTitleMatch: false, shortLiteralLeadMatch: true, queryCoverage: 0.2 }),
    };
    const cmp = compareConstraint(a, b);
    expect(cmp.order).toBe(-1);
    expect(cmp.decisiveClass).toBe("absolute");
    expect(cmp.resolution).toBe("stronger-class-wins");
    expect(cmp.conflict).toBe(true);
  });

  test("unanimous absolute constraint resolves without a same-class conflict", () => {
    const a = { document: { id: "a" }, features: blankFeatures({ exactTitleMatch: true }) };
    const b = { document: { id: "b" }, features: blankFeatures({ exactTitleMatch: false }) };
    const cmp = compareConstraint(a, b);
    expect(cmp.order).toBe(-1);
    expect(cmp.decisiveClass).toBe("absolute");
  });

  test("same-class contradiction is unordered and flagged, not a silent score fallthrough", () => {
    const defs = [
      {
        id: "rule-ab",
        invariant: "test",
        class: "strong",
        fn: (a, b) => (a.document.id === "a" && b.document.id === "b" ? -1 : a.document.id === "b" && b.document.id === "a" ? 1 : 0),
      },
      {
        id: "rule-ba",
        invariant: "test",
        class: "strong",
        fn: (a, b) => (a.document.id === "a" && b.document.id === "b" ? 1 : a.document.id === "b" && b.document.id === "a" ? -1 : 0),
      },
    ];
    const a = { document: { id: "a" }, features: blankFeatures() };
    const b = { document: { id: "b" }, features: blankFeatures() };
    const cmp = compareConstraint(a, b, defs);
    expect(cmp.order).toBe(0);
    expect(cmp.conflict).toBe(true);
    expect(cmp.resolution).toBe("unordered-same-class-conflict");
  });

  test("detects a 3-cycle and still ranks deterministically", () => {
    const defs = [
      {
        id: "cycle",
        invariant: "test",
        class: "strong",
        fn: (a, b) => {
          const order = { a: 0, b: 1, c: 2 };
          const d = (order[b.document.id] - order[a.document.id] + 3) % 3;
          if (d === 1) return -1;
          if (d === 2) return 1;
          return 0;
        },
      },
    ];
    const cands = [
      { document: { id: "b" }, features: blankFeatures({ queryCoverage: 0.2 }), retrievalSources: ["title-token"] },
      { document: { id: "c" }, features: blankFeatures({ queryCoverage: 0.9 }), retrievalSources: ["title-token"] },
      { document: { id: "a" }, features: blankFeatures({ queryCoverage: 0.5 }), retrievalSources: ["title-token"] },
    ];
    const diagnosis = detectConstraintCycles(cands, defs);
    expect(diagnosis.cycles.length).toBeGreaterThanOrEqual(1);
    expect(diagnosis.cycles[0].sort()).toEqual(["a", "b", "c"]);
    const ranked = rankCandidates(cands, { constraints: defs });
    expect(ranked.map((r) => r.document.id).sort()).toEqual(["a", "b", "c"]);
    expect(ranked[0].document.id).toBe("c");
    expect(ranked[0].constraintMeta.cycles.length).toBeGreaterThanOrEqual(1);
  });

  test("catalog exposes class", () => {
    expect(DEFAULT_CONSTRAINTS.every((c) => c.class === "absolute" || c.class === "strong" || c.class === "soft")).toBe(true);
  });
});

describe("compiled artifacts", () => {
  test("relationship artifact is versioned and generic", () => {
    const parsed = parseRelationships({
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        "tls-config": [{ target: "vpn", type: "semantic", strength: 0.84, provenance: "offline-embedding-builder" }],
      },
    });
    expect(parsed.version).toBe(1);
    expect(parsed.relationships["tls-config"][0].type).toBe("semantic");
    const g = RelationshipGraph(parsed);
    expect(g.neighbors("tls-config")[0].target).toBe("vpn");
  });

  test("configured-concept artifact stays distinct from equivalent relationshipMap recall", () => {
    const eq = parseConfiguredConcepts({
      format: "search-v2-configured-concepts",
      version: 1,
      entries: [{ key: "tls", aliases: [["transport", "layer", "security"]], type: "equivalence", provenance: "manual" }],
    });
    const authored = compileAuthoredRelevance({
      relationshipMap: {
        auth: [{ to: { form: "authentication" }, kind: "equivalent" }],
        authentication: [{ to: { form: "auth" }, kind: "equivalent" }],
      },
    });
    expect(eq.entries[0].type).toBe("equivalence");
    expect(eq.entries[0].key).toBe("tls");
    expect(authored.plugins.some((plugin) => plugin.name === "synonyms")).toBe(true);
  });

  test("engine works with zero artifacts", async () => {
    const engine = SearchEngine.create({ schema });
    await engine.index([{ id: "a", title: "Alpha", body: "alpha text" }]);
    const results = engine.search("alpha");
    expect(results[0].title).toBe("Alpha");
  });
});

describe("precomputed relationships", () => {
  const docs = [
    { id: "tls-config", title: "TLS Configuration", body: "Configure TLS certificates." },
    { id: "vpn", title: "VPN Settings", body: "Virtual private network settings." },
    { id: "enc", title: "Encryption Settings", body: "Symmetric encryption settings." },
    { id: "unrelated", title: "Monotonic Stack", body: "Stack algorithm." },
  ];
  const graph = {
    format: "search-v2-relationships",
    version: 1,
    relationships: {
      "tls-config": [
        { target: "vpn", type: "semantic", strength: 0.8, provenance: "test" },
        { target: "enc", type: "same-category", strength: 0.7, provenance: "test" },
      ],
    },
  };

  test("direct result stays first; related enter with provenance; unrelated stay out", async () => {
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]]}] })],
      documentRelationships: graph,
    });
    await engine.index(docs);
    const results = engine.search("tls", { limit: 10, explain: true });
    expect(results[0].title).toBe("TLS Configuration");
    expect(results[0].relevanceKind).toBe("direct");
    const vpn = results.find((r) => r.id === "vpn");
    const enc = results.find((r) => r.id === "enc");
    expect(vpn).toBeTruthy();
    expect(enc).toBeTruthy();
    expect(vpn.relevanceKind).toBe("related");
    expect(vpn.retrievalSources).toContain("relationship");
    expect(vpn.features.relationshipSourceId).toBe("tls-config");
    expect(vpn.features.relationshipType).toBe("semantic");
    expect(vpn.features.relationshipStrength).toBe(0.8);
    expect(vpn.explanation.relationship.sourceTitle).toBe("TLS Configuration");
    expect(results.map((r) => r.id)).not.toContain("unrelated");
    expect(results.findIndex((r) => r.id === "vpn")).toBeGreaterThan(0);
  });

  test("omitting the graph does not add related documents", async () => {
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]]}] })],
    });
    await engine.index(docs);
    const titles = engine.search("tls", { limit: 10 }).map((r) => r.title);
    expect(titles).toContain("TLS Configuration");
    expect(titles).not.toContain("VPN Settings");
  });

  test("relationships are not query equivalences", async () => {
    const q = analyzeQuery("tls", {
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]]}] })],
    });
    expect(q.concepts.some((c) => c.forms.includes("vpn"))).toBe(false);
  });
});

describe("general lexical search", () => {
  test("partial configured expansion continuous d maps to cd with provenance", () => {
    const q = analyzeQuery("continuous d", {
      plugins: [
        morphology(),
        compileConfiguredConceptPlugin({ configuredConcepts: [
            { key: "cd", aliases: [["continuous", "deployment"]]},
            { key: "cicd", aliases: [["continuous", "integration", "continuous", "deployment"]]},
          ],
        }),
      ],
    });
    const hit = q.concepts.find((c) => c.id === "cd" || c.id === "cicd");
    expect(hit).toBeTruthy();
    expect(hit.provenance).toBe("partial-form");
  });

  test("prefix of a longer expansion is partial-form not a rewrite", () => {
    const q = analyzeQuery("application programming", {
      plugins: [
        morphology(),
        compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "api", aliases: [["application", "programming", "interface"]]}],
        }),
      ],
    });
    const hit = q.concepts.find((c) => c.id === "api");
    expect(hit).toBeTruthy();
    expect(hit.provenance).toBe("partial-form");
  });

  test("single-letter still does not prefix a configured-concept key", () => {
    const q = analyzeQuery("a", {
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "api", aliases: [["application", "programming", "interface"]]}] })],
    });
    expect(q.concepts.some((c) => c.kind === "configured-concept")).toBe(false);
  });

  test("configured-key query prefers a title that states the expansion", async () => {
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "oop", aliases: [["object", "oriented", "programming"]]}] })],
    });
    await engine.index([
      { id: "/oop-vs/", title: "OOP vs Functional", body: "Comparing OOP and functional programming." },
      {
        id: "/what-oop/",
        title: "What is OOP (Object-Oriented Programming)?",
        body: "Object-oriented programming tutorial.",
      },
    ]);
    const results = engine.search("oop", { limit: 5, explain: true });
    expect(results[0].title).toBe("What is OOP (Object-Oriented Programming)?");
    expect(results[0].features.configuredConceptMatch).toBe("key-in-title");
    expect(results[0].features.configuredFormEvidence).toBeGreaterThan(
      results.find((r) => r.id === "/oop-vs/").features.configuredFormEvidence
    );
  });

  test("equivalent relationshipMap recall participates in query interpretation only", () => {
    const q = analyzeQuery("auth", {
      plugins: [
        morphology(),
        ...compileAuthoredRelevance({
          relationshipMap: {
            auth: [{ to: { form: "authentication" }, kind: "equivalent" }],
            authentication: [{ to: { form: "auth" }, kind: "equivalent" }],
          },
        }).plugins,
      ],
    });
    const term = q.concepts.find((c) => c.forms.includes("auth") || c.id === "auth");
    expect(term.forms).toContain("authentication");
    expect(term.provenance).toBe("synonym");
  });
});
