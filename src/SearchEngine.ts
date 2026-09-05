import { analyzeQuery, exactExplicitQueryIntentKeys, suggestTypoForms } from "./query/analyze.js";
import { buildIndex, resolveSchema } from "./indexing/indexDocuments.js";
import {
  compactIndexFromAnalyzed,
  exactPruningRuntime,
  lexicalAnalyzerIdentity,
  lexicalCorpusFingerprint,
  lexicalHydrationFingerprint,
  loadLexicalIndex,
} from "./indexing/lexicalIndex.js";
import { extractFeatures } from "./features.js";
import { retrievalSourcesForDocument } from "./retrieval/retrieve.js";
import { buildQueryPlan } from "./query/queryPlan.js";
import {
  applyCompleteInterpretationCollector,
  COMPLETE_INTERPRETATION_COLLECTOR,
} from "./completeInterpretationCollector.js";
import { searchSessionCapabilities } from "./executionSession.js";
import {
  exhaustiveFeaturePruningStats,
  featureBlockPruningFallbackReason,
  planExactFeaturePruning,
} from "./exactPruning.js";
import {
  rankCandidates,
  rankCandidatesAsync,
  scoreFeatures,
  selectTopPerBuiltinSignature,
} from "./rank.js";
import { compileRankingEvidencePlan } from "./rankingEvidencePlan.js";
import { RankingEvidenceSessionPool, rankingEvidenceStaticFor } from "./rankingEvidenceState.js";
import { finalizeRankingEvidence } from "./rankingEvidenceFinalize.js";
import { createPackedDirectHits, isPackedDirectFeatures } from "./rankingEvidencePacked.js";
import { packedSearchFallbackReason } from "./rankingEvidenceSearch.js";
import { assembleDetailedResult, withPackedSearchMeta } from "./resultAssembly.js";
import {
  hasRankingEvidenceRetrieverCapability,
  retrieveWithRankingEvidence,
  retrieveWithRankingEvidenceAsync,
} from "./retrieval/retrievers.js";
import { constraintsForStrategy } from "./constraints.js";
import { morphology } from "./morphology.js";
import { compileConfiguredConceptPlugin } from "./configuredConcepts.js";
import { bindMorphologyDerivedEquivalences } from "./query/synonyms.js";
import {
  RelationshipGraph,
  applyRelationshipExpansion,
  pickPrimariesForExpansion,
} from "./relationships.js";
import { throwIfAborted } from "./cancel.js";
import {
  RELATIONSHIP_STRATEGIES,
  DEFAULT_RELATIONSHIP_STRATEGY,
  validateCreateOptions,
  requireStrategy,
  requireIndexed,
} from "./config.js";
import { ArtifactValidationError, InvalidDocumentError } from "./errors.js";
import type {
  AdaptiveOptions,
  AnalyzedQuery,
  FeaturedHit,
  FinishTimings,
  IndexedDocument,
  QueryAlternative,
  QueryConcept,
  RankedHit,
  RelationshipArtifact,
  RelationshipGraphApi,
  RetrievalHit,
  RetrieveOptions,
  Schema,
  SearchDocument,
  SearchEngineOptions,
  SearchIndex,
  LexicalIndexArtifact,
  SearchOptions,
  SearchPlugin,
  SourcePolicy,
} from "./types.js";

export { RELATIONSHIP_STRATEGIES, DEFAULT_RELATIONSHIP_STRATEGY };

function packedFeatureStats(evaluated: number) {
  return {
    mode: "exhaustive" as const,
    documentBlocksVisited: 0,
    documentBlocksSkipped: 0,
    boundedBlocksSkipped: 0,
    postingBlocksVisited: 0,
    postingBlocksSkipped: 0,
    postingEntriesSkipped: 0,
    documentsFullyEvaluated: evaluated,
    documentsBoundRejected: 0,
    signaturesEncountered: 0,
    representativesRetained: 0,
    pruningFallbackReason: null,
  };
}

function missingPhraseFeatured(query: AnalyzedQuery, doc: IndexedDocument): FeaturedHit {
  const retrievalSources = retrievalSourcesForDocument(query, doc);
  return {
    document: doc,
    retrievalSources,
    features: extractFeatures(query, doc, { relationship: null, retrievalScore: 0, retrievalSources }),
  };
}

/** Executed PhraseQuery / PhrasePrefix hits are ranking candidates. Not result-set collapse. */
function unionExecutedClauseHits(
  featured: FeaturedHit[],
  plan: { exactHits: Array<{ document: IndexedDocument }>; prefixHits: Array<{ document: IndexedDocument }> },
  query: AnalyzedQuery
): FeaturedHit[] {
  const seen = new Set(featured.map((hit) => hit.document.id));
  const extra: FeaturedHit[] = [];
  for (const hit of [...plan.exactHits, ...plan.prefixHits]) {
    if (seen.has(hit.document.id)) continue;
    seen.add(hit.document.id);
    extra.push(missingPhraseFeatured(query, hit.document));
  }
  return extra.length ? featured.concat(extra) : featured;
}

type TypoCompanionConcept = QueryConcept & {
  distance: number;
};

type RuntimeRetriever = {
  name?: string;
  exactSignatureSelection?: boolean;
  retrieve: (query: AnalyzedQuery, index: SearchIndex, options?: RetrieveOptions) => RetrievalHit[];
  retrieveAsync?: (
    query: AnalyzedQuery,
    index: SearchIndex,
    options?: RetrieveOptions
  ) => Promise<RetrievalHit[]>;
  prepare?: (index: SearchIndex, extra?: { schema?: Schema; plugins?: SearchPlugin[] }) => void;
  stats?: () => Record<string, unknown>;
};

function typoVocabulary(index: SearchIndex, plugins: SearchPlugin[]) {
  const set = new Set(index.titleTokenSet || []);
  for (const plugin of plugins) {
    if (typeof plugin.lexicon === "function") {
      for (const w of plugin.lexicon()) {
        if (typeof w === "string" && w.length >= 5) set.add(w);
      }
    }
    if (typeof plugin.lemmaTableKeys === "function") {
      for (const w of plugin.lemmaTableKeys()) {
        if (typeof w === "string" && w.length >= 5) set.add(w);
      }
    }
  }
  return set;
}

function isPrefixOfVocabulary(token: string, vocabulary: Set<string>) {
  const t = String(token || "");
  if (t.length < 4) return false;
  for (const w of vocabulary) {
    if (typeof w === "string" && w.length > t.length && w.startsWith(t)) return true;
  }
  return false;
}

function attachTypoAlternatives(
  query: AnalyzedQuery,
  vocabulary: Set<string>,
  explicitQueryIntentKeys: Set<string>,
  { signal }: { signal?: AbortSignal } = {}
) {
  const extra: TypoCompanionConcept[] = [];
  const alternatives: QueryAlternative[] = [...(query.alternatives || [])];
  for (const tok of query.tokens) {
    if (!tok) continue;
    if (tok.completedToken || (tok.sources || []).includes("final-token-prefix")) continue;
    const exactExplicitIntent = explicitQueryIntentKeys.has(tok.surface);
    if (vocabulary.has(tok.normalized) || isPrefixOfVocabulary(tok.normalized, vocabulary)) continue;
    const suggestions = suggestTypoForms(tok.normalized, vocabulary, { signal });
    for (const s of suggestions) {
      if (s.form === tok.normalized) continue;
      if (exactExplicitIntent && explicitQueryIntentKeys.has(s.form)) continue;
      extra.push({
        id: s.form,
        kind: "term",
        forms: [s.form],
        provenance: s.provenance,
        distance: s.distance,
      });
      alternatives.push({
        tokens: [s.form],
        source: s.provenance === "edit-distance" ? "typo-correction" : s.provenance,
        confidence: s.distance <= 1 ? 0.85 : 0.6,
      });
    }
  }
  if (!extra.length) return { ...query, alternatives };
  return { ...query, concepts: [...query.concepts, ...extra], alternatives };
}

function resolveGraph(
  relationships: RelationshipArtifact | RelationshipGraphApi | null | undefined
): RelationshipGraphApi {
  if (!relationships) return RelationshipGraph(null);
  if (typeof relationships === "object" && "neighbors" in relationships && typeof relationships.neighbors === "function") {
    return relationships;
  }
  return RelationshipGraph(relationships);
}

function representativeDepthForOutput(
  ranked: RankedHit[],
  strategy: string,
  {
    limit,
    relatedLimit,
    explain,
  }: { limit: number; relatedLimit: number; explain: boolean }
) {
  const primaryTarget = Math.max(0, limit);
  const relatedTarget = Math.max(0, relatedLimit);
  let primarySeen = 0;
  let relatedSeen = 0;
  const requiredIndexes = new Set<number>();
  for (let i = 0; i < ranked.length; i++) {
    const related = ranked[i].features.relevanceKind === "related";
    const primaryEligible = strategy === "separate" || strategy === "none" ? !related : true;
    if (primaryEligible && primarySeen < primaryTarget) {
      primarySeen += 1;
      requiredIndexes.add(i);
    }
    if (related && relatedSeen < relatedTarget) {
      relatedSeen += 1;
      requiredIndexes.add(i);
    }
    if (primarySeen >= primaryTarget && relatedSeen >= relatedTarget) break;
  }
  if (explain) {
    for (const i of [...requiredIndexes]) {
      if (i + 1 < ranked.length) requiredIndexes.add(i + 1);
    }
  }
  if (requiredIndexes.size === 0) return 0;

  // Public rows expose absolute global rank, and explain mode exposes the
  // immediate global successor. Preserving those values requires the global
  // prefix through the deepest required row. Applying the proven top-R
  // theorem with that exact global depth is the smallest generally valid
  // uniform per-signature requirement; a smaller corpus-specific bucket
  // occupancy could unlock a dominated signature too early.
  const lastRequired = Math.max(...requiredIndexes);
  return lastRequired + 1;
}

export class SearchEngine {
  declare schema: Schema;
  declare plugins: SearchPlugin[];
  declare relationships: RelationshipGraphApi;
  declare lexicalIndex: LexicalIndexArtifact | null;
  declare loadedLexicalIndex: {
    fingerprint: string;
    hydrationFingerprint: string;
    analyzer: string;
    schema: [string, string];
  } | null;
  declare relationshipStrategy: string;
  declare retriever: RuntimeRetriever;
  declare candidateLimit: number | null;
  declare adaptive: AdaptiveOptions;
  declare retrievalScoreWeight: number;
  declare _index: SearchIndex | null;
  declare indexBuildMs: number;
  declare lastSearchMeta: Record<string, unknown> | null;
  declare _rankingEvidencePool: RankingEvidenceSessionPool;

  constructor(options: SearchEngineOptions = {}) {
    const cfg = validateCreateOptions(options);
    this.schema = cfg.schema;
    this.plugins = bindMorphologyDerivedEquivalences(cfg.plugins);
    this.lexicalIndex = cfg.lexicalIndex;
    this.loadedLexicalIndex = null;
    this.relationships = resolveGraph(cfg.relationships);
    this.relationshipStrategy = cfg.relationshipStrategy;
    this.retriever = cfg.retriever;
    this.candidateLimit = cfg.candidateLimit;
    this.adaptive = cfg.adaptive;
    this.retrievalScoreWeight = cfg.retrievalScoreWeight;
    this._index = null;
    this.indexBuildMs = 0;
    this.lastSearchMeta = null;
    this._rankingEvidencePool = new RankingEvidenceSessionPool();
  }

  static create(options?: SearchEngineOptions) {
    return new SearchEngine(options);
  }

  async index(documents: SearchDocument[] | null | undefined) {
    if (documents != null && !Array.isArray(documents)) {
      throw new InvalidDocumentError("index(documents) requires an array", { field: "documents" });
    }
    const t0 = performance.now();
    if (!this.lexicalIndex && this.loadedLexicalIndex && this._index) {
      const resolved = resolveSchema(this.schema);
      const analyzer = lexicalAnalyzerIdentity(this.plugins, { requireIdentified: true });
      const fingerprint = lexicalCorpusFingerprint(documents || [], this.schema);
      const hydrationFingerprint = lexicalHydrationFingerprint(documents || [], this.schema);
      if (
        analyzer !== this.loadedLexicalIndex.analyzer ||
        resolved.titleField !== this.loadedLexicalIndex.schema[0] ||
        resolved.bodyField !== this.loadedLexicalIndex.schema[1] ||
        fingerprint !== this.loadedLexicalIndex.fingerprint ||
        hydrationFingerprint !== this.loadedLexicalIndex.hydrationFingerprint
      ) {
        throw new ArtifactValidationError(
          "Re-index input is incompatible with the consumed lexical index",
          {
            format: "search-v2-lexical-index",
            field:
              fingerprint === this.loadedLexicalIndex.fingerprint &&
              hydrationFingerprint !== this.loadedLexicalIndex.hydrationFingerprint
                ? "hydration.fingerprint"
                : "corpus.fingerprint",
          }
        );
      }
      this.indexBuildMs = performance.now() - t0;
      return { documentCount: this._index.documents.length, buildMs: this.indexBuildMs };
    }
    const suppliedLexicalIndex = this.lexicalIndex;
    this._index = suppliedLexicalIndex
      ? loadLexicalIndex(suppliedLexicalIndex, documents || [], this.schema, this.plugins)
      : this.retriever?.name === "full-scan"
        ? buildIndex(documents, this.schema, this.plugins)
        : compactIndexFromAnalyzed(
            buildIndex(documents, this.schema, this.plugins),
            lexicalAnalyzerIdentity(this.plugins)
          );
    this._rankingEvidencePool.reset();
    if (this.retriever && typeof this.retriever.prepare === "function") {
      this.retriever.prepare(this._index, { schema: this.schema, plugins: this.plugins });
    }
    // Runtime terms retain only the positional arrays they need. Drop the
    // validated envelope/document tuples so Worker initialization does not
    // permanently keep both serialized and hydrated representations.
    if (suppliedLexicalIndex) {
      this.loadedLexicalIndex = {
        fingerprint: suppliedLexicalIndex.corpus.fingerprint,
        hydrationFingerprint: lexicalHydrationFingerprint(documents || [], this.schema),
        analyzer: suppliedLexicalIndex.compatibility.analyzer,
        schema: [...suppliedLexicalIndex.compatibility.schema],
      };
      this.lexicalIndex = null;
    }
    this.indexBuildMs = performance.now() - t0;
    return { documentCount: this._index.documents.length, buildMs: this.indexBuildMs };
  }

  /**
   * Default OSS API: returns an array. Same ranking as searchDetailed().results.
   */
  search(rawQuery: unknown, opts: SearchOptions = {}) {
    return this._searchDetailedSync(rawQuery, opts, false).results;
  }

  /**
   * Richer API for UIs and debugging. `results` uses the same strategy as search().
   * `related` is always the relationship-derived channel (empty when strategy is none
   * or no graph is configured).
   */
  searchDetailed(rawQuery: unknown, opts: SearchOptions = {}) {
    return this._searchDetailedSync(rawQuery, opts, true);
  }

  async searchAsync(rawQuery: unknown, opts: SearchOptions = {}) {
    return (await this._searchDetailedAsync(rawQuery, opts, false)).results;
  }

  async searchDetailedAsync(rawQuery: unknown, opts: SearchOptions = {}) {
    return this._searchDetailedAsync(rawQuery, opts, true);
  }

  _prepareQuery(rawQuery: unknown, { signal }: { signal?: AbortSignal } = {}) {
    throwIfAborted(signal);
    const index = requireIndexed(this);
    const explicitQueryIntentKeys = exactExplicitQueryIntentKeys(this.plugins);
    let query = analyzeQuery(rawQuery, {
      plugins: this.plugins,
      lexicon: index.titleTokenSet,
      prefixLexicon: index.surfaceVocabulary || index.titleTokenSet,
      signal,
    });
    query = attachTypoAlternatives(query, typoVocabulary(index, this.plugins), explicitQueryIntentKeys, { signal });
    return query;
  }

  _expandAndFeature(
    retrieved: RetrievalHit[],
    query: AnalyzedQuery,
    strategy: string,
    {
      signal,
      sourcePolicy,
      exactDiagnostics = true,
      pruningMode = "auto",
      requiredDepth = 0,
    }: {
      signal?: AbortSignal;
      sourcePolicy?: SourcePolicy;
      exactDiagnostics?: boolean;
      pruningMode?: "auto" | "exhaustive";
      requiredDepth?: number;
    } = {}
  ) {
    throwIfAborted(signal);
    const weight = this.retrievalScoreWeight;
    let maxRet = 0;
    if (weight) {
      for (const hit of retrieved) maxRet = Math.max(maxRet, hit.retrievalScore || 0);
    }
    const retrievalScoreOf = (hit: RetrievalHit) => (weight && maxRet ? weight * ((hit.retrievalScore || 0) / maxRet) : 0);
    const tFeat = performance.now();
    let featureVectorsConstructed = 0;
    const featureHits = (hits: RetrievalHit[]) =>
      hits.map((hit, i) => {
        if (i % 8 === 0) throwIfAborted(signal);
        featureVectorsConstructed += 1;
        return {
          ...hit,
          features: extractFeatures(query, hit.document, {
            relationship: hit.relationship || null,
            retrievalScore: retrievalScoreOf(hit),
            retrievalSources: hit.retrievalSources,
          }),
        };
      });
    const mergeFeatured = (...groups: FeaturedHit[][]) => {
      const byId = new Map<string, FeaturedHit>();
      for (const group of groups) {
        for (const hit of group) byId.set(hit.document.id, hit);
      }
      return retrieved
        .map((hit) => byId.get(hit.document.id))
        .filter((hit): hit is FeaturedHit => Boolean(hit));
    };
    const index = requireIndexed(this);
    let pruningStats = exhaustiveFeaturePruningStats(retrieved.length, "disabled");
    let featured: FeaturedHit[];
    const compiledRuntime = exactPruningRuntime(index);
    const retrieverKind = this.retriever.stats?.().kind;
    const fallbackReason = featureBlockPruningFallbackReason({
      session: searchSessionCapabilities({
        exactDiagnostics,
        pruningMode,
        retrievalScoreWeight: weight,
        sourcePolicy,
        rankingEvidenceRetriever: hasRankingEvidenceRetrieverCapability(
          this.retriever as import("./types.js").Retriever
        ),
      }),
      compiledIndexedRetriever:
        Boolean(this.retriever.exactSignatureSelection) && retrieverKind === "compiled-indexed",
      hasExactPruningRuntime: Boolean(compiledRuntime),
      relationshipStrategy: strategy,
    });

    if (fallbackReason || !compiledRuntime) {
      featured = featureHits(retrieved);
      pruningStats = exhaustiveFeaturePruningStats(
        retrieved.length,
        fallbackReason || "missing-pruning-extension"
      );
    } else {
      const plan = planExactFeaturePruning({
        retrieved,
        query,
        requiredDepth,
        extension: compiledRuntime.extension,
      });
      if (!plan.bounded.length) {
        featured = featureHits(retrieved);
        pruningStats = exhaustiveFeaturePruningStats(
          retrieved.length,
          plan.stats.pruningFallbackReason || "no-provable-candidates"
        );
      } else {
        const unboundedFeatured = featureHits(plan.unbounded);
        const constraints = constraintsForStrategy(strategy);
        const primaries =
          strategy === "none"
            ? []
            : pickPrimariesForExpansion(unboundedFeatured, {
                sourcePolicy,
                constraints,
                signal,
              });
        const activeRelationships = primaries.some((primary) =>
          this.relationships.has(primary.document.id)
        );
        if (activeRelationships) {
          const boundedFeatured = featureHits(plan.bounded.map((candidate) => candidate.hit));
          featured = mergeFeatured(unboundedFeatured, boundedFeatured);
          pruningStats = exhaustiveFeaturePruningStats(
            retrieved.length,
            "active-relationships"
          );
        } else {
          const retainedFeatured = featureHits(plan.retainedBounded);
          featured = mergeFeatured(unboundedFeatured, retainedFeatured);
          pruningStats = plan.stats;
        }
      }
    }
    const featureMs = performance.now() - tFeat;

    if (strategy === "none") {
      return {
        featured,
        applied: { featured, relatedHits: [], primaries: [] },
        featureMs,
        relationshipMs: 0,
        pruningStats,
        featureVectorsConstructed,
      };
    }

    throwIfAborted(signal);
    const tRel = performance.now();
    const applied = applyRelationshipExpansion({
      featured,
      query,
      extractFeatures,
      scoreFeatures,
      index,
      graph: this.relationships,
      sourcePolicy,
      signal,
      constraints: constraintsForStrategy(strategy),
    });
    featured = applied.featured;
    for (const hit of applied.relatedHits) {
      throwIfAborted(signal);
      const features = extractFeatures(query, hit.document, {
        relationship: hit.relationship,
        retrievalSources: hit.retrievalSources,
      });
      featured.push({
        ...hit,
        features,
        score: scoreFeatures(features),
      });
    }
    const relationshipMs = performance.now() - tRel;
    return { featured, applied, featureMs, relationshipMs, pruningStats, featureVectorsConstructed };
  }

  _expandPacked(
    packedDirects: FeaturedHit[],
    query: AnalyzedQuery,
    strategy: string,
    {
      signal,
      sourcePolicy,
    }: {
      signal?: AbortSignal;
      sourcePolicy?: SourcePolicy;
    } = {}
  ) {
    throwIfAborted(signal);
    const tFeat = performance.now();
    let directFeatureVectorsConstructed = 0;
    let relationshipOnlyFeatureVectorsConstructed = 0;
    let featured = packedDirects;
    const featureMs = performance.now() - tFeat;
    if (strategy === "none") {
      return {
        featured,
        applied: { featured, relatedHits: [], primaries: [] },
        featureMs,
        relationshipMs: 0,
        directFeatureVectorsConstructed,
        relationshipOnlyFeatureVectorsConstructed,
      };
    }

    throwIfAborted(signal);
    const tRel = performance.now();
    const extractDirectOverlay: import("./types.js").ExtractFeaturesFn = (
      overlayQuery,
      document,
      extra
    ) => {
      directFeatureVectorsConstructed += 1;
      return extractFeatures(overlayQuery, document, extra);
    };
    const applied = applyRelationshipExpansion({
      featured,
      query,
      extractFeatures: extractDirectOverlay,
      scoreFeatures,
      index: requireIndexed(this),
      graph: this.relationships,
      sourcePolicy,
      signal,
      constraints: constraintsForStrategy(strategy),
    });
    featured = applied.featured;
    for (const hit of applied.relatedHits) {
      throwIfAborted(signal);
      relationshipOnlyFeatureVectorsConstructed += 1;
      const features = extractFeatures(query, hit.document, {
        relationship: hit.relationship,
        retrievalSources: hit.retrievalSources,
      });
      featured.push({
        ...hit,
        features,
        score: scoreFeatures(features),
      });
    }
    const relationshipMs = performance.now() - tRel;
    return {
      featured,
      applied,
      featureMs,
      relationshipMs,
      directFeatureVectorsConstructed,
      relationshipOnlyFeatureVectorsConstructed,
    };
  }

  _finishPacked(
    ranked: RankedHit[],
    query: AnalyzedQuery,
    strategy: string,
    timings: FinishTimings & {
      rankingEvidenceFallbackReason?: string | null;
      optimizedDirectCandidates?: number;
      directFeatureVectorsConstructed?: number;
      relationshipOnlyFeatureVectorsConstructed?: number;
    }
  ) {
    const finished = this._finish(ranked, query, false, strategy, timings);
    const meta = withPackedSearchMeta(finished.meta as Record<string, unknown>, timings);
    this.lastSearchMeta = meta;
    return finished;
  }

  _rankPackedFeatured(
    featured: FeaturedHit[],
    query: AnalyzedQuery,
    plan: ReturnType<typeof buildQueryPlan>,
    strategy: string,
    {
      signal,
      limit,
      relatedLimit,
    }: {
      signal?: AbortSignal;
      limit: number;
      relatedLimit: number;
    }
  ) {
    const seen = new Set(featured.map((hit) => hit.document.id));
    let extraDirectFeatureVectors = 0;
    for (const hit of [...plan.exactHits, ...plan.prefixHits]) {
      if (seen.has(hit.document.id)) continue;
      seen.add(hit.document.id);
      extraDirectFeatureVectors += 1;
      featured.push(missingPhraseFeatured(query, hit.document));
    }

    const constraints = constraintsForStrategy(strategy);
    let representativeStats: Record<string, unknown> | null = null;
    const fullRelatedCount = featured.filter((hit) => hit.features.relevanceKind === "related").length;
    const tSelect = performance.now();
    const publicDepth = Math.max(0, limit, relatedLimit);
    if (this.retriever.exactSignatureSelection) {
      let representativeDepth = publicDepth;
      const hasRelated = fullRelatedCount > 0;
      if (publicDepth > 0 && ((relatedLimit > 0 && hasRelated) || (strategy === "separate" && limit > 0 && hasRelated))) {
        const planningRanked = rankCandidates(featured, { constraints, signal });
        representativeDepth = Math.max(
          representativeDepth,
          representativeDepthForOutput(planningRanked, strategy, { limit, relatedLimit, explain: false })
        );
      }
      const selected = selectTopPerBuiltinSignature(featured, representativeDepth, constraints);
      featured = selected.candidates;
      representativeStats = {
        ...selected.stats,
        outputDepth: representativeDepth,
        plannedFullRanking: false,
      };
    }
    const selectionMs = performance.now() - tSelect;
    const tRank = performance.now();
    const ranked = rankCandidates(featured, { constraints, signal });
    const rankMs = performance.now() - tRank;
    return {
      featured,
      ranked,
      representativeStats,
      fullRelatedCount,
      selectionMs,
      rankMs,
      extraDirectFeatureVectors,
    };
  }

  _searchPackedSync(
    query: AnalyzedQuery,
    plan: ReturnType<typeof buildQueryPlan>,
    opts: SearchOptions,
    strategy: string,
    retrieveOpts: {
      signal?: AbortSignal;
      candidateLimit?: number | null;
      skipDuplicatePostingLists?: boolean;
      exactBlockSkip: false | { requiredDepth: number };
    },
    t0: number
  ) {
    const compiled = compileRankingEvidencePlan(rankingEvidenceStaticFor(requireIndexed(this)), query);
    if (!compiled.eligible || !compiled.plan) return null;
    const session = this._rankingEvidencePool.acquire(compiled.plan);
    try {
      const tRetrieve = performance.now();
      const retrieved = retrieveWithRankingEvidence(
        this.retriever as import("./types.js").Retriever,
        query,
        requireIndexed(this),
        session,
        retrieveOpts
      );
      const retrieveMs = performance.now() - tRetrieve;
      if (!retrieved) {
        session.abort();
        return null;
      }
      const tFeat = performance.now();
      const finalized = finalizeRankingEvidence(session, retrieved, plan);
      const packedDirects = createPackedDirectHits(retrieved, finalized);
      const packedMs = performance.now() - tFeat;
      const {
        limit = 10,
        relatedLimit = 5,
        sourcePolicy = "top1-strong",
        signal,
      } = opts;
      const expanded = this._expandPacked(packedDirects, query, strategy, {
        signal,
        sourcePolicy,
      });
      const rankedPack = this._rankPackedFeatured(expanded.featured, query, plan, strategy, {
        signal,
        limit,
        relatedLimit,
      });
      const finished = this._finishPacked(rankedPack.ranked, query, strategy, {
        limit,
        relatedLimit,
        retrieveMs,
        featureMs: packedMs + expanded.featureMs,
        relationshipMs: expanded.relationshipMs,
        selectionMs: rankedPack.selectionMs,
        rankMs: rankedPack.rankMs,
        totalMs: performance.now() - t0,
        candidateCount: rankedPack.featured.length,
        relationshipExpanded: expanded.applied.relatedHits.length,
        relatedCount: rankedPack.fullRelatedCount,
        primaryId: expanded.applied.primaries[0]?.document?.id || null,
        primaryIds: expanded.applied.primaries.map((p) => p.document.id),
        matchCount: retrieved.length,
        representativeStats: rankedPack.representativeStats,
        diagnosticRanked: null,
        pruningStats: packedFeatureStats(
          expanded.directFeatureVectorsConstructed +
            expanded.relationshipOnlyFeatureVectorsConstructed +
            rankedPack.extraDirectFeatureVectors
        ),
        featureVectorsConstructed:
          expanded.directFeatureVectorsConstructed +
          expanded.relationshipOnlyFeatureVectorsConstructed +
          rankedPack.extraDirectFeatureVectors,
        rankingEvidenceFallbackReason: null,
        optimizedDirectCandidates: packedDirects.filter((hit) =>
          isPackedDirectFeatures(hit.features)
        ).length,
        directFeatureVectorsConstructed:
          expanded.directFeatureVectorsConstructed + rankedPack.extraDirectFeatureVectors,
        relationshipOnlyFeatureVectorsConstructed:
          expanded.relationshipOnlyFeatureVectorsConstructed,
      });
      session.release();
      return finished;
    } catch (error) {
      session.abort();
      throw error;
    }
  }

  async _searchPackedAsync(
    query: AnalyzedQuery,
    plan: ReturnType<typeof buildQueryPlan>,
    opts: SearchOptions,
    strategy: string,
    retrieveOpts: {
      signal?: AbortSignal;
      candidateLimit?: number | null;
      skipDuplicatePostingLists?: boolean;
      exactBlockSkip: false | { requiredDepth: number };
    },
    t0: number
  ) {
    const compiled = compileRankingEvidencePlan(rankingEvidenceStaticFor(requireIndexed(this)), query);
    if (!compiled.eligible || !compiled.plan) return null;
    const session = this._rankingEvidencePool.acquire(compiled.plan);
    try {
      const tRetrieve = performance.now();
      const retrieved = await retrieveWithRankingEvidenceAsync(
        this.retriever as import("./types.js").Retriever,
        query,
        requireIndexed(this),
        session,
        retrieveOpts
      );
      const retrieveMs = performance.now() - tRetrieve;
      if (!retrieved) {
        session.abort();
        return null;
      }
      throwIfAborted(retrieveOpts.signal);
      await Promise.resolve();
      throwIfAborted(retrieveOpts.signal);
      const tFeat = performance.now();
      const finalized = finalizeRankingEvidence(session, retrieved, plan);
      const packedDirects = createPackedDirectHits(retrieved, finalized);
      const packedMs = performance.now() - tFeat;
      const {
        limit = 10,
        relatedLimit = 5,
        sourcePolicy = "top1-strong",
        signal,
      } = opts;
      const expanded = this._expandPacked(packedDirects, query, strategy, {
        signal,
        sourcePolicy,
      });
      throwIfAborted(signal);
      await Promise.resolve();
      throwIfAborted(signal);
      const rankedPack = this._rankPackedFeatured(expanded.featured, query, plan, strategy, {
        signal,
        limit,
        relatedLimit,
      });
      const finished = this._finishPacked(rankedPack.ranked, query, strategy, {
        limit,
        relatedLimit,
        retrieveMs,
        featureMs: packedMs + expanded.featureMs,
        relationshipMs: expanded.relationshipMs,
        selectionMs: rankedPack.selectionMs,
        rankMs: rankedPack.rankMs,
        totalMs: performance.now() - t0,
        candidateCount: rankedPack.featured.length,
        relationshipExpanded: expanded.applied.relatedHits.length,
        relatedCount: rankedPack.fullRelatedCount,
        primaryId: expanded.applied.primaries[0]?.document?.id || null,
        primaryIds: expanded.applied.primaries.map((p) => p.document.id),
        matchCount: retrieved.length,
        representativeStats: rankedPack.representativeStats,
        diagnosticRanked: null,
        pruningStats: packedFeatureStats(
          expanded.directFeatureVectorsConstructed +
            expanded.relationshipOnlyFeatureVectorsConstructed +
            rankedPack.extraDirectFeatureVectors
        ),
        featureVectorsConstructed:
          expanded.directFeatureVectorsConstructed +
          expanded.relationshipOnlyFeatureVectorsConstructed +
          rankedPack.extraDirectFeatureVectors,
        rankingEvidenceFallbackReason: null,
        optimizedDirectCandidates: packedDirects.filter((hit) =>
          isPackedDirectFeatures(hit.features)
        ).length,
        directFeatureVectorsConstructed:
          expanded.directFeatureVectorsConstructed + rankedPack.extraDirectFeatureVectors,
        relationshipOnlyFeatureVectorsConstructed:
          expanded.relationshipOnlyFeatureVectorsConstructed,
      });
      session.release();
      return finished;
    } catch (error) {
      session.abort();
      throw error;
    }
  }


  _finish(ranked: RankedHit[], query: AnalyzedQuery, explain: boolean, strategy: string, timings: FinishTimings) {
    const finished = assembleDetailedResult({
      ranked,
      query,
      explain,
      strategy,
      timings,
      retrievalStats: this.retriever?.stats?.() || {},
      indexBuildMs: this.indexBuildMs || 0,
      retrieverName: this.retriever?.name || "indexed-lexical",
    });
    this.lastSearchMeta = finished.meta;
    return finished;
  }

  _searchDetailedSync(
    rawQuery: unknown,
    opts: SearchOptions = {},
    exactDiagnostics = true,
    pruningMode: "auto" | "exhaustive" = "auto",
    skipDuplicatePostingLists?: boolean
  ) {
    const {
      limit = 10,
      explain = false,
      relationshipStrategy,
      relatedLimit = 5,
      sourcePolicy = "top1-strong",
      signal,
    } = opts;
    throwIfAborted(signal);
    const strategy =
      relationshipStrategy == null
        ? this.relationshipStrategy
        : requireStrategy(relationshipStrategy);
    const t0 = performance.now();
    const query = this._prepareQuery(rawQuery, { signal });
    const index = requireIndexed(this);
    const plan = buildQueryPlan(query, index);

    const publicDepth = Math.max(0, limit, relatedLimit);
    const initialRepresentativeDepth =
      publicDepth + (explain && publicDepth > 0 ? 1 : 0);
    const retrieveOpts = {
      signal,
      candidateLimit: opts.candidateLimit || this.candidateLimit,
      skipDuplicatePostingLists:
        skipDuplicatePostingLists ??
        (this.retrievalScoreWeight === 0 && pruningMode === "auto" && !exactDiagnostics),
      exactBlockSkip: (
        !exactDiagnostics &&
        pruningMode === "auto" &&
        this.retrievalScoreWeight === 0 &&
        sourcePolicy !== "all-strong"
          ? { requiredDepth: initialRepresentativeDepth }
          : false
      ) as false | { requiredDepth: number },
    };
    if (
      !packedSearchFallbackReason({
        exactDiagnostics,
        pruningMode,
        retrievalScoreWeight: this.retrievalScoreWeight,
        sourcePolicy,
        retriever: this.retriever as import("./types.js").Retriever,
        opts,
        query,
        index,
      })
    ) {
      const packed = this._searchPackedSync(query, plan, opts, strategy, retrieveOpts, t0);
      if (packed) return packed;
    }

    const tRetrieve = performance.now();
    const retrieved = this.retriever.retrieve(query, index, retrieveOpts);
    const retrieveMs = performance.now() - tRetrieve;

    const expanded = this._expandAndFeature(retrieved, query, strategy, {
      signal,
      sourcePolicy,
      exactDiagnostics,
      pruningMode,
      requiredDepth: initialRepresentativeDepth,
    });
    let featured = unionExecutedClauseHits(expanded.featured, plan, query);
    const { applied, featureMs, relationshipMs, pruningStats, featureVectorsConstructed } = expanded;
    if (opts.resultCollector === COMPLETE_INTERPRETATION_COLLECTOR) {
      featured = applyCompleteInterpretationCollector(
        featured,
        plan,
        index,
        (doc) => missingPhraseFeatured(query, doc),
        query
      ).featured;
    }

    const constraints = constraintsForStrategy(strategy);
    let representativeStats: Record<string, unknown> | null = null;
    let planningRanked: RankedHit[] | null = null;
    const fullRelatedCount = featured.filter((hit) => hit.features.relevanceKind === "related").length;
    const tSelect = performance.now();
    if (this.retriever.exactSignatureSelection) {
      if (exactDiagnostics) {
        planningRanked = rankCandidates(featured, { constraints, signal });
      }
      let representativeDepth = publicDepth + (explain && publicDepth > 0 ? 1 : 0);
      const hasRelated = fullRelatedCount > 0;
      if (
        publicDepth > 0 &&
        (explain || (relatedLimit > 0 && hasRelated) || (strategy === "separate" && limit > 0 && hasRelated))
      ) {
        planningRanked ||= rankCandidates(featured, { constraints, signal });
        representativeDepth = Math.max(
          representativeDepth,
          representativeDepthForOutput(planningRanked, strategy, { limit, relatedLimit, explain })
        );
      }
      const selected = selectTopPerBuiltinSignature(featured, representativeDepth, constraints);
      featured = selected.candidates;
      representativeStats = {
        ...selected.stats,
        outputDepth: representativeDepth,
        plannedFullRanking: Boolean(planningRanked),
      };
    }
    const selectionMs = performance.now() - tSelect;

    const tRank = performance.now();
    const ranked = rankCandidates(featured, { constraints, signal });
    if (planningRanked?.[0]?.constraintMeta) {
      for (const hit of ranked) hit.constraintMeta = planningRanked[0].constraintMeta;
    }
    const rankMs = performance.now() - tRank;

    return this._finish(ranked, query, explain, strategy, {
      limit,
      relatedLimit,
      retrieveMs,
      featureMs,
      relationshipMs,
      selectionMs,
      rankMs,
      totalMs: performance.now() - t0,
      candidateCount: featured.length,
      relationshipExpanded: applied.relatedHits.length,
      relatedCount: fullRelatedCount,
      primaryId: applied.primaries[0]?.document?.id || null,
      primaryIds: applied.primaries.map((p) => p.document.id),
      matchCount: retrieved.length,
      representativeStats,
      diagnosticRanked: exactDiagnostics ? planningRanked : null,
      pruningStats,
      featureVectorsConstructed,
    });
  }

  async _searchDetailedAsync(
    rawQuery: unknown,
    opts: SearchOptions = {},
    exactDiagnostics = true,
    pruningMode: "auto" | "exhaustive" = "auto",
    skipDuplicatePostingLists?: boolean
  ) {
    const {
      limit = 10,
      explain = false,
      relationshipStrategy,
      relatedLimit = 5,
      sourcePolicy = "top1-strong",
      signal,
    } = opts;
    throwIfAborted(signal);
    await Promise.resolve();
    throwIfAborted(signal);
    const strategy =
      relationshipStrategy == null
        ? this.relationshipStrategy
        : requireStrategy(relationshipStrategy);
    const t0 = performance.now();
    const query = this._prepareQuery(rawQuery, { signal });
    const index = requireIndexed(this);
    const plan = buildQueryPlan(query, index);
    throwIfAborted(signal);
    await Promise.resolve();
    throwIfAborted(signal);

    const publicDepth = Math.max(0, limit, relatedLimit);
    const initialRepresentativeDepth =
      publicDepth + (explain && publicDepth > 0 ? 1 : 0);
    const retrieveOpts = {
      signal,
      candidateLimit: opts.candidateLimit || this.candidateLimit,
      skipDuplicatePostingLists:
        skipDuplicatePostingLists ??
        (this.retrievalScoreWeight === 0 && pruningMode === "auto" && !exactDiagnostics),
      exactBlockSkip: (
        !exactDiagnostics &&
        pruningMode === "auto" &&
        this.retrievalScoreWeight === 0 &&
        sourcePolicy !== "all-strong"
          ? { requiredDepth: initialRepresentativeDepth }
          : false
      ) as false | { requiredDepth: number },
    };
    if (
      !packedSearchFallbackReason({
        exactDiagnostics,
        pruningMode,
        retrievalScoreWeight: this.retrievalScoreWeight,
        sourcePolicy,
        retriever: this.retriever as import("./types.js").Retriever,
        opts,
        query,
        index,
      })
    ) {
      const packed = await this._searchPackedAsync(query, plan, opts, strategy, retrieveOpts, t0);
      if (packed) return packed;
    }
    const tRetrieve = performance.now();
    const retrieved =
      typeof this.retriever.retrieveAsync === "function"
        ? await this.retriever.retrieveAsync(query, index, retrieveOpts)
        : this.retriever.retrieve(query, index, retrieveOpts);
    throwIfAborted(signal);
    const retrieveMs = performance.now() - tRetrieve;

    throwIfAborted(signal);
    await Promise.resolve();
    throwIfAborted(signal);

    const expanded = this._expandAndFeature(retrieved, query, strategy, {
      signal,
      sourcePolicy,
      exactDiagnostics,
      pruningMode,
      requiredDepth: initialRepresentativeDepth,
    });
    let featured = unionExecutedClauseHits(expanded.featured, plan, query);
    const { applied, featureMs, relationshipMs, pruningStats, featureVectorsConstructed } = expanded;
    if (opts.resultCollector === COMPLETE_INTERPRETATION_COLLECTOR) {
      featured = applyCompleteInterpretationCollector(
        featured,
        plan,
        index,
        (doc) => missingPhraseFeatured(query, doc),
        query
      ).featured;
    }

    throwIfAborted(signal);
    await Promise.resolve();
    throwIfAborted(signal);

    const constraints = constraintsForStrategy(strategy);
    let representativeStats: Record<string, unknown> | null = null;
    let planningRanked: RankedHit[] | null = null;
    const fullRelatedCount = featured.filter((hit) => hit.features.relevanceKind === "related").length;
    const tSelect = performance.now();
    if (this.retriever.exactSignatureSelection) {
      if (exactDiagnostics) {
        planningRanked = await rankCandidatesAsync(featured, { constraints, signal });
      }
      let representativeDepth = publicDepth + (explain && publicDepth > 0 ? 1 : 0);
      const hasRelated = fullRelatedCount > 0;
      if (
        publicDepth > 0 &&
        (explain || (relatedLimit > 0 && hasRelated) || (strategy === "separate" && limit > 0 && hasRelated))
      ) {
        planningRanked ||= await rankCandidatesAsync(featured, { constraints, signal });
        representativeDepth = Math.max(
          representativeDepth,
          representativeDepthForOutput(planningRanked, strategy, { limit, relatedLimit, explain })
        );
      }
      const selected = selectTopPerBuiltinSignature(featured, representativeDepth, constraints);
      featured = selected.candidates;
      representativeStats = {
        ...selected.stats,
        outputDepth: representativeDepth,
        plannedFullRanking: Boolean(planningRanked),
      };
    }
    const selectionMs = performance.now() - tSelect;

    const tRank = performance.now();
    const ranked = await rankCandidatesAsync(featured, { constraints, signal });
    if (planningRanked?.[0]?.constraintMeta) {
      for (const hit of ranked) hit.constraintMeta = planningRanked[0].constraintMeta;
    }
    const rankMs = performance.now() - tRank;

    throwIfAborted(signal);
    return this._finish(ranked, query, explain, strategy, {
      limit,
      relatedLimit,
      retrieveMs,
      featureMs,
      relationshipMs,
      selectionMs,
      rankMs,
      totalMs: performance.now() - t0,
      candidateCount: featured.length,
      relationshipExpanded: applied.relatedHits.length,
      relatedCount: fullRelatedCount,
      primaryId: applied.primaries[0]?.document?.id || null,
      primaryIds: applied.primaries.map((p) => p.document.id),
      matchCount: retrieved.length,
      representativeStats,
      diagnosticRanked: exactDiagnostics ? planningRanked : null,
      pruningStats,
      featureVectorsConstructed,
    });
  }
}

export { morphology, compileConfiguredConceptPlugin };
