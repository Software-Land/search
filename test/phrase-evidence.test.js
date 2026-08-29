/**
 * Exact typed-surface phrase evidence facts. Not ranking policy:
 * no minimum token-count relevance threshold lives here.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import {
  computeExactPhraseEvidence,
  exactPhraseExplainRecord,
  typedSurfacePhraseTokens,
} from "../dist/phraseEvidence.js";
import { sequenceCount, sequencePresent } from "../dist/retrieve.js";
import { tokenize } from "../dist/text.js";

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

  function evidence(raw) {
    return computeExactPhraseEvidence(engine._prepareQuery(raw), engine._index);
  }

  test("one-token queries have no phrase-order evidence", () => {
    expect(evidence("vpn")).toBeNull();
    expect(evidence("rpc")).toBeNull();
    expect(typedSurfacePhraseTokens(engine._prepareQuery("rpc"))).toEqual(["rpc"]);
  });

  test("punctuation and case fold to the same typed surface", () => {
    const hyphen = engine._prepareQuery("TWO-LAYER AUTHORIZATION");
    const spaced = engine._prepareQuery("two layer authorization");
    expect(hyphen.originalSurface).toEqual(["two", "layer", "authorization"]);
    expect(spaced.originalSurface).toEqual(hyphen.originalSurface);
    expect(tokenize("TWO-LAYER AUTHORIZATION")).toEqual(["two", "layer", "authorization"]);
    const a = evidence("TWO-LAYER AUTHORIZATION");
    const b = evidence("two layer authorization");
    expect(a.tokens).toEqual(b.tokens);
    expect(a.phraseDf).toBe(b.phraseDf);
    expect(a.hits.map((hit) => hit.document.id)).toEqual(b.hits.map((hit) => hit.document.id));
  });

  test("2-token phrase DF, conjunction DF, and field frequencies", () => {
    const ev = evidence("cloud security");
    expect(ev).not.toBeNull();
    expect(ev.tokenCount).toBe(2);
    expect(ev.tokens).toEqual(["cloud", "security"]);
    expect(ev.phraseDf).toBe(2);
    expect(ev.conjunctionDf).toBe(2);
    expect(ev.selectivity).toBe(1);
    const titleHit = ev.hits.find((hit) => hit.document.id === "title-two");
    const bodyHit = ev.hits.find((hit) => hit.document.id === "body-two");
    expect(titleHit.titleFrequency).toBe(1);
    expect(titleHit.summaryFrequency).toBe(0);
    expect(titleHit.bodyFrequency).toBe(0);
    expect(bodyHit.titleFrequency).toBe(0);
    expect(bodyHit.summaryFrequency).toBe(0);
    expect(bodyHit.bodyFrequency).toBe(1);
  });

  test("3-token exact phrase counts body occurrences and ignores order-only bags", () => {
    const ev = evidence("two-layer authorization");
    expect(ev.tokenCount).toBe(3);
    expect(ev.phraseDf).toBe(1);
    expect(ev.hits[0].document.id).toBe("three-body");
    expect(ev.hits[0].titleFrequency).toBe(0);
    expect(ev.hits[0].summaryFrequency).toBe(0);
    expect(ev.hits[0].bodyFrequency).toBe(1);
    const unordered = engine._index.documents.find((doc) => doc.id === "three-tokens-unordered");
    expect(sequencePresent(["two", "layer", "authorization"], unordered.bodyTokens)).toBe(false);
    expect(sequenceCount(["two", "layer", "authorization"], unordered.bodyTokens)).toBe(0);
    expect(ev.conjunctionDf).toBeGreaterThanOrEqual(1);
  });

  test("4+-token phrases record DF and repeated body frequency", () => {
    const ev = evidence("role based access control");
    expect(ev.tokenCount).toBe(4);
    expect(ev.phraseDf).toBe(2);
    const titleHit = ev.hits.find((hit) => hit.document.id === "four-title");
    const bodyHit = ev.hits.find((hit) => hit.document.id === "four-body-repeat");
    expect(titleHit.titleFrequency).toBe(1);
    expect(titleHit.summaryFrequency).toBe(0);
    expect(titleHit.bodyFrequency).toBe(0);
    expect(bodyHit.titleFrequency).toBe(0);
    expect(bodyHit.summaryFrequency).toBe(0);
    expect(bodyHit.bodyFrequency).toBe(2);
    expect(ev.conjunctionDf).toBeGreaterThanOrEqual(2);
    expect(ev.selectivity).toBe(ev.phraseDf / ev.conjunctionDf);
  });

  test("order mismatch is not an exact phrase hit", () => {
    const ev = evidence("role based access control");
    expect(ev.hits.map((hit) => hit.document.id)).not.toContain("order-mismatch");
    const doc = engine._index.documents.find((row) => row.id === "order-mismatch");
    expect(sequenceCount(["role", "based", "access", "control"], doc.bodyTokens)).toBe(0);
  });

  test("a missing token yields phrase DF 0 and conjunction DF 0", () => {
    const ev = evidence("quantum lattice authorization");
    expect(ev.phraseDf).toBe(0);
    expect(ev.conjunctionDf).toBe(0);
    expect(ev.selectivity).toBeNull();
    expect(ev.hits).toEqual([]);
    const missing = ev.tokenDfs.find((row) => row.token === "quantum");
    expect(missing.df).toBe(0);
  });

  test("lemmas and configured aliases are not phrase identity", () => {
    const lemmaQuery = evidence("two layer authorizing");
    expect(lemmaQuery.phraseDf).toBe(0);

    const expansion = engine._prepareQuery("remote procedure call");
    expect(expansion.originalSurface).toEqual(["remote", "procedure", "call"]);
    expect(expansion.configuredSequenceIntent?.key).toBe("rpc");
    const ev = computeExactPhraseEvidence(expansion, engine._index);
    expect(ev.tokens).toEqual(["remote", "procedure", "call"]);
    expect(ev.phraseDf).toBe(1);
    expect(ev.hits[0].document.id).toBe("rpc-incidental");
    expect(ev.hits.map((hit) => hit.document.id)).not.toContain("rpc-intent");
  });

  test("token DFs count documents containing each typed token regardless of order", () => {
    const ev = evidence("cloud security");
    const cloud = ev.tokenDfs.find((row) => row.token === "cloud");
    const security = ev.tokenDfs.find((row) => row.token === "security");
    expect(cloud.df).toBeGreaterThanOrEqual(2);
    expect(security.df).toBeGreaterThanOrEqual(2);
    expect(ev.corpusSize).toBe(docs.length);
  });

  test("2, 3, and 4 token queries all receive evidence objects", () => {
    expect(evidence("cloud security")).not.toBeNull();
    expect(evidence("two layer authorization")).not.toBeNull();
    expect(evidence("role based access control")).not.toBeNull();
    expect(evidence("retries are exactly what it sounds")).not.toBeNull();
  });

  test("explain record preserves per-field frequencies", () => {
    const query = engine._prepareQuery("remote procedure call");
    const ev = computeExactPhraseEvidence(query, engine._index);
    const incidental = ev.hits.find((hit) => hit.document.id === "rpc-incidental");
    const sketch = exactPhraseExplainRecord(ev, query, incidental);
    expect(sketch.configuredIntent).toBe("rpc");
    expect(sketch.exactPhrase.df).toBe(1);
    expect(sketch.exactPhrase.bodyFrequency).toBe(1);
    expect(sketch.exactPhrase.summaryFrequency).toBe(0);
    expect(sketch.exactPhrase.field).toBe("body");
  });
});
