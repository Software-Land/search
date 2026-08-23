import fs from "node:fs";
import path from "node:path";
import {
  compileRelationships,
  relationshipId,
  filterRelationships,
  RelationshipError,
  DEFAULT_RUNTIME_TYPES,
  COMPILER_VERSION,
} from "../tools/search-relationships/index.js";
import { normalizePath } from "../tools/search-relationships/lib/ids.js";
import { RelationshipError as ImplementationRelationshipError } from "../tools/search-relationships/lib/domain.js";
import { filterRelationships as filterRelationshipsImpl } from "../tools/search-relationships/lib/compile.js";
import { morphology, SearchEngine, dictionary } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";

import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

function walkJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walkJs(p));
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const bluetoothDocs = {
  documents: [
    { id: "bluetooth", title: "Bluetooth", body: "A short-range wireless protocol." },
    { id: "connected-devices", title: "Connected Devices", body: "Gadgets that talk over a network." },
    { id: "wifi", title: "Wi-Fi", body: "Local wireless networking." },
    { id: "tls-basics", title: "TLS Basics", body: "Transport Layer Security introduction." },
    { id: "advanced-tls", title: "Advanced TLS", body: "Hardening TLS after the basics.", metadata: { prerequisite: "tls-basics" } },
  ],
};

const slEquivalentDocs = {
  documents: [
    {
      id: "ai",
      title: "TLS 1.2 Vulnerability",
      body: "See also [VPN](/what-is-vpn/). tls",
      metadata: { path: "/tls-1.2-vulnerability/" },
    },
    { id: "bg", title: "What is VPN?", body: "vpn", metadata: { path: "/what-is-vpn/" } },
    { id: "ch", title: "Working with Llama.cpp", body: "embeddings" },
  ],
};

const slEquivalentSemantic = {
  format: "search-v2-relationships",
  version: 1,
  relationships: {
    ai: [{ target: "ch", type: "semantic", strength: 0.41, provenance: "embedding" }],
    ch: [{ target: "ai", type: "semantic", strength: 0.39, provenance: "embedding" }],
  },
};

const slEquivalentDomain = {
  format: "search-relationships-domain",
  version: 1,
  relationships: [
    {
      source: "/tls-1.2-vulnerability/",
      target: "/what-is-vpn/",
      type: "editorial",
    },
  ],
};

describe("search-relationships isolation", () => {
  test("review and decisions APIs are not exported", async () => {
    const api = await import("../tools/search-relationships/index.js");
    expect(api.analyzeRelationships).toBeUndefined();
    expect(api.LIFECYCLE).toBeUndefined();
    expect(api.loadDecisions).toBeUndefined();
    expect(api.validateDecisions).toBeUndefined();
    expect(api.DecisionError).toBeUndefined();
    expect(api.COMPILER_VERSION).toBe(2);
    expect(COMPILER_VERSION).toBe(2);
  });

  test("compiler does not import Search Core, search-corpus, or search-semantic", () => {
    const root = path.join(__dirname, "../tools/search-relationships/lib");
    for (const file of walkJs(root)) {
      const text = fs.readFileSync(file, "utf8");
      expect(text.includes("src/search/")).toBe(false);
      expect(text.includes("src/search-v2")).toBe(false);
      expect(text.includes("search-corpus")).toBe(false);
      expect(text.includes("search-semantic")).toBe(false);
      expect(text.includes("../index.js")).toBe(false);
    }
  });

  test("Search Core does not import search-relationships", () => {
    const root = path.join(__dirname, "../dist");
    for (const file of walkJs(root)) {
      const text = fs.readFileSync(file, "utf8").toLowerCase();
      expect(text.includes("search-relationships")).toBe(false);
    }
  });
});

describe("normalizePath", () => {
  test("canonicalizes ordinary paths and strips fragments from the first hash", () => {
    expect(normalizePath("/foo")).toBe("/foo/");
    expect(normalizePath("/foo/")).toBe("/foo/");
    expect(normalizePath("/foo#section")).toBe("/foo/");
    expect(normalizePath("/foo#section/subsection")).toBe("/foo/");
    expect(normalizePath("#")).toBe("/");
    expect(normalizePath("/#")).toBe("/");
    expect(normalizePath("/foo###")).toBe("/foo/");
  });

  test("strips from the first hash even when later characters include newlines", () => {
    expect(normalizePath("/foo#section\nstill-here")).toBe("/foo/");
    expect(normalizePath("#\nnot-a-path")).toBe("/");
  });

  test("long hash-only suffixes are stripped with linear string operations", () => {
    const manyHashes = "#".repeat(20_000);
    expect(normalizePath(manyHashes)).toBe("/");
    expect(normalizePath(`/tls-1.2-vulnerability/${manyHashes}`)).toBe("/tls-1.2-vulnerability/");
    expect(normalizePath(`${manyHashes}\ntrailing`)).toBe("/");
  });

  test("domain path refs with URL fragments resolve to the same document", () => {
    const compiled = compileRelationships(slEquivalentDocs, {
      domain: {
        relationships: [
          {
            source: "/tls-1.2-vulnerability/#cipher-suites",
            target: "/what-is-vpn/",
            type: "editorial",
          },
        ],
      },
    });
    expect(compiled.runtime.relationships.ai?.some((e) => e.target === "bg" && e.type === "editorial")).toBe(true);
  });
});

describe("search-relationships compilation", () => {
  test("editorial relation compiles and is not a synonym or equivalence", async () => {
    const compiled = compileRelationships(bluetoothDocs, {
      domain: {
        relationships: [{ source: "bluetooth", target: "connected-devices", type: "editorial" }],
      },
    });
    const edges = compiled.runtime.relationships.bluetooth || [];
    expect(edges.some((e) => e.target === "connected-devices" && e.type === "editorial")).toBe(true);
    expect(edges.find((e) => e.target === "connected-devices").strength).toBe(1);
    expect(edges.find((e) => e.target === "connected-devices").provenance).toBe("manual");
    expect(compiled.runtime.relationships["connected-devices"]?.some((e) => e.target === "bluetooth")).toBe(true);
    expect(compiled.manifest.counts.domainRelationships).toBe(1);
    expect(compiled.manifest.counts.domainEdges).toBe(2);

    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), dictionary({ entries: [] })],
      relationships: compiled.runtime,
    });
    await engine.index(bluetoothDocs.documents);
    const detailed = engine.searchDetailed("bluetooth", { limit: 10, relatedLimit: 5, explain: true });
    const primary = detailed.results.find((r) => r.title === "Bluetooth");
    expect(primary.relevanceKind).toBe("direct");
    const related = [...detailed.results, ...detailed.related].find((r) => r.title === "Connected Devices");
    expect(related).toBeTruthy();
    expect(related.relationship.type).toBe("editorial");
    const q = analyzeQuery("vpn", { plugins: engine.plugins });
    expect(q.concepts.some((c) => (c.forms || []).includes("tls"))).toBe(false);
  });

  test("prerequisite stays directional", () => {
    const compiled = compileRelationships(bluetoothDocs, {
      domain: {
        relationships: [{ source: "advanced-tls", target: "tls-basics", type: "prerequisite", directional: true }],
      },
    });
    expect(compiled.merged.relationships["advanced-tls"]?.some((e) => e.target === "tls-basics" && e.type === "prerequisite")).toBe(
      true
    );
    expect(compiled.merged.relationships["tls-basics"]?.some((e) => e.target === "advanced-tls" && e.type === "prerequisite") || false).toBe(
      false
    );
    expect(compiled.runtime.relationships["advanced-tls"]?.some((e) => e.type === "prerequisite") || false).toBe(false);
  });

  test("same-category is symmetric and structural", () => {
    const docs = {
      documents: [
        { id: "wifi", title: "Wi-Fi", body: "radio", metadata: { category: "wireless" } },
        { id: "bluetooth", title: "Bluetooth", body: "radio", metadata: { category: "wireless" } },
      ],
    };
    const compiled = compileRelationships(docs, {
      domain: {
        relationships: [{ source: "wifi", target: "bluetooth", type: "same-category" }],
      },
    });
    expect(compiled.merged.relationships.wifi.some((e) => e.target === "bluetooth" && e.type === "same-category")).toBe(true);
    expect(compiled.merged.relationships.bluetooth.some((e) => e.target === "wifi" && e.type === "same-category")).toBe(true);
    expect(DEFAULT_RUNTIME_TYPES.includes("same-category")).toBe(false);
    expect(compiled.runtime.relationships.wifi?.some((e) => e.type === "same-category")).toBeFalsy();
  });

  test("semantic and editorial coexist on the same pair without duplicating the result", async () => {
    const semantic = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        bluetooth: [{ target: "wifi", type: "semantic", strength: 0.82, provenance: "embedding" }],
      },
    };
    const compiled = compileRelationships(bluetoothDocs, {
      semantic,
      domain: {
        relationships: [{ source: "bluetooth", target: "wifi", type: "editorial" }],
      },
    });
    const edges = compiled.runtime.relationships.bluetooth;
    expect(edges.filter((e) => e.target === "wifi").map((e) => e.type).sort()).toEqual(["editorial", "semantic"]);
    const engine = SearchEngine.create({ schema, plugins: [morphology()], relationships: compiled.runtime });
    await engine.index(bluetoothDocs.documents);
    const detailed = engine.searchDetailed("bluetooth", { limit: 10, relatedLimit: 8, explain: true });
    const relatedWifi = detailed.related.filter((r) => r.title === "Wi-Fi");
    const resultWifi = detailed.results.filter((r) => r.title === "Wi-Fi");
    expect(relatedWifi.length).toBeLessThanOrEqual(1);
    expect(resultWifi.length).toBeLessThanOrEqual(1);
    const hit = relatedWifi[0] || resultWifi[0];
    expect(hit.relationship.sources.length).toBe(2);
    expect(new Set(hit.relationship.sources.map((s) => s.type))).toEqual(new Set(["semantic", "editorial"]));
  });

  test("markdown and metadata links produce no edge without an explicit domain relationship", () => {
    const docs = {
      documents: [
        {
          id: "tls",
          title: "TLS",
          body: "See [VPN](/vpn/).",
          metadata: {
            path: "/tls/",
            links: [{ target: "/vpn/", type: "editorial" }],
            category: "security",
            prerequisite: "vpn",
          },
        },
        { id: "vpn", title: "VPN", body: "tunnels", metadata: { path: "/vpn/", category: "security" } },
      ],
    };
    const compiled = compileRelationships(docs);
    expect(compiled.runtime.relationships).toEqual({});
    expect(compiled.merged.relationships).toEqual({});
    expect(compiled.domain.relationships).toEqual({});
    expect(compiled.manifest.counts.domainRelationships).toBe(0);
    expect(compiled.manifest.counts.domainEdges).toBe(0);
  });

  test("missing target fails compile instead of silently retargeting", () => {
    expect(() =>
      compileRelationships(bluetoothDocs, {
        domain: {
          relationships: [{ source: "bluetooth", target: "gone-doc", type: "editorial" }],
        },
      })
    ).toThrow(RelationshipError);
    try {
      compileRelationships(bluetoothDocs, {
        domain: {
          relationships: [{ source: "bluetooth", target: "gone-doc", type: "editorial" }],
        },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RelationshipError);
      expect(err.details.some((d) => /unresolved target "gone-doc"/.test(d))).toBe(true);
      return;
    }
    throw new Error("compileRelationships should have thrown RelationshipError");
  });

  test("related editorial does not rewrite the query", () => {
    const compiled = compileRelationships(
      {
        documents: [
          { id: "ai", title: "TLS 1.2 Vulnerability", body: "tls transport layer security" },
          { id: "bg", title: "What is VPN?", body: "virtual private network" },
        ],
      },
      {
        domain: { relationships: [{ source: "ai", target: "bg", type: "editorial" }] },
      }
    );
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), dictionary({ entries: [] })],
      relationships: compiled.runtime,
    });
    const tls = analyzeQuery("tls", { plugins: engine.plugins });
    expect(tls.tokens.map((t) => t.normalized)).toEqual(["tls"]);
    expect(tls.concepts.some((c) => (c.forms || []).includes("vpn"))).toBe(false);
    const vpn = analyzeQuery("vpn", { plugins: engine.plugins });
    expect(vpn.concepts.some((c) => (c.forms || []).includes("tls"))).toBe(false);
  });

  test("missing type fails clearly", () => {
    const missing = [
      { source: "bluetooth", target: "wifi" },
      { source: "bluetooth", target: "wifi", type: "" },
      { source: "bluetooth", target: "wifi", type: "  " },
    ];
    for (const relationship of missing) {
      try {
        compileRelationships(bluetoothDocs, { domain: { relationships: [relationship] } });
      } catch (err) {
        expect(err).toBeInstanceOf(RelationshipError);
        expect(err.details.some((d) => /missing type/.test(d))).toBe(true);
        continue;
      }
      throw new Error("compileRelationships should have thrown RelationshipError");
    }
  });

  test("unknown type fails clearly", () => {
    try {
      compileRelationships(bluetoothDocs, {
        domain: { relationships: [{ source: "bluetooth", target: "wifi", type: "vibes" }] },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RelationshipError);
      expect(err.constructor).toBe(RelationshipError);
      expect(err).toBeInstanceOf(ImplementationRelationshipError);
      expect(Array.isArray(err.details)).toBe(true);
      expect(err.details.some((d) => /unknown relationship type/.test(d))).toBe(true);
      return;
    }
    throw new Error("compileRelationships should have thrown RelationshipError");
  });

  test("public RelationshipError is the class thrown by compile", () => {
    expect(RelationshipError).toBe(ImplementationRelationshipError);

    let err;
    try {
      compileRelationships(bluetoothDocs, { domain: [] });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RelationshipError);
    expect(err).toBeInstanceOf(Error);
    expect(err.constructor).toBe(RelationshipError);
    expect(err.name).toBe("RelationshipError");
  });

  test("filterRelationships honors a caller-provided type array and keeps the default path", () => {
    const artifact = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        bluetooth: [
          { target: "wifi", type: "semantic", strength: 0.5, provenance: "embedding" },
          { target: "connected-devices", type: "editorial", strength: 1, provenance: "manual" },
          { target: "tls-basics", type: "prerequisite", strength: 1, provenance: "manual" },
        ],
      },
    };
    const omitted = filterRelationships(artifact);
    const explicitDefault = filterRelationships(artifact, DEFAULT_RUNTIME_TYPES);
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(explicitDefault));
    expect(omitted.relationships.bluetooth.map((e) => e.type).sort()).toEqual(["editorial", "semantic"]);

    const semanticOnly = filterRelationships(artifact, ["semantic"]);
    expect(semanticOnly.relationships.bluetooth).toEqual([
      { target: "wifi", type: "semantic", strength: 0.5, provenance: "embedding" },
    ]);

    const structuralOnly = filterRelationships(artifact, ["prerequisite"]);
    expect(structuralOnly.relationships.bluetooth).toEqual([
      { target: "tls-basics", type: "prerequisite", strength: 1, provenance: "manual" },
    ]);

    const fromInternalOpts = filterRelationshipsImpl(artifact, { types: ["semantic"] });
    expect(fromInternalOpts).toEqual(semanticOnly);

    expect(() => filterRelationships(artifact, "semantic")).not.toThrow();
    expect(JSON.stringify(filterRelationships(artifact, "semantic"))).toBe(JSON.stringify(omitted));
    expect(JSON.stringify(filterRelationships(artifact, null))).toBe(JSON.stringify(omitted));
  });

  test("path-based editorial relationship keeps semantic edges and two domain edges", () => {
    const compiled = compileRelationships(slEquivalentDocs, {
      semantic: slEquivalentSemantic,
      domain: slEquivalentDomain,
    });

    expect(compiled.manifest.counts.domainRelationships).toBe(1);
    expect(compiled.manifest.counts.domainEdges).toBe(2);
    expect(compiled.manifest.counts.semanticEdges).toBe(2);
    expect(compiled.manifest.counts.runtimeEdges).toBe(4);
    expect(compiled.life).toBeUndefined();
    expect(compiled.inspection).toBeUndefined();
    expect(compiled.orphaned).toBeUndefined();

    const domainAi = compiled.domain.relationships.ai || [];
    const domainBg = compiled.domain.relationships.bg || [];
    expect(domainAi).toEqual([{ target: "bg", type: "editorial", strength: 1, provenance: "manual" }]);
    expect(domainBg).toEqual([{ target: "ai", type: "editorial", strength: 1, provenance: "manual" }]);
    expect(compiled.domain.relationships.ch).toBeUndefined();

    const semanticEdges = (artifact) =>
      Object.fromEntries(
        Object.entries(artifact.relationships || {})
          .map(([source, edges]) => [source, (edges || []).filter((e) => e.type === "semantic")])
          .filter(([, edges]) => edges.length)
      );
    expect(semanticEdges(compiled.merged)).toEqual(slEquivalentSemantic.relationships);
    expect(semanticEdges(compiled.runtime)).toEqual(slEquivalentSemantic.relationships);

    const runtimeAi = compiled.runtime.relationships.ai;
    expect(runtimeAi.filter((e) => e.target === "bg" && e.type === "editorial")).toEqual([
      { target: "bg", type: "editorial", strength: 1, provenance: "manual" },
    ]);
    expect(compiled.runtime.relationships.bg).toEqual([
      { target: "ai", type: "editorial", strength: 1, provenance: "manual" },
    ]);
    expect(JSON.stringify(compiled.runtime)).toBe(JSON.stringify(compiled.merged));
    expect(compiled.runtime.format).toBe("search-v2-relationships");
    expect(compiled.runtime.version).toBe(1);
  });

  test("Software.Land TLS→VPN fixture supplies type editorial and stays byte-identical", () => {
    expect(slEquivalentDomain.relationships[0].type).toBe("editorial");
    const examplePath = path.join(__dirname, "../tools/search-relationships/config/domain.example.json");
    const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
    expect(example.relationships[0].source).toBe("/tls-1.2-vulnerability/");
    expect(example.relationships[0].target).toBe("/what-is-vpn/");
    expect(example.relationships[0].type).toBe("editorial");

    const compiled = compileRelationships(slEquivalentDocs, {
      semantic: slEquivalentSemantic,
      domain: slEquivalentDomain,
    });
    const expected = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        ai: [
          { target: "bg", type: "editorial", strength: 1, provenance: "manual" },
          { target: "ch", type: "semantic", strength: 0.41, provenance: "embedding" },
        ],
        bg: [{ target: "ai", type: "editorial", strength: 1, provenance: "manual" }],
        ch: [{ target: "ai", type: "semantic", strength: 0.39, provenance: "embedding" }],
      },
    };
    expect(JSON.stringify(compiled.runtime)).toBe(JSON.stringify(expected));
  });

  test("merged artifacts are byte-stable", () => {
    const semantic = {
      format: "search-v2-relationships",
      version: 1,
      relationships: { bluetooth: [{ target: "wifi", type: "semantic", strength: 0.5, provenance: "embedding" }] },
    };
    const domain = {
      relationships: [{ source: "bluetooth", target: "connected-devices", type: "editorial" }],
    };
    const a = compileRelationships(bluetoothDocs, { semantic, domain });
    const b = compileRelationships(bluetoothDocs, { semantic, domain });
    expect(JSON.stringify(a.runtime)).toBe(JSON.stringify(b.runtime));
    expect(a.manifest.artifactHash).toBe(b.manifest.artifactHash);
    expect(relationshipId("editorial", "bluetooth", "connected-devices")).toBe(
      relationshipId("editorial", "connected-devices", "bluetooth")
    );
  });
});
