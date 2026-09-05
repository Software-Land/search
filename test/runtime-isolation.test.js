import fs from "node:fs";
import path from "node:path";
import { parseRelationships } from "../dist/artifacts.js";
import { morphology, SearchEngine } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";

import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));


const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

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

describe("runtime isolation", () => {
  test("runtime does not import the semantic builder or embedding stacks", () => {
    const root = path.join(__dirname, "../dist");
    const banned = [
      "search-semantic",
      "search-lexical",
      "sentence-transformers",
      "fastembed",
      "huggingface",
      "hnsw",
      "pytorch",
      "onnxruntime",
      "search-enrichment",
      "llama.cpp",
      "gguf",
    ];
    for (const file of walkJs(root)) {
      const text = fs.readFileSync(file, "utf8").toLowerCase();
      for (const token of banned) {
        expect(text.includes(token)).toBe(false);
      }
    }
  });

  test("relationship parser rejects nothing extra and stores no vectors", () => {
    const art = parseRelationships({
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        "/tls/": [{ target: "/vpn/", type: "semantic", strength: 0.77, provenance: "embedding" }],
      },
      vectors: { "/tls/": [0.1, 0.2] },
    });
    expect(art.relationships["/tls/"][0].target).toBe("/vpn/");
    expect(art.relationships["/tls/"][0].provenance).toBe("embedding");
    expect(art.vectors).toBeUndefined();
  });

  test("strong direct title still outranks a compiled semantic neighbor", async () => {
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]]}] })],
      documentRelationships: {
        format: "search-v2-relationships",
        version: 1,
        relationships: {
          "/tls-1.2-vulnerability/": [
            { target: "/what-is-vpn/", type: "semantic", strength: 0.99, provenance: "embedding" },
          ],
        },
      },
    });
    await engine.index([
      { id: "/tls-1.2-vulnerability/", title: "TLS 1.2 Vulnerability", body: "tls" },
      { id: "/what-is-vpn/", title: "What is VPN?", body: "vpn" },
    ]);
    const results = engine.search("tls", { limit: 5, explain: true });
    expect(results[0].title).toBe("TLS 1.2 Vulnerability");
    expect(results[0].relevanceKind).toBe("direct");
    const vpn = results.find((r) => r.title === "What is VPN?");
    expect(vpn.relevanceKind).toBe("related");
    expect(results.findIndex((r) => r.title === "What is VPN?")).toBeGreaterThan(0);
  });

  test("query analysis does not treat relationship targets as synonyms", () => {
    const q = analyzeQuery("tls", {
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]]}] })],
    });
    expect(q.concepts.some((c) => (c.forms || []).includes("vpn"))).toBe(false);
  });
});
