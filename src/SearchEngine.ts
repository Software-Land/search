import { analyzeQuery, suggestTypoForms } from "./analyze.js";
import { buildIndex, resolveSchema } from "./indexDocuments.js";
import {
  compactIndexFromAnalyzed,
  exactPruningRuntime,
  lexicalAnalyzerIdentity,
  lexicalCorpusFingerprint,
  loadLexicalIndex,
} from "./lexicalIndex.js";
import { extractFeatures } from "./features.js";
import {
  exhaustiveFeaturePruningStats,
  planExactFeaturePruning,
} from "./exactPruning.js";
import {
  rankCandidates,
  rankCandidatesAsync,
  scoreFeatures,
  selectTopPerBuiltinSignature,
} from "./rank.js";
import { constraintsForStrategy } from "./constraints.js";
import { morphology } from "./morphology.js";
import { dictionary } from "./dictionary.js";
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
  FeatureVector,
  FinishTimings,
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
  SearchResultRow,
  SourcePolicy,
} from "./types.js";

export { RELATIONSHIP_STRATEGIES, DEFAULT_RELATIONSHIP_STRATEGY };

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

function attachTypoAlternatives(query: AnalyzedQuery, vocabulary: Set<string>, { signal }: { signal?: AbortSignal } = {}) {
  const extra: TypoCompanionConcept[] = [];
  const alternatives: QueryAlternative[] = [...(query.alternatives || [])];
  for (const tok of query.tokens) {
    if (!tok) continue;
    if (tok.completedToken || (tok.sources || []).includes("final-token-prefix")) continue;
    if (vocabulary.has(tok.normalized) || isPrefixOfVocabulary(tok.normalized, vocabulary)) continue;
    const suggestions = suggestTypoForms(tok.normalized, vocabulary, { signal });
    for (const s of suggestions) {
      if (s.form === tok.normalized) continue;
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

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      if (typeof v === "function") return undefined;
      return v;
    })
  );
}

function explainLexical(f: FeatureVector) {
  if ((f.queryTokenCount ?? 0) < 2 && (f.bodyPhraseCount ?? 0) <= 0) return undefined;
  return {
    normalizedQueryPhrase: f.normalizedQueryPhrase ?? "",
    matchingPhraseKey: f.matchingPhraseKey ?? null,
    bodyPhraseCount: f.bodyPhraseCount ?? 0,
    bodyPhraseFrequency: f.bodyPhraseFrequency ?? 0,
  };
}

function explainContextualPrefix(f: FeatureVector) {
  if (!f.contextualTitlePrefix) return undefined;
  return {
    matchedPrefixTokens: f.matchedPrefixTokens ?? [],
    activeFinalPrefix: f.activeFinalPrefix ?? null,
    completedTitleToken: f.completedTitleToken ?? null,
    unmatchedTitleTokensAfter: f.unmatchedTitleTokensAfter ?? 0,
    titleSequenceTightness: f.titleSequenceTightness ?? 0,
    contextualPrefixQuality: f.contextualPrefixQuality ?? 0,
  };
}

function serializeHit(c: RankedHit, query: AnalyzedQuery, explain?: boolean): SearchResultRow {
  const f = c.features;
  const row: SearchResultRow = {
    id: c.document.id,
    title: c.document.title,
    rank: c.rank,
    score: c.score,
    relevanceKind: f.relevanceKind,
    directClass: f.directClass,
  };
  if (c.relationship) {
    row.relationship = {
      sourceId: c.relationship.sourceId,
      sourceTitle: c.relationship.sourceTitle,
      type: c.relationship.type,
      strength: c.relationship.strength,
      provenance: c.relationship.provenance,
      rank: c.relationship.rank,
      sources: c.relationship.sources || undefined,
    };
  }
  if (explain) {
    row.retrievalSources = [...(c.retrievalSources || [])];
    row.features = { ...f };
    row.constraints = c.constraintVsNext?.applied || [];
    row.explanation = jsonSafe({
      query: {
        raw: query.raw,
        originalSurface: query.originalSurface,
        tokens: query.tokens,
        concepts: query.concepts,
        alternatives: query.alternatives || [],
        prefixCompletion: query.prefixCompletion ?? null,
        contextualCompletion: query.contextualCompletion ?? null,
        configuredSequenceIntent: query.configuredSequenceIntent ?? null,
        configuredSpans: (query.configuredSpans || []).map((span) => ({
          key: span.key,
          start: span.start,
          end: span.end,
          matchedKinds: [...(span.matchedKinds || [])],
        })),
        standaloneRecall: query.standaloneRecall
          ? { key: query.standaloneRecall.key, sourceToken: query.standaloneRecall.sourceToken }
          : null,
        topicalRecall: query.topicalRecall
          ? { key: query.topicalRecall.key, forms: query.topicalRecall.forms.map((form) => [...form]) }
          : null,
        lexicalTokens: query.lexicalTokens,
        lexicalPhraseKey: query.lexicalPhraseKey,
        normalizedQueryPhrase: f.normalizedQueryPhrase ?? "",
      },
      retrievalSources: row.retrievalSources,
      relevanceKind: f.relevanceKind,
      directClass: f.directClass,
      features: row.features,
      lexical: explainLexical(f),
      contextualPrefix: explainContextualPrefix(f),
      relationship: c.relationship ?? null,
      constraintsVsNext: c.constraintVsNext,
      constraintMeta: c.constraintMeta ?? null,
    });
  }
  return row;
}

function sliceResults(ranked: RankedHit[], strategy: string, { limit, relatedLimit }: { limit: number; relatedLimit: number }) {
  const relatedRanked = ranked.filter((c) => c.features.relevanceKind === "related");
  const directRanked = ranked.filter((c) => c.features.relevanceKind !== "related");
  const primaryPool = strategy === "separate" || strategy === "none" ? directRanked : ranked;
  return {
    sliced: primaryPool.slice(0, Math.max(0, limit)),
    relatedSliced: relatedRanked.slice(0, Math.max(0, relatedLimit)),
    relatedRanked,
    directRanked,
  };
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

  constructor(options: SearchEngineOptions = {}) {
    const cfg = validateCreateOptions(options);
    this.schema = cfg.schema;
    this.plugins = cfg.plugins;
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
      if (
        analyzer !== this.loadedLexicalIndex.analyzer ||
        resolved.titleField !== this.loadedLexicalIndex.schema[0] ||
        resolved.bodyField !== this.loadedLexicalIndex.schema[1] ||
        fingerprint !== this.loadedLexicalIndex.fingerprint
      ) {
        throw new ArtifactValidationError(
          "Re-index input is incompatible with the consumed lexical index",
          { format: "search-v2-lexical-index", field: "corpus.fingerprint" }
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
    if (this.retriever && typeof this.retriever.prepare === "function") {
      this.retriever.prepare(this._index, { schema: this.schema, plugins: this.plugins });
    }
    // Runtime terms retain only the positional arrays they need. Drop the
    // validated envelope/document tuples so Worker initialization does not
    // permanently keep both serialized and hydrated representations.
    if (suppliedLexicalIndex) {
      this.loadedLexicalIndex = {
        fingerprint: suppliedLexicalIndex.corpus.fingerprint,
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
    let query = analyzeQuery(rawQuery, {
      plugins: this.plugins,
      lexicon: index.titleTokenSet,
      prefixLexicon: index.surfaceVocabulary || index.titleTokenSet,
      signal,
    });
    query = attachTypoAlternatives(query, typoVocabulary(index, this.plugins), { signal });
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
    let fallbackReason: string | null = null;
    if (exactDiagnostics) fallbackReason = "exact-diagnostics";
    else if (pruningMode === "exhaustive") fallbackReason = "explicit-exhaustive";
    else if (!this.retriever.exactSignatureSelection || retrieverKind !== "compiled-indexed") {
      fallbackReason = "unsupported-retriever";
    } else if (!compiledRuntime) fallbackReason = "missing-pruning-extension";
    else if (weight) fallbackReason = "retrieval-score-weight";
    else if (strategy !== "none" && sourcePolicy === "all-strong") {
      fallbackReason = "all-strong-relationships";
    }

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
      const features = extractFeatures(query, hit.document, { relationship: hit.relationship });
      featured.push({
        ...hit,
        features,
        score: scoreFeatures(features),
      });
    }
    const relationshipMs = performance.now() - tRel;
    return { featured, applied, featureMs, relationshipMs, pruningStats, featureVectorsConstructed };
  }

  _finish(ranked: RankedHit[], query: AnalyzedQuery, explain: boolean, strategy: string, timings: FinishTimings) {
    const { sliced, relatedSliced, relatedRanked } = sliceResults(ranked, strategy, {
      limit: timings.limit,
      relatedLimit: timings.relatedLimit,
    });
    const results = sliced.map((c) => serializeHit(c, query, explain));
    const related = relatedSliced.map((c) => serializeHit(c, query, explain));
    const retrievalStats = this.retriever?.stats?.() || {};
    const diagnosticRanked = timings.diagnosticRanked || ranked;
    const meta = {
      candidateCount: timings.diagnosticRanked?.length ?? timings.candidateCount,
      candidateTitles: diagnosticRanked.map((c) => c.document.title),
      retrieveMs: timings.retrieveMs,
      featureMs: timings.featureMs,
      relationshipMs: timings.relationshipMs,
      selectionMs: timings.selectionMs || 0,
      rankMs: timings.rankMs,
      totalMs: timings.totalMs,
      indexBuildMs: this.indexBuildMs || 0,
      relationshipExpanded: timings.relationshipExpanded,
      matchCount: timings.matchCount ?? timings.candidateCount,
      representativeSelection: timings.representativeStats || null,
      retrievalStats,
      postingEntriesVisited: retrievalStats.postingEntriesVisited ?? null,
      distinctDocumentsExamined: retrievalStats.distinctDocumentsExamined ?? null,
      rawDocumentScans: retrievalStats.rawDocumentScans ?? null,
      postingBlocksVisited: retrievalStats.postingBlocksVisited ?? timings.pruningStats?.postingBlocksVisited ?? 0,
      postingBlocksSkipped: retrievalStats.postingBlocksSkipped ?? timings.pruningStats?.postingBlocksSkipped ?? 0,
      duplicatePostingBlocksAvoided: retrievalStats.duplicatePostingBlocksAvoided ?? retrievalStats.postingBlocksSkipped ?? 0,
      postingEntriesSkipped:
        (Number(retrievalStats.postingEntriesSkipped) || 0) +
        (timings.pruningStats?.postingEntriesSkipped ?? 0),
      duplicatePostingEntriesAvoided: retrievalStats.duplicatePostingEntriesAvoided ?? 0,
      queryFormsExpanded: retrievalStats.queryFormsExpanded ?? 0,
      termsExpanded: retrievalStats.termsExpanded ?? 0,
      documentBlocksVisited: timings.pruningStats?.documentBlocksVisited ?? 0,
      documentBlocksSkipped: timings.pruningStats?.documentBlocksSkipped ?? 0,
      boundedBlocksSkipped: timings.pruningStats?.boundedBlocksSkipped ?? 0,
      documentsFullyEvaluated: timings.pruningStats?.documentsFullyEvaluated ?? timings.matchCount ?? 0,
      documentsBoundRejected: timings.pruningStats?.documentsBoundRejected ?? 0,
      pruningSignaturesEncountered: timings.pruningStats?.signaturesEncountered ?? 0,
      pruningRepresentativesRetained: timings.pruningStats?.representativesRetained ?? 0,
      pruningFallbackReason: timings.pruningStats?.pruningFallbackReason ?? null,
      postingBlocksTotal: retrievalStats.postingBlocksTotal ?? 0,
      postingBlocksDecoded: retrievalStats.postingBlocksDecoded ?? 0,
      postingBlocksClassifiedFromMasks: retrievalStats.postingBlocksClassifiedFromMasks ?? 0,
      postingBlocksSkippedUnread: retrievalStats.postingBlocksSkippedUnread ?? 0,
      postingEntriesDecoded: retrievalStats.postingEntriesDecoded ?? retrievalStats.postingEntriesVisited ?? 0,
      candidateDocumentsMaterialized: retrievalStats.candidateDocumentsMaterialized ?? timings.matchCount ?? 0,
      provenanceDocumentsScanned: retrievalStats.provenanceDocumentsScanned ?? 0,
      featureVectorsConstructed: timings.featureVectorsConstructed ?? 0,
      signaturesDiscovered: (timings.representativeStats as { signatures?: number } | null)?.signatures ?? 0,
      representativesInserted: (timings.representativeStats as { retained?: number } | null)?.retained ?? 0,
      representativesReplaced: 0,
      stage3A: retrievalStats.stage3A ?? "off",
      stage3AFallbackReason: retrievalStats.stage3AFallbackReason ?? null,
      relatedCount: timings.relatedCount ?? relatedRanked.length,
      primaryId: timings.primaryId,
      primaryIds: timings.primaryIds,
      relationshipStrategy: strategy,
      retriever: this.retriever?.name || "indexed-lexical",
      related,
      constraintCycles: diagnosticRanked[0]?.constraintMeta?.cycles || [],
      constraintConflicts: diagnosticRanked[0]?.constraintMeta?.conflictCount || 0,
      query: {
        raw: query.raw,
        originalSurface: query.originalSurface,
        alternatives: query.alternatives || [],
      },
    };
    this.lastSearchMeta = meta;
    return { results, related, meta };
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

    const tRetrieve = performance.now();
    const publicDepth = Math.max(0, limit, relatedLimit);
    const initialRepresentativeDepth =
      publicDepth + (explain && publicDepth > 0 ? 1 : 0);
    const retrieved = this.retriever.retrieve(query, index, {
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
    });
    const retrieveMs = performance.now() - tRetrieve;

    const expanded = this._expandAndFeature(retrieved, query, strategy, {
      signal,
      sourcePolicy,
      exactDiagnostics,
      pruningMode,
      requiredDepth: initialRepresentativeDepth,
    });
    let featured = expanded.featured;
    const { applied, featureMs, relationshipMs, pruningStats, featureVectorsConstructed } = expanded;

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
    throwIfAborted(signal);
    await Promise.resolve();
    throwIfAborted(signal);

    const tRetrieve = performance.now();
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
    let featured = expanded.featured;
    const { applied, featureMs, relationshipMs, pruningStats, featureVectorsConstructed } = expanded;

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

export { morphology, dictionary };
