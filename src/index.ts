/**
 * Public runtime API.
 * Internals remain importable from sibling modules for tests and tooling.
 *
 * Value exports are the JavaScript implementations. Types are the designed
 * 0.2.0 facade in ./api.ts, not inferred implementation shapes.
 */

import { SearchEngine as searchEngineImpl } from "./SearchEngine.js";
import { english as englishImpl } from "./english.js";
import { dictionary as dictionaryImpl } from "./dictionary.js";
import {
  RELATIONSHIP_STRATEGIES as relationshipStrategiesImpl,
  DEFAULT_RELATIONSHIP_STRATEGY as defaultRelationshipStrategyImpl,
  RETRIEVER_NAMES as retrieverNamesImpl,
  DEFAULT_CANDIDATE_LIMIT as defaultCandidateLimitImpl,
  DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD as defaultAdaptiveDocumentThresholdImpl,
} from "./config.js";
import {
  parseEquivalences as parseEquivalencesImpl,
  parseSynonyms as parseSynonymsImpl,
  parseRelationships as parseRelationshipsImpl,
  ARTIFACT_FORMATS as artifactFormatsImpl,
  ARTIFACT_VERSION as artifactVersionImpl,
} from "./artifacts.js";
import { abortError as abortErrorImpl, isAbortError as isAbortErrorImpl } from "./cancel.js";
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
  EquivalenceArtifact,
  EquivalenceEntry,
  IndexStateError as IndexStateErrorType,
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
  SynonymArtifact,
} from "./api.js";

export type {
  AdaptiveOptions,
  DirectClass,
  EquivalenceArtifact,
  EquivalenceEntry,
  IndexResult,
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
  SearchResult,
  SynonymArtifact,
  TextRole,
} from "./api.js";

export type SearchEngine = SearchEngineType;
export const SearchEngine: SearchEngineConstructor = searchEngineImpl as unknown as SearchEngineConstructor;

export const english: (options?: { lemmas?: Record<string, string> }) => unknown = englishImpl;
export const dictionary: (options?: { entries?: EquivalenceEntry[] }) => unknown = dictionaryImpl;

export const RELATIONSHIP_STRATEGIES: readonly RelationshipStrategy[] =
  relationshipStrategiesImpl as readonly RelationshipStrategy[];
export const DEFAULT_RELATIONSHIP_STRATEGY: "hybrid" = defaultRelationshipStrategyImpl;
export const RETRIEVER_NAMES: readonly RetrieverName[] = retrieverNamesImpl as readonly RetrieverName[];
export const DEFAULT_CANDIDATE_LIMIT: 200 = defaultCandidateLimitImpl;
export const DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD: 1500 = defaultAdaptiveDocumentThresholdImpl;

export const parseEquivalences: (obj?: unknown) => EquivalenceArtifact = parseEquivalencesImpl as (
  obj?: unknown
) => EquivalenceArtifact;
export const parseSynonyms: (obj?: unknown) => SynonymArtifact = parseSynonymsImpl as (obj?: unknown) => SynonymArtifact;
export const parseRelationships: (obj?: unknown) => RelationshipArtifact = parseRelationshipsImpl as (
  obj?: unknown
) => RelationshipArtifact;
export const ARTIFACT_FORMATS: {
  equivalences: "search-v2-equivalences";
  synonyms: "search-v2-synonyms";
  relationships: "search-v2-relationships";
  corpusStats: "search-v2-corpus-stats";
} = artifactFormatsImpl as {
  equivalences: "search-v2-equivalences";
  synonyms: "search-v2-synonyms";
  relationships: "search-v2-relationships";
  corpusStats: "search-v2-corpus-stats";
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
  "english",
  "dictionary",
  "RELATIONSHIP_STRATEGIES",
  "DEFAULT_RELATIONSHIP_STRATEGY",
  "RETRIEVER_NAMES",
  "DEFAULT_CANDIDATE_LIMIT",
  "DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD",
  "parseEquivalences",
  "parseSynonyms",
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
