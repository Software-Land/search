/**
 * Field-aware configured-concept evidence: title is identity, summary/body are
 * mentions. One token of a multi-token form is not form evidence.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { extractFeatures } from "../dist/features.js";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

const plugins = [
  morphology(),
  compileConfiguredConceptPlugin({
    configuredConcepts: [
      { key: "svg", aliases: [["scalable", "vector", "graphics"]] },
      { key: "cli", aliases: [["command", "line", "interface"]] },
      { key: "api", aliases: [["application", "programming", "interface"]] },
    ],
  }),
];

describe("configured-concept field evidence", () => {
  let engine;

  beforeAll(async () => {
    engine = SearchEngine.create({ schema, plugins, retriever: "full-scan" });
    await engine.index([
      { id: "svg-title", title: "SVG", summary: "graphics primer", body: "drawing" },
      {
        id: "fps",
        title: "200FPS",
        summary: "comparing CSS, SVG, Canvas and WebGL",
        body: "svg pipelines in the browser",
      },
      { id: "llama", title: "Llama.cpp", summary: "local cli inference", body: "run models from the cli" },
      { id: "iface", title: "What is an Interface?", summary: "types", body: "class versus interface" },
      { id: "form-title", title: "Scalable Vector Graphics", summary: "", body: "" },
      { id: "api-body", title: "Refactoring", summary: "cleanup around an api", body: "touch the api surface" },
    ]);
  });

  function feat(query, id) {
    const q = engine._prepareQuery(query);
    const doc = engine._index.byId.get(id);
    return extractFeatures(q, doc);
  }

  test("title key is identity and does not mint typed phrase evidence", () => {
    const f = feat("svg", "svg-title");
    expect(f.configuredConceptMatch).toBe("key-in-title");
    expect(f.configuredConceptFieldEvidence).toEqual({ title: "key", summary: false, body: false });
    expect(f.exactTitleOrSummaryPhrase).toBe(false);
    expect(f.directClass).toBe("strong");
  });

  test("complete form in title is form identity, not a single form token", () => {
    const f = feat("scalable vector graphics", "form-title");
    expect(f.configuredConceptMatch).toBe("form");
    expect(f.configuredConceptFieldEvidence.title).toBe("form");
    const iface = feat("command line interface", "iface");
    expect(iface.configuredConceptMatch).toBe(false);
    expect(iface.configuredConceptFieldEvidence).toEqual({ title: false, summary: false, body: false });
    expect(iface.directClass === "strong" || iface.directClass === "moderate").toBe(false);
  });

  test("summary and body configured keys are weak mentions", () => {
    const fps = feat("scalable vector graphics", "fps");
    expect(fps.configuredConceptMatch).toBe(false);
    expect(fps.configuredConceptFieldEvidence.summary).toBe("key");
    expect(fps.configuredConceptFieldEvidence.body).toBe("key");
    expect(fps.directClass).toBe("weak");
    const llama = feat("command line interface", "llama");
    expect(llama.configuredConceptFieldEvidence.summary).toBe("key");
    expect(llama.configuredConceptFieldEvidence.body).toBe("key");
    expect(llama.directClass).toBe("weak");
    const refactor = feat("api", "api-body");
    expect(refactor.configuredConceptFieldEvidence.summary).toBe("key");
    expect(refactor.configuredConceptFieldEvidence.body).toBe("key");
    expect(refactor.directClass).toBe("weak");
    expect(refactor.exactTitleOrSummaryPhrase).toBe(false);
  });
});

describe("summary field evidence is recorded without ranking consumption", () => {
  let engine;

  beforeAll(async () => {
    engine = SearchEngine.create({
      schema,
      plugins,
      retriever: "full-scan",
      relationshipStrategy: "hybrid",
    });
    await engine.index([
      {
        id: "aa-rbac",
        title: "RBAC",
        summary: "access control",
        body: "diagrams in svg for roles",
      },
      {
        id: "zz-fps",
        title: "200FPS",
        summary: "comparing CSS, SVG, Canvas and WebGL",
        body: "svg pipelines in the browser",
      },
      {
        id: "iface",
        title: "What is an Interface?",
        summary: "types",
        body: "the command line interface is not this article. also cli notes.",
      },
      {
        id: "llama",
        title: "Llama.cpp",
        summary: "local cli inference",
        body: "run models from the cli",
      },
    ]);
  });

  test("equal-score svg mentions keep document-id order, not summary provenance", () => {
    for (const q of ["svg", "scalable vector graphics"]) {
      const rows = engine.search(q, { limit: 10, explain: true });
      const rbac = rows.find((r) => r.id === "aa-rbac");
      const fps = rows.find((r) => r.id === "zz-fps");
      expect(rbac.directClass).toBe("weak");
      expect(fps.directClass).toBe("weak");
      expect(fps.features.configuredConceptFieldEvidence.summary).toBe("key");
      expect(rbac.features.configuredConceptFieldEvidence).toEqual({
        title: false,
        summary: false,
        body: "key",
      });
      expect(rbac.score).toBe(fps.score);
      expect(rows[0].id).toBe("aa-rbac");
    }
  });

  test("unequal scores are not reversed by summary provenance", () => {
    for (const q of ["cli", "command line interface"]) {
      const rows = engine.search(q, { limit: 10, explain: true });
      const llama = rows.find((r) => r.id === "llama");
      const iface = rows.find((r) => r.id === "iface");
      expect(llama.features.configuredConceptFieldEvidence.summary).toBe("key");
      expect(iface.features.configuredConceptFieldEvidence.summary).toBe(false);
      expect(iface.features.configuredConceptFieldEvidence.body).toBeTruthy();
      if (iface.score !== llama.score) {
        expect(rows[0].id).toBe(iface.score > llama.score ? "iface" : "llama");
      }
    }
  });
});
