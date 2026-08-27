/**
 * Public runtime API.
 * Internals remain importable from sibling modules for tests and tooling.
 *
 * Value exports are the JavaScript implementations. Types are the designed
 * 0.2.0 facade in ./api.ts, not inferred implementation shapes.
 */

import { SearchEngine as searchEngineImpl } from "./SearchEngine.js";
import { morphology as morphologyImpl } from "./morphology.js";
import { compileAuthoredRelevance as compileAuthoredRelevanceImpl } from "./dictionary.js";
import { migrateConfiguredEntry as migrateConfiguredEntryImpl } from "./configuredAuthoring.js";
import { compileRelationshipMap as compileRelationshipMapImpl, mergeRelationships as mergeRelationshipsImpl } from "./relationshipMap.js";
import {
  RELATIONSHIP_STRATEGIES as relationshipStrategiesImpl,
  DEFAULT_RELATIONSHIP_STRATEGY as defaultRelationshipStrategyImpl,
  RETRIEVER_NAMES as retrieverNamesImpl,
  DEFAULT_CANDIDATE_LIMIT as defaultCandidateLimitImpl,
  DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD as defaultAdaptiveDocumentThresholdImpl,
} from "./config.js";
import {
  parseEquivalences as parseEquivalencesImpl,
  parseRelationships as parseRelationshipsImpl,
  ARTIFACT_FORMATS as artifactFormatsImpl,
  ARTIFACT_VERSION as artifactVersionImpl,
} from "./artifacts.js";
import { abortError as abortErrorImpl, isAbortError as isAbortErrorImpl } from "./cancel.js";
import {
  normalizeSearchEquivalences as normalizeSearchEquivalencesImpl,
  MAX_SEARCH_EQUIVALENCE_TARGETS as maxSearchEquivalenceTargetsImpl,
} from "./synonyms.js";
import {
  InvalidConfigurationError as invalidConfigurationErrorImpl,
  InvalidDocumentError as invalidDocumentErrorImpl,
  ArtifactVersionError as artifactVersionErrorImpl,
  ArtifactValidationError as artifactValidationErrorImpl,
  IndexStateError as indexStateErrorImpl,
} from "./errors.js";
import type {
  ArtifactValidationError as ArtifactValidationErrorType,
  ArtifactValidationErrorConstructor,
  ArtifactVersionError as ArtifactVersionErrorType,
  ArtifactVersionErrorConstructor,
  AuthoredRelationshipEdge,
  CompiledAuthoredRelevance,
  CompiledRelationshipMap,
  EquivalenceArtifact,
  EquivalenceEntry,
  IndexStateError as IndexStateErrorType,
  MigratedConfiguredEntry,
  RelationshipEndpoint,
  RelationshipKind,
  RelationshipMap,
  IndexStateErrorConstructor,
  InvalidConfigurationError as InvalidConfigurationErrorType,
  InvalidConfigurationErrorConstructor,
  InvalidDocumentError as InvalidDocumentErrorType,
  InvalidDocumentErrorConstructor,
  RelationshipArtifact,
  RelationshipStrategy,
  RetrieverName,
  SearchEngine as SearchEngineType,
  SearchEngineConstructor,
  EnglishPlugin,
  MorphologyOptions,
  NormalizedSearchEquivalences,
} from "./api.js";

export type {
  AdaptiveOptions,
  DictionaryPlugin,
  DirectClass,
  EnglishPlugin,
  AuthoredRelationshipEdge,
  CompiledAuthoredRelevance,
  CompiledRelationshipMap,
  EquivalenceArtifact,
  EquivalenceEntry,
  ExperimentalRetrieveOptions,
  MigratedConfiguredEntry,
  RelationshipEndpoint,
  RelationshipKind,
  RelationshipMap,
  ExperimentalRetriever,
  IndexResult,
  LexicalIndexArtifact,
  LexiconPlugin,
  MorphologyOptions,
  PrefixCompletion,
  RelationshipArtifact,
  RelationshipEdge,
  RelationshipInfo,
  RelationshipStrategy,
  RelevanceKind,
  RetrieverName,
  Schema,
  SchemaField,
  SearchDetailedResult,
  SearchDocument,
  SearchEngineOptions,
  SearchExplanation,
  SearchOptions,
  SearchPlugin,
  SearchResult,
  SynonymPlugin,
  TextRole,
  SearchEquivalenceMap,
  SearchEquivalencePair,
  SearchEquivalenceRejection,
  NormalizedSearchEquivalenceEntry,
  NormalizedSearchEquivalences,
} from "./api.js";

export type SearchEngine = SearchEngineType;
export const SearchEngine: SearchEngineConstructor = searchEngineImpl as unknown as SearchEngineConstructor;

export const morphology: (options?: MorphologyOptions) => EnglishPlugin = morphologyImpl;
export const migrateConfiguredEntry: (raw?: unknown) => MigratedConfiguredEntry = migrateConfiguredEntryImpl as (
  raw?: unknown
) => MigratedConfiguredEntry;
export const compileRelationshipMap: (
  map?: unknown,
  options?: { concepts?: Iterable<{ key?: string } | string> | Map<string, unknown> | null; documents?: import("./api.js").SearchDocument[] | null }
) => CompiledRelationshipMap = compileRelationshipMapImpl as (
  map?: unknown,
  options?: { concepts?: Iterable<{ key?: string } | string> | Map<string, unknown> | null; documents?: import("./api.js").SearchDocument[] | null }
) => CompiledRelationshipMap;
export const compileAuthoredRelevance: (options?: {
  configuredConcepts?: EquivalenceEntry[];
  relationshipMap?: RelationshipMap;
  documents?: import("./api.js").SearchDocument[];
}) => CompiledAuthoredRelevance = compileAuthoredRelevanceImpl as (options?: {
  configuredConcepts?: EquivalenceEntry[];
  relationshipMap?: RelationshipMap;
  documents?: import("./api.js").SearchDocument[];
}) => CompiledAuthoredRelevance;
export const mergeRelationships: (base?: unknown, extra?: unknown) => RelationshipArtifact | null =
  mergeRelationshipsImpl as (base?: unknown, extra?: unknown) => RelationshipArtifact | null;
export const normalizeSearchEquivalences: (input?: unknown) => NormalizedSearchEquivalences =
  normalizeSearchEquivalencesImpl as (input?: unknown) => NormalizedSearchEquivalences;
export const MAX_SEARCH_EQUIVALENCE_TARGETS: 8 = maxSearchEquivalenceTargetsImpl as 8;

export const RELATIONSHIP_STRATEGIES: readonly RelationshipStrategy[] =
  relationshipStrategiesImpl as readonly RelationshipStrategy[];
export const DEFAULT_RELATIONSHIP_STRATEGY: "hybrid" = defaultRelationshipStrategyImpl;
export const RETRIEVER_NAMES: readonly RetrieverName[] = retrieverNamesImpl as readonly RetrieverName[];
export const DEFAULT_CANDIDATE_LIMIT: 200 = defaultCandidateLimitImpl;
export const DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD: 1500 = defaultAdaptiveDocumentThresholdImpl;

export const parseEquivalences: (obj?: unknown) => EquivalenceArtifact = parseEquivalencesImpl as (
  obj?: unknown
) => EquivalenceArtifact;
export const parseRelationships: (obj?: unknown) => RelationshipArtifact = parseRelationshipsImpl as (
  obj?: unknown
) => RelationshipArtifact;
export const ARTIFACT_FORMATS: {
  equivalences: "search-v2-equivalences";
  relationships: "search-v2-relationships";
  corpusStats: "search-v2-corpus-stats";
  lexicalIndex: "search-v2-lexical-index";
} = artifactFormatsImpl as {
  equivalences: "search-v2-equivalences";
  relationships: "search-v2-relationships";
  corpusStats: "search-v2-corpus-stats";
  lexicalIndex: "search-v2-lexical-index";
};
export const ARTIFACT_VERSION: 1 = artifactVersionImpl;

export const abortError: (message?: string) => Error = abortErrorImpl;
export const isAbortError: (err: unknown) => boolean = isAbortErrorImpl;

export type InvalidConfigurationError = InvalidConfigurationErrorType;
export const InvalidConfigurationError: InvalidConfigurationErrorConstructor =
  invalidConfigurationErrorImpl as unknown as InvalidConfigurationErrorConstructor;
export type InvalidDocumentError = InvalidDocumentErrorType;
export const InvalidDocumentError: InvalidDocumentErrorConstructor =
  invalidDocumentErrorImpl as unknown as InvalidDocumentErrorConstructor;
export type ArtifactVersionError = ArtifactVersionErrorType;
export const ArtifactVersionError: ArtifactVersionErrorConstructor =
  artifactVersionErrorImpl as unknown as ArtifactVersionErrorConstructor;
export type ArtifactValidationError = ArtifactValidationErrorType;
export const ArtifactValidationError: ArtifactValidationErrorConstructor =
  artifactValidationErrorImpl as unknown as ArtifactValidationErrorConstructor;
export type IndexStateError = IndexStateErrorType;
export const IndexStateError: IndexStateErrorConstructor =
  indexStateErrorImpl as unknown as IndexStateErrorConstructor;

export const PUBLIC_EXPORTS: readonly string[] = Object.freeze([
  "SearchEngine",
  "morphology",
  "migrateConfiguredEntry",
  "compileRelationshipMap",
  "compileAuthoredRelevance",
  "mergeRelationships",
  "normalizeSearchEquivalences",
  "MAX_SEARCH_EQUIVALENCE_TARGETS",
  "RELATIONSHIP_STRATEGIES",
  "DEFAULT_RELATIONSHIP_STRATEGY",
  "RETRIEVER_NAMES",
  "DEFAULT_CANDIDATE_LIMIT",
  "DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD",
  "parseEquivalences",
  "parseRelationships",
  "ARTIFACT_FORMATS",
  "ARTIFACT_VERSION",
  "abortError",
  "isAbortError",
  "InvalidConfigurationError",
  "InvalidDocumentError",
  "ArtifactVersionError",
  "ArtifactValidationError",
  "IndexStateError",
  "PUBLIC_EXPORTS",
]);
