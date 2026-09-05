/**
 * Slice 3 characterization: query-semantic facts feed separate eligibility
 * policies. This file freezes intentional disagreements (reason strings and
 * precedence). It does not unify the policies.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { synonyms } from "../dist/synonyms.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import { querySemanticFacts } from "../dist/querySemantics.js";
import { stage3AUnsupportedReason } from "../dist/exactBlockSkip.js";
import { rankingEvidenceEligibilityReason } from "../dist/rankingEvidencePlan.js";
import { rankingEvidenceStaticFor } from "../dist/rankingEvidenceState.js";
import { packedSearchFallbackReason } from "../dist/rankingEvidenceSearch.js";
import { searchSessionCapabilities } from "../dist/executionSession.js";
import { featureBlockPruningFallbackReason } from "../dist/exactPruning.js";
import {
  collectCompleteInterpretations,
  COMPLETE_INTERPRETATION_COLLECTOR,
} from "../dist/completeInterpretationCollector.js";
import { configuredConceptPluginFromLegacy } from "./helpers/authored.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const dict = [
  { key: "nist", aliases: [["national", "institute", "standards", "technology"]] },
  { key: "gatech", aliases: [["georgia", "institute", "of", "technology"]] },
  { key: "rpc", aliases: [["remote", "procedure", "call"]] },
  { key: "ml", aliases: [["machine", "learning"]] },
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]], standaloneRecall: ["hypertext"] },
  { key: "appsec", aliases: [["application", "security"]], topicalRecall: [["authentication"]] },
  { key: "api", aliases: [["application", "programming", "interface"]] },
  { key: "qa", aliases: [["quality", "assurance"]] },
];

const docs = [
  { id: "tls", title: "TLS 1.2 Vulnerability", body: "information notes" },
  { id: "notes", title: "Information Notes", body: "request notes about open interface interceptor internet" },
  { id: "api", title: "What is an API?", body: "programming interface" },
  { id: "rpc", title: "Remote Procedure Call", body: "rpc notes" },
  { id: "nist", title: "National Institute", body: "standards technology" },
  { id: "ml", title: "Machine Learning", body: "models" },
  { id: "http", title: "HTTP Notes", body: "hypertext transfer protocol" },
  { id: "appsec", title: "Application Security", body: "authentication authorization" },
  { id: "qa", title: "Quality Assurance", body: "testing" },
];

function plugins() {
  return [morphology(), configuredConceptPluginFromLegacy(dict), synonyms({ qa: ["testing"] })];
}

async function compiledEngine() {
  const compiledPlugins = plugins();
  const lexicalIndex = compileLexicalIndex(docs, { schema, plugins: compiledPlugins });
  const e = SearchEngine.create({
    schema,
    plugins: compiledPlugins,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  await e.index(docs);
  return e;
}

function snapshot(engine, raw) {
  const query = engine._prepareQuery(raw);
  const facts = querySemanticFacts(query);
  const collector = collectCompleteInterpretations({
    occupancy: Boolean(facts.configured.occupiedKey),
    configuredContentIdentity: Boolean(facts.configured.contentIdentityKey),
    version: Boolean(query.dottedSpans?.length),
    exactHits: [],
    prefixHits: [],
  });
  return {
    query,
    facts,
    stage3A: stage3AUnsupportedReason(query),
    rankingEvidence: rankingEvidenceEligibilityReason(query, rankingEvidenceStaticFor(engine._index)),
    packed: packedSearchFallbackReason({
      exactDiagnostics: false,
      pruningMode: "auto",
      retrievalScoreWeight: 0,
      sourcePolicy: "top1-strong",
      retriever: engine.retriever,
      opts: {},
      query,
      index: engine._index,
    }),
    collector: collector.reason,
  };
}

function featureBlock(sessionInput, extras = {}) {
  return featureBlockPruningFallbackReason({
    session: searchSessionCapabilities({
      rankingEvidenceRetriever: true,
      ...sessionInput,
    }),
    compiledIndexedRetriever: extras.compiledIndexedRetriever ?? true,
    hasExactPruningRuntime: extras.hasExactPruningRuntime ?? true,
    relationshipStrategy: extras.relationshipStrategy ?? "none",
  });
}

describe("execution eligibility primitives", () => {
  let engine;

  beforeAll(async () => {
    engine = await compiledEngine();
  });

  test("ordinary two-token query is eligible for Stage 3A and packed evidence", () => {
    const row = snapshot(engine, "information notes");
    expect(row.facts.configured).toMatchObject({
      occupiedKey: null,
      contentIdentityKey: null,
      hasRankingIdentity: false,
      weakRecall: null,
    });
    expect(row.facts.completion).toEqual({ vocabularyPrefix: false, boundTrailing: false });
    expect(row.facts.relatedRecall).toEqual({ standalone: false, topical: false, equivalent: false });
    expect(row.stage3A).toBeNull();
    expect(row.rankingEvidence).toBeNull();
    expect(row.packed).toBeNull();
    expect(row.collector).toBe("no-complete-hit");
  });

  test("occupancy, identity, and weak recall disagree across policies", () => {
    const occupied = snapshot(engine, "machine learning");
    expect(occupied.facts.configured.occupiedKey).toBe("ml");
    expect(occupied.facts.configured.hasRankingIdentity).toBe(true);
    expect(occupied.stage3A).toBe("configured-concept");
    expect(occupied.rankingEvidence).toBeNull();
    expect(occupied.packed).toBeNull();
    expect(occupied.collector).toBe("occupancy");

    const unigram = snapshot(engine, "api");
    expect(unigram.facts.configured.occupiedKey).toBe("api");
    expect(unigram.stage3A).toBe("token-count");
    expect(unigram.rankingEvidence).toBeNull();
    expect(unigram.packed).toBeNull();
    expect(unigram.collector).toBe("occupancy");

    const identity = snapshot(engine, "what is rpc");
    expect(identity.facts.configured.occupiedKey).toBeNull();
    expect(identity.facts.configured.contentIdentityKey).toBe("rpc");
    expect(identity.facts.configured.hasRankingIdentity).toBe(true);
    expect(identity.stage3A).toBe("configured-concept");
    expect(identity.rankingEvidence).toBeNull();
    expect(identity.packed).toBeNull();
    expect(identity.collector).toBe("configured-content-identity");

    const unique = snapshot(engine, "national");
    expect(unique.facts.configured.weakRecall).toMatchObject({ ambiguity: "unique" });
    expect(unique.stage3A).toBe("token-count");
    expect(unique.rankingEvidence).toBe("configured-prefix-recall");
    expect(unique.packed).toBe("configured-prefix-recall");
    expect(unique.collector).toBe("no-complete-hit");

    const uniqueTwo = snapshot(engine, "national in");
    expect(uniqueTwo.facts.configured.weakRecall).toMatchObject({ ambiguity: "unique" });
    expect(uniqueTwo.stage3A).toBe("configured-prefix-recall");
    expect(uniqueTwo.rankingEvidence).toBe("configured-prefix-recall");
    expect(uniqueTwo.packed).toBe("configured-prefix-recall");

    const ambiguous = snapshot(engine, "appl");
    expect(ambiguous.facts.configured.weakRecall).toMatchObject({ ambiguity: "group" });
    expect(ambiguous.stage3A).toBe("token-count");
    expect(ambiguous.rankingEvidence).toBe("configured-prefix-recall");
    expect(ambiguous.packed).toBe("configured-prefix-recall");
  });

  test("completion reasons stay policy-local and keep alternatives-before-prefix-completion", () => {
    const bound = snapshot(engine, "machine l");
    expect(bound.facts.completion.boundTrailing).toBe(true);
    expect(bound.stage3A).toBe("contextual-completion");
    expect(bound.rankingEvidence).toBe("bound-contextual-completion");
    expect(bound.packed).toBe("bound-contextual-completion");

    const prefix = snapshot(engine, "open interfa");
    expect(prefix.facts.completion.vocabularyPrefix).toBe(true);
    expect(prefix.query.alternatives.length).toBeGreaterThan(0);
    expect(prefix.stage3A).toBe("alternatives");
    expect(prefix.rankingEvidence).toBeNull();
    expect(prefix.packed).toBeNull();
    expect(stage3AUnsupportedReason({ ...prefix.query, alternatives: [] })).toBe("prefix-completion");
  });

  test("related-recall and version policies keep distinct reason names", () => {
    const standalone = snapshot(engine, "hypertext");
    expect(standalone.facts.relatedRecall.standalone).toBe(true);
    expect(standalone.stage3A).toBe("token-count");
    expect(standalone.rankingEvidence).toBe("standalone-recall");
    expect(standalone.packed).toBe("standalone-recall");

    const topical = snapshot(engine, "application security");
    expect(topical.facts.configured.occupiedKey).toBe("appsec");
    expect(topical.facts.relatedRecall.topical).toBe(true);
    expect(topical.stage3A).toBe("topical-recall");
    expect(topical.rankingEvidence).toBe("topical-recall");
    expect(topical.packed).toBe("topical-recall");
    expect(topical.collector).toBe("occupancy");

    const equivalent = snapshot(engine, "qa");
    expect(equivalent.facts.relatedRecall.equivalent).toBe(true);
    expect(equivalent.rankingEvidence).toBe("equivalent-recall");
    expect(equivalent.packed).toBe("equivalent-recall");
    expect(equivalent.stage3A).not.toBe("equivalent-recall");

    const dotted = snapshot(engine, "1.2 vulnerability");
    expect(dotted.query.dottedSpans).toContain("1.2");
    expect(dotted.stage3A).toBe("dotted-spans");
    expect(dotted.rankingEvidence).toBe("version-number-dotted");
    expect(dotted.packed).toBe("version-number-dotted");
    expect(dotted.collector).toBe("version");

    const number = snapshot(engine, "open 12");
    expect(number.query.concepts.some((concept) => concept.kind === "number")).toBe(true);
    expect(number.query.dottedSpans || []).toEqual([]);
    expect(number.stage3A).toBe("term-concept-count");
    expect(number.rankingEvidence).toBe("version-number-dotted");
    expect(number.packed).toBe("version-number-dotted");
    expect(number.collector).toBe("no-complete-hit");

    const short = snapshot(engine, "ap");
    expect(short.stage3A).toBe("token-count");
    expect(short.rankingEvidence).toBe("short-literal");
    expect(short.packed).toBe("short-literal");
  });

  test("packed and feature-block session gates share facts but not precedence", () => {
    const query = engine._prepareQuery("information notes");
    const packed = (overrides) =>
      packedSearchFallbackReason({
        exactDiagnostics: false,
        pruningMode: "auto",
        retrievalScoreWeight: 0,
        sourcePolicy: "top1-strong",
        retriever: engine.retriever,
        opts: {},
        query,
        index: engine._index,
        ...overrides,
      });

    expect(packed({ opts: { explain: true } })).toBe("explain");
    expect(
      featureBlock({
        exactDiagnostics: false,
        pruningMode: "auto",
        retrievalScoreWeight: 0,
        explain: true,
      })
    ).toBeNull();

    expect(packed({ opts: { resultCollector: COMPLETE_INTERPRETATION_COLLECTOR } })).toBe(
      "complete-interpretation"
    );
    expect(
      featureBlock({
        exactDiagnostics: false,
        pruningMode: "auto",
        retrievalScoreWeight: 0,
        resultCollector: COMPLETE_INTERPRETATION_COLLECTOR,
      })
    ).toBeNull();

    expect(packed({ exactDiagnostics: true, opts: { explain: true } })).toBe("exact-diagnostics");
    expect(
      featureBlock({
        exactDiagnostics: true,
        pruningMode: "exhaustive",
        retrievalScoreWeight: 0,
      })
    ).toBe("exact-diagnostics");

    expect(packed({ pruningMode: "exhaustive", opts: { explain: true } })).toBe("explain");
    expect(
      featureBlock({
        exactDiagnostics: false,
        pruningMode: "exhaustive",
        retrievalScoreWeight: 0,
        explain: true,
      })
    ).toBe("explicit-exhaustive");

    const custom = { retrieve() { return []; } };
    expect(packed({ retrievalScoreWeight: 0.1, retriever: custom })).toBe("retrieval-score-weight");
    expect(
      featureBlock(
        {
          exactDiagnostics: false,
          pruningMode: "auto",
          retrievalScoreWeight: 0.1,
        },
        { compiledIndexedRetriever: false }
      )
    ).toBe("unsupported-retriever");

    expect(packed({ sourcePolicy: "all-strong", retriever: custom })).toBe("all-strong-relationships");
    expect(
      featureBlock(
        {
          exactDiagnostics: false,
          pruningMode: "auto",
          retrievalScoreWeight: 0,
          sourcePolicy: "all-strong",
        },
        { compiledIndexedRetriever: false, relationshipStrategy: "hybrid" }
      )
    ).toBe("unsupported-retriever");

    expect(packed({ sourcePolicy: "all-strong" })).toBe("all-strong-relationships");
    expect(
      featureBlock({
        exactDiagnostics: false,
        pruningMode: "auto",
        retrievalScoreWeight: 0,
        sourcePolicy: "all-strong",
      })
    ).toBeNull();
    expect(
      featureBlock(
        {
          exactDiagnostics: false,
          pruningMode: "auto",
          retrievalScoreWeight: 0,
          sourcePolicy: "all-strong",
        },
        { relationshipStrategy: "hybrid" }
      )
    ).toBe("all-strong-relationships");
  });
});
