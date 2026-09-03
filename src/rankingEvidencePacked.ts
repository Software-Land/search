/**
 * Column-backed direct ranking views for the PROD-1 fused evidence path.
 *
 * These adapters are not extractFeatures FeatureVectors. They read finalized
 * numeric columns so builtin ranking/selection/hybrid expansion can run without
 * reconstructing a FeatureVector for every retrieved direct.
 */
import {
  RANKING_FINAL_CANONICAL_KEY_TITLE,
  RANKING_FINAL_CONFIGURED_FORM_BODY,
  RANKING_FINAL_CONTEXTUAL,
  RANKING_FINAL_EXACT_TITLE,
  RANKING_FINAL_EXACT_TITLE_OR_SUMMARY_PHRASE,
  RANKING_FINAL_EXACT_TITLE_TOKEN,
  RANKING_FINAL_MORPHOLOGY,
  RANKING_FINAL_TYPED_SURFACE,
} from "./rankingEvidenceState.js";
import type { RankingEvidenceFinalized } from "./rankingEvidenceFinalize.js";
import type {
  DirectClass,
  FeaturedHit,
  FeatureVector,
  RetrievalHit,
} from "./types.js";

const EMPTY_MATCHED_PREFIX_TOKENS: string[] = [];

function fieldEvidenceFromCode(code: number): false | "key" | "form" {
  if (code === 2) return "key";
  if (code === 1) return "form";
  return false;
}

function directClassFromCode(code: number): DirectClass {
  if (code === 3) return "strong";
  if (code === 2) return "moderate";
  if (code === 1) return "weak";
  return "none";
}

function configuredClassValue(
  code: number
): FeatureVector["configuredConceptMatch"] {
  if (code === 2) return "key-in-title";
  if (code === 1) return "form";
  return false;
}

/**
 * Packed column view. Getters are the production ranking adapter; they are not
 * counted as FeatureVector construction.
 */
export class PackedDirectFeatures {
  readonly configuredConceptFieldEvidence: FeatureVector["configuredConceptFieldEvidence"];
  readonly configuredConceptMatch: FeatureVector["configuredConceptMatch"];
  readonly directClass: DirectClass;
  readonly matchingPhraseKey: string | null;
  readonly completedTitleToken: string | null;
  readonly matchedPrefixTokens: string[];
  readonly activeFinalPrefix: string | null;
  readonly normalizedQueryPhrase: string;

  constructor(
    private readonly finalized: RankingEvidenceFinalized,
    private readonly candidate: number
  ) {
    const session = finalized.session;
    const plan = finalized.plan;
    const fieldEvidence = session.finalFieldEvidence[candidate];
    this.configuredConceptFieldEvidence = {
      title: fieldEvidenceFromCode(fieldEvidence & 3),
      summary: fieldEvidenceFromCode((fieldEvidence >> 2) & 3),
      body: fieldEvidenceFromCode((fieldEvidence >> 4) & 3),
    };
    this.configuredConceptMatch = configuredClassValue(
      session.finalConfiguredClass[candidate]
    );
    this.directClass = directClassFromCode(session.finalDirectClass[candidate]);
    const matchingPhraseCode = session.finalMatchingPhrase[candidate];
    this.matchingPhraseKey =
      matchingPhraseCode > 0
        ? plan.facts.feature.phraseKeys[matchingPhraseCode - 1]
        : null;
    const contextualCode = session.finalContextualChoice[candidate];
    const contextual = contextualCode ? plan.contextual : null;
    this.completedTitleToken =
      contextual && contextualCode
        ? contextual.final[contextualCode - 1].aligned
        : null;
    this.matchedPrefixTokens = contextual
      ? [...contextual.matchedPrefixTokens]
      : EMPTY_MATCHED_PREFIX_TOKENS;
    this.activeFinalPrefix = contextual?.activeFinalPrefix || null;
    this.normalizedQueryPhrase = plan.facts.feature.primaryPhrase;
  }

  private get flags() {
    return this.finalized.session.finalFlags[this.candidate];
  }

  get exactTitleMatch() {
    return Boolean(this.flags & RANKING_FINAL_EXACT_TITLE);
  }
  get exactTitleTokenMatch() {
    return Boolean(this.flags & RANKING_FINAL_EXACT_TITLE_TOKEN);
  }
  get typedSurfaceTitleMatch() {
    return Boolean(this.flags & RANKING_FINAL_TYPED_SURFACE);
  }
  get titleCoverage() {
    return this.finalized.session.finalTitleCoverage[this.candidate];
  }
  get queryCoverage() {
    return this.finalized.session.finalQueryCoverage[this.candidate];
  }
  get titlePrefixQuality() {
    return this.finalized.session.finalTitlePrefixQuality[this.candidate];
  }
  get contextualTitlePrefix() {
    return Boolean(this.flags & RANKING_FINAL_CONTEXTUAL);
  }
  get unmatchedTitleTokensAfter() {
    return this.finalized.session.finalUnmatchedTitleTokensAfter[this.candidate];
  }
  get titleSequenceTightness() {
    return this.finalized.session.finalTitleSequenceTightness[this.candidate];
  }
  get contextualPrefixQuality() {
    return this.finalized.session.finalContextualPrefixQuality[this.candidate];
  }
  get morphologyMatch() {
    return Boolean(this.flags & RANKING_FINAL_MORPHOLOGY);
  }
  get typoDistance() {
    return this.finalized.session.finalTypoDistance[this.candidate];
  }
  get versionMatch() {
    return false as const;
  }
  get shortLiteralLeadMatch() {
    return false;
  }
  get dottedSpanComponentTitleMatch() {
    return false;
  }
  get phraseAdjacency() {
    return this.finalized.session.finalPhraseAdjacency[this.candidate];
  }
  get bodyLexicalMatch() {
    return this.finalized.session.finalBodyLexicalMatch[this.candidate];
  }
  get lexicalConceptCoverage() {
    return this.finalized.session.finalLexicalConceptCoverage[this.candidate];
  }
  get coverageConceptCount() {
    return this.finalized.session.finalCoverageConceptCount[this.candidate];
  }
  get ordinaryEquivalenceBodyMatch() {
    return false;
  }
  get titleTokenCount() {
    return this.finalized.session.finalTitleTokenCount[this.candidate];
  }
  get configuredFormEvidence() {
    return this.finalized.session.finalConfiguredFormEvidence[this.candidate];
  }
  get configuredFormCoverage() {
    return this.finalized.session.finalConfiguredFormCoverage[this.candidate];
  }
  get configuredFormBodyMatch() {
    return Boolean(this.flags & RANKING_FINAL_CONFIGURED_FORM_BODY);
  }
  get canonicalKeyTitle() {
    return Boolean(this.flags & RANKING_FINAL_CANONICAL_KEY_TITLE);
  }
  get queryTokenCount() {
    return this.finalized.session.finalQueryTokenCount[this.candidate];
  }
  get bodyPhraseCount() {
    return this.finalized.session.finalBodyPhraseCount[this.candidate];
  }
  get bodyPhraseFrequency() {
    return this.finalized.session.finalBodyPhraseFrequency[this.candidate];
  }
  get titlePhraseFrequency() {
    return this.finalized.session.finalTitlePhraseFrequency[this.candidate];
  }
  get summaryPhraseFrequency() {
    return this.finalized.session.finalSummaryPhraseFrequency[this.candidate];
  }
  get exactTitleOrSummaryPhrase() {
    return Boolean(this.flags & RANKING_FINAL_EXACT_TITLE_OR_SUMMARY_PHRASE);
  }
  get relationshipStrength() {
    return 0;
  }
  get relationshipType() {
    return null;
  }
  get relationshipSourceId() {
    return null;
  }
  get retrievalScore() {
    return this.finalized.session.finalRetrievalScore[this.candidate];
  }
  get relevanceKind() {
    return "direct" as const;
  }
}

export function isPackedDirectFeatures(
  value: unknown
): value is PackedDirectFeatures {
  return value instanceof PackedDirectFeatures;
}

export function createPackedDirectHit(
  hit: RetrievalHit,
  finalized: RankingEvidenceFinalized,
  candidate: number
): FeaturedHit {
  return {
    ...hit,
    features: new PackedDirectFeatures(finalized, candidate) as unknown as FeatureVector,
    score: finalized.session.finalScore[candidate],
  };
}

export function createPackedDirectHits(
  hits: readonly RetrievalHit[],
  finalized: RankingEvidenceFinalized
): FeaturedHit[] {
  const featured: FeaturedHit[] = new Array(hits.length);
  for (let candidate = 0; candidate < hits.length; candidate++) {
    featured[candidate] = createPackedDirectHit(hits[candidate], finalized, candidate);
  }
  return featured;
}
