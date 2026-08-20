/**
 * Internal Search Core contracts for checkJs.
 * Public facade types live in api.ts / index.ts; this file describes implementation shapes.
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
  /** Explicit lemma-table identity only; omit suffix-heuristic stems. */
  canonicalLemma?: (token: string) => string | null;
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
  /** Literal tokenize() surface. */
  surface: string;
  /**
   * Repaired typed form after allowed surface repair (repeat-collapse / leet /
   * typo), frozen before lemma and unique-prefix completion. Use for
   * typed/ranking evidence: what the user typed, and how complete that typing
   * was. Do not treat rewritten `normalized`, `lemma`, or `completedToken` as
   * a substitute.
   */
  surfaceNormalized?: string;
  /**
   * Canonical retrieval identity after analysis. May include morphology/table
   * normalization and unique-prefix completion. Use for retrieval and
   * canonical-identity features (exact title token, phrase keys, compact
   * version digits). Not typed evidence.
   */
  normalized: string;
  /**
   * Morphology / canonical morphology layer. May reflect inferred unique-prefix
   * completion. Never a fallback for typed companion evidence.
   */
  lemma: string;
  /** Provenance of analysis steps applied to this token. */
  sources: string[];
  /**
   * Inferred unique-prefix completion of this token, when present. Retrieval /
   * explanation metadata only. Never typed evidence.
   */
  completedToken?: string;
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

export interface ContextualTitlePrefix {
  matchedPrefixTokens: string[];
  activeFinalPrefix: string;
  completedTitleToken: string;
  unmatchedTitleTokensAfter: number;
  titleSequenceTightness: number;
  contextualPrefixQuality: number;
}

export interface QueryConcept {
  id: string;
  kind: string;
  /**
   * Recall bag of surface, repaired, canonical, lemma, and completed forms.
   * Not a proxy for what the user typed; do not use as typed companion evidence.
   */
  forms: string[];
  provenance: string;
  expansion?: string[];
  aliases?: string[][];
  matchedExpansionTokens?: number;
  expansionTokenCount?: number;
  expansionCoverage?: number;
}

export interface QueryAlternative {
  tokens: string[];
  source: string;
  confidence: number;
}

export interface AnalyzedQuery {
  /** Raw query string. Future semantic embedding should use this by default. */
  raw: string;
  originalSurface: string[];
  /**
   * Lexical intent after analysis, including unique-prefix rewrite and unique
   * configured-key projection. Not the typed key; not a semantic embed string.
   */
  tokens: QueryToken[];
  concepts: QueryConcept[];
  alternatives: QueryAlternative[];
  dottedSpans: string[];
  prefixCompletion?: PrefixCompletion | null;
  lexicalTokens: QueryToken[];
  lexicalPhraseTokens: string[];
  lexicalPhraseKey: string;
  stopstripped: QueryToken[];
}

export interface AnalyzeOptions {
  plugins?: SearchPlugin[];
  lexicon?: Iterable<string> | Set<string>;
  prefixLexicon?: Iterable<string> | Set<string>;
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
  lexicalFrequency: Record<string, number> | null;
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
  surfaceVocabulary: Set<string>;
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
  typedSurfaceTitleMatch: boolean;
  titleCoverage: number;
  queryCoverage: number;
  titlePrefixQuality: number;
  contextualTitlePrefix: boolean;
  matchedPrefixTokens: string[];
  activeFinalPrefix: string | null;
  completedTitleToken: string | null;
  unmatchedTitleTokensAfter: number;
  titleSequenceTightness: number;
  contextualPrefixQuality: number;
  configuredEquivalenceMatch: false | "key-in-title" | "expansion";
  morphologyMatch: boolean;
  typoDistance: number;
  versionMatch: false | string;
  shortLiteralLeadMatch: boolean;
  phraseAdjacency: number;
  bodyLexicalMatch: number;
  titleTokenCount: number;
  expansionEvidence: number;
  canonicalKeyTitle: boolean;
  queryTokenCount: number;
  normalizedQueryPhrase: string;
  matchingPhraseKey: string | null;
  bodyPhraseCount: number;
  bodyPhraseFrequency: number;
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
  constraints?: ConstraintDef[];
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
