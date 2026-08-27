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
  morphology,
  isAbortError,
  parseRelationships,
  compileAuthoredRelevance,
  type EnglishPlugin,
  type SearchPlugin,
  type MorphologyOptions,
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

const morphologyFn: (options?: MorphologyOptions) => EnglishPlugin = morphology;
const parseRelationshipsFn: (obj?: unknown) => unknown = parseRelationships;
const abortErrorFn: (message?: string) => Error = abortError;
const isAbortErrorFn: (err: unknown) => boolean = isAbortError;

void typeof morphology;
void typeof compileAuthoredRelevance;
void typeof abortError;
void typeof SearchEngine;
void morphologyFn();
void parseRelationshipsFn();
void abortErrorFn("Aborted");
void isAbortErrorFn(new Error("no"));
void morphology({ lemmas: { widgets: "widget" } });
const authored = compileAuthoredRelevance({ configuredConcepts: [{ key: "qa", aliases: [["quality", "assurance"]] }],
  relationshipMap: { qa: [{ to: { form: "testing" }, kind: "equivalent" }] },
});
void authored.plugins.find((plugin): plugin is SearchPlugin => typeof plugin.lexicon === "function")?.lexicon;
void authored.plugins.find((plugin) => plugin.name === "synonyms")?.expand;
void authored.plugins[0];
void authored.documentRelationships;
void parseRelationships();
void abortError();
void isAbortError(abortError());
