import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSemantic, semanticBuilderPath, semanticRoot } from "../tools/search-semantic/index.js";

import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const DOCS = [
  { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security certificates https encryption" },
  { id: "vpn", title: "What is VPN?", body: "virtual private network tunnels encrypted traffic tls" },
  { id: "noise", title: "About this Blog", body: "welcome to the site navigation footer" },
];

describe("search-semantic package boundary", () => {
  test("npm files and semantic export ship the Python builder", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
    expect(pkg.files).toContain("tools/search-semantic");
    expect(pkg.exports["./semantic"].import).toBe("./tools/search-semantic/index.js");
    expect(fs.existsSync(semanticBuilderPath())).toBe(true);
    expect(semanticRoot()).toContain("search-semantic");
    expect(fs.existsSync(path.join(semanticRoot(), "lib", "embedding.py"))).toBe(true);
  });

  test("runtime and browser do not import the semantic launcher", () => {
    for (const dir of ["src", "src/browser"]) {
      const root = path.join(__dirname, "..", dir);
      if (!fs.existsSync(root)) continue;
      for (const file of walkJs(root)) {
        const text = fs.readFileSync(file, "utf8");
        expect(text.includes("search-semantic")).toBe(false);
        expect(text.includes("@software-land/search/semantic")).toBe(false);
        expect(text.includes("compileSemantic")).toBe(false);
      }
    }
  });

  test("semantic launcher does not import Search Core", () => {
    const text = fs.readFileSync(path.join(__dirname, "../tools/search-semantic/index.js"), "utf8");
    expect(text.includes("../src/")).toBe(false);
    expect(text.includes("@software-land/search/src")).toBe(false);
  });

  test("lexical compile emits search-v2-relationships without vectors", async () => {
    const outputPath = path.join(os.tmpdir(), `search-semantic-lex-${process.pid}.json`);
    const { artifact, report } = await compileSemantic(DOCS, {
      method: "lexical",
      representation: "title_lead",
      topK: 2,
      minScore: 0.05,
      outputPath,
    });
    expect(artifact.format).toBe("search-v2-relationships");
    expect(artifact.version).toBe(1);
    expect(artifact.vectors).toBeUndefined();
    expect(artifact.embeddings).toBeUndefined();
    expect(JSON.stringify(artifact)).not.toContain('"vector"');
    expect(report?.method).toBe("lexical");
    expect(Number(report?.edgeCount || 0)).toBeGreaterThan(0);
    expect(artifact.relationships.tls.some((e) => e.target === "vpn")).toBe(true);
  }, 30000);

  test("lexical compile with precisionGate drops IoT↔IO prefix false-friends", async () => {
    const outputPath = path.join(os.tmpdir(), `search-semantic-gate-${process.pid}.json`);
    const docs = [
      { id: "iot", title: "What is IoT?", body: "internet of things devices sensors" },
      { id: "io", title: "What is IO?", body: "input output streams files" },
      { id: "edge", title: "Edge Computing", body: "internet of things devices sensors near the device" },
    ];
    const gated = await compileSemantic(docs, {
      method: "lexical",
      representation: "title",
      topK: 5,
      minScore: 0.01,
      precisionGate: true,
      mutual: true,
      outputPath,
    });
    const gatedIot = (gated.artifact.relationships.iot || []).map((e) => e.target);
    expect(gated.report?.precisionGate).toBe(true);
    expect(gated.report?.mutual).toBe(true);
    expect(gated.report?.filterOrder).toContain("precision-gate");
    expect(gatedIot).not.toContain("io");
  }, 30000);
});
