/**
 * Class-like consumer usage that 0.2.0 handwritten declarations accepted.
 * Must remain valid against generated dist declarations without exposing impl fields.
 */
import {
  ArtifactValidationError,
  ArtifactVersionError,
  IndexStateError,
  InvalidConfigurationError,
  InvalidDocumentError,
  SearchEngine,
  abortError,
  dictionary,
  english,
  isAbortError,
  parseEquivalences,
  parseRelationships,
  parseSynonyms,
  type EquivalenceEntry,
} from "@software-land/search";

class DerivedEngine extends SearchEngine {}

const engine = new SearchEngine();
const derived = new DerivedEngine();
const created = SearchEngine.create();
const EngineConstructor = SearchEngine;
const constructedFromAlias = new EngineConstructor();
const isEngine = engine instanceof SearchEngine;
const isDerivedEngine = derived instanceof SearchEngine;

void created;
void constructedFromAlias;
void isEngine;
void isDerivedEngine;

// @ts-expect-error derived instances still omit public-impl fields
derived.retriever;
// @ts-expect-error derived instances still omit public-impl fields
derived.lastSearchMeta;
// @ts-expect-error derived instances still omit public-impl fields
derived._index;

class DerivedInvalidConfigurationError extends InvalidConfigurationError {}
class DerivedInvalidDocumentError extends InvalidDocumentError {}
class DerivedArtifactVersionError extends ArtifactVersionError {}
class DerivedArtifactValidationError extends ArtifactValidationError {}
class DerivedIndexStateError extends IndexStateError {}

const invalidConfiguration = new InvalidConfigurationError("bad config");
const invalidDocument = new InvalidDocumentError("bad document");
const artifactVersion = new ArtifactVersionError("bad version");
const artifactValidation = new ArtifactValidationError("bad artifact");
const indexState = new IndexStateError("not indexed");

void (invalidConfiguration instanceof InvalidConfigurationError);
void (invalidDocument instanceof InvalidDocumentError);
void (artifactVersion instanceof ArtifactVersionError);
void (artifactValidation instanceof ArtifactValidationError);
void (indexState instanceof IndexStateError);

void new DerivedInvalidConfigurationError("derived");
void new DerivedInvalidDocumentError("derived");
void new DerivedArtifactVersionError("derived");
void new DerivedArtifactValidationError("derived");
void new DerivedIndexStateError("derived");

const InvalidConfigurationErrorConstructor = InvalidConfigurationError;
const InvalidDocumentErrorConstructor = InvalidDocumentError;
const ArtifactVersionErrorConstructor = ArtifactVersionError;
const ArtifactValidationErrorConstructor = ArtifactValidationError;
const IndexStateErrorConstructor = IndexStateError;
void new InvalidConfigurationErrorConstructor("aliased");
void new InvalidDocumentErrorConstructor("aliased");
void new ArtifactVersionErrorConstructor("aliased");
void new ArtifactValidationErrorConstructor("aliased");
void new IndexStateErrorConstructor("aliased");

const englishFn: (options?: { lemmas?: Record<string, string> }) => unknown = english;
const dictionaryFn: (options?: { entries?: EquivalenceEntry[] }) => unknown = dictionary;
const parseEquivalencesFn: (obj?: unknown) => unknown = parseEquivalences;
const parseSynonymsFn: (obj?: unknown) => unknown = parseSynonyms;
const parseRelationshipsFn: (obj?: unknown) => unknown = parseRelationships;
const abortErrorFn: (message?: string) => Error = abortError;
const isAbortErrorFn: (err: unknown) => boolean = isAbortError;

void typeof english;
void typeof dictionary;
void typeof parseEquivalences;
void typeof abortError;
void typeof SearchEngine;
void englishFn();
void dictionaryFn();
void parseEquivalencesFn();
void parseSynonymsFn();
void parseRelationshipsFn();
void abortErrorFn("Aborted");
void isAbortErrorFn(new Error("no"));
void english({ lemmas: { widgets: "widget" } });
void dictionary({ entries: [{ key: "wifi" }] });
void parseEquivalences();
void parseSynonyms();
void parseRelationships();
void abortError();
void isAbortError(abortError());
