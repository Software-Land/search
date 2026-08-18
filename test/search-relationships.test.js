import fs from "node:fs";
import path from "node:path";
import {
  compileRelationships,
  analyzeRelationships,
  LIFECYCLE,
  relationshipId,
  validateDecisions,
  DecisionError,
  DEFAULT_RUNTIME_TYPES,
} from "../tools/search-relationships/index.js";
import { SearchEngine, english, dictionary } from "../src/index.js";
import { analyzeQuery } from "../src/analyze.js";

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

describe("search-relationships isolation", () => {
  test("compiler does not import V1, Search Core, search-corpus, or search-semantic", () => {
    const root = path.join(__dirname, "../tools/search-relationships/lib");
    for (const file of walkJs(root)) {
      const text = fs.readFileSync(file, "utf8");
      expect(text.includes("src/search/")).toBe(false);
      expect(text.includes("src/search-v2")).toBe(false);
      expect(text.includes("search-corpus")).toBe(false);
      expect(text.includes("search-semantic")).toBe(false);
    }
  });

  test("Search Core does not import search-relationships", () => {
    const root = path.join(__dirname, "../src");
    for (const file of walkJs(root)) {
      const text = fs.readFileSync(file, "utf8").toLowerCase();
      expect(text.includes("search-relationships")).toBe(false);
    }
  });
});

describe("search-relationships compilation", () => {
  test("editorial relation compiles and is not a synonym or equivalence", async () => {
    const compiled = compileRelationships(bluetoothDocs, {
      mine: false,
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
      mine: true,
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
      mine: false,
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

  test("human rejection keeps a generated candidate out of runtime", () => {
    const docs = {
      documents: [
        { id: "a", title: "A", body: "See also [B](/b/)." },
        { id: "b", title: "B", body: "B", metadata: { path: "/b/" } },
      ],
    };
    const analyzed = analyzeRelationships(docs);
    const pending = analyzed.inspection.pending.find((p) => p.source === "a" && p.target === "b");
    expect(pending).toBeTruthy();
    expect(pending.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    const compiled = compileRelationships(docs, {
      decisions: { relationships: [{ source: "a", target: "b", type: "editorial", decision: "reject" }] },
    });
    expect(compiled.runtime.relationships.a || []).toEqual([]);
    expect(compiled.inspection.lifecycle[LIFECYCLE.HUMAN_REJECTED]?.some((r) => r.target === "b")).toBe(true);
  });

  test("missing target is orphaned, not silently retargeted", () => {
    const compiled = compileRelationships(bluetoothDocs, {
      mine: false,
      decisions: {
        relationships: [{ source: "bluetooth", target: "gone-doc", type: "editorial", decision: "accept" }],
      },
    });
    expect(compiled.runtime.relationships.bluetooth || []).toEqual([]);
    expect(compiled.life.orphaned.some((o) => o.lifecycle === LIFECYCLE.ORPHANED_DECISION)).toBe(true);
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
        mine: false,
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

  test("merged artifacts are byte-stable", () => {
    const semantic = {
      format: "search-v2-relationships",
      version: 1,
      relationships: { bluetooth: [{ target: "wifi", type: "semantic", strength: 0.5, provenance: "embedding" }] },
    };
    const decisions = {
      relationships: [{ source: "bluetooth", target: "connected-devices", type: "editorial", decision: "accept" }],
    };
    const a = compileRelationships(bluetoothDocs, { mine: false, semantic, decisions });
    const b = compileRelationships(bluetoothDocs, { mine: false, semantic, decisions });
    expect(JSON.stringify(a.runtime)).toBe(JSON.stringify(b.runtime));
    expect(a.manifest.artifactHash).toBe(b.manifest.artifactHash);
    expect(relationshipId("editorial", "bluetooth", "connected-devices")).toBe(
      relationshipId("editorial", "connected-devices", "bluetooth")
    );
  });

  test("content-link candidates stay review-pending until accepted", () => {
    const docs = {
      documents: [
        { id: "tls", title: "TLS", body: "See [VPN](/vpn/).", metadata: { path: "/tls/" } },
        { id: "vpn", title: "VPN", body: "tunnels", metadata: { path: "/vpn/" } },
      ],
    };
    const auto = compileRelationships(docs);
    expect(auto.runtime.relationships.tls || []).toEqual([]);
    expect(auto.inspection.pending.some((p) => p.target === "vpn" && p.reviewBand === "HIGH")).toBe(true);
    const accepted = compileRelationships(docs, {
      decisions: { relationships: [{ source: "tls", target: "vpn", type: "editorial", decision: "accept" }] },
    });
    expect(accepted.runtime.relationships.tls.some((e) => e.target === "vpn")).toBe(true);
    expect(accepted.life.candidates.find((c) => c.resolvedTarget === "vpn").lifecycle).toBe(LIFECYCLE.HUMAN_ACCEPTED);
  });
});
