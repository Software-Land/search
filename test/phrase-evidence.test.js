/**
 * Typed-surface phrase execution facts via PhraseQuery. Not ranking policy:
 * no minimum token-count relevance threshold lives here.
 * Token/conjunction DF and selectivity are not computed (rejected rare-phrase
 * exclusivity diagnostics).
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { typedSurfacePhraseTokens } from "../dist/query/phraseEvidence.js";
import { executePhraseQuery } from "../dist/positionalQueries.js";
import { sequenceCount, sequencePresent } from "../dist/retrieve.js";
import { tokenize } from "../dist/text/text.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const docs = [
  {
    id: "title-two",
    title: "Cloud Security Overview",
    body: "Notes about networks.",
  },
  {
    id: "body-two",
    title: "Other Notes",
    body: "Teams discuss cloud security during incidents.",
  },
  {
    id: "three-body",
    title: "Cookie Guide",
    body: "Use two-layer authorization at the edge.",
  },
  {
    id: "three-tokens-unordered",
    title: "Auth Notes",
    body: "Authorization uses a second layer and two factors.",
  },
  {
    id: "four-title",
    title: "Role Based Access Control",
    body: "A permission model.",
  },
  {
    id: "four-body-repeat",
    title: "Permissions",
    body: "Role based access control. Repeat: role based access control.",
  },
  {
    id: "order-mismatch",
    title: "Control Access",
    body: "Access based role control is not the same order.",
  },
  {
    id: "missing-token",
    title: "Role Access",
    body: "Role based control without the access word in sequence.",
  },
  {
    id: "lemma-only",
    title: "Authorizing Requests",
    body: "Two layers of authorizing users at the edge.",
  },
  {
    id: "rpc-incidental",
    title: "Build Time",
    body: "A remote procedure call happens during compile.",
  },
  {
    id: "rpc-intent",
    title: "gRPC vs REST",
    body: "gRPC is an RPC framework, not the exact expansion phrase.",
  },
];

function createEngine() {
  const compiled = compileAuthoredRelevance({
    configuredConcepts: [
      {
        key: "rpc",
        aliases: [["remote", "procedure", "call"], ["grpc"]],
      },
      {
        key: "rbac",
        aliases: [["role", "based", "access", "control"]],
      },
    ],
  });
  return SearchEngine.create({
    schema,
    plugins: [morphology({ lemmas: { authorizing: "authorize" } }), ...compiled.plugins],
    relationshipStrategy: "none",
    retriever: "full-scan",
  });
}

describe("exact phrase evidence", () => {
  let engine;

  beforeAll(async () => {
    engine = createEngine();
    await engine.index(docs);
  });

  function hits(raw) {
    const tokens = typedSurfacePhraseTokens(engine._prepareQuery(raw));
    if (tokens.length < 2) return [];
    return executePhraseQuery({ kind: "phrase", tokens }, engine._index);
  }

  test("one-token queries have no phrase-order evidence", () => {
    expect(hits("vpn")).toEqual([]);
    expect(hits("rpc")).toEqual([]);
    expect(typedSurfacePhraseTokens(engine._prepareQuery("rpc"))).toEqual(["rpc"]);
  });

  test("punctuation and case fold to the same typed surface", () => {
    const hyphen = engine._prepareQuery("TWO-LAYER AUTHORIZATION");
    const spaced = engine._prepareQuery("two layer authorization");
    expect(hyphen.originalSurface).toEqual(["two", "layer", "authorization"]);
    expect(spaced.originalSurface).toEqual(hyphen.originalSurface);
    expect(tokenize("TWO-LAYER AUTHORIZATION")).toEqual(["two", "layer", "authorization"]);
    const a = hits("TWO-LAYER AUTHORIZATION");
    const b = hits("two layer authorization");
    expect(typedSurfacePhraseTokens(hyphen)).toEqual(typedSurfacePhraseTokens(spaced));
    expect(a.map((hit) => hit.document.id)).toEqual(b.map((hit) => hit.document.id));
  });

  test("2-token phrase field frequencies", () => {
    const found = hits("cloud security");
    expect(typedSurfacePhraseTokens(engine._prepareQuery("cloud security"))).toEqual(["cloud", "security"]);
    const titleHit = found.find((hit) => hit.document.id === "title-two");
    const bodyHit = found.find((hit) => hit.document.id === "body-two");
    expect(titleHit.titleFrequency).toBe(1);
    expect(titleHit.summaryFrequency).toBe(0);
    expect(titleHit.bodyFrequency).toBe(0);
    expect(bodyHit.titleFrequency).toBe(0);
    expect(bodyHit.summaryFrequency).toBe(0);
    expect(bodyHit.bodyFrequency).toBe(1);
  });

  test("3-token exact phrase counts body occurrences and ignores order-only bags", () => {
    const found = hits("two-layer authorization");
    expect(found).toHaveLength(1);
    expect(found[0].document.id).toBe("three-body");
    expect(found[0].titleFrequency).toBe(0);
    expect(found[0].summaryFrequency).toBe(0);
    expect(found[0].bodyFrequency).toBe(1);
    const unordered = engine._index.documents.find((doc) => doc.id === "three-tokens-unordered");
    expect(sequencePresent(["two", "layer", "authorization"], unordered.bodyTokens)).toBe(false);
    expect(sequenceCount(["two", "layer", "authorization"], unordered.bodyTokens)).toBe(0);
  });

  test("4+-token phrases record repeated body frequency", () => {
    const found = hits("role based access control");
    const titleHit = found.find((hit) => hit.document.id === "four-title");
    const bodyHit = found.find((hit) => hit.document.id === "four-body-repeat");
    expect(titleHit.titleFrequency).toBe(1);
    expect(titleHit.summaryFrequency).toBe(0);
    expect(titleHit.bodyFrequency).toBe(0);
    expect(bodyHit.titleFrequency).toBe(0);
    expect(bodyHit.summaryFrequency).toBe(0);
    expect(bodyHit.bodyFrequency).toBe(2);
  });

  test("order mismatch is not an exact phrase hit", () => {
    const found = hits("role based access control");
    expect(found.map((hit) => hit.document.id)).not.toContain("order-mismatch");
    const doc = engine._index.documents.find((row) => row.id === "order-mismatch");
    expect(sequenceCount(["role", "based", "access", "control"], doc.bodyTokens)).toBe(0);
  });

  test("a missing token yields no phrase hits", () => {
    expect(hits("quantum lattice authorization")).toEqual([]);
  });

  test("lemmas and configured aliases are not phrase identity", () => {
    expect(hits("two layer authorizing")).toEqual([]);

    const expansion = engine._prepareQuery("remote procedure call");
    expect(expansion.originalSurface).toEqual(["remote", "procedure", "call"]);
    expect(expansion.configuredSequenceIntent?.key).toBe("rpc");
    const found = executePhraseQuery(
      { kind: "phrase", tokens: typedSurfacePhraseTokens(expansion) },
      engine._index
    );
    expect(found).toHaveLength(1);
    expect(found[0].document.id).toBe("rpc-incidental");
    expect(found.map((hit) => hit.document.id)).not.toContain("rpc-intent");
  });

  test("2, 3, and 4 token queries all execute as PhraseQuery", () => {
    expect(hits("cloud security").length).toBeGreaterThan(0);
    expect(hits("two layer authorization").length).toBeGreaterThan(0);
    expect(hits("role based access control").length).toBeGreaterThan(0);
    expect(Array.isArray(hits("retries are exactly what it sounds"))).toBe(true);
  });

  test("per-field frequencies stay on PhraseQuery hits", () => {
    const found = hits("remote procedure call");
    const incidental = found.find((hit) => hit.document.id === "rpc-incidental");
    expect(incidental.bodyFrequency).toBe(1);
    expect(incidental.summaryFrequency).toBe(0);
    expect(incidental.titleFrequency).toBe(0);
  });
});
