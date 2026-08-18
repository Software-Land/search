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

export { RELATIONSHIP_STRATEGIES, DEFAULT_RELATIONSHIP_STRATEGY };

/** @param {import("./types.js").SearchIndex} index @param {import("./types.js").SearchPlugin[]} plugins */
function typoVocabulary(index, plugins) {
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

/** @param {import("./types.js").AnalyzedQuery} query @param {Set<string>} vocabulary @param {{ signal?: AbortSignal }} [opts] */
function attachTypoAlternatives(query, vocabulary, { signal } = {}) {
  const extra = [];
  const alternatives = [...(query.alternatives || [])];
  for (const tok of query.tokens) {
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

/** @param {import("./types.js").RelationshipArtifact | import("./types.js").RelationshipGraphApi | null | undefined} relationships @returns {import("./types.js").RelationshipGraphApi} */
function resolveGraph(relationships) {
  if (!relationships) return RelationshipGraph(null);
  if (typeof relationships === "object" && "neighbors" in relationships && typeof relationships.neighbors === "function") {
    return relationships;
  }
  return RelationshipGraph(relationships);
}

/** @param {unknown} value */
function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      if (typeof v === "function") return undefined;
      return v;
    })
  );
}

/**
 * @param {import("./types.js").RankedHit} c
 * @param {import("./types.js").AnalyzedQuery} query
 * @param {boolean} [explain]
 * @returns {import("./types.js").SearchResultRow}
 */
function serializeHit(c, query, explain) {
  /** @type {import("./types.js").SearchResultRow} */
  const row = {
    id: c.document.id,
    title: c.document.title,
    rank: c.rank,
    score: c.score,
    relevanceKind: c.features.relevanceKind,
    directClass: c.features.directClass,
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
    row.features = { ...c.features };
    row.constraints = c.constraintVsNext?.applied || [];
    row.explanation = jsonSafe({
      query: {
        raw: query.raw,
        originalSurface: query.originalSurface,
        tokens: query.tokens,
        concepts: query.concepts,
        alternatives: query.alternatives || [],
      },
      retrievalSources: row.retrievalSources,
      relevanceKind: c.features.relevanceKind,
      directClass: c.features.directClass,
      features: row.features,
      relationship: c.relationship || null,
      constraintsVsNext: c.constraintVsNext,
      constraintMeta: c.constraintMeta || null,
    });
  }
  return row;
}

/**
 * @param {import("./types.js").RankedHit[]} ranked
 * @param {string} strategy
 * @param {{ limit: number, relatedLimit: number }} opts
 */
function sliceResults(ranked, strategy, { limit, relatedLimit }) {
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
  /**
   * @param {import("./types.js").SearchEngineOptions} [options]
   */
  constructor(options = {}) {
    const cfg = validateCreateOptions(options);
    /** @type {import("./types.js").Schema} */
    this.schema = cfg.schema;
    /** @type {import("./types.js").SearchPlugin[]} */
    this.plugins = cfg.plugins;
    this.relationships = resolveGraph(cfg.relationships);
    this.relationshipStrategy = cfg.relationshipStrategy;
    /** @type {import("./types.js").Retriever} */
    this.retriever = cfg.retriever;
    /** @type {number | null} */
    this.candidateLimit = cfg.candidateLimit;
    /** @type {import("./types.js").AdaptiveOptions} */
    this.adaptive = cfg.adaptive;
    /** @type {number} */
    this.retrievalScoreWeight = cfg.retrievalScoreWeight;
    /** @type {import("./types.js").SearchIndex | null} */
    this._index = null;
    this.indexBuildMs = 0;
    /** @type {Record<string, unknown> | null} */
    this.lastSearchMeta = null;
  }

  /** @param {import("./types.js").SearchEngineOptions} [options] */
  static create(options) {
    return new SearchEngine(options);
  }

  /** @param {import("./types.js").SearchDocument[] | null | undefined} documents */
  async index(documents) {
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
  /** @param {unknown} rawQuery @param {import("./types.js").SearchOptions} [opts] */
  search(rawQuery, opts = {}) {
    return this.searchDetailed(rawQuery, opts).results;
  }

  /**
   * Richer API for UIs and debugging. `results` uses the same strategy as search().
   * `related` is always the relationship-derived channel (empty when strategy is none
   * or no graph is configured).
   * @param {unknown} rawQuery
   * @param {import("./types.js").SearchOptions} [opts]
   */
  searchDetailed(rawQuery, opts = {}) {
    return this._searchDetailedSync(rawQuery, opts);
  }

  /** @param {unknown} rawQuery @param {import("./types.js").SearchOptions} [opts] */
  async searchAsync(rawQuery, opts = {}) {
    return (await this.searchDetailedAsync(rawQuery, opts)).results;
  }

  /** @param {unknown} rawQuery @param {import("./types.js").SearchOptions} [opts] */
  async searchDetailedAsync(rawQuery, opts = {}) {
    return this._searchDetailedAsync(rawQuery, opts);
  }

  /** @param {unknown} rawQuery @param {{ signal?: AbortSignal }} [opts] */
  _prepareQuery(rawQuery, { signal } = {}) {
    throwIfAborted(signal);
    const index = requireIndexed(this);
    let query = analyzeQuery(rawQuery, {
      plugins: this.plugins,
      lexicon: index.titleTokenSet,
      signal,
    });
    query = attachTypoAlternatives(query, typoVocabulary(index, this.plugins), { signal });
    return query;
  }

  /**
   * @param {import("./types.js").RetrievalHit[]} retrieved
   * @param {import("./types.js").AnalyzedQuery} query
   * @param {string} strategy
   * @param {{ signal?: AbortSignal, sourcePolicy?: import("./types.js").SourcePolicy }} [opts]
   */
  _expandAndFeature(retrieved, query, strategy, { signal, sourcePolicy } = {}) {
    throwIfAborted(signal);
    const weight = this.retrievalScoreWeight;
    let maxRet = 0;
    if (weight) {
      for (const hit of retrieved) maxRet = Math.max(maxRet, hit.retrievalScore || 0);
    }
    /** @param {import("./types.js").RetrievalHit} hit */
    const retrievalScoreOf = (hit) => (weight && maxRet ? weight * ((hit.retrievalScore || 0) / maxRet) : 0);
    const tFeat = performance.now();
    /** @type {import("./types.js").FeaturedHit[]} */
    let featured = retrieved.map((hit, i) => {
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

  /**
   * @param {import("./types.js").RankedHit[]} ranked
   * @param {import("./types.js").AnalyzedQuery} query
   * @param {boolean} explain
   * @param {string} strategy
   * @param {import("./types.js").FinishTimings} timings
   */
  _finish(ranked, query, explain, strategy, timings) {
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

  /** @param {unknown} rawQuery @param {import("./types.js").SearchOptions} [opts] */
  _searchDetailedSync(rawQuery, opts = {}) {
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

  /** @param {unknown} rawQuery @param {import("./types.js").SearchOptions} [opts] */
  async _searchDetailedAsync(rawQuery, opts = {}) {
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
