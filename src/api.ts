/**
 * Designed public type contract for @software-land/search.
 * Implementation details (FeatureVector, AnalyzedQuery, IndexedDocument) stay internal.
 * SearchPlugin and ExperimentalRetriever are the public authoring contracts for
 * `SearchEngine.create({ plugins, retriever })`. Runtime still duck-types plugins
 * and custom retrievers; the declarations no longer leave those slots untyped.
 */

export type TextRole = "title" | "body";

export interface SchemaField {
  type: "text";
  role?: TextRole;
}

export type Schema = Record<string, SchemaField>;

export interface SearchDocument {
  id: string;
  title?: string;
  body?: string;
  metadata?: Record<string, unknown>;
  [field: string]: unknown;
}

export type RelationshipStrategy = "none" | "mixed" | "hybrid" | "separate";
export type RetrieverName = "full-scan" | "indexed" | "adaptive";
export type RelevanceKind = "direct" | "related";
export type DirectClass = "strong" | "moderate" | "weak" | "none";

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
 * If `sequences` is present, Core reads `tokens` and `entry.key` on each item.
 */
export interface SearchPlugin {
  name?: string;
  /** Deterministic identity for plugin behavior compiled into a lexical index. */
  indexIdentity?: string;
  lemma?(token: string): string;
  canonicalLemma?(token: string): string | null;
  lexicon?(): Iterable<string>;
  sequences?: ReadonlyArray<{
    tokens: readonly string[];
    kind?: string;
    entry: EquivalenceEntry;
  }>;
  byKey?: ReadonlyMap<string, EquivalenceEntry>;
  /** Unique reviewed standalone token → configured key. Collisions are omitted. */
  standaloneRecallByToken?: ReadonlyMap<string, string>;
  expand?(token: string): Array<{ form: string }>;
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

/**
 * Configured-equivalence plugin shape. `dictionary()` returns `DictionaryPlugin`.
 * Core does not read a plugin `entries` array.
 */
export interface DictionaryPlugin extends SearchPlugin {
  name: "dictionary";
  sequences: NonNullable<SearchPlugin["sequences"]>;
  byKey: ReadonlyMap<string, EquivalenceEntry>;
  standaloneRecallByToken?: ReadonlyMap<string, string>;
  lexicon(): Iterable<string>;
}

/** Opt-in near-synonym plugin shape. Detected when `name === "synonyms"`. */
export interface SynonymPlugin extends SearchPlugin {
  name: "synonyms";
  expand(token: string): Array<{ form: string }>;
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
  relationships?: RelationshipArtifact | null;
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
      source: "configured-expansion-prefix";
    } | null;
    configuredSequenceIntent?: {
      key: string;
      expansion: string[];
      matchedKinds: string[];
    } | null;
    standaloneRecall?: {
      key: string;
      sourceToken: string;
    } | null;
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

export interface EquivalenceEntry {
  key: string;
  expansion?: string[];
  aliases?: string[][];
  primary?: string | null;
  /** Reviewed exact standalone tokens that may open secondary configured recall. */
  standaloneRecall?: string[];
  type?: string;
  provenance?: string | null;
  confidence?: number | null;
}

export interface EquivalenceArtifact {
  format: "search-v2-equivalences";
  version: 1;
  entries: EquivalenceEntry[];
}

export interface SynonymArtifact {
  format: "search-v2-synonyms";
  version: 1;
  entries: Array<{ terms: string[]; type?: string; provenance?: string | null; confidence?: number | null }>;
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
