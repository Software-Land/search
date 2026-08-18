/**
 * Internal Search V2 contracts for checkJs.
 * Public facade types live in index.d.ts; this file describes implementation shapes.
 */

export type RelationshipStrategy = "none" | "mixed" | "hybrid" | "separate";
export type RetrieverName = "full-scan" | "indexed" | "adaptive";
export type RelevanceKind = "direct" | "related";
export type DirectClass = "strong" | "moderate" | "weak" | "none";
export type TextRole = "title" | "body";
export type ConstraintClass = "absolute" | "strong" | "soft";
export type SourcePolicy = "top1-strong" | "all-strong" | "top-n-strong" | string;

export interface SchemaField {
  type?: "text";
  role?: TextRole;
}

export type Schema = Record<string, SchemaField | null | undefined>;

export interface SearchDocument {
  id?: unknown;
  title?: unknown;
  body?: unknown;
  metadata?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface DictionaryEntry {
  key: string;
  expansion: string[];
  aliases: string[][];
  primary?: string | null;
  type?: string;
  provenance?: string | null;
  confidence?: number | null;
}

export interface DictionarySequence {
  entry: DictionaryEntry;
  tokens: string[];
  kind: "key" | "expansion" | "alias" | string;
}

export interface SearchPlugin {
  name?: string;
  lemma?: (token: string) => string;
  lexicon?: () => Iterable<string>;
  sequences?: DictionarySequence[];
  byKey?: Map<string, DictionaryEntry>;
  expand?: (token: string) => Array<{
    form: string;
    type?: string;
    provenance?: string;
    confidence?: number | null;
  }>;
  collapseRepeats?: (token: string) => string;
  entries?: DictionaryEntry[];
  format?: string;
  version?: number;
  lookup?: Map<string, unknown>;
}

export interface QueryToken {
  surface: string;
  normalized: string;
  lemma: string;
  sources: string[];
}

export interface QueryConcept {
  id: string;
  kind: string;
  forms: string[];
  provenance: string;
}

export interface QueryAlternative {
  tokens: string[];
  source: string;
  confidence: number;
}

export interface AnalyzedQuery {
  raw: string;
  originalSurface: string[];
  tokens: QueryToken[];
  concepts: QueryConcept[];
  alternatives: QueryAlternative[];
  dottedSpans: string[];
  stopstripped: QueryToken[];
}

export interface AnalyzeOptions {
  plugins?: SearchPlugin[];
  lexicon?: Iterable<string> | Set<string>;
  signal?: AbortSignal;
}

export interface IndexedDocument {
  id: string;
  raw: { id: string; title: string; body: string; metadata?: Record<string, unknown> };
  title: string;
  body: string;
  titleTokens: string[];
  bodyTokens: string[];
  titleLemmas: string[];
  bodyLemmas: string[];
  titleLemmaSet: Set<string>;
  bodyLemmaSet: Set<string>;
  titleTokenSet: Set<string>;
  bodyTokenSet: Set<string>;
  nonStopTitle: string[];
  firstToken: string;
  normalizedTitle: string;
  versionCompactForms: string[];
  dottedSpans: string[];
}

export interface ResolvedSchema {
  fields: Schema;
  titleField: string;
  bodyField: string;
}

export interface SearchIndex {
  schema: ResolvedSchema;
  documents: IndexedDocument[];
  byId: Map<string, IndexedDocument>;
  titleTokenSet: Set<string>;
}

export interface RelationshipEdge {
  target: string;
  type?: string;
  strength?: number;
  provenance?: string | null;
}

export interface RelationshipArtifact {
  format: string;
  version: number;
  relationships: Record<string, RelationshipEdge[]>;
}

export interface RelationshipGraphApi {
  name: string;
  format: string;
  version: number;
  empty: boolean;
  neighbors(sourceId: string): RelationshipEdge[];
  has(sourceId: string): boolean;
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

export type RetrievalSource = string;

export interface RetrievalHit {
  document: IndexedDocument;
  retrievalSources: RetrievalSource[];
  retrievalScore?: number;
  relationship?: RelationshipInfo | null;
}

export interface FeatureVector {
  exactTitleMatch: boolean;
  exactTitleTokenMatch: boolean;
  titleCoverage: number;
  queryCoverage: number;
  titlePrefixQuality: number;
  configuredEquivalenceMatch: false | "key-in-title" | "expansion" | "related" | string;
  morphologyMatch: boolean;
  typoDistance: number;
  versionMatch: false | string;
  shortLiteralLeadMatch: boolean;
  phraseAdjacency: number;
  bodyLexicalMatch: number;
  titleTokenCount: number;
  expansionEvidence: number;
  canonicalKeyTitle: boolean;
  relationshipStrength: number;
  relationshipType: string | null;
  relationshipSourceId: string | null;
  retrievalScore: number;
  relevanceKind: RelevanceKind;
  directClass: DirectClass;
  [key: string]: unknown;
}

export interface FeaturedHit extends RetrievalHit {
  features: FeatureVector;
  score?: number;
}

export interface ConstraintDef {
  id: string;
  invariant: string;
  class: ConstraintClass | string;
  fn: (a: FeaturedHit, b: FeaturedHit) => number;
}

export interface ConstraintCompareResult {
  order: number;
  applied: Array<{ id: string; invariant: string; class: string; result: string }>;
  conflict?: boolean;
  decisiveClass?: string;
  resolution?: string;
}

export interface RankedHit extends FeaturedHit {
  score: number;
  rank: number;
  constraintVsNext: ConstraintCompareResult;
  constraintMeta: { cycles: unknown[]; conflictCount: number };
}

export interface Retriever {
  name?: string;
  prepare: (index: SearchIndex, extra?: { schema?: Schema }) => void;
  retrieve: (query: AnalyzedQuery, index: SearchIndex, options?: RetrieveOptions) => RetrievalHit[];
  retrieveAsync: (
    query: AnalyzedQuery,
    index: SearchIndex,
    options?: RetrieveOptions
  ) => Promise<RetrievalHit[]>;
  stats?: () => Record<string, unknown>;
}

export interface RetrieveOptions {
  signal?: AbortSignal;
  candidateLimit?: number | null;
}

export interface AdaptiveOptions {
  documentThreshold?: number;
}

export interface IndexedLexicalOptions {
  candidateLimit?: number;
  prefixCap?: number;
  unionDeterministic?: boolean;
  titleBoost?: number;
  type?: string;
}

export interface AdaptiveRetrieverOptions {
  documentThreshold?: number;
  smallLimit?: number;
  indexedOptions?: IndexedLexicalOptions;
  type?: string;
}

export interface Posting {
  df: number;
  docs: number[];
  tfs: number[];
}

export interface IndexedLexicalState {
  prepared: boolean;
  n: number;
  titlePostings: Map<string, Posting>;
  bodyPostings: Map<string, Posting>;
  titleLemmaPostings: Map<string, Posting>;
  bodyLemmaPostings: Map<string, Posting>;
  sortedTerms: string[];
  sortedTitles: Array<{ norm: string; pos: number }>;
  titleByNorm: Map<string, number[]>;
  versionIndex: Map<string, number[]>;
  titleDl: number[];
  bodyDl: number[];
  avgTitleDl: number;
  avgBodyDl: number;
  postingBytes: number;
  termCount: number;
}

export type ExtractFeaturesFn = (
  query: AnalyzedQuery,
  doc: IndexedDocument,
  extra?: { relationship?: RelationshipInfo | null; retrievalScore?: number }
) => FeatureVector;

export type ScoreFeaturesFn = (features: Partial<FeatureVector>) => number;

export interface RelationshipExpansionArgs {
  featured?: FeaturedHit[];
  query?: AnalyzedQuery;
  extractFeatures?: ExtractFeaturesFn;
  scoreFeatures?: ScoreFeaturesFn;
  index?: SearchIndex | null;
  graph?: RelationshipGraphApi | null;
  sourcePolicy?: SourcePolicy;
  signal?: AbortSignal;
}

export interface ConstraintGraph {
  n: number;
  edges: number[][];
  pairReports: Array<ConstraintCompareResult & { i: number; j: number }>;
}

export interface SearchEngineOptions {
  schema?: Schema;
  plugins?: Array<SearchPlugin | null | undefined>;
  relationships?: RelationshipArtifact | RelationshipGraphApi | null;
  relationshipStrategy?: RelationshipStrategy | string;
  retriever?: RetrieverName | "indexed-lexical" | Retriever | IndexedLexicalOptions | AdaptiveRetrieverOptions | null;
  candidateLimit?: number | null;
  adaptive?: AdaptiveOptions | null;
  retrievalScoreWeight?: number;
}

export interface SearchOptions {
  limit?: number;
  relatedLimit?: number;
  explain?: boolean;
  relationshipStrategy?: RelationshipStrategy | string;
  signal?: AbortSignal;
  candidateLimit?: number | null;
  sourcePolicy?: SourcePolicy;
}

export interface SearchResultRow {
  id: string;
  title: string;
  rank: number;
  score?: number;
  relevanceKind: RelevanceKind | string;
  directClass?: DirectClass | string;
  relationship?: RelationshipInfo;
  retrievalSources?: string[];
  features?: FeatureVector | Record<string, unknown>;
  constraints?: unknown;
  explanation?: unknown;
}

export interface ExpansionResult {
  featured: FeaturedHit[];
  relatedHits: RetrievalHit[];
  primaries: FeaturedHit[];
}

export interface TypoSuggestion {
  form: string;
  distance: number;
  provenance: string;
}

export interface FinishTimings {
  limit: number;
  relatedLimit: number;
  retrieveMs: number;
  featureMs: number;
  relationshipMs: number;
  rankMs: number;
  totalMs: number;
  candidateCount: number;
  relationshipExpanded: number;
  primaryId: string | null;
  primaryIds: string[];
}
