/**
 * Software.Land complete-interpretation collector contract.
 * Default Core search is collector-off. This file is product membership,
 * not the frozen ranking oracle.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { COMPLETE_INTERPRETATION_COLLECTOR, collectCompleteInterpretations } from "../dist/execution/completeInterpretationCollector.js";
import { buildQueryPlan } from "../dist/query/queryPlan.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { loadSoftwareLandRelevanceInputs } from "./helpers/software-land-fixture.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SL = process.env.SOFTWARE_LAND_ROOT;
const COLLECTOR = { limit: 10, resultCollector: COMPLETE_INTERPRETATION_COLLECTOR };

const FALLBACK_SUMMARIES = {
  "200FPS: CSS vs Canvas vs WebGL vs WebGPU":
    "A practical guide to building high-frame-rate web experiences—comparing CSS, SVG, Canvas, WebGL and WebGPU while covering React animation patterns, frame budgets, optimization techniques and realistic hardware reach.",
  "Idempotency Keys":
    "A practical guide to idempotency keys—covering safe retries, duplicate request prevention, request fingerprinting, storage design, concurrency handling, TTLs, and real-world API trade-offs.",
  "Rate Limiting":
    "Rate-limiting serves as an important mechanism in more than just distributed computing, but that is the focus of this blog post.",
  "Rate Limiting Algorithms":
    "A practical guide to rate limiting—covering token bucket, leaky bucket, fixed/sliding windows, distributed implementations, and real-world nuances like burst handling, fairness, and clock skew.",
  "CloudFront Signed Cookies":
    "A practical guide to CloudFront Signed Cookies—covering edge gating, two-layer authorization, origin protection, key management, failure modes, and how the product uses them to protect backend routes.",
  "What is OOP (Object-Oriented Programming)?":
    "Also known as Object-Oriented Design, it is a paradigm for writing code where data and behavior are encapsulated by objects that leverage polymorphism.",
  "OOP vs Functional":
    "Object-Oriented Programming and Functional Programming are both foundational paradigms that every developer should know.",
};

function loadDescriptions() {
  const byTitle = new Map(Object.entries(FALLBACK_SUMMARIES));
  const blog = SL ? path.join(SL, "content/blog") : "";
  if (!blog) return byTitle;
  try {
    for (const dir of readdirSync(blog)) {
      let text;
      try {
        text = readFileSync(path.join(blog, dir, "index.md"), "utf8");
      } catch {
        continue;
      }
      const title = text.match(/^title:\s*"([^"]+)"/m)?.[1];
      const description = text.match(/^description:\s*"([^"]+)"/m)?.[1];
      if (title && description) byTitle.set(title, description);
    }
  } catch {
    return byTitle;
  }
  return byTitle;
}

describe("Software.Land complete-interpretation collector", () => {
  let engine;

  beforeAll(async () => {
    const inputs = loadSoftwareLandRelevanceInputs();
    const compiled = compileAuthoredRelevance({
      configuredConcepts: inputs.configuredConcepts,
      relationshipMap: inputs.relationshipMap,
    });
    const descriptions = loadDescriptions();
    const docs = attachLexicalFrequency(
      inputs.documents.map((doc) => ({ ...doc, summary: descriptions.get(doc.title) || doc.summary || "" })),
      inputs.lexicalFrequency
    );
    engine = SearchEngine.create({
      schema: {
        title: { type: "text", role: "title" },
        summary: { type: "text", role: "summary" },
        body: { type: "text", role: "body" },
      },
      plugins: [morphology({ lemmas: inputs.lemmas }), ...compiled.plugins],
      documentRelationships: inputs.relationships,
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    });
    await engine.index(docs);
  });

  test("default search does not collapse rate limit", () => {
    const off = engine.search("rate limit", { limit: 10 }).map((h) => h.title);
    expect(off.length).toBeGreaterThan(2);
    expect(off).toContain("Hot Shards");
  });

  test("collector keeps authored rate-limit titles and drops Hot Shards", () => {
    expect(engine.search("rate limit", COLLECTOR).map((h) => h.title)).toEqual([
      "Rate Limiting",
      "Rate Limiting Algorithms",
    ]);
  });

  test("dfs backtracking exact and incomplete prefix share the contiguous phrase cohort", () => {
    const expected = ["DFS Backtracking", "A-Star Pathfinding", "What is Recursion?"];
    expect(engine.search("dfs backtracking", COLLECTOR).map((h) => h.title)).toEqual(expected);
    expect(engine.search("dfs backtrackin", COLLECTOR).map((h) => h.title)).toEqual(expected);
  });

  test("HFR exact and 1-char prefix collapse to 200FPS", () => {
    for (const q of [
      "a practical guide to building high-frame-rate",
      "a practical guide to building high-frame-ra",
      "a practical guide to building high-frame-r",
    ]) {
      expect(engine.search(q, COLLECTOR).map((h) => h.title)).toEqual([
        "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
      ]);
    }
  });

  test("Idempotency long phrases collapse to Idempotency Keys", () => {
    for (const q of [
      "duplicate request prevention request fingerprinting storage",
      "duplicate request prevention request fingerprinting storag",
      "covering safe retries, duplicate request prevention request fingerprinting",
      "covering safe retries, duplicate request prevention request finger",
    ]) {
      expect(engine.search(q, COLLECTOR).map((h) => h.title)).toEqual(["Idempotency Keys"]);
    }
  });

  test("configured-expanded OOP phrase is a complete union", () => {
    expect(engine.search("object oriented programming vs functional", COLLECTOR).map((h) => h.title)).toEqual([
      "What is OOP (Object-Oriented Programming)?",
      "OOP vs Functional",
    ]);
  });

  test("two-layer authorization is CloudFront only", () => {
    expect(engine.search("two-layer authorization", COLLECTOR).map((h) => h.title)).toEqual([
      "CloudFront Signed Cookies",
    ]);
  });

  test("occupancy and version decline the collector", () => {
    for (const q of [
      "remote procedure call",
      "cross site scripting",
      "simple queue service",
      "command line interface",
      "application programming interface",
      "tls 1.2",
    ]) {
      const off = engine.search(q, { limit: 10 }).map((h) => h.id);
      const on = engine.search(q, COLLECTOR).map((h) => h.id);
      expect(on).toEqual(off);
      expect(on.length).toBeGreaterThan(1);
    }
  });

  test("configured-content identity declines the collector for wrapper-complete keys", () => {
    for (const q of ["what is an api", "what is rpc", "what is tls", "what is oauth", "an api", "the api", "what is appsec"]) {
      const off = engine.search(q, { limit: 10 }).map((h) => h.id);
      const on = engine.search(q, COLLECTOR).map((h) => h.id);
      expect(on).toEqual(off);
      expect(on.length).toBeGreaterThan(1);
    }
  });

  test("direct collectCompleteInterpretations must pass configuredContentIdentity", () => {
    const q = "what is appsec";
    const analyzed = engine._prepareQuery(q);
    const plan = buildQueryPlan(analyzed, engine._index);
    expect(plan.configuredContentIdentity).toBe("appsec");
    expect(plan.structuredKey).toBeFalsy();
    const omitted = collectCompleteInterpretations({
      occupancy: Boolean(plan.structuredKey),
      version: plan.versionIntent,
      exactHits: plan.exactHits,
      prefixHits: plan.prefixHits,
    });
    const faithful = collectCompleteInterpretations({
      occupancy: Boolean(plan.structuredKey),
      version: plan.versionIntent,
      exactHits: plan.exactHits,
      prefixHits: plan.prefixHits,
      configuredContentIdentity: Boolean(plan.configuredContentIdentity),
    });
    expect(omitted.reason).not.toBe("configured-content-identity");
    expect(faithful.apply).toBe(false);
    expect(faithful.reason).toBe("configured-content-identity");
    expect(engine.search(q, COLLECTOR).map((h) => h.id)).toEqual(engine.search(q, { limit: 10 }).map((h) => h.id));
  });
});
