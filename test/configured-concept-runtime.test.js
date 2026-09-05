/**
 * Pass 1 one-model invariant: compiler-owned ConfiguredConcept is the only
 * configured-concept representation. Diagnostic-only internal plugin fields.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { compileConfiguredConceptPlugin, compileStandaloneRecallLookup } from "../dist/relationships/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { configuredConceptPluginFromLegacy } from "./helpers/authored.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const httpConcept = {
  key: "http",
  aliases: [
    ["hypertext", "transfer", "protocol"],
    ["http", "protocol"],
  ],
  type: "acronym",
  provenance: "manual",
  confidence: 0.9,
};

describe("canonical ConfiguredConcept runtime", () => {
  test("compiled byKey values are ConfiguredConcept and sequences share them", () => {
    const plugin = compileConfiguredConceptPlugin({ configuredConcepts: [httpConcept] });
    const concept = plugin.byKey.get("http");
    expect(concept).toEqual({
      key: "http",
      aliases: [
        ["hypertext", "transfer", "protocol"],
        ["http", "protocol"],
      ],
      type: "acronym",
      provenance: "manual",
      confidence: 0.9,
    });
    expect(concept).not.toHaveProperty("expansion");
    expect(concept).not.toHaveProperty("standaloneRecall");
    expect(concept).not.toHaveProperty("topicalRecall");
    expect(plugin.entries).toBeUndefined();
    for (const seq of plugin.sequences) {
      expect(seq.concept).toBe(plugin.byKey.get(seq.concept.key));
    }
    expect(plugin.sequences.find((s) => s.kind === "key").tokens).toEqual(["http"]);
    const forms = plugin.sequences.filter((s) => s.kind === "form").map((s) => s.tokens);
    expect(forms).toEqual(
      expect.arrayContaining([
        ["hypertext", "transfer", "protocol"],
        ["http", "protocol"],
      ])
    );
    expect(plugin.sequences.filter((s) => s.kind === "form")).toHaveLength(2);
  });

  test("omitted type is not invented", () => {
    const plugin = compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]] }],
    });
    expect(plugin.byKey.get("http")).not.toHaveProperty("type");
    expect(plugin.byKey.get("http")).not.toHaveProperty("provenance");
    expect(plugin.byKey.get("http")).not.toHaveProperty("confidence");
  });

  test("lexicon is the union of key and every alias token", () => {
    const plugin = compileConfiguredConceptPlugin({ configuredConcepts: [httpConcept] });
    expect([...plugin.lexicon()].sort()).toEqual(["http", "hypertext", "protocol", "transfer"]);
  });

  test("standalone recall lookup omits colliding tokens and does not mutate concepts", () => {
    const authored = compileAuthoredRelevance({
      configuredConcepts: [
        { key: "nist", aliases: [["national", "institute"]] },
        { key: "gatech", aliases: [["georgia", "institute"]] },
        { key: "http", aliases: [["hypertext", "transfer", "protocol"]] },
      ],
      relationshipMap: {
        institute: [
          { to: { concept: "nist" }, kind: "related" },
          { to: { concept: "gatech" }, kind: "related" },
        ],
        hypertext: [{ to: { concept: "http" }, kind: "related" }],
      },
    });
    const plugin = authored.plugins.find((p) => p.name === "configured-concepts");
    expect(plugin.standaloneRecallByToken.get("hypertext")).toBe("http");
    expect(plugin.standaloneRecallByToken.has("institute")).toBe(false);
    expect(plugin.byKey.get("http")).not.toHaveProperty("standaloneRecall");
    expect(compileStandaloneRecallLookup(
      new Map([
        ["nist", ["institute"]],
        ["gatech", ["institute"]],
        ["http", ["hypertext"]],
      ])
    ).has("institute")).toBe(false);
  });

  test("standalone recall query hydration uses all peer aliases without a privileged expansion", () => {
    const plugin = configuredConceptPluginFromLegacy([
      {
        key: "http",
        aliases: [
          ["hypertext", "transfer", "protocol"],
          ["http", "protocol"],
        ],
        standaloneRecall: ["hypertext"],
      },
    ]);
    const q = analyzeQuery("hypertext", { plugins: [plugin] });
    expect(q.standaloneRecall).toMatchObject({
      key: "http",
      sourceToken: "hypertext",
      expansion: [],
      aliases: expect.arrayContaining([
        ["hypertext", "transfer", "protocol"],
        ["http", "protocol"],
      ]),
    });
    expect(q.standaloneRecall.aliases).toHaveLength(2);
    expect(q.standaloneRecall.forms).toEqual(["http", "hypertext", "transfer", "protocol"]);
  });

  test("topical recall lives only on the derived map", () => {
    const authored = compileAuthoredRelevance({
      configuredConcepts: [{ key: "appsec", aliases: [["application", "security"]] }],
      relationshipMap: {
        appsec: [
          { to: { form: "authentication" }, kind: "related" },
          { to: { form: ["bearer", "token"] }, kind: "related" },
        ],
      },
    });
    const plugin = authored.plugins.find((p) => p.name === "configured-concepts");
    expect(plugin.topicalRecallByKey.get("appsec")).toEqual([["authentication"], ["bearer", "token"]]);
    expect(plugin.byKey.get("appsec")).not.toHaveProperty("topicalRecall");
    const identity = compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "appsec", aliases: [["application", "security"]] }],
    });
    expect(identity.topicalRecallByKey.size).toBe(0);
  });
});

describe("canonical ConfiguredConcept query occupancy", () => {
  const entries = [
    {
      key: "http",
      aliases: [
        ["hypertext", "transfer", "protocol"],
        ["http", "protocol"],
      ],
    },
    { key: "appsec", aliases: [["application", "security"]] },
    { key: "tls", aliases: [["transport", "layer", "security"]] },
  ];
  const relationshipMap = {
    hypertext: [{ to: { concept: "http" }, kind: "related" }],
    appsec: [{ to: { form: "authentication" }, kind: "related" }],
    tls: [{ to: { form: "testing" }, kind: "equivalent" }],
  };
  const docs = [
    { id: "http", title: "HTTP", body: "hypertext transfer protocol methods" },
    { id: "appsec", title: "Application Security", body: "authentication overview" },
    { id: "authn", title: "Login Flow", body: "password authentication cookies" },
    { id: "tls", title: "Transport Layer Security", body: "tls handshake" },
    { id: "test", title: "Testing Notes", body: "load testing notes" },
  ];

  test("key, canonical, alias, prefix, recall, and equivalent occupancy stay occupied", async () => {
    const authored = compileAuthoredRelevance({ configuredConcepts: entries, relationshipMap });
    const plugins = [morphology(), ...authored.plugins];
    const engine = SearchEngine.create({
      schema,
      plugins,
      retriever: "full-scan",
      relationshipStrategy: "none",
    });
    await engine.index(docs);
    const cases = [
      ["http", "http"],
      ["hypertext transfer protocol", "http"],
      ["http protocol", "http"],
      ["hypertext transfer proto", "http"],
      ["application security", "appsec"],
      ["hypertext", null],
      ["tls", "tls"],
    ];
    for (const [raw, key] of cases) {
      const q = analyzeQuery(raw, { plugins });
      expect(q.configuredSequenceIntent?.key ?? null).toBe(key);
      if (key === "http" && raw !== "hypertext") {
        const concept = q.concepts.find((c) => c.kind === "configured-concept");
        expect(concept?.aliases).toEqual(
          expect.arrayContaining([
            ["hypertext", "transfer", "protocol"],
            ["http", "protocol"],
          ])
        );
        if (raw === "http") expect(concept?.matchedForm).toEqual([]);
        if (raw === "hypertext transfer protocol") {
          expect(concept?.matchedForm).toEqual(["hypertext", "transfer", "protocol"]);
        }
        if (raw === "http protocol") expect(concept?.matchedForm).toEqual(["http", "protocol"]);
      }
    }
    const standalone = analyzeQuery("hypertext", { plugins });
    expect(standalone.standaloneRecall?.key).toBe("http");
    expect(standalone.standaloneRecall?.expansion).toEqual([]);
    expect(standalone.standaloneRecall?.aliases).toEqual(
      expect.arrayContaining([
        ["hypertext", "transfer", "protocol"],
        ["http", "protocol"],
      ])
    );
    const topical = analyzeQuery("appsec", { plugins });
    expect(topical.topicalRecall).toEqual({ key: "appsec", forms: [["authentication"]] });
    const detailed = engine.searchDetailed("http", { limit: 10, explain: true });
    expect(detailed.results[0].id).toBe("http");
    expect(detailed.results[0].explanation.query.configuredSequenceIntent.matchedForm).toEqual([]);
  });
});