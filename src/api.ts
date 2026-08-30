/**
 * Designed public type contract for @software-land/search.
 * Implementation details (FeatureVector, AnalyzedQuery, IndexedDocument) stay internal.
 * SearchPlugin and ExperimentalRetriever are the public authoring contracts for
 * `SearchEngine.create({ plugins, retriever })`. Runtime still duck-types plugins
 * and custom retrievers; the declarations no longer leave those slots untyped.
 */

export type TextRole = "title" | "body" | "summary";

export interface SchemaField {
  type: "text";
  role?: TextRole;
}

export type Schema = Record<string, SchemaField>;

export interface SearchDocument {
  id: string;
  title?: string;
  body?: string;
  /** Optional summary/abstract field when the schema includes role `summary`. */
  summary?: string;
  metadata?: Record<string, unknown>;
  [field: string]: unknown;
}

export type RelationshipStrategy = "none" | "mixed" | "hybrid" | "separate";
export type RetrieverName = "full-scan" | "indexed" | "adaptive";
export type RelevanceKind = "direct" | "related";
export type DirectClass = "strong" | "moderate" | "weak" | "none";

/**
 * One configured concept. Aliases are unordered semantic peers.
 * This is not relationshipMap `kind: "equivalent"` recall.
 */
export interface ConfiguredConcept {
  key: string;
  /** Unordered peer lexical forms. Alias array order has no search semantic effect. */
  aliases?: string[][];
  /** Optional authored/compiled identity metadata. Not a ranking weight. */
  type?: string;
  provenance?: string | null;
  confidence?: number | null;
}

export interface AdaptiveOptions {
  /** Deterministic document-count cutoff. Not a hardware auto-tuner. Default 1500. */
  documentThreshold?: number;
}

/**
 * Opt-in plugin authoring contract. `SearchEngine.create({ plugins })` accepts
 * `SearchPlugin[]`. Runtime still duck-types plugin objects and ignores
 * unrecognized entries.
 *
 * Hooks are duck-typed at runtime. Provide only the hooks you implement.
 * Custom plugins may supply `lemma`, `canonicalLemma`, and `lexicon`.
 * Configured concepts are not a custom-plugin field set; author
 * `configuredConcepts` and compile with `compileAuthoredRelevance()`.
 */
export interface SearchPlugin {
  name?: string;
  /** Deterministic identity for plugin behavior compiled into a lexical index. */
  indexIdentity?: string;
  lemma?(token: string): string;
  canonicalLemma?(token: string): string | null;
  lexicon?(): Iterable<string>;
}

/**
 * Options for `morphology()`. Optional `lemmas` augment the built-in English table.
 */
export interface MorphologyOptions {
  lemmas?: Record<string, string>;
}

/**
 * Public morphology plugin shape. `morphology()` returns `EnglishPlugin`.
 */
export interface EnglishPlugin extends SearchPlugin {
  name: "english";
  lemma(token: string): string;
  canonicalLemma(token: string): string | null;
}

/** Opt-in lexicon-only plugin shape (typo vocabulary / prefix words). */
export interface LexiconPlugin extends SearchPlugin {
  lexicon(): Iterable<string>;
}

/**
 * @experimental Options Core passes into a custom retriever.
 * `candidateLimit` is the indexed budget override; `signal` is abort.
 */
export interface ExperimentalRetrieveOptions {
  signal?: AbortSignal;
  candidateLimit?: number | null;
}

/**
 * @experimental Custom retriever authoring contract.
 * `query` and `index` are engine internals and stay `unknown` on purpose.
 * This type does not publish AnalyzedQuery, SearchIndex, or IndexedDocument.
 * `SearchEngine.create({ retriever })` accepts `ExperimentalRetriever`.
 */
export interface ExperimentalRetriever {
  name?: string;
  prepare?(index: unknown, extra?: { schema?: Schema }): void;
  retrieve(query: unknown, index: unknown, options?: ExperimentalRetrieveOptions): unknown[];
  retrieveAsync?(
    query: unknown,
    index: unknown,
    options?: ExperimentalRetrieveOptions
  ): Promise<unknown[]>;
}

export interface SearchEngineOptions {
  schema?: Schema;
  plugins?: SearchPlugin[];
  /** Optional search-v2-lexical-index v1 artifact compiled for these documents. */
  lexicalIndex?: LexicalIndexArtifact;
  documentRelationships?: RelationshipArtifact | null;
  relationshipStrategy?: RelationshipStrategy;
  retriever?: RetrieverName | "indexed-lexical" | ExperimentalRetriever;
  /** Compatibility/experimental-retriever budget; exact indexed retrieval does not truncate to it. */
  candidateLimit?: number;
  adaptive?: AdaptiveOptions;
  /** @experimental Default 0. Not a supported ranking feature. */
  retrievalScoreWeight?: number;
}

/**
 * Opaque compiled lexical index envelope. Build it with
 * `@software-land/search/lexical`; posting internals are versioned data rather
 * than a public runtime API.
 */
export interface LexicalIndexArtifact {
  format: "search-v2-lexical-index";
  version: 1;
  compatibility: {
    core: string;
    analyzer: string;
    schema: [string, string];
  };
  corpus: {
    documentCount: number;
    fingerprint: string;
  };
  integrity: string;
  data: unknown;
}

export interface SearchOptions {
  limit?: number;
  relatedLimit?: number;
  explain?: boolean;
  relationshipStrategy?: RelationshipStrategy;
  signal?: AbortSignal;
  candidateLimit?: number;
  /**
   * Optional built-in result collector. Default omits it.
   * `"complete-interpretation"` keeps documents that fully match a positional
   * phrase or phrase-prefix clause. If the typed phrase has no exact PhraseQuery
   * hit, every PhrasePrefix field participates. If an exact hit exists, body-only
   * PhrasePrefix expansions stay out. Occupancy and version queries skip it.
   */
  resultCollector?: "complete-interpretation";
}

export interface RelationshipInfo {
  sourceId: string;
  sourceTitle: string;
  type?: string;
  strength?: number;
  provenance?: string | null;
  rank?: number;
  sources?: RelationshipInfo[];
}

export interface SearchResult {
  id: string;
  title: string;
  rank: number;
  /** Unstable within-constraint number. Not a calibrated relevance score. */
  score?: number;
  relevanceKind: RelevanceKind;
  directClass?: DirectClass;
  relationship?: RelationshipInfo;
  retrievalSources?: string[];
  features?: Record<string, unknown>;
  /** Present when `explain: true`. Pairwise constraint report vs the next hit. */
  constraints?: unknown;
  explanation?: SearchExplanation;
}

export interface PrefixCompletion {
  activePrefix: string;
  /** Inferred completion metadata. Never typed ranking evidence. */
  completedToken: string | null;
  /** Canonical retrieval form of a unique completion. Never typed evidence. */
  canonicalToken: string | null;
  completedTokens: string[];
  canonicalTokens: string[];
  source: "final-token-prefix";
  ambiguous: boolean;
}

export interface SearchExplanation {
  query: {
    raw: string;
    originalSurface?: string[];
    tokens?: unknown[];
    concepts?: unknown[];
    alternatives?: unknown[];
    prefixCompletion?: PrefixCompletion | null;
    contextualCompletion?: {
      activePrefix: string;
      completedToken: string;
      canonicalToken: string;
      source: "configured-form-prefix";
    } | null;
    configuredSequenceIntent?: {
      key: string;
      matchedForm: string[];
      matchedKinds: string[];
    } | null;
    configuredContentIdentity?: {
      key: string;
    } | null;
    configuredSpans?: Array<{
      key: string;
      start: number;
      end: number;
      matchedKinds: string[];
    }>;
    configuredPrefixSpans?: Array<{
      key: string;
      start: number;
      end: number;
      matchedKinds: string[];
      usedPrefix: true;
    }>;
    standaloneRecall?: {
      key: string;
      sourceToken: string;
    } | null;
    topicalRecall?: {
      key: string;
      forms: string[][];
    } | null;
    equivalentRecall?: Array<{ source: string; target: string }>;
    lexicalTokens?: unknown[];
    lexicalPhraseKey?: string;
    normalizedQueryPhrase?: string;
  };
  retrievalSources: string[];
  relevanceKind: RelevanceKind;
  directClass?: DirectClass;
  features: Record<string, unknown>;
  lexical?: {
    normalizedQueryPhrase: string;
    matchingPhraseKey: string | null;
    bodyPhraseCount: number;
    bodyPhraseFrequency: number;
  };
  contextualPrefix?: {
    matchedPrefixTokens: string[];
    activeFinalPrefix: string | null;
    completedTitleToken: string | null;
    unmatchedTitleTokensAfter: number;
    titleSequenceTightness: number;
    contextualPrefixQuality: number;
  };
  relationship: RelationshipInfo | null;
  constraintsVsNext?: unknown;
  constraintMeta?: unknown;
}

export interface SearchDetailedResult {
  results: SearchResult[];
  related: SearchResult[];
  /** @experimental Timing and candidate diagnostics. */
  meta?: Record<string, unknown>;
}

export interface IndexResult {
  documentCount: number;
  buildMs: number;
}

export interface SearchEngine {
  index(documents: SearchDocument[]): Promise<IndexResult>;
  search(query: string, options?: SearchOptions): SearchResult[];
  searchDetailed(query: string, options?: SearchOptions): SearchDetailedResult;
  searchAsync(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  searchDetailedAsync(query: string, options?: SearchOptions): Promise<SearchDetailedResult>;
}

export interface SearchEngineConstructor {
  new (): SearchEngine;
  create(options?: SearchEngineOptions): SearchEngine;
  prototype: SearchEngine;
}

export type RelationshipKind = "equivalent" | "related";

export type RelationshipEndpoint =
  | { form: string | string[] }
  | { concept: string }
  | { document: string };

export interface AuthoredRelationshipEdge {
  to: RelationshipEndpoint;
  kind: RelationshipKind;
}

export type RelationshipMap = Record<string, AuthoredRelationshipEdge[]>;

export interface MigratedConfiguredEntry {
  entry: ConfiguredConcept;
  discardedPrimary: string | null;
  standaloneRelationships: Array<{ sourceToken: string; concept: string }>;
  topicalRelationships: Array<{ concept: string; form: string[] }>;
}

export interface CompiledAuthoredRelevance {
  /**
   * Canonical SearchEngine plugin list for authored relevance: configured-concept
   * recognition (including compiled standalone/topical related recall) then
   * compiled equivalent one-hop recall. Pass as `plugins: [morphology(), ...authored.plugins]`.
   * Order is owned by the compiler.
   */
  plugins: SearchPlugin[];
  /**
   * Authored document→document edges as a `search-v2-relationships` artifact,
   * or `null` when none were authored. Pass as `SearchEngine.create({ documentRelationships })`.
   * Combine with a generated semantic artifact via `mergeRelationships(semantic, authored.documentRelationships)`.
   */
  documentRelationships: RelationshipArtifact | null;
}

export interface RelationshipEdge {
  target: string;
  type?: string;
  strength?: number;
  provenance?: string | null;
}

export interface RelationshipArtifact {
  format: "search-v2-relationships";
  version: 1;
  relationships: Record<string, RelationshipEdge[]>;
}

export interface InvalidConfigurationError extends Error {
  field: string | null;
  expected: string | null;
}
export interface InvalidDocumentError extends Error {
  index: number | null;
  field: string | null;
}
export interface ArtifactVersionError extends Error {
  format: string | null;
  version: number | null;
}
export interface ArtifactValidationError extends Error {
  format: string | null;
  field: string | null;
}
export interface IndexStateError extends Error {}

export interface InvalidConfigurationErrorConstructor {
  new (message?: string): InvalidConfigurationError;
  prototype: InvalidConfigurationError;
}
export interface InvalidDocumentErrorConstructor {
  new (message?: string): InvalidDocumentError;
  prototype: InvalidDocumentError;
}
export interface ArtifactVersionErrorConstructor {
  new (message?: string): ArtifactVersionError;
  prototype: ArtifactVersionError;
}
export interface ArtifactValidationErrorConstructor {
  new (message?: string): ArtifactValidationError;
  prototype: ArtifactValidationError;
}
export interface IndexStateErrorConstructor {
  new (message?: string): IndexStateError;
  prototype: IndexStateError;
}
