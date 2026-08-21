import fs from "node:fs";
import path from "node:path";
import {
  compileRelationships,
  relationshipId,
  loadDecisions,
  validateDecisions,
  filterRelationships,
  DecisionError,
  DEFAULT_RUNTIME_TYPES,
  COMPILER_VERSION,
} from "../tools/search-relationships/index.js";
import { DecisionError as ImplementationDecisionError } from "../tools/search-relationships/lib/decisions.js";
import { filterRelationships as filterRelationshipsImpl } from "../tools/search-relationships/lib/compile.js";
import { SearchEngine, english, dictionary } from "../dist/index.js";
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

const slEquivalentDecisions = {
  format: "search-relationships-decisions",
  version: 1,
  relationships: [
    {
      source: "/tls-1.2-vulnerability/",
      target: "/what-is-vpn/",
      type: "editorial",
      decision: "accept",
    },
  ],
};

describe("search-relationships isolation", () => {
  test("review-only APIs are not exported", async () => {
    const api = await import("../tools/search-relationships/index.js");
    expect(api.analyzeRelationships).toBeUndefined();
    expect(api.LIFECYCLE).toBeUndefined();
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

describe("search-relationships compilation", () => {
  test("editorial relation compiles and is not a synonym or equivalence", async () => {
    const compiled = compileRelationships(bluetoothDocs, {
      decisions: {
        relationships: [
          { source: "bluetooth", target: "connected-devices", type: "editorial", decision: "accept" },
        ],
      },
    });
    const edges = compiled.runtime.relationships.bluetooth || [];
    expect(edges.some((e) => e.target === "connected-devices" && e.type === "editorial")).toBe(true);
    expect(edges.find((e) => e.target === "connected-devices").strength).toBe(1);
    expect(edges.find((e) => e.target === "connected-devices").provenance).toBe("manual");
    expect(compiled.runtime.relationships["connected-devices"]?.some((e) => e.target === "bluetooth")).toBe(true);
    expect(compiled.manifest.counts.accepted).toBe(1);
    expect(compiled.manifest.counts.domainEdges).toBe(2);

    const engine = SearchEngine.create({
      schema,
      plugins: [english(), dictionary({ entries: [] })],
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
      decisions: {
        relationships: [
          { source: "advanced-tls", target: "tls-basics", type: "prerequisite", decision: "accept", directional: true },
        ],
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
      decisions: {
        relationships: [{ source: "wifi", target: "bluetooth", type: "same-category", decision: "accept" }],
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
      decisions: {
        relationships: [{ source: "bluetooth", target: "wifi", type: "editorial", decision: "accept" }],
      },
    });
    const edges = compiled.runtime.relationships.bluetooth;
    expect(edges.filter((e) => e.target === "wifi").map((e) => e.type).sort()).toEqual(["editorial", "semantic"]);
    const engine = SearchEngine.create({ schema, plugins: [english()], relationships: compiled.runtime });
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

  test("typed reject-wins drops matching semantic edges and leaves other types", () => {
    const docs = {
      documents: [
        { id: "a", title: "A", body: "a" },
        { id: "b", title: "B", body: "b" },
      ],
    };
    const semantic = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        a: [{ target: "b", type: "semantic", strength: 0.7, provenance: "embedding" }],
        b: [{ target: "a", type: "semantic", strength: 0.6, provenance: "embedding" }],
      },
    };
    const rejected = compileRelationships(docs, {
      semantic,
      decisions: { relationships: [{ source: "a", target: "b", type: "semantic", decision: "reject" }] },
    });
    expect(rejected.runtime.relationships.a || []).toEqual([]);
    expect(rejected.runtime.relationships.b).toEqual([
      { target: "a", type: "semantic", strength: 0.6, provenance: "embedding" },
    ]);
    expect(rejected.manifest.counts.rejected).toBe(1);

    const editorialKept = compileRelationships(docs, {
      semantic,
      decisions: { relationships: [{ source: "a", target: "b", type: "editorial", decision: "reject" }] },
    });
    expect(editorialKept.runtime.relationships).toEqual(semantic.relationships);
  });

  test("path-based type:'*' reject-wins against semantic edges uses resolved document ids", () => {
    const docs = {
      documents: [
        { id: "tls", title: "TLS", body: "tls", metadata: { path: "/tls/" } },
        { id: "vpn", title: "VPN", body: "vpn", metadata: { path: "/vpn/" } },
      ],
    };
    const semantic = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        tls: [{ target: "vpn", type: "semantic", strength: 0.88, provenance: "embedding" }],
        vpn: [{ target: "tls", type: "semantic", strength: 0.81, provenance: "embedding" }],
      },
    };
    const compiled = compileRelationships(docs, {
      semantic,
      decisions: {
        relationships: [{ source: "/tls/", target: "/vpn/", type: "*", decision: "reject" }],
      },
    });
    expect(compiled.runtime.relationships.tls || []).toEqual([]);
    expect(compiled.runtime.relationships.vpn || []).toEqual([]);
    expect(compiled.merged.relationships).toEqual({});
    expect(compiled.manifest.counts.rejected).toBe(1);
    expect(compiled.manifest.counts.orphaned).toBe(0);
  });

  test("markdown and metadata links produce no edge without an explicit decision", () => {
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
    expect(compiled.manifest.counts.accepted).toBe(0);
    expect(compiled.manifest.counts.domainEdges).toBe(0);
  });

  test("missing target is orphaned, not silently retargeted", () => {
    const compiled = compileRelationships(bluetoothDocs, {
      decisions: {
        relationships: [{ source: "bluetooth", target: "gone-doc", type: "editorial", decision: "accept" }],
      },
    });
    expect(compiled.runtime.relationships.bluetooth || []).toEqual([]);
    expect(compiled.orphaned.some((o) => o.target === "gone-doc" && o.decision === "accept")).toBe(true);
    expect(compiled.manifest.counts.orphaned).toBe(1);
    expect(compiled.manifest.counts.accepted).toBe(0);
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
        decisions: { relationships: [{ source: "ai", target: "bg", type: "editorial", decision: "accept" }] },
      }
    );
    const engine = SearchEngine.create({
      schema,
      plugins: [english(), dictionary({ entries: [] })],
      relationships: compiled.runtime,
    });
    const tls = analyzeQuery("tls", { plugins: engine.plugins });
    expect(tls.tokens.map((t) => t.normalized)).toEqual(["tls"]);
    expect(tls.concepts.some((c) => (c.forms || []).includes("vpn"))).toBe(false);
    const vpn = analyzeQuery("vpn", { plugins: engine.plugins });
    expect(vpn.concepts.some((c) => (c.forms || []).includes("tls"))).toBe(false);
  });

  test("malformed type and conflicting decisions fail clearly", () => {
    expect(() =>
      validateDecisions({
        relationships: [{ source: "a", target: "b", type: "vibes", decision: "accept" }],
      })
    ).toThrow(DecisionError);
    expect(() =>
      validateDecisions({
        relationships: [
          { source: "a", target: "b", type: "editorial", decision: "accept" },
          { source: "a", target: "b", type: "editorial", decision: "reject" },
        ],
      })
    ).toThrow(/both accept and reject/);
  });

  test("public DecisionError is the class thrown by load and validate", () => {
    expect(DecisionError).toBe(ImplementationDecisionError);

    let loadErr;
    try {
      loadDecisions([]);
    } catch (err) {
      loadErr = err;
    }
    expect(loadErr).toBeInstanceOf(DecisionError);
    expect(loadErr).toBeInstanceOf(Error);
    expect(loadErr.constructor).toBe(DecisionError);
    expect(loadErr.name).toBe("DecisionError");

    let validateErr;
    try {
      validateDecisions({
        relationships: [{ source: "a", target: "b", type: "vibes", decision: "accept" }],
      });
    } catch (err) {
      validateErr = err;
    }
    expect(validateErr).toBeInstanceOf(DecisionError);
    expect(validateErr.constructor).toBe(DecisionError);
    expect(Array.isArray(validateErr.details)).toBe(true);
    expect(validateErr.details.some((d) => /unknown relationship type/.test(d))).toBe(true);

    try {
      compileRelationships(bluetoothDocs, {
        decisions: { relationships: [{ source: "bluetooth", target: "wifi", type: "vibes", decision: "accept" }] },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionError);
      expect(err.constructor).toBe(DecisionError);
      expect(err).toBeInstanceOf(ImplementationDecisionError);
      return;
    }
    throw new Error("compileRelationships should have thrown DecisionError");
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

  test("path-based editorial accept keeps semantic edges and two domain edges", () => {
    const compiled = compileRelationships(slEquivalentDocs, {
      semantic: slEquivalentSemantic,
      decisions: slEquivalentDecisions,
    });

    expect(compiled.manifest.counts.accepted).toBe(1);
    expect(compiled.manifest.counts.rejected).toBe(0);
    expect(compiled.manifest.counts.orphaned).toBe(0);
    expect(compiled.manifest.counts.domainEdges).toBe(2);
    expect(compiled.manifest.counts.semanticEdges).toBe(2);
    expect(compiled.manifest.counts.runtimeEdges).toBe(4);
    expect(compiled.life).toBeUndefined();
    expect(compiled.inspection).toBeUndefined();

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

  test("Software.Land-shaped fixture serializes to the frozen expected runtime artifact", () => {
    const compiled = compileRelationships(slEquivalentDocs, {
      semantic: slEquivalentSemantic,
      decisions: slEquivalentDecisions,
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
    const decisions = {
      relationships: [{ source: "bluetooth", target: "connected-devices", type: "editorial", decision: "accept" }],
    };
    const a = compileRelationships(bluetoothDocs, { semantic, decisions });
    const b = compileRelationships(bluetoothDocs, { semantic, decisions });
    expect(JSON.stringify(a.runtime)).toBe(JSON.stringify(b.runtime));
    expect(a.manifest.artifactHash).toBe(b.manifest.artifactHash);
    expect(relationshipId("editorial", "bluetooth", "connected-devices")).toBe(
      relationshipId("editorial", "connected-devices", "bluetooth")
    );
  });
});
