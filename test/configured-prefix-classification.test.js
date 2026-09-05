/**
 * Non-occupied configured prefix attachments must not inflate candidate
 * classification. Query completeness is not candidate evidence.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { isWeakSingleTokenBodyPack } from "../dist/ranking/rankTieBreak.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");
const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

describe("non-occupied prefix classification (synthetic)", () => {
  test("unigram appli body + title-token-prefix does not outrank a related API neighbor", async () => {
    const plug = [
      morphology(),
      compileConfiguredConceptPlugin({
        configuredConcepts: [{ key: "api", aliases: [["application", "programming", "interface"]] }],
      }),
    ];
    const engine = SearchEngine.create({
      schema,
      plugins: plug,
      documentRelationships: {
        format: "search-v2-relationships",
        version: 1,
        relationships: {
          "api-primary": [{ target: "api-neighbor", type: "editorial", strength: 1 }],
        },
      },
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    });
    await engine.index([
      {
        id: "api-primary",
        title: "What is an API?",
        body: "application programming interface notes",
      },
      {
        id: "api-neighbor",
        title: "Neighbor Protocol",
        body: "related interface notes",
      },
      {
        id: "boilerplate",
        title: "What is a Widget?",
        body: "appli appli leftover tokens",
        lexicalFrequency: { appli: 2 },
      },
    ]);

    const analyzed = analyzeQuery("what is an appli", { plugins: plug });
    expect(analyzed.configuredSequenceIntent?.key ?? null).toBeNull();
    expect((analyzed.configuredPrefixSpans || []).find((s) => s.key === "api")).toBeFalsy();
    expect(analyzed.configuredPrefixRecall?.key).toBe("api");

    const detailed = engine.searchDetailed("what is an appli", { limit: 10, relatedLimit: 8, explain: true });
    const boilerplate = detailed.results.find((h) => h.id === "boilerplate");
    expect(boilerplate).toBeTruthy();
    expect(boilerplate.features.configuredFormCoverage).toBe(0);
    expect(boilerplate.features.configuredFormEvidence).toBe(0);
    expect(boilerplate.features.configuredConceptMatch).toBe(false);
    expect(boilerplate.directClass).not.toBe("moderate");
    expect(boilerplate.directClass).not.toBe("strong");
  });

  test("next as a non-occupied nextjs key prefix does not inherit moderate class", async () => {
    const plug = [
      morphology(),
      compileConfiguredConceptPlugin({
        configuredConcepts: [{ key: "nextjs", aliases: [["next", "js"]] }],
      }),
    ];
    const engine = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
    const docs = [
      { id: "a-hit", title: "Alpha Notes", body: "next js next js", lexicalFrequency: { next: 2, "next js": 2 } },
      { id: "b-hit", title: "Beta Notes", body: "next js next js next js next js", lexicalFrequency: { next: 8, "next js": 4 } },
      { id: "c-hit", title: "Gamma Notes", body: "next js next js next js", lexicalFrequency: { next: 3, "next js": 3 } },
    ];
    await engine.index(docs);

    const analyzed = analyzeQuery("next", { plugins: plug });
    expect(analyzed.configuredSequenceIntent?.key ?? null).toBeNull();
    expect(analyzed.concepts.some((c) => c.kind === "configured-concept" && c.id === "nextjs")).toBe(true);

    const detailed = engine.searchDetailed("next", { limit: 10, explain: true });
    expect(detailed.results).toHaveLength(3);
    for (const hit of detailed.results) {
      expect(hit.features.configuredFormCoverage).toBe(0);
      expect(hit.features.configuredFormEvidence).toBe(0);
      expect(hit.features.configuredConceptMatch).toBe(false);
      expect(hit.directClass).toBe("weak");
      expect(hit.features.queryTokenCount).toBe(1);
      expect(isWeakSingleTokenBodyPack(hit.features)).toBe(true);
    }
    const keyQuery = analyzeQuery("nextjs", { plugins: plug });
    expect(keyQuery.configuredSequenceIntent?.key).toBe("nextjs");
    const occupiedHit = engine.searchDetailed("nextjs", { limit: 3, explain: true }).results[0];
    expect(occupiedHit.features.configuredFormCoverage).toBe(1);
  });

  test("occupied 2/3 form prefix still stamps configuredFormCoverage on candidates", async () => {
    const plug = [
      morphology(),
      compileConfiguredConceptPlugin({
        configuredConcepts: [{ key: "xyz", aliases: [["alpha", "beta", "gamma"]] }],
      }),
    ];
    const engine = SearchEngine.create({ schema, plugins: plug, retriever: "full-scan" });
    await engine.index([
      { id: "xyz-key", title: "XYZ", body: "key document" },
      { id: "xyz-body", title: "Unrelated Heading", body: "mentions alpha beta gamma in the body" },
    ]);
    const analyzed = analyzeQuery("alpha beta", { plugins: plug });
    expect(analyzed.configuredSequenceIntent?.key).toBe("xyz");
    expect(analyzed.concepts.find((c) => c.id === "xyz")?.formCoverage).toBe(0.6667);
    const body = engine.searchDetailed("alpha beta", { limit: 10, explain: true }).results.find((h) => h.id === "xyz-body");
    expect(body.features.configuredFormCoverage).toBe(0.6667);
  });
});

describe("Software.Land non-occupied prefix classification", () => {
  let engine;
  let plugins;

  beforeAll(async () => {
    plugins = [
      morphology({ lemmas: loadJson("lemmas.json") }),
      compileConfiguredConceptPlugin({ configuredConcepts: loadJson("configured-concepts.json") }),
    ];
    engine = SearchEngine.create({
      schema,
      plugins,
      documentRelationships: loadJson("relationships.json"),
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    });
    await engine.index(attachLexicalFrequency(loadJson("documents.json"), loadJson("lexical-frequency.json")));
  });

  function analyzed(query) {
    return analyzeQuery(query, { plugins });
  }

  function detailed(query) {
    return engine.searchDetailed(query, { limit: 20, relatedLimit: 8, explain: true });
  }

  test("what is an appli does not occupy a one-token first-form prefix", () => {
    const result = engine.searchDetailed("what is an appli", {
      limit: loadJson("documents.json").length,
      relatedLimit: 8,
      explain: true,
    });
    const q = result.results[0].explanation.query;
    expect(q.configuredSequenceIntent?.key ?? null).toBeNull();
    expect((q.configuredPrefixSpans || []).find((s) => s.key === "api")).toBeFalsy();
    expect(q.configuredPrefixRecall).toBeNull();
    expect(q.concepts.some((c) => c.kind === "configured-concept" && c.id === "api")).toBe(false);
    for (const hit of [...result.results, ...result.related]) {
      expect(hit.features.configuredFormCoverage).toBe(0);
    }

    const container = [...result.results, ...result.related].find((h) => h.title === "What is a Container?");
    expect(container).toBeTruthy();
    expect(container.features.configuredFormEvidence).toBe(0);
    expect(container.directClass).not.toBe("moderate");
    expect(container.directClass).not.toBe("strong");
  });

  test("what is an appli does not promote Container via query formCoverage", () => {
    const q = analyzed("what is an appli");
    expect(q.configuredSequenceIntent?.key ?? null).toBeNull();
    expect((q.configuredPrefixSpans || []).some((s) => s.key === "api")).toBe(false);

    const result = engine.searchDetailed("what is an appli", {
      limit: loadJson("documents.json").length,
      relatedLimit: 8,
      explain: true,
    });
    const container = [...result.results, ...result.related].find((h) => h.title === "What is a Container?");
    expect(container).toBeTruthy();
    expect(container.features.configuredFormCoverage).toBe(0);
    expect(container.features.configuredFormEvidence).toBe(0);
    expect(container.directClass).not.toBe("moderate");
    expect(container.directClass).not.toBe("strong");
  });

  test("next does not occupy nextjs and does not inherit moderate from prefix coverage", () => {
    const q = analyzed("next");
    expect(q.configuredSequenceIntent?.key ?? null).toBeNull();
    const nextjs = q.concepts.find((c) => c.kind === "configured-concept" && c.id === "nextjs");
    expect(nextjs).toBeTruthy();
    expect(nextjs.formCoverage).toBe(0.6667);
    expect(nextjs.provenance).toBe("partial-form");
    const explained = detailed("next");
    const explainConcept = explained.results[0].explanation.query.concepts.find(
      (c) => c.kind === "configured-concept" && c.id === "nextjs"
    );
    expect(explainConcept.formCoverage).toBe(0.6667);
    expect(explained.results[0].explanation.query.configuredSequenceIntent?.key ?? null).toBeNull();
    const result = explained;
    for (const hit of result.results) {
      expect(hit.features.configuredFormCoverage).toBe(0);
      if (!hit.features.configuredConceptMatch && !hit.features.configuredFormEvidence) {
        expect(hit.directClass).not.toBe("moderate");
        expect(hit.directClass).not.toBe("strong");
      }
    }
    const bodyOnly = result.results.filter(
      (h) =>
        h.directClass === "weak" &&
        h.features.bodyLexicalMatch > 0 &&
        !h.features.configuredConceptMatch
    );
    expect(bodyOnly.length).toBeGreaterThan(0);
    expect(bodyOnly.every((h) => isWeakSingleTokenBodyPack(h.features))).toBe(true);
  });

  test.each(["what is an app", "what is an appl", "what is ci", "what are apis", "what is iot"])(
    "%s does not inflate zero-form-evidence hits to moderate via prefix coverage",
    (query) => {
      const q = analyzed(query);
      expect(q.configuredSequenceIntent?.key ?? null).toBeNull();
      const result = detailed(query);
      for (const hit of result.results) {
        expect(hit.features.configuredFormCoverage).toBe(0);
        const noCandidateForm =
          !hit.features.configuredFormEvidence &&
          hit.features.configuredConceptMatch === false &&
          !hit.features.configuredFormBodyMatch &&
          !hit.features.contextualTitlePrefix;
        if (noCandidateForm && (hit.score === 0 || hit.features.bodyLexicalMatch > 0)) {
          expect(hit.directClass).not.toBe("moderate");
          expect(hit.directClass).not.toBe("strong");
        }
      }
    }
  );

  test("what is an ap may remain moderate via candidate contextual title prefix", () => {
    const q = analyzed("what is an ap");
    expect(q.configuredSequenceIntent?.key ?? null).toBeNull();
    const result = detailed("what is an ap");
    const api = result.results.find((h) => h.title === "What is an API?");
    expect(api).toBeTruthy();
    expect(api.directClass).toBe("moderate");
    expect(api.features.contextualTitlePrefix).toBe(true);
    expect(api.features.configuredFormCoverage).toBe(0);
  });
});
