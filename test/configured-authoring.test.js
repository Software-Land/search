/**
 * 0.5.0 authored configuration contracts.
 * Compiles onto existing expansion / synonym / standalone / topical / editorial machinery.
 */
import {
  SearchEngine,
  morphology,
  migrateConfiguredEntry,
  compileRelationshipMap,
  compileAuthoredRelevance,
  InvalidConfigurationError,
  parseEquivalences,
} from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { synonyms as synonymsPrimitive } from "../dist/synonyms.js";
import { pluginByName } from "./helpers/authored.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

describe("canonical alias compiler", () => {
  test("A. aliases[0] compiles internally as expansion", () => {
    const plugin = dictionary({
      entries: [
        {
          key: "paas",
          aliases: [
            ["platform", "service"],
            ["platform", "as", "a", "service"],
          ],
        },
      ],
    });
    const entry = plugin.byKey.get("paas");
    expect(entry.expansion).toEqual(["platform", "service"]);
    expect(entry.aliases).toEqual([["platform", "as", "a", "service"]]);
    const kinds = plugin.sequences.filter((s) => s.entry.key === "paas").map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(["key", "expansion", "alias"]));
    expect(plugin.sequences.find((s) => s.kind === "expansion" && s.entry.key === "paas").tokens).toEqual([
      "platform",
      "service",
    ]);
  });

  test("B. aliases[1...] identify the same configured concept", () => {
    const plugin = dictionary({
      entries: [
        {
          key: "paas",
          aliases: [
            ["platform", "service"],
            ["platform", "as", "a", "service"],
          ],
        },
      ],
    });
    const alias = plugin.sequences.find((s) => s.kind === "alias" && s.entry.key === "paas");
    expect(alias.tokens).toEqual(["platform", "as", "a", "service"]);
    expect(alias.entry.key).toBe("paas");
  });

  test("O. primary is absent from the new schema", () => {
    expect(() =>
      dictionary({ entries: [{ key: "api", aliases: [["application", "programming", "interface"]], primary: "interface" }] })
    ).toThrow(InvalidConfigurationError);
    const migrated = migrateConfiguredEntry({
      key: "api",
      exp: ["application", "programming", "interface"],
      aliases: [["app", "programming", "interface"]],
      primary: "interface",
    });
    expect(migrated.discardedPrimary).toBe("interface");
    expect(migrated.entry).toEqual({
      key: "api",
      aliases: [
        ["application", "programming", "interface"],
        ["app", "programming", "interface"],
      ],
    });
    expect(migrated.entry).not.toHaveProperty("primary");
  });

  test("P. old recall fields are absent from the new schema", () => {
    expect(() =>
      dictionary({
        entries: [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]], standaloneRecall: ["hypertext"] }],
      })
    ).toThrow(/standaloneRecall/);
    expect(() =>
      dictionary({
        entries: [{ key: "appsec", aliases: [["application", "security"]], topicalRecall: [["authentication"]] }],
      })
    ).toThrow(/topicalRecall/);
    expect(() =>
      dictionary({ entries: [{ key: "http", expansion: ["hypertext", "transfer", "protocol"] }] })
    ).toThrow(/expansion/);
  });

  test("migrateConfiguredEntry inserts exp once as aliases[0] and preserves alias order", () => {
    const migrated = migrateConfiguredEntry({
      key: "iot",
      exp: ["internet", "things"],
      aliases: [["internet", "of", "things"], ["internet", "things"]],
    });
    expect(migrated.entry.aliases).toEqual([
      ["internet", "things"],
      ["internet", "of", "things"],
    ]);
  });
});

describe("relationshipMap compile", () => {
  test("G. equivalent compiles to existing synonym behavior", () => {
    const compiled = compileAuthoredRelevance({ configuredConcepts: [{ key: "qa", aliases: [["quality", "assurance"]] }],
      relationshipMap: { qa: [{ to: { form: "testing" }, kind: "equivalent" }] },
    });
    expect(compileRelationshipMap({ qa: [{ to: { form: "testing" }, kind: "equivalent" }] }).synonymMap).toEqual({
      qa: ["testing"],
    });
    expect(pluginByName(compiled, "synonyms").expand("qa").map((row) => row.form)).toEqual(["testing"]);
  });

  test("equivalent relationshipMap matches internal synonym primitive one-hop", async () => {
    const docs = [
      { id: "qa-guide", title: "Quality Assurance Guide", body: "process quality assurance handbook" },
      { id: "load", title: "Load Testing", body: "performance load testing notes" },
      { id: "unrelated", title: "Gardening Tips", body: "tomatoes and soil" },
    ];
    const entries = [{ key: "qa", aliases: [["quality", "assurance"]] }];
    const authored = compileAuthoredRelevance({ configuredConcepts: entries,
      relationshipMap: { qa: [{ to: { form: "testing" }, kind: "equivalent" }] },
    });
    const viaAuthored = SearchEngine.create({
      schema,
      plugins: [morphology(), ...authored.plugins],
      retriever: "full-scan",
      relationshipStrategy: "none",
    });
    const viaPrimitive = SearchEngine.create({
      schema,
      plugins: [morphology(), dictionary({ entries }), synonymsPrimitive({ qa: ["testing"] })],
      retriever: "full-scan",
      relationshipStrategy: "none",
    });
    await viaAuthored.index(docs);
    await viaPrimitive.index(docs);
    const authoredHits = viaAuthored.search("qa", { limit: 10 }).map((hit) => ({
      id: hit.id,
      score: hit.score,
      relevanceKind: hit.relevanceKind,
      directClass: hit.directClass,
    }));
    const primitiveHits = viaPrimitive.search("qa", { limit: 10 }).map((hit) => ({
      id: hit.id,
      score: hit.score,
      relevanceKind: hit.relevanceKind,
      directClass: hit.directClass,
    }));
    expect(authoredHits).toEqual(primitiveHits);
    expect(pluginByName(authored, "synonyms").expand("qa")).toEqual(synonymsPrimitive({ qa: ["testing"] }).expand("qa"));
  });

  test("H. related token -> concept compiles to existing standalone behavior", () => {
    const compiled = compileAuthoredRelevance({ configuredConcepts: [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]] }],
      relationshipMap: { hypertext: [{ to: { concept: "http" }, kind: "related" }] },
    });
    const plugin = pluginByName(compiled, "dictionary");
    expect(plugin.standaloneRecallByToken.get("hypertext")).toBe("http");
    expect(plugin.byKey.get("http").standaloneRecall).toEqual(["hypertext"]);
  });

  test("I. related concept -> form compiles to existing topical behavior", () => {
    const compiled = compileAuthoredRelevance({ configuredConcepts: [{ key: "appsec", aliases: [["application", "security"]] }],
      relationshipMap: {
        appsec: [
          { to: { form: "authentication" }, kind: "related" },
          { to: { form: ["bearer", "token"] }, kind: "related" },
        ],
      },
    });
    const plugin = pluginByName(compiled, "dictionary");
    expect(plugin.topicalRecallByKey.get("appsec")).toEqual([["authentication"], ["bearer", "token"]]);
  });

  test("J. related document -> document compiles to editorial relationship behavior", () => {
    const compiled = compileRelationshipMap(
      { tls: [{ to: { document: "vpn" }, kind: "related" }] },
      { documents: [{ id: "tls", title: "TLS 1.2 Vulnerability" }, { id: "vpn", title: "What is VPN?" }] }
    );
    expect(compiled.editorialRelationships).toEqual({
      tls: [{ target: "vpn", type: "editorial", strength: 1, provenance: "manual" }],
    });
    expect(compiled.editorialRelationships.vpn).toBeUndefined();
    const authored = compileAuthoredRelevance({ configuredConcepts: [],
      relationshipMap: { tls: [{ to: { document: "vpn" }, kind: "related" }] },
      documents: [{ id: "tls", title: "TLS 1.2 Vulnerability" }, { id: "vpn", title: "What is VPN?" }],
    });
    expect(authored.documentRelationships.relationships.tls).toEqual([
      { target: "vpn", type: "editorial", strength: 1, provenance: "manual" },
    ]);
  });

  test("K. relationships remain directional unless reverse authored", () => {
    const compiled = compileRelationshipMap({
      qa: [{ to: { form: "testing" }, kind: "equivalent" }],
    });
    expect(compiled.synonymMap.qa).toEqual(["testing"]);
    expect(compiled.synonymMap.testing).toBeUndefined();
  });

  test("L. no numeric authored relationship weight", () => {
    expect(() =>
      compileRelationshipMap({ qa: [{ to: { form: "testing" }, kind: "equivalent", strength: 0.9 }] })
    ).toThrow(/weight/);
  });

  test("M. invalid typed endpoints fail clearly", () => {
    expect(() =>
      compileRelationshipMap(
        { hypertext: [{ to: { concept: "missing" }, kind: "related" }] },
        { concepts: [{ key: "http" }] }
      )
    ).toThrow(/unknown concept/);
    expect(() =>
      compileRelationshipMap(
        { appsec: [{ to: { form: ["bearer token"] }, kind: "related" }] },
        { concepts: [{ key: "appsec" }] }
      )
    ).toThrow(/malformed form/);
    expect(() =>
      compileRelationshipMap(
        { tls: [{ to: { document: "vpn" }, kind: "related" }] },
        { documents: [{ id: "tls" }] }
      )
    ).toThrow(/unknown document/);
    expect(() =>
      compileRelationshipMap(
        { a: [{ to: { document: "The Cloud" }, kind: "related" }] },
        { documents: [{ id: "a", title: "The Cloud" }, { id: "b", title: "The Cloud" }] }
      )
    ).toThrow(/ambiguous document/);
    expect(() => compileRelationshipMap({ qa: [{ to: { form: "testing" }, kind: "nearby" }] })).toThrow(
      /unsupported relationship kind/
    );
  });
});

describe("authored compile preserves runtime identity", () => {
  test("C-F left-prefix, contextual completion, suffix occupancy, and surface identity still work", async () => {
    const engine = SearchEngine.create({
      schema,
      plugins: [
        morphology(),
        dictionary({
          entries: [
            {
              key: "api",
              aliases: [
                ["application", "programming", "interface"],
                ["app", "programming", "interface"],
              ],
            },
          ],
        }),
      ],
    });
    await engine.index([
      { id: "api", title: "What is an API?", body: "application programming interface" },
      { id: "other", title: "Other", body: "unrelated" },
    ]);
    expect(engine.search("application programming", { limit: 1 })[0].id).toBe("api");
    expect(engine.search("app programming interface", { limit: 1 })[0].id).toBe("api");
    expect(engine.search("api", { limit: 1 })[0].id).toBe("api");
  });

  test("N. generated semantic provenance remains distinct from authored related", async () => {
    const compiled = compileAuthoredRelevance({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]] }],
      relationshipMap: {},
    });
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), ...compiled.plugins],
      documentRelationships: {
        format: "search-v2-relationships",
        version: 1,
        relationships: {
          tls: [{ target: "vpn", type: "semantic", strength: 0.42, provenance: "embedding" }],
        },
      },
      relationshipStrategy: "hybrid",
    });
    await engine.index([
      { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security" },
      { id: "vpn", title: "What is VPN?", body: "virtual private network" },
    ]);
    const related = engine.searchDetailed("tls", { limit: 5, relatedLimit: 5 }).related;
    expect(related[0].relationship.provenance).toBe("embedding");
    expect(related[0].relationship.type).toBe("semantic");
    expect(compiled.documentRelationships).toBeNull();
  });
});

describe("parseEquivalences hard cut", () => {
  test("rejects expansion and primary on the public artifact", () => {
    expect(() =>
      parseEquivalences({
        format: "search-v2-equivalences",
        version: 1,
        entries: [{ key: "wifi", expansion: ["wi", "fi"] }],
      })
    ).toThrow(/expansion/);
  });
});
