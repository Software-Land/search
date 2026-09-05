/**
 * Relationship support is orthogonal to directClass. Weak lexical candidates
 * keep relevanceKind=direct when an edge is attached.
 */
import { SearchEngine, morphology, ARTIFACT_FORMATS, ARTIFACT_VERSION } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

describe("relationship orthogonality", () => {
  test("weak direct plus relationship stays direct; none-class neighbors are related", async () => {
    const engine = SearchEngine.create({
      schema,
      retriever: "full-scan",
      relationshipStrategy: "hybrid",
      plugins: [
        morphology(),
        compileConfiguredConceptPlugin({
          configuredConcepts: [{ key: "api", aliases: [["application", "programming", "interface"]] }],
        }),
      ],
      documentRelationships: {
        format: ARTIFACT_FORMATS.relationships,
        version: ARTIFACT_VERSION,
        relationships: {
          api: [
            { target: "neighbor", type: "semantic", strength: 0.5, provenance: "test" },
            { target: "mention", type: "semantic", strength: 0.4, provenance: "test" },
          ],
        },
      },
    });
    await engine.index([
      { id: "api", title: "What is an API?", summary: "", body: "identity" },
      { id: "mention", title: "Refactoring", summary: "mentions api", body: "api cleanup" },
      { id: "neighbor", title: "Class vs Interface", summary: "", body: "types without the key" },
    ]);
    const rows = engine.search("api", { limit: 10, explain: true });
    const mention = rows.find((r) => r.id === "mention");
    const neighbor = rows.find((r) => r.id === "neighbor");
    expect(mention.directClass).toBe("weak");
    expect(mention.relevanceKind).toBe("direct");
    expect(mention.features.configuredConceptFieldEvidence.body).toBe("key");
    expect(mention.relationship.strength).toBe(0.4);
    expect(neighbor.directClass).toBe("none");
    expect(neighbor.relevanceKind).toBe("related");
    expect(neighbor.relationship.strength).toBe(0.5);
    expect(rows.findIndex((r) => r.id === "neighbor")).toBeLessThan(rows.findIndex((r) => r.id === "mention"));
  });
});
