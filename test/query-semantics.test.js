/**
 * Internal query-semantic projection. Locks fact extraction against AnalyzedQuery
 * fields. Does not change ranking, retrieval, or public explain.
 */
import { morphology } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { querySemanticFacts } from "../dist/querySemantics.js";
import { configuredConceptPluginFromLegacy } from "./helpers/authored.js";

const nistFamily = [
  { key: "nist", aliases: [["national", "institute", "standards", "technology"]] },
  { key: "gatech", aliases: [["georgia", "institute", "of", "technology"]] },
];

const httpFamily = [
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]], standaloneRecall: ["hypertext"] },
  { key: "https", aliases: [["hypertext", "transfer", "protocol", "secure"]] },
  { key: "html", aliases: [["hypertext", "markup", "language"]] },
];

const identityDict = [
  { key: "rpc", aliases: [["remote", "procedure", "call"]] },
  { key: "api", aliases: [["application", "programming", "interface"]] },
];

const appsec = [
  { key: "appsec", aliases: [["application", "security"]], topicalRecall: [["authentication"]] },
];

function analyze(raw, entries) {
  return analyzeQuery(raw, {
    plugins: [morphology(), configuredConceptPluginFromLegacy(entries)],
  });
}

describe("querySemanticFacts", () => {
  test("null query is empty", () => {
    expect(querySemanticFacts(null)).toEqual({
      configured: { occupiedKey: null, contentIdentityKey: null, weakRecall: null },
      completion: { vocabularyPrefix: false, boundTrailing: false },
      relatedRecall: { standalone: false, topical: false, equivalent: false },
    });
  });

  test("unique weak configured recall keeps the coverage row", () => {
    const q = analyze("nationa", nistFamily);
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredPrefixRecall?.key).toBe("nist");
    const facts = querySemanticFacts(q);
    expect(facts.configured.occupiedKey).toBeNull();
    expect(facts.configured.weakRecall?.ambiguity).toBe("unique");
    expect(facts.configured.weakRecall.candidates).toEqual([q.configuredPrefixRecall]);
    expect(facts.configured.weakRecall.candidates[0]).toBe(q.configuredPrefixRecall);
  });

  test("ambiguous weak configured recall keeps every matching row", () => {
    const q = analyze("hypertex", httpFamily);
    expect(q.configuredPrefixRecall).toBeNull();
    expect((q.configuredPrefixRecallGroup || []).map((row) => row.key).sort()).toEqual(["html", "http", "https"]);
    const facts = querySemanticFacts(q);
    expect(facts.configured.weakRecall?.ambiguity).toBe("group");
    expect(facts.configured.weakRecall.candidates.map((row) => row.key).sort()).toEqual(["html", "http", "https"]);
    expect(facts.configured.weakRecall.candidates).toEqual(q.configuredPrefixRecallGroup);
  });

  test("occupancy nulls weak recall", () => {
    const q = analyze("national institute", nistFamily);
    expect(q.configuredSequenceIntent?.key).toBe("nist");
    expect(q.configuredPrefixRecall).toBeNull();
    expect(querySemanticFacts(q).configured).toMatchObject({
      occupiedKey: "nist",
      weakRecall: null,
    });
  });

  test("occupancy wins even if weak-recall fields are also present", () => {
    const facts = querySemanticFacts({
      configuredSequenceIntent: { key: "api", matchedForm: ["application"], matchedKinds: ["form"] },
      configuredPrefixRecall: {
        key: "nist",
        form: ["national", "institute", "standards", "technology"],
        exactCount: 1,
        formLength: 4,
        coverage: 0.25,
        lastExact: true,
        partialCompleteness: 0,
      },
      configuredPrefixRecallGroup: [
        {
          key: "http",
          form: ["hypertext", "transfer", "protocol"],
          exactCount: 0,
          formLength: 3,
          coverage: 0.1,
          lastExact: false,
          partialCompleteness: 0.3,
        },
      ],
    });
    expect(facts.configured.occupiedKey).toBe("api");
    expect(facts.configured.weakRecall).toBeNull();
  });

  test("content identity is not occupancy", () => {
    const q = analyze("what is rpc", identityDict);
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredContentIdentity?.key).toBe("rpc");
    expect(querySemanticFacts(q).configured).toMatchObject({
      occupiedKey: null,
      contentIdentityKey: "rpc",
      weakRecall: null,
    });
  });

  test("related-recall presence follows compiled activation", () => {
    const standalone = analyze("hypertext", httpFamily);
    expect(standalone.standaloneRecall?.key).toBe("http");
    expect(querySemanticFacts(standalone).relatedRecall).toEqual({
      standalone: true,
      topical: false,
      equivalent: false,
    });

    const topical = analyze("application security", appsec);
    expect(topical.configuredSequenceIntent?.key).toBe("appsec");
    expect(topical.topicalRecall?.key).toBe("appsec");
    expect(querySemanticFacts(topical).relatedRecall).toEqual({
      standalone: false,
      topical: true,
      equivalent: false,
    });
  });

  test("completion flags track rewrite vs bound trailing stub", () => {
    expect(
      querySemanticFacts({
        prefixCompletion: {
          activePrefix: "learni",
          completedToken: "learning",
          canonicalToken: "learn",
          completedTokens: ["learning"],
          canonicalTokens: ["learn"],
          source: "final-token-prefix",
          ambiguous: false,
        },
      }).completion
    ).toEqual({ vocabularyPrefix: true, boundTrailing: false });

    expect(
      querySemanticFacts({
        prefixCompletion: {
          activePrefix: "lear",
          completedToken: null,
          canonicalToken: null,
          completedTokens: ["learn", "learning"],
          canonicalTokens: ["learn"],
          source: "final-token-prefix",
          ambiguous: true,
        },
      }).completion.vocabularyPrefix
    ).toBe(false);

    expect(
      querySemanticFacts({
        contextualCompletion: {
          activePrefix: "prot",
          completedToken: "protocol",
          canonicalToken: "protocol",
          source: "configured-form-prefix",
        },
      }).completion
    ).toEqual({ vocabularyPrefix: false, boundTrailing: true });
  });
});
