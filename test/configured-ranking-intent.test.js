/**
 * Configured ranking intent is occupancy ?? content-identity. Identity does
 * not become occupancy. Ranking may evaluate the configured concept and
 * authored peer forms; structural wrappers do not mint concept coverage.
 */
import { SearchEngine, morphology, ARTIFACT_FORMATS, ARTIFACT_VERSION } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { extractFeatures } from "../dist/features/features.js";
import { TWO_THIRDS_QUERY_COVERAGE } from "../dist/evidencePolicy.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const plugins = [
  morphology(),
  compileConfiguredConceptPlugin({
    configuredConcepts: [
      { key: "wgt", aliases: [["widget", "gadget"]] },
      { key: "rpc", aliases: [["remote", "procedure", "call"]] },
    ],
  }),
];

function analyzed(raw) {
  return analyzeQuery(raw, { plugins });
}

describe("configured ranking intent", () => {
  let engine;

  beforeAll(async () => {
    engine = SearchEngine.create({
      schema,
      plugins,
      retriever: "full-scan",
      relationshipStrategy: "hybrid",
      documentRelationships: {
        format: ARTIFACT_FORMATS.relationships,
        version: ARTIFACT_VERSION,
        relationships: {
          identity: [{ target: "neighbor", type: "semantic", strength: 0.45, provenance: "test" }],
        },
      },
    });
    await engine.index([
      { id: "identity", title: "Widget Gadget", body: "authored peer-form title for the compact key" },
      { id: "generic", title: "What is Recursion?", body: "unrelated wrapper-shaped title" },
      { id: "container", title: "What is a Container?", body: "another generic what-is title" },
      { id: "rpc-title", title: "Remote Procedure Call", body: "multi-token form title" },
      { id: "neighbor", title: "Zero Neighbor", body: "no lexical overlap with the concept" },
    ]);
  });

  function feat(query, id) {
    const q = engine._prepareQuery(query);
    const doc = engine._index.byId.get(id);
    return extractFeatures(q, doc);
  }

  test("identity remains distinct from occupancy", () => {
    const wrap = analyzed("what is wgt");
    expect(wrap.configuredSequenceIntent).toBeNull();
    expect(wrap.configuredContentIdentity?.key).toBe("wgt");
    const bare = analyzed("wgt");
    expect(bare.configuredSequenceIntent?.key).toBe("wgt");
    expect(bare.configuredContentIdentity?.key).toBe("wgt");
    const formWrap = analyzed("what is widget gadget");
    expect(formWrap.configuredSequenceIntent).toBeNull();
    expect(formWrap.configuredContentIdentity?.key).toBe("wgt");
    const form = analyzed("widget gadget");
    expect(form.configuredSequenceIntent?.key).toBe("wgt");
  });

  test("compact key behind wrappers retains peer-form title evidence", () => {
    const occupied = feat("wgt", "identity");
    const wrapped = feat("what is wgt", "identity");
    expect(occupied.exactTitleMatch).toBe(true);
    expect(wrapped.exactTitleMatch).toBe(true);
    expect(wrapped.titlePrefixQuality).toBeGreaterThan(0.4);
    expect(wrapped.queryCoverage).toBe(1);
    expect(wrapped.directClass).toBe("strong");
  });

  test("strong-primary classification is retained for wrapped compact keys", () => {
    const rows = engine.search("what is wgt", { limit: 10, explain: true });
    expect(rows[0].id).toBe("identity");
    expect(rows[0].directClass).toBe("strong");
    expect(rows[0].features.exactTitleMatch).toBe(true);
    const neighbor = rows.find((r) => r.id === "neighbor");
    expect(neighbor).toBeTruthy();
    expect(neighbor.relevanceKind).toBe("related");
  });

  test("structural wrappers do not mint generic queryCoverage against unrelated What is titles", () => {
    for (const query of ["what is wgt", "the wgt", "an wgt"]) {
      const recursion = feat(query, "generic");
      const container = feat(query, "container");
      expect(recursion.queryCoverage).toBeLessThan(TWO_THIRDS_QUERY_COVERAGE);
      expect(container.queryCoverage).toBeLessThan(TWO_THIRDS_QUERY_COVERAGE);
      expect(recursion.exactTitleMatch).toBe(false);
      expect(container.directClass === "strong" || container.directClass === "moderate").toBe(false);
    }
  });

  test("multi-token configured forms remain correct behind wrappers", () => {
    const occupied = feat("widget gadget", "identity");
    const wrapped = feat("what is widget gadget", "identity");
    expect(analyzed("widget gadget").configuredSequenceIntent?.key).toBe("wgt");
    expect(analyzed("what is widget gadget").configuredSequenceIntent).toBeNull();
    expect(analyzed("what is widget gadget").configuredContentIdentity?.key).toBe("wgt");
    expect(occupied.exactTitleMatch).toBe(true);
    expect(wrapped.exactTitleMatch).toBe(true);
    expect(wrapped.directClass).toBe("strong");
    expect(engine.search("what is widget gadget", { limit: 1 })[0].id).toBe("identity");
  });

  test("wrapped multi-token rpc form keeps peer-form title evidence", () => {
    const occupied = feat("rpc", "rpc-title");
    const wrapped = feat("what is rpc", "rpc-title");
    expect(analyzed("what is rpc").configuredSequenceIntent).toBeNull();
    expect(analyzed("what is rpc").configuredContentIdentity?.key).toBe("rpc");
    expect(occupied.exactTitleMatch).toBe(true);
    expect(wrapped.exactTitleMatch).toBe(true);
    expect(wrapped.directClass).toBe("strong");
  });
});
