/**
 * @software-land/search public TypeScript declarations.
 * Implementation remains JavaScript. These types describe the stable v0 facade.
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

export interface SearchEngineOptions {
  schema?: Schema;
  plugins?: unknown[];
  relationships?: RelationshipArtifact | null;
  relationshipStrategy?: RelationshipStrategy;
  retriever?: RetrieverName | "indexed-lexical" | { retrieve: Function; retrieveAsync?: Function; prepare?: Function; name?: string };
  candidateLimit?: number;
  adaptive?: AdaptiveOptions;
  /** @experimental Default 0. Not a supported ranking feature. */
  retrievalScoreWeight?: number;
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
  completedToken: string | null;
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

export declare class SearchEngine {
  static create(options?: SearchEngineOptions): SearchEngine;
  index(documents: SearchDocument[]): Promise<IndexResult>;
  search(query: string, options?: SearchOptions): SearchResult[];
  searchDetailed(query: string, options?: SearchOptions): SearchDetailedResult;
  searchAsync(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  searchDetailedAsync(query: string, options?: SearchOptions): Promise<SearchDetailedResult>;
}

export declare function english(options?: { lemmas?: Record<string, string> }): unknown;
export declare function dictionary(options?: { entries?: EquivalenceEntry[] }): unknown;

export interface EquivalenceEntry {
  key: string;
  expansion?: string[];
  aliases?: string[][];
  primary?: string | null;
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

export declare const RELATIONSHIP_STRATEGIES: readonly RelationshipStrategy[];
export declare const DEFAULT_RELATIONSHIP_STRATEGY: "hybrid";
export declare const RETRIEVER_NAMES: readonly RetrieverName[];
export declare const DEFAULT_CANDIDATE_LIMIT: 200;
export declare const DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD: 1500;
export declare const ARTIFACT_FORMATS: {
  equivalences: "search-v2-equivalences";
  synonyms: "search-v2-synonyms";
  relationships: "search-v2-relationships";
  corpusStats: "search-v2-corpus-stats";
};
export declare const ARTIFACT_VERSION: 1;
export declare const PUBLIC_EXPORTS: readonly string[];

export declare function parseEquivalences(obj?: unknown): EquivalenceArtifact;
export declare function parseSynonyms(obj?: unknown): SynonymArtifact;
export declare function parseRelationships(obj?: unknown): RelationshipArtifact;

export declare function abortError(message?: string): Error;
export declare function isAbortError(err: unknown): boolean;

export declare class InvalidConfigurationError extends Error {
  field: string | null;
  expected: string | null;
}
export declare class InvalidDocumentError extends Error {
  index: number | null;
  field: string | null;
}
export declare class ArtifactVersionError extends Error {
  format: string | null;
  version: number | null;
}
export declare class ArtifactValidationError extends Error {
  format: string | null;
  field: string | null;
}
export declare class IndexStateError extends Error {}
