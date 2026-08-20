import { analyzeQuery, suggestTypoForms } from "./analyze.js";
import { buildIndex } from "./indexDocuments.js";
import { extractFeatures } from "./features.js";
import { rankCandidates, rankCandidatesAsync, scoreFeatures } from "./rank.js";
import { constraintsForStrategy } from "./constraints.js";
import { english } from "./english.js";
import { dictionary } from "./dictionary.js";
import {
  RelationshipGraph,
  applyRelationshipExpansion,
} from "./relationships.js";
import { throwIfAborted } from "./cancel.js";
import {
  RELATIONSHIP_STRATEGIES,
  DEFAULT_RELATIONSHIP_STRATEGY,
  validateCreateOptions,
  requireStrategy,
  requireIndexed,
} from "./config.js";
import { InvalidDocumentError } from "./errors.js";
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
  retrieve: (query: AnalyzedQuery, index: SearchIndex, options?: RetrieveOptions) => RetrievalHit[];
  retrieveAsync?: (
    query: AnalyzedQuery,
    index: SearchIndex,
    options?: RetrieveOptions
  ) => Promise<RetrievalHit[]>;
  prepare?: (index: SearchIndex, extra?: { schema?: Schema }) => void;
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

export class SearchEngine {
  declare schema: Schema;
  declare plugins: SearchPlugin[];
  declare relationships: RelationshipGraphApi;
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
    this._index = buildIndex(documents, this.schema, this.plugins);
    if (this.retriever && typeof this.retriever.prepare === "function") {
      this.retriever.prepare(this._index, { schema: this.schema });
    }
    this.indexBuildMs = performance.now() - t0;
    return { documentCount: this._index.documents.length, buildMs: this.indexBuildMs };
  }

  /**
   * Default OSS API: returns an array. Same ranking as searchDetailed().results.
   */
  search(rawQuery: unknown, opts: SearchOptions = {}) {
    return this.searchDetailed(rawQuery, opts).results;
  }

  /**
   * Richer API for UIs and debugging. `results` uses the same strategy as search().
   * `related` is always the relationship-derived channel (empty when strategy is none
   * or no graph is configured).
   */
  searchDetailed(rawQuery: unknown, opts: SearchOptions = {}) {
    return this._searchDetailedSync(rawQuery, opts);
  }

  async searchAsync(rawQuery: unknown, opts: SearchOptions = {}) {
    return (await this.searchDetailedAsync(rawQuery, opts)).results;
  }

  async searchDetailedAsync(rawQuery: unknown, opts: SearchOptions = {}) {
    return this._searchDetailedAsync(rawQuery, opts);
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
    { signal, sourcePolicy }: { signal?: AbortSignal; sourcePolicy?: SourcePolicy } = {}
  ) {
    throwIfAborted(signal);
    const weight = this.retrievalScoreWeight;
    let maxRet = 0;
    if (weight) {
      for (const hit of retrieved) maxRet = Math.max(maxRet, hit.retrievalScore || 0);
    }
    const retrievalScoreOf = (hit: RetrievalHit) => (weight && maxRet ? weight * ((hit.retrievalScore || 0) / maxRet) : 0);
    const tFeat = performance.now();
    let featured: FeaturedHit[] = retrieved.map((hit, i) => {
      if (i % 8 === 0) throwIfAborted(signal);
      return {
        ...hit,
        features: extractFeatures(query, hit.document, {
          relationship: hit.relationship || null,
          retrievalScore: retrievalScoreOf(hit),
        }),
      };
    });
    const featureMs = performance.now() - tFeat;

    if (strategy === "none") {
      return { featured, applied: { featured, relatedHits: [], primaries: [] }, featureMs, relationshipMs: 0 };
    }

    throwIfAborted(signal);
    const tRel = performance.now();
    const applied = applyRelationshipExpansion({
      featured,
      query,
      extractFeatures,
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
      const features = extractFeatures(query, hit.document, { relationship: hit.relationship });
      featured.push({
        ...hit,
        features,
        score: scoreFeatures(features),
      });
    }
    const relationshipMs = performance.now() - tRel;
    return { featured, applied, featureMs, relationshipMs };
  }

  _finish(ranked: RankedHit[], query: AnalyzedQuery, explain: boolean, strategy: string, timings: FinishTimings) {
    const { sliced, relatedSliced, relatedRanked } = sliceResults(ranked, strategy, {
      limit: timings.limit,
      relatedLimit: timings.relatedLimit,
    });
    const results = sliced.map((c) => serializeHit(c, query, explain));
    const related = relatedSliced.map((c) => serializeHit(c, query, explain));
    const meta = {
      candidateCount: timings.candidateCount,
      candidateTitles: ranked.map((c) => c.document.title),
      retrieveMs: timings.retrieveMs,
      featureMs: timings.featureMs,
      relationshipMs: timings.relationshipMs,
      rankMs: timings.rankMs,
      totalMs: timings.totalMs,
      indexBuildMs: this.indexBuildMs || 0,
      relationshipExpanded: timings.relationshipExpanded,
      relatedCount: relatedRanked.length,
      primaryId: timings.primaryId,
      primaryIds: timings.primaryIds,
      relationshipStrategy: strategy,
      retriever: this.retriever?.name || "full-scan",
      related,
      constraintCycles: ranked[0]?.constraintMeta?.cycles || [],
      constraintConflicts: ranked[0]?.constraintMeta?.conflictCount || 0,
      query: {
        raw: query.raw,
        originalSurface: query.originalSurface,
        alternatives: query.alternatives || [],
      },
    };
    this.lastSearchMeta = meta;
    return { results, related, meta };
  }

  _searchDetailedSync(rawQuery: unknown, opts: SearchOptions = {}) {
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
    const retrieved = this.retriever.retrieve(query, index, {
      signal,
      candidateLimit: opts.candidateLimit || this.candidateLimit,
    });
    const retrieveMs = performance.now() - tRetrieve;

    const { featured, applied, featureMs, relationshipMs } = this._expandAndFeature(retrieved, query, strategy, {
      signal,
      sourcePolicy,
    });

    const tRank = performance.now();
    const constraints = constraintsForStrategy(strategy);
    const ranked = rankCandidates(featured, { constraints, signal });
    const rankMs = performance.now() - tRank;

    return this._finish(ranked, query, explain, strategy, {
      limit,
      relatedLimit,
      retrieveMs,
      featureMs,
      relationshipMs,
      rankMs,
      totalMs: performance.now() - t0,
      candidateCount: featured.length,
      relationshipExpanded: applied.relatedHits.length,
      primaryId: applied.primaries[0]?.document?.id || null,
      primaryIds: applied.primaries.map((p) => p.document.id),
    });
  }

  async _searchDetailedAsync(rawQuery: unknown, opts: SearchOptions = {}) {
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
    const retrieveOpts = {
      signal,
      candidateLimit: opts.candidateLimit || this.candidateLimit,
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

    const { featured, applied, featureMs, relationshipMs } = this._expandAndFeature(retrieved, query, strategy, {
      signal,
      sourcePolicy,
    });

    throwIfAborted(signal);
    await Promise.resolve();
    throwIfAborted(signal);

    const tRank = performance.now();
    const constraints = constraintsForStrategy(strategy);
    const ranked = await rankCandidatesAsync(featured, { constraints, signal });
    const rankMs = performance.now() - tRank;

    throwIfAborted(signal);
    return this._finish(ranked, query, explain, strategy, {
      limit,
      relatedLimit,
      retrieveMs,
      featureMs,
      relationshipMs,
      rankMs,
      totalMs: performance.now() - t0,
      candidateCount: featured.length,
      relationshipExpanded: applied.relatedHits.length,
      primaryId: applied.primaries[0]?.document?.id || null,
      primaryIds: applied.primaries.map((p) => p.document.id),
    });
  }
}

export { english, dictionary };
