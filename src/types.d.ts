/**
 * Internal Search Core contracts for checkJs.
 * Public facade types live in api.ts / index.ts; this file describes implementation shapes.
 */

export type RelationshipStrategy = "none" | "mixed" | "hybrid" | "separate";
export type RetrieverName = "full-scan" | "indexed" | "adaptive";
export type RelevanceKind = "direct" | "related";
export type DirectClass = "strong" | "moderate" | "weak" | "none";
export type TextRole = "title" | "body" | "summary";
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

export interface ConfiguredConcept {
  key: string;
  /** Unordered peer lexical forms. Alias array order has no search semantic effect. */
  aliases?: string[][];
  type?: string;
  provenance?: string | null;
  confidence?: number | null;
}

/** Exact one-token recall bridge. Not configured concept or lexical intent. */
export interface StandaloneRecall {
  key: string;
  sourceToken: string;
  expansion: string[];
  aliases: string[][];
  forms: string[];
}

/**
 * One-hop topical recall attached to a trusted configured concept.
 * Forms are tokenized phrases. Not query identity and not reverse edges.
 */
export interface TopicalRecall {
  key: string;
  forms: string[][];
}

export interface ConfiguredConceptSequence {
  concept: ConfiguredConcept;
  tokens: string[];
  kind: "key" | "form" | string;
}

export interface SearchPlugin {
  name?: string;
  /** Deterministic identity for document-index-affecting plugin behavior. */
  indexIdentity?: string;
  lemma?: (token: string) => string;
  /** Explicit lemma-table identity only; omit suffix-heuristic stems. */
  canonicalLemma?: (token: string) => string | null;
  lexicon?: () => Iterable<string>;
  /** Inflected lemma-table keys for typo vocabulary. Not a public root export. */
  lemmaTableKeys?: () => Iterable<string>;
  sequences?: ConfiguredConceptSequence[];
  byKey?: Map<string, ConfiguredConcept>;
  standaloneRecallByToken?: Map<string, string>;
  topicalRecallByKey?: Map<string, string[][]>;
  expand?: (token: string) => Array<{
    form: string;
    type?: string;
    provenance?: string;
    confidence?: number | null;
  }>;
  collapseRepeats?: (token: string) => string;
  format?: string;
  version?: number;
  lookup?: Map<string, unknown>;
  directionality?: "directional" | "symmetric";
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

/**
 * Unique configured-form completion of a trailing typed stub.
 * Ranking evidence only. Never a rewrite of the typed QueryToken.
 */
export interface ContextualCompletion {
  activePrefix: string;
  completedToken: string;
  canonicalToken: string;
  source: "configured-form-prefix";
}

/**
 * Unique complete-query alignment to one configured concept.
 * `matchedForm` is the matched peer form for this query (explain/provenance).
 * It is not a canonical or privileged alias. Concept-level ranking uses
 * the unordered set of peer forms.
 */
export interface ConfiguredSequenceIntent {
  key: string;
  matchedForm: string[];
  matchedKinds: string[];
}

/**
 * Exact configured subspan in analyzed query tokens. Indexes are [start, end).
 * Diagnostic and span-triggered topical activation only; not lexical identity.
 */
export interface ConfiguredSpan {
  key: string;
  start: number;
  end: number;
  matchedKinds: string[];
}

/** Unique complete configured concept with only structural-wrapper remainder. */
export interface ConfiguredContentIdentity {
  key: string;
}

/**
 * Incomplete configured subspan aligned with sequenceAligns prefix rules,
 * plus unique 1-token first-form prefixes. Occupies configured-concept
 * evidence only. Not exact configuredSpans, not whole-query
 * configuredSequenceIntent, and not topical recall.
 */
export interface ConfiguredPrefixSpan {
  key: string;
  start: number;
  end: number;
  matchedKinds: string[];
  usedPrefix: true;
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
  matchedForm?: string[];
  aliases?: string[][];
  matchedFormTokens?: number;
  formTokenCount?: number;
  formCoverage?: number;
}

export interface SearchEquivalenceRecall {
  source: string;
  target: string;
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
   * Typed query identity after analysis, including unique-prefix rewrite of
   * the final token when applicable. Unique configured-key matches no longer
   * rewrite these tokens. Occupied concept-level ranking evaluates each peer
   * form independently; `lexicalTokens` is not a concatenated alias stream.
   */
  tokens: QueryToken[];
  concepts: QueryConcept[];
  alternatives: QueryAlternative[];
  dottedSpans: string[];
  prefixCompletion?: PrefixCompletion | null;
  /**
   * Unique configured-form completion of the trailing typed token.
   * Present only when the completion is unambiguous under trusted peer forms.
   */
  contextualCompletion?: ContextualCompletion | null;
  /**
   * Unique complete-query alignment to one configured concept key.
   * Absent when no sequence matches or multiple keys remain plausible.
   */
  configuredSequenceIntent?: ConfiguredSequenceIntent | null;
  /**
   * Exact configured key/form windows. Absent or empty when no
   * exact subspan matches. Not whole-query configuredSequenceIntent.
   */
  configuredSpans?: ConfiguredSpan[];
  /**
   * Unique incomplete configured windows aligned with sequenceAligns.
   * Present only when activated: n>=2, usedPrefix, unique key, remainder
   * tokens are existing stopwords, and whole-query intent is absent.
   * Not exact configuredSpans and not topical recall.
   */
  configuredPrefixSpans?: ConfiguredPrefixSpan[];
  /**
   * Unique complete configured concept with only structural-wrapper remainder
   * (WH / copula / determiner) before a suffix exact span. Not occupancy.
   * Prefix spans never qualify. Coordinators/prepositions outside the span
   * are unmatched composition.
   */
  configuredContentIdentity?: ConfiguredContentIdentity | null;
  /**
   * Reviewed exact-standalone recall hint. Absent unless the complete query is
   * one typed token that uniquely matches a `standaloneRecall` declaration.
   * Does not rewrite tokens, lexical intent, or configuredSequenceIntent.
   */
  standaloneRecall?: StandaloneRecall | null;
  /**
   * One-hop topical recall for a trusted configured concept: either
   * configuredSequenceIntent.key or a unique exact configured span whose
   * remaining tokens are existing stopwords. Absent unless that key declares
   * topicalRecall forms. Does not rewrite tokens, lexical intent, or
   * configuredSequenceIntent.
   */
  topicalRecall?: TopicalRecall | null;
  /**
   * One-hop search-equivalence recall pairs admitted from accepted query
   * semantics. Absent or empty when no equivalent-recall plugin fires. Does not rewrite
   * tokens, lexical intent, or configured-concept occupancy.
   */
  equivalentRecall?: SearchEquivalenceRecall[];
  /**
   * Canonical lexical-intent stream for compiled phrase lookup. May include
   * unique contextual form completion for unoccupied queries.
   * Occupied configured concepts do not concatenate peer aliases here.
   * Not typed identity; ranking features that mean "what the user typed" must
   * use `tokens` / `surfaceNormalized`. Occupied ranking evaluates each peer
   * form independently.
   */
  lexicalTokens: QueryToken[];
  lexicalPhraseTokens: string[];
  lexicalPhraseKey: string;
  /**
   * Lemmatized token streams for each occupied peer form, independently.
   * Used for compiled phrase lookup. Never concatenated into one query.
   */
  peerFormLexical?: string[][];
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
  raw: { id: string; title: string; body: string; summary?: string; metadata?: Record<string, unknown> };
  title: string;
  body: string;
  /** Optional third text field. Empty when the schema omits role `summary`. Phrase/configured/ranking evidence, not unigram postings. */
  summary: string;
  titleTokens: string[];
  bodyTokens: string[];
  summaryTokens: string[];
  titleLemmas: string[];
  bodyLemmas: string[];
  summaryLemmas: string[];
  titleLemmaSet: Set<string>;
  bodyLemmaSet: Set<string>;
  summaryLemmaSet: Set<string>;
  titleTokenSet: Set<string>;
  bodyTokenSet: Set<string>;
  summaryTokenSet: Set<string>;
  nonStopTitle: string[];
  firstToken: string;
  normalizedTitle: string;
  versionCompactForms: string[];
  dottedSpans: string[];
  /**
   * Indexes into titleTokens whose source range is a dotted numeric span
   * component (the "2" in "1.2"). Not independent exact-title evidence.
   */
  dottedSpanComponentIndexes: Set<number>;
  independentTitleTokens?: string[];
  independentTitleTokenSet?: Set<string>;
  independentTitleLemmaSet?: Set<string>;
  bodyTokenPositions?: Map<string, number[]>;
  bodyLemmaPositions?: Map<string, number[]>;
  lexicalFrequency: Record<string, number> | null;
}

export interface ResolvedSchema {
  fields: Schema;
  titleField: string;
  bodyField: string;
  /** Null when the schema has no `summary` role. */
  summaryField: string | null;
}

export interface SearchIndex {
  schema: ResolvedSchema;
  documents: IndexedDocument[];
  byId: Map<string, IndexedDocument>;
  titleTokenSet: Set<string>;
  surfaceVocabulary: Set<string>;
  /** Internal compact postings compiled at build time or initialization. */
  compiledLexical?: unknown;
  /** Inverted positional postings for PhraseQuery / PhrasePrefixQuery / token-graph execution. */
  positional?: unknown;
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
  /** Stable compiled document ordinal; internal exact-pruning metadata. */
  documentOrdinal?: number;
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
  configuredConceptMatch: false | "key-in-title" | "form";
  /**
   * Resolved configured-concept evidence by field. `title` is authored
   * identity (`key` / complete `form`). `summary` and `body` are mentions,
   * never identity. A single token of a multi-token form is not `form`.
   */
  configuredConceptFieldEvidence: {
    title: false | "key" | "form";
    summary: false | "key" | "form";
    body: false | "key" | "form";
  };
  morphologyMatch: boolean;
  typoDistance: number;
  versionMatch: false | string;
  shortLiteralLeadMatch: boolean;
  dottedSpanComponentTitleMatch: boolean;
  phraseAdjacency: number;
  bodyLexicalMatch: number;
  lexicalConceptCoverage: number;
  coverageConceptCount: number;
  /**
   * Candidate body matches a directed target of an ordinary same-concept
   * search equivalence. This is provenance, not additional coverage.
   */
  ordinaryEquivalenceBodyMatch: boolean;
  titleTokenCount: number;
  configuredFormEvidence: number;
  /**
   * Occupied matched-form completeness from query analysis.
   * 0 when the query does not uniquely occupy a configured concept.
   * Unique occupancy does not imply this is 1.
   */
  configuredFormCoverage: number;
  /**
   * Unambiguous partial configured-form prefix with a contiguous
   * n≥3 peer form in the body.
   */
  configuredFormBodyMatch: boolean;
  canonicalKeyTitle: boolean;
  /**
   * Non-stop analyzed query token count. Occupied concepts use the max
   * non-stop length of one peer form. This summary is not a lexical scoring
   * denominator; per-form features use that form's own length.
   */
  queryTokenCount: number;
  normalizedQueryPhrase: string;
  matchingPhraseKey: string | null;
  bodyPhraseCount: number;
  bodyPhraseFrequency: number;
  /** Exact typed-surface phrase occurrences in the title field. */
  titlePhraseFrequency: number;
  /** Exact typed-surface phrase occurrences in the optional summary field. */
  summaryPhraseFrequency: number;
  /** True when the complete typed phrase occurs in title or summary. */
  exactTitleOrSummaryPhrase: boolean;
  standaloneRecallMatch?: boolean;
  standaloneRecallScore?: number;
  topicalRecallMatch?: boolean;
  topicalRecallFormCount?: number;
  topicalRecallTitleMatch?: boolean;
  topicalRecallPhraseMatch?: boolean;
  topicalRecallScore?: number;
  equivalentRecallMatch?: boolean;
  equivalentRecallFormCount?: number;
  equivalentRecallTitleMatch?: boolean;
  equivalentRecallBodyMatch?: boolean;
  equivalentRecallScore?: number;
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
  exactSignatureSelection?: boolean;
  prepare: (index: SearchIndex, extra?: { schema?: Schema; plugins?: SearchPlugin[] }) => void;
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
  /**
   * Internal Stage-2B flag. When true, already-walked posting arrays are not
   * decoded again. Membership stays exhaustive; BM25 retrievalScore is not
   * double-counted. The engine enables this only when retrievalScoreWeight is 0.
   */
  skipDuplicatePostingLists?: boolean;
  /**
   * Internal Stage-3A flag. When set, compiled retrieval may skip unread
   * 1-of-k body blocks after stronger co-occurrence classes are evaluated.
   * Fail closed to exhaustive compiled retrieval if the proof does not hold.
   */
  exactBlockSkip?: false | { requiredDepth: number };
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

/**
 * Internal packed directed-edge store. Not a public package type.
 * Each edge is two uint32 candidate indexes in insertion order.
 */
export interface PackedConstraintEdges {
  readonly length: number;
  readonly chunkEdges: number;
  append(from: number, to: number): void;
  forEachEdge(visit: (u: number, v: number) => void): void;
  allocatedBytes(): number;
  fromAt(i: number): number;
  toAt(i: number): number;
  [Symbol.iterator](): IterableIterator<[number, number]>;
}

export interface ConstraintCsr {
  offsets: Uint32Array;
  neighbors: Uint32Array;
}

/**
 * Kosaraju result. `cycles` are copies of multi-node `groups` entries,
 * not aliases. `adj` is forward CSR only; reverse CSR is not retained.
 */
export interface ConstraintScc {
  comp: number[];
  groups: number[][];
  cycles: number[][];
  adj: ConstraintCsr;
}

export interface ConstraintGraph {
  n: number;
  edges: PackedConstraintEdges;
  /**
   * Conflict diagnostics only. Unordered / no-decision pairs are compared
   * during graph construction but not retained.
   */
  pairReports: Array<ConstraintCompareResult & { i: number; j: number }>;
}

export interface SearchEngineOptions {
  schema?: Schema;
  plugins?: Array<SearchPlugin | null | undefined>;
  lexicalIndex?: LexicalIndexArtifact | null;
  documentRelationships?: RelationshipArtifact | RelationshipGraphApi | null;
  relationshipStrategy?: RelationshipStrategy | string;
  retriever?: RetrieverName | "indexed-lexical" | Retriever | IndexedLexicalOptions | AdaptiveRetrieverOptions | null;
  candidateLimit?: number | null;
  adaptive?: AdaptiveOptions | null;
  retrievalScoreWeight?: number;
}

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
  /** Versioned opaque payload. Posting internals are intentionally not public API. */
  data: unknown;
}

export interface SearchOptions {
  limit?: number;
  relatedLimit?: number;
  explain?: boolean;
  relationshipStrategy?: RelationshipStrategy | string;
  signal?: AbortSignal;
  candidateLimit?: number | null;
  sourcePolicy?: SourcePolicy;
  /**
   * Optional built-in result collector applied after query execution and
   * before ranking. Default is ordinary ranked retrieval. When the typed
   * phrase has no exact hit, all PhrasePrefix fields participate. Occupancy,
   * configured-content identity, and version queries skip the collector.
   */
  resultCollector?: "complete-interpretation";
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

export interface ExactPruningStats {
  mode: "exhaustive" | "feature-blocks";
  documentBlocksVisited: number;
  documentBlocksSkipped: number;
  boundedBlocksSkipped: number;
  postingBlocksVisited: number;
  postingBlocksSkipped: number;
  postingEntriesSkipped: number;
  documentsFullyEvaluated: number;
  documentsBoundRejected: number;
  signaturesEncountered: number;
  representativesRetained: number;
  pruningFallbackReason: string | null;
}

export interface FinishTimings {
  limit: number;
  relatedLimit: number;
  retrieveMs: number;
  featureMs: number;
  relationshipMs: number;
  selectionMs?: number;
  rankMs: number;
  totalMs: number;
  candidateCount: number;
  relationshipExpanded: number;
  relatedCount?: number;
  primaryId: string | null;
  primaryIds: string[];
  matchCount?: number;
  featureVectorsConstructed?: number;
  representativeStats?: Record<string, unknown> | null;
  diagnosticRanked?: RankedHit[] | null;
  pruningStats?: ExactPruningStats | null;
}
