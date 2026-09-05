/**
 * 0.5.0 authored configuration contracts.
 * Compiles onto existing expansion / synonym / standalone / topical / editorial machinery.
 */
import {
  SearchEngine,
  morphology,
  migrateConfiguredEntry,
  compileAuthoredRelevance,
  InvalidConfigurationError,
} from "../dist/index.js";
import { compileRelationshipMap } from "../dist/relationshipMap.js";
import { parseConfiguredConcepts } from "../tools/search-corpus/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { synonyms as synonymsPrimitive } from "../dist/query/synonyms.js";
import { pluginByName } from "./helpers/authored.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

describe("peer-alias compiler", () => {
  test("A. every alias compiles as an equal form sequence", () => {
    const plugin = compileConfiguredConceptPlugin({ configuredConcepts: [
        {
          key: "paas",
          aliases: [
            ["platform", "service"],
            ["platform", "as", "a", "service"],
          ],
        },
      ],
    });
    const concept = plugin.byKey.get("paas");
    expect(concept.aliases).toEqual([
      ["platform", "service"],
      ["platform", "as", "a", "service"],
    ]);
    expect(concept).not.toHaveProperty("expansion");
    expect(concept).not.toHaveProperty("standaloneRecall");
    expect(concept).not.toHaveProperty("topicalRecall");
    const kinds = plugin.sequences.filter((s) => s.concept.key === "paas").map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(["key", "form"]));
    expect(kinds.filter((k) => k === "form")).toHaveLength(2);
    expect(plugin.sequences.find((s) => s.kind === "form" && s.concept.key === "paas" && s.tokens[1] === "service").tokens).toEqual([
      "platform",
      "service",
    ]);
    expect(plugin.sequences.find((s) => s.kind === "form" && s.concept.key === "paas").concept).toBe(concept);
  });

  test("B. later aliases identify the same configured concept", () => {
    const plugin = compileConfiguredConceptPlugin({ configuredConcepts: [
        {
          key: "paas",
          aliases: [
            ["platform", "service"],
            ["platform", "as", "a", "service"],
          ],
        },
      ],
    });
    const alias = plugin.sequences.find((s) => s.kind === "form" && s.concept.key === "paas" && s.tokens.includes("as"));
    expect(alias.tokens).toEqual(["platform", "as", "a", "service"]);
    expect(alias.concept.key).toBe("paas");
    expect(alias.concept).toBe(plugin.byKey.get("paas"));
  });

  test("O. primary is absent from the new schema", () => {
    expect(() =>
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "api", aliases: [["application", "programming", "interface"]], primary: "interface" }] })
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
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]], standaloneRecall: ["hypertext"] }],
      })
    ).toThrow(/standaloneRecall/);
    expect(() =>
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "appsec", aliases: [["application", "security"]], topicalRecall: [["authentication"]] }],
      })
    ).toThrow(/topicalRecall/);
    expect(() =>
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "http", expansion: ["hypertext", "transfer", "protocol"] }] })
    ).toThrow(/expansion/);
  });

  test("migrateConfiguredEntry inserts exp as one peer alias and preserves remaining alias order", () => {
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

  test("migrateConfiguredEntry preserves type, provenance, and confidence", () => {
    const migrated = migrateConfiguredEntry({
      key: "api",
      expansion: ["application", "programming", "interface"],
      type: "acronym",
      provenance: "manual",
      confidence: 0.9,
    });
    expect(migrated.entry).toEqual({
      key: "api",
      aliases: [["application", "programming", "interface"]],
      type: "acronym",
      provenance: "manual",
      confidence: 0.9,
    });
    expect(migrated.entry).not.toHaveProperty("primary");
    expect(migrated.entry).not.toHaveProperty("expansion");
    expect(migrated.entry).not.toHaveProperty("standaloneRecall");
    expect(migrated.entry).not.toHaveProperty("topicalRecall");
    expect(migrated.discardedPrimary).toBe(null);
  });

  test("migrateConfiguredEntry preserves explicit null provenance and confidence and omits absent type", () => {
    const migrated = migrateConfiguredEntry({
      key: "http",
      expansion: ["hypertext", "transfer", "protocol"],
      provenance: null,
      confidence: null,
    });
    expect(migrated.entry).toEqual({
      key: "http",
      aliases: [["hypertext", "transfer", "protocol"]],
      provenance: null,
      confidence: null,
    });
    expect(migrated.entry).not.toHaveProperty("type");
  });

  test("migrateConfiguredEntry leaves omitted identity metadata omitted", () => {
    const migrated = migrateConfiguredEntry({
      key: "tls",
      aliases: [["transport", "layer", "security"]],
    });
    expect(migrated.entry).toEqual({
      key: "tls",
      aliases: [["transport", "layer", "security"]],
    });
    expect(migrated.entry).not.toHaveProperty("type");
    expect(migrated.entry).not.toHaveProperty("provenance");
    expect(migrated.entry).not.toHaveProperty("confidence");
  });

  test("migrateConfiguredEntry discards primary and extracts recall into descriptors", () => {
    const migrated = migrateConfiguredEntry({
      key: "http",
      expansion: ["hypertext", "transfer", "protocol"],
      primary: "protocol",
      type: "acronym",
      provenance: "manual",
      confidence: 1,
      standaloneRecall: ["hypertext"],
      topicalRecall: [["authentication"]],
    });
    expect(migrated.entry).toEqual({
      key: "http",
      aliases: [["hypertext", "transfer", "protocol"]],
      type: "acronym",
      provenance: "manual",
      confidence: 1,
    });
    expect(migrated.entry).not.toHaveProperty("primary");
    expect(migrated.entry).not.toHaveProperty("standaloneRecall");
    expect(migrated.entry).not.toHaveProperty("topicalRecall");
    expect(migrated.discardedPrimary).toBe("protocol");
    expect(migrated.standaloneRelationships).toEqual([{ sourceToken: "hypertext", concept: "http" }]);
    expect(migrated.topicalRelationships).toEqual([{ concept: "http", form: ["authentication"] }]);
  });

  test("migrated.entry compiles directly through compileAuthoredRelevance", () => {
    const migrated = migrateConfiguredEntry({
      key: "api",
      expansion: ["application", "programming", "interface"],
      type: "acronym",
      provenance: "manual",
      confidence: 0.9,
    });
    const authored = compileAuthoredRelevance({ configuredConcepts: [migrated.entry] });
    expect(authored.plugins.length).toBeGreaterThan(0);
    const plugin = pluginByName(authored, "configured-concepts");
    const compiled = plugin.byKey.get("api");
    expect(compiled.key).toBe("api");
    expect(compiled.aliases[0]).toEqual(["application", "programming", "interface"]);
    expect(compiled).not.toHaveProperty("expansion");
    expect(compiled.type).toBe("acronym");
    expect(compiled.provenance).toBe("manual");
    expect(compiled.confidence).toBe(0.9);
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
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: entries }), synonymsPrimitive({ qa: ["testing"] })],
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
    const plugin = pluginByName(compiled, "configured-concepts");
    expect(plugin.standaloneRecallByToken.get("hypertext")).toBe("http");
    expect(plugin.byKey.get("http")).not.toHaveProperty("standaloneRecall");
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
    const plugin = pluginByName(compiled, "configured-concepts");
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
        compileConfiguredConceptPlugin({ configuredConcepts: [
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

describe("parseConfiguredConcepts hard cut", () => {
  test("rejects expansion and primary on the configured-concept artifact", () => {
    expect(() =>
      parseConfiguredConcepts({
        format: "search-v2-configured-concepts",
        version: 1,
        entries: [{ key: "wifi", expansion: ["wi", "fi"] }],
      })
    ).toThrow(/expansion/);
  });

  test("parses search-v2-configured-concepts and feeds compileAuthoredRelevance", () => {
    const parsed = parseConfiguredConcepts({
      format: "search-v2-configured-concepts",
      version: 1,
      entries: [{ key: "wifi", aliases: [["wi", "fi"]] }],
    });
    expect(parsed.format).toBe("search-v2-configured-concepts");
    expect(parsed.version).toBe(1);
    expect(parsed.entries[0]).toEqual(
      expect.objectContaining({ key: "wifi", aliases: [["wi", "fi"]] })
    );
    const authored = compileAuthoredRelevance({ configuredConcepts: parsed.entries });
    expect(authored.plugins[0].byKey.get("wifi").key).toBe("wifi");
  });

  test("rejects search-v2-equivalences", () => {
    expect(() =>
      parseConfiguredConcepts({
        format: "search-v2-equivalences",
        version: 1,
        entries: [{ key: "wifi", aliases: [["wi", "fi"]] }],
      })
    ).toThrow(/search-v2-equivalences/);
  });

  test("rejects search-v2-synonyms", () => {
    expect(() =>
      parseConfiguredConcepts({
        format: "search-v2-synonyms",
        version: 1,
        entries: [],
      })
    ).toThrow(/search-v2-configured-concepts/);
  });
});
