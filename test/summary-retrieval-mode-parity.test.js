/**
 * Optional summary must have the same phrase field identity and public
 * ordering across full-scan, indexed, and adaptive. Indexed artifacts do
 * not store summary postings; positional execution uses hydrated documents.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import { buildQueryPlan } from "../dist/query/queryPlan.js";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

const docs = [
  {
    id: "summary-only",
    title: "CloudFront Signed Cookies",
    summary: "Use two-layer authorization at the edge.",
    body: "CDN cookies and cache behavior.",
  },
  {
    id: "title-only",
    title: "gRPC vs REST",
    summary: "An RPC framework.",
    body: "Uses HTTP/2 streams.",
  },
  {
    id: "body-only",
    title: "Build Time",
    summary: "Compile notes.",
    body: "A remote procedure call happens during compile. Also in many programming languages.",
  },
  {
    id: "omitted-summary",
    title: "Authorization Middleware",
    body: "Checks a bearer token.",
  },
  {
    id: "programming-title",
    title: "Which Programming Language to Start?",
    summary: "Pick a first language.",
    body: "Curriculum notes.",
  },
  {
    id: "version-title",
    title: "TLS 1.2 Vulnerability",
    summary: "Transport security.",
    body: "Cipher details.",
  },
];

const QUERIES = {
  summaryOnly: "two-layer authorization",
  titleOnly: "grpc vs rest",
  bodyOnly: "in many programming languages",
  omitted: "authorization middleware",
  structuredVsBody: "remote procedure call",
  version: "tls 1.2",
};

function snapshot(engine, queryText) {
  const query = engine._prepareQuery(queryText);
  const plan = buildQueryPlan(query, engine._index);
  return {
    exactIds: plan.exactHits.map((h) => h.document.id).sort(),
    prefixIds: plan.prefixHits.map((h) => h.document.id).sort(),
    occupancy: plan.structuredKey,
    version: plan.versionIntent,
    titles: engine.search(queryText, { limit: docs.length }).map((hit) => hit.title),
  };
}

async function createMode(mode) {
  const compiled = compileAuthoredRelevance({
    configuredConcepts: [
      { key: "rpc", aliases: [["remote", "procedure", "call"]] },
      { key: "tls", aliases: [["transport", "layer", "security"]] },
    ],
    relationshipMap: {
      rpc: [{ kind: "equivalent", to: { form: "grpc" } }],
    },
  });
  const plugins = [morphology(), ...compiled.plugins];
  const options = {
    schema,
    plugins,
    relationshipStrategy: "hybrid",
  };
  if (mode === "full-scan") {
    return SearchEngine.create({ ...options, retriever: "full-scan" });
  }
  if (mode === "indexed") {
    return SearchEngine.create({ ...options, retriever: "indexed" });
  }
  if (mode === "indexed-artifact") {
    const artifact = compileLexicalIndex(docs, { schema, plugins });
    return SearchEngine.create({
      ...options,
      retriever: "indexed",
      lexicalIndex: artifact,
    });
  }
  if (mode === "adaptive-indexed") {
    return SearchEngine.create({
      ...options,
      retriever: "adaptive",
      adaptive: { documentThreshold: 1 },
    });
  }
  return SearchEngine.create({ ...options, retriever: "adaptive" });
}

const MODES = ["full-scan", "indexed", "indexed-artifact", "adaptive-indexed", "adaptive"];

describe("summary retrieval-mode parity", () => {
  const engines = {};

  beforeAll(async () => {
    for (const mode of MODES) {
      engines[mode] = await createMode(mode);
      await engines[mode].index(docs);
    }
  });

  test("indexed artifact has no summary postings; every mode hydrates summary", () => {
    const artifactEngine = engines["indexed-artifact"];
    const artifact = compileLexicalIndex(docs, {
      schema,
      plugins: artifactEngine.plugins,
    });
    expect(artifact.data.documents.every((row) => row.length === 7)).toBe(true);
    expect(JSON.stringify(artifact.data.documents)).not.toMatch(/two-layer authorization/i);
    expect(artifact.data.terms.every((row) => row.length === 4)).toBe(true);
    for (const mode of MODES) {
      const byId = Object.fromEntries(engines[mode]._index.documents.map((doc) => [doc.id, doc]));
      expect(engines[mode]._index.schema.summaryField).toBe("summary");
      expect(byId["summary-only"].summary).toContain("two-layer authorization");
      expect(byId["summary-only"].title).not.toContain("two-layer");
      expect(byId["summary-only"].body).not.toContain("two-layer");
      expect(byId["title-only"].title).toBe("gRPC vs REST");
      expect(byId["body-only"].bodyTokens.join(" ")).toContain("remote procedure call");
      expect(byId["omitted-summary"].summary).toBe("");
    }
  });

  test.each(Object.entries(QUERIES))("%s is identical across retrieval modes", (_name, queryText) => {
    const baseline = snapshot(engines["full-scan"], queryText);
    for (const mode of MODES.slice(1)) {
      expect({ mode, ...snapshot(engines[mode], queryText) }).toEqual({ mode, ...baseline });
    }
  });

  test("pinned phrase cases keep field identity across modes", () => {
    const full = engines["full-scan"];
    const summary = snapshot(full, QUERIES.summaryOnly);
    expect(summary.exactIds).toEqual(["summary-only"]);
    expect(summary.titles[0]).toBe("CloudFront Signed Cookies");

    const title = snapshot(full, QUERIES.titleOnly);
    expect(title.exactIds).toContain("title-only");

    const body = snapshot(full, QUERIES.bodyOnly);
    expect(body.exactIds).toEqual(["body-only"]);
    expect(body.titles).toContain("Build Time");
    expect(body.titles).toContain("Which Programming Language to Start?");

    const omitted = snapshot(full, QUERIES.omitted);
    expect(omitted.exactIds).toEqual(["omitted-summary"]);

    const structured = snapshot(full, QUERIES.structuredVsBody);
    expect(structured.occupancy).toBe("rpc");
    expect(structured.exactIds).toContain("body-only");
    expect(structured.titles).toContain("gRPC vs REST");
    expect(structured.titles).toContain("Build Time");

    const version = snapshot(full, QUERIES.version);
    expect(version.version).toBe(true);
    expect(version.titles[0]).toBe("TLS 1.2 Vulnerability");
  });
});
