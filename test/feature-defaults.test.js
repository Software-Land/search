/**
 * Slice 4: canonical FeatureVector empty semantics and packed enum codecs.
 * Does not couple packed and diagnostic evaluators.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import {
  createPackedDirectHits,
  isPackedDirectFeatures,
} from "../dist/rankingEvidencePacked.js";
import { runEvidence, releaseEvidence } from "./helpers/ranking-evidence-prod1.js";
import {
  DEFAULT_CONFIGURED_FIELD_EVIDENCE,
  DEFAULT_FEATURE_VALUES,
  EMPTY_MATCHED_PREFIX_TOKENS,
  createReusableFeatureScalar,
  resetReusableFeatureScalar,
} from "../dist/featureDefaults.js";
import {
  decodeConfiguredConceptMatch,
  decodeConfiguredFieldEvidenceAtom,
  decodeDirectClass,
  encodeConfiguredConceptMatch,
  encodeConfiguredFieldEvidenceAtom,
  encodeDirectClass,
  packConfiguredFieldEvidence,
  unpackConfiguredFieldEvidence,
} from "../dist/rankingEvidenceCodec.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

describe("feature default semantics and packed codecs", () => {
  test("DirectClass codec round-trips all four classes at historical codes", () => {
    expect(encodeDirectClass("none")).toBe(0);
    expect(encodeDirectClass("weak")).toBe(1);
    expect(encodeDirectClass("moderate")).toBe(2);
    expect(encodeDirectClass("strong")).toBe(3);
    for (const value of ["strong", "moderate", "weak", "none"]) {
      expect(decodeDirectClass(encodeDirectClass(value))).toBe(value);
    }
    expect(decodeDirectClass(0)).toBe("none");
    expect(decodeDirectClass(99)).toBe("none");
  });

  test("configured field-evidence codec round-trips false/key/form without changing layout", () => {
    expect(encodeConfiguredFieldEvidenceAtom(false)).toBe(0);
    expect(encodeConfiguredFieldEvidenceAtom("form")).toBe(1);
    expect(encodeConfiguredFieldEvidenceAtom("key")).toBe(2);
    expect(decodeConfiguredFieldEvidenceAtom(0)).toBe(false);
    expect(decodeConfiguredFieldEvidenceAtom(99)).toBe(false);
    const atoms = [false, "key", "form"];
    for (const title of atoms) {
      for (const summary of atoms) {
        for (const body of atoms) {
          const evidence = { title, summary, body };
          const packed = packConfiguredFieldEvidence(evidence);
          expect(unpackConfiguredFieldEvidence(packed)).toEqual(evidence);
        }
      }
    }
    expect(
      packConfiguredFieldEvidence({ title: "key", summary: "form", body: "key" })
    ).toBe(2 | (1 << 2) | (2 << 4));
    expect(unpackConfiguredFieldEvidence(0)).toEqual(DEFAULT_CONFIGURED_FIELD_EVIDENCE);
  });

  test("configuredConceptMatch codec keeps key-in-title distinct from field-evidence key", () => {
    expect(encodeConfiguredConceptMatch(false)).toBe(0);
    expect(encodeConfiguredConceptMatch("form")).toBe(1);
    expect(encodeConfiguredConceptMatch("key-in-title")).toBe(2);
    expect(decodeConfiguredConceptMatch(2)).toBe("key-in-title");
    expect(decodeConfiguredConceptMatch(99)).toBe(false);
  });

  test("reusable scalar reset restores canonical empty semantics without sharing nested evidence", () => {
    const scalar = createReusableFeatureScalar();
    const evidence = scalar.configuredConceptFieldEvidence;
    expect(scalar.directClass).toBe(DEFAULT_FEATURE_VALUES.directClass);
    expect(scalar.relevanceKind).toBe(DEFAULT_FEATURE_VALUES.relevanceKind);
    expect(scalar.matchedPrefixTokens).toEqual([]);
    expect(scalar.matchedPrefixTokens).not.toBe(EMPTY_MATCHED_PREFIX_TOKENS);

    scalar.exactTitleMatch = true;
    scalar.exactTitleTokenMatch = true;
    scalar.typedSurfaceTitleMatch = true;
    scalar.titleCoverage = 1;
    scalar.queryCoverage = 0.8;
    scalar.titlePrefixQuality = 0.7;
    scalar.contextualTitlePrefix = true;
    scalar.matchedPrefixTokens = ["open"];
    scalar.activeFinalPrefix = "interfa";
    scalar.completedTitleToken = "interface";
    scalar.unmatchedTitleTokensAfter = 2;
    scalar.titleSequenceTightness = 0.5;
    scalar.contextualPrefixQuality = 0.4;
    scalar.configuredConceptMatch = "key-in-title";
    evidence.title = "key";
    evidence.summary = "form";
    evidence.body = "key";
    scalar.morphologyMatch = true;
    scalar.typoDistance = 2;
    scalar.versionMatch = "dotted";
    scalar.shortLiteralLeadMatch = true;
    scalar.dottedSpanComponentTitleMatch = true;
    scalar.phraseAdjacency = 1;
    scalar.bodyLexicalMatch = 1;
    scalar.lexicalConceptCoverage = 1;
    scalar.coverageConceptCount = 3;
    scalar.ordinaryEquivalenceBodyMatch = true;
    scalar.titleTokenCount = 4;
    scalar.configuredFormEvidence = 1;
    scalar.configuredFormCoverage = 0.75;
    scalar.configuredFormBodyMatch = true;
    scalar.canonicalKeyTitle = true;
    scalar.queryTokenCount = 2;
    scalar.normalizedQueryPhrase = "open interface";
    scalar.matchingPhraseKey = "open interface";
    scalar.bodyPhraseCount = 5;
    scalar.bodyPhraseFrequency = 0.9;
    scalar.titlePhraseFrequency = 1;
    scalar.summaryPhraseFrequency = 1;
    scalar.exactTitleOrSummaryPhrase = true;
    scalar.relationshipStrength = 0.8;
    scalar.relationshipType = "related";
    scalar.relationshipSourceId = "src";
    scalar.retrievalScore = 3;
    scalar.configuredPrefixRecallScore = 0.5;
    scalar.relevanceKind = "related";
    scalar.directClass = "strong";

    resetReusableFeatureScalar(scalar);

    expect(scalar.exactTitleMatch).toBe(DEFAULT_FEATURE_VALUES.exactTitleMatch);
    expect(scalar.exactTitleTokenMatch).toBe(DEFAULT_FEATURE_VALUES.exactTitleTokenMatch);
    expect(scalar.typedSurfaceTitleMatch).toBe(DEFAULT_FEATURE_VALUES.typedSurfaceTitleMatch);
    expect(scalar.titleCoverage).toBe(DEFAULT_FEATURE_VALUES.titleCoverage);
    expect(scalar.queryCoverage).toBe(DEFAULT_FEATURE_VALUES.queryCoverage);
    expect(scalar.titlePrefixQuality).toBe(DEFAULT_FEATURE_VALUES.titlePrefixQuality);
    expect(scalar.contextualTitlePrefix).toBe(DEFAULT_FEATURE_VALUES.contextualTitlePrefix);
    expect(scalar.matchedPrefixTokens).toBe(EMPTY_MATCHED_PREFIX_TOKENS);
    expect(scalar.activeFinalPrefix).toBe(DEFAULT_FEATURE_VALUES.activeFinalPrefix);
    expect(scalar.completedTitleToken).toBe(DEFAULT_FEATURE_VALUES.completedTitleToken);
    expect(scalar.unmatchedTitleTokensAfter).toBe(DEFAULT_FEATURE_VALUES.unmatchedTitleTokensAfter);
    expect(scalar.titleSequenceTightness).toBe(DEFAULT_FEATURE_VALUES.titleSequenceTightness);
    expect(scalar.contextualPrefixQuality).toBe(DEFAULT_FEATURE_VALUES.contextualPrefixQuality);
    expect(scalar.configuredConceptMatch).toBe(DEFAULT_FEATURE_VALUES.configuredConceptMatch);
    expect(scalar.configuredConceptFieldEvidence).toBe(evidence);
    expect(evidence).toEqual(DEFAULT_CONFIGURED_FIELD_EVIDENCE);
    expect(scalar.morphologyMatch).toBe(DEFAULT_FEATURE_VALUES.morphologyMatch);
    expect(scalar.typoDistance).toBe(DEFAULT_FEATURE_VALUES.typoDistance);
    expect(scalar.versionMatch).toBe(DEFAULT_FEATURE_VALUES.versionMatch);
    expect(scalar.shortLiteralLeadMatch).toBe(DEFAULT_FEATURE_VALUES.shortLiteralLeadMatch);
    expect(scalar.dottedSpanComponentTitleMatch).toBe(DEFAULT_FEATURE_VALUES.dottedSpanComponentTitleMatch);
    expect(scalar.phraseAdjacency).toBe(DEFAULT_FEATURE_VALUES.phraseAdjacency);
    expect(scalar.bodyLexicalMatch).toBe(DEFAULT_FEATURE_VALUES.bodyLexicalMatch);
    expect(scalar.lexicalConceptCoverage).toBe(DEFAULT_FEATURE_VALUES.lexicalConceptCoverage);
    expect(scalar.coverageConceptCount).toBe(DEFAULT_FEATURE_VALUES.coverageConceptCount);
    expect(scalar.ordinaryEquivalenceBodyMatch).toBe(DEFAULT_FEATURE_VALUES.ordinaryEquivalenceBodyMatch);
    expect(scalar.titleTokenCount).toBe(DEFAULT_FEATURE_VALUES.titleTokenCount);
    expect(scalar.configuredFormEvidence).toBe(DEFAULT_FEATURE_VALUES.configuredFormEvidence);
    expect(scalar.configuredFormCoverage).toBe(DEFAULT_FEATURE_VALUES.configuredFormCoverage);
    expect(scalar.configuredFormBodyMatch).toBe(DEFAULT_FEATURE_VALUES.configuredFormBodyMatch);
    expect(scalar.canonicalKeyTitle).toBe(DEFAULT_FEATURE_VALUES.canonicalKeyTitle);
    expect(scalar.queryTokenCount).toBe(DEFAULT_FEATURE_VALUES.queryTokenCount);
    expect(scalar.normalizedQueryPhrase).toBe(DEFAULT_FEATURE_VALUES.normalizedQueryPhrase);
    expect(scalar.matchingPhraseKey).toBe(DEFAULT_FEATURE_VALUES.matchingPhraseKey);
    expect(scalar.bodyPhraseCount).toBe(DEFAULT_FEATURE_VALUES.bodyPhraseCount);
    expect(scalar.bodyPhraseFrequency).toBe(DEFAULT_FEATURE_VALUES.bodyPhraseFrequency);
    expect(scalar.titlePhraseFrequency).toBe(DEFAULT_FEATURE_VALUES.titlePhraseFrequency);
    expect(scalar.summaryPhraseFrequency).toBe(DEFAULT_FEATURE_VALUES.summaryPhraseFrequency);
    expect(scalar.exactTitleOrSummaryPhrase).toBe(DEFAULT_FEATURE_VALUES.exactTitleOrSummaryPhrase);
    expect(scalar.relationshipStrength).toBe(DEFAULT_FEATURE_VALUES.relationshipStrength);
    expect(scalar.relationshipType).toBe(DEFAULT_FEATURE_VALUES.relationshipType);
    expect(scalar.relationshipSourceId).toBe(DEFAULT_FEATURE_VALUES.relationshipSourceId);
    expect(scalar.retrievalScore).toBe(DEFAULT_FEATURE_VALUES.retrievalScore);
    expect(scalar.configuredPrefixRecallScore).toBe(DEFAULT_FEATURE_VALUES.configuredPrefixRecallScore);
    expect(scalar.relevanceKind).toBe(DEFAULT_FEATURE_VALUES.relevanceKind);
    expect(scalar.directClass).toBe(DEFAULT_FEATURE_VALUES.directClass);
    expect(Object.prototype.hasOwnProperty.call(scalar, "standaloneRecallMatch")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(scalar, "topicalRecallMatch")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(scalar, "equivalentRecallMatch")).toBe(false);
  });

  test("packed candidate N+1 does not inherit candidate N features; ineligible classes stay empty", async () => {
    const docs = [
      { id: "strong", title: "Open Interface", body: "open interface notes" },
      { id: "weak", title: "Garden Notes", body: "open interface mentioned once" },
    ];
    const plugins = [morphology()];
    const lexicalIndex = compileLexicalIndex(docs, { schema, plugins });
    const engine = SearchEngine.create({
      schema,
      plugins,
      lexicalIndex,
      retriever: "indexed",
      relationshipStrategy: "none",
    });
    await engine.index(docs);
    const run = runEvidence(engine, "open interface");
    try {
      expect(run.eligible).toBe(true);
      const packedHits = createPackedDirectHits(run.hits, run.finalized);
      const strong = packedHits.find((hit) => hit.document.id === "strong");
      const weak = packedHits.find((hit) => hit.document.id === "weak");
      expect(isPackedDirectFeatures(strong.features)).toBe(true);
      expect(isPackedDirectFeatures(weak.features)).toBe(true);
      expect(strong.features.directClass).toBe("strong");
      expect(strong.features.exactTitleMatch).toBe(true);
      expect(weak.features.exactTitleMatch).toBe(false);
      expect(weak.features.canonicalKeyTitle).toBe(false);
      expect(weak.features.directClass).not.toBe("strong");
      for (const hit of [strong, weak]) {
        expect(hit.features.versionMatch).toBe(false);
        expect(hit.features.shortLiteralLeadMatch).toBe(false);
        expect(hit.features.dottedSpanComponentTitleMatch).toBe(false);
        expect(hit.features.ordinaryEquivalenceBodyMatch).toBe(false);
        expect(hit.features.relationshipStrength).toBe(0);
        expect(hit.features.relationshipType).toBe(null);
        expect(hit.features.relationshipSourceId).toBe(null);
        expect(hit.features.configuredPrefixRecallScore).toBe(0);
        expect(hit.features.relevanceKind).toBe("direct");
      }
    } finally {
      releaseEvidence(run);
    }
    const publicRows = engine.search("open interface", { limit: 10, relatedLimit: 0 });
    expect(engine.lastSearchMeta.rankingEvidence).toBe("packed");
    expect(publicRows.find((row) => row.id === "strong").directClass).toBe("strong");
    expect(publicRows.find((row) => row.id === "weak").directClass).not.toBe("strong");
  });
});
