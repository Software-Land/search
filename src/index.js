/**
 * Public runtime API.
 * Internals remain importable from sibling modules for tests and tooling.
 */

export { SearchEngine } from "./SearchEngine.js";
export { english } from "./english.js";
export { dictionary } from "./dictionary.js";
export {
  RELATIONSHIP_STRATEGIES,
  DEFAULT_RELATIONSHIP_STRATEGY,
  RETRIEVER_NAMES,
  DEFAULT_CANDIDATE_LIMIT,
  DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD,
} from "./config.js";
export {
  parseEquivalences,
  parseSynonyms,
  parseRelationships,
  ARTIFACT_FORMATS,
  ARTIFACT_VERSION,
} from "./artifacts.js";
export { abortError, isAbortError } from "./cancel.js";
export {
  InvalidConfigurationError,
  InvalidDocumentError,
  ArtifactVersionError,
  ArtifactValidationError,
  IndexStateError,
} from "./errors.js";

export const PUBLIC_EXPORTS = Object.freeze([
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
