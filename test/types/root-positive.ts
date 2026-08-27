/**
 * Public-consumer type fixtures for @software-land/search.
 * Paths in tsconfig.json mirror package.json exports.types (0.2.0 handwritten facades).
 */
import {
  ARTIFACT_FORMATS,
  ARTIFACT_VERSION,
  DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD,
  DEFAULT_CANDIDATE_LIMIT,
  DEFAULT_RELATIONSHIP_STRATEGY,
  IndexStateError,
  InvalidConfigurationError,
  PUBLIC_EXPORTS,
  RELATIONSHIP_STRATEGIES,
  RETRIEVER_NAMES,
  SearchEngine,
  abortError,
  morphology,
  migrateConfiguredEntry,
  compileRelationshipMap,
  compileAuthoredRelevance,
  mergeRelationships,
  isAbortError,
  parseEquivalences,
  parseRelationships,
  normalizeSearchEquivalences,
  MAX_SEARCH_EQUIVALENCE_TARGETS,
  type EquivalenceArtifact,
  type EquivalenceEntry,
  type RelationshipArtifact,
  type Schema,
  type SearchDetailedResult,
  type SearchDocument,
  type SearchEngineOptions,
  type SearchOptions,
  type SearchResult,
  type SynonymPlugin,
  type EnglishPlugin,
  type DictionaryPlugin,
  type LexicalIndexArtifact,
  type SearchEquivalenceMap,
  type NormalizedSearchEquivalences,
  type RelationshipMap,
  type MigratedConfiguredEntry,
  type CompiledAuthoredRelevance,
  type CompiledRelationshipMap,
} from "@software-land/search";

const schema: Schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const documents: SearchDocument[] = [
  { id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks.", metadata: { area: "network" } },
];

const relationships: RelationshipArtifact = {
  format: "search-v2-relationships",
  version: 1,
  relationships: {
    wifi: [{ target: "wifi", type: "editorial", strength: 1, provenance: "manual" }],
  },
};

const entries: EquivalenceEntry[] = [
  { key: "wifi", aliases: [["wi", "fi"]] },
];

const morphologyPlugin: EnglishPlugin = morphology();
const authoredIdentity: CompiledAuthoredRelevance = compileAuthoredRelevance({ configuredConcepts: entries });
const dictionaryPlugin = authoredIdentity.plugins.find((plugin): plugin is DictionaryPlugin => plugin.name === "dictionary");
if (!dictionaryPlugin) throw new Error("compileAuthoredRelevance must include the dictionary plugin");
void dictionaryPlugin.standaloneRecallByToken;
void dictionaryPlugin.topicalRecallByKey;
const migrated: MigratedConfiguredEntry = migrateConfiguredEntry({
  key: "wifi",
  expansion: ["wi", "fi"],
  primary: "fi",
});
void migrated.entry.aliases;
void migrated.discardedPrimary;
const relationshipMap: RelationshipMap = {
  qa: [{ to: { form: "testing" }, kind: "equivalent" }],
};
const compiledPublic: CompiledRelationshipMap = compileRelationshipMap(relationshipMap, { concepts: entries });
void compiledPublic.synonymMap;
void compiledPublic.editorialRelationships;
const authored: CompiledAuthoredRelevance = compileAuthoredRelevance({ configuredConcepts: entries, relationshipMap });
void authored.plugins;
void authored.documentRelationships;
void mergeRelationships(null, authored.documentRelationships);
const morphologyWithLemmas: EnglishPlugin = morphology({ lemmas: { widgets: "widget" } });
void morphologyPlugin.lemma;
void morphologyPlugin.indexIdentity;

const lexicalIndex: LexicalIndexArtifact = {
  format: "search-v2-lexical-index",
  version: 1,
  compatibility: {
    core: "search-v2-core-analyzer-v1",
    analyzer: morphologyPlugin.indexIdentity || "runtime-generated",
    schema: ["title", "body"],
  },
  corpus: { documentCount: 1, fingerprint: "fixture" },
  integrity: "fixture",
  data: {},
};

const options: SearchEngineOptions = {
  schema,
  plugins: [morphologyPlugin, dictionaryPlugin, morphologyWithLemmas],
  lexicalIndex,
  documentRelationships: relationships,
  relationshipStrategy: "hybrid",
  retriever: "indexed",
  candidateLimit: DEFAULT_CANDIDATE_LIMIT,
  adaptive: { documentThreshold: DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD },
  retrievalScoreWeight: 0,
};

const created: SearchEngine = SearchEngine.create(options);
const constructed: SearchEngine = new SearchEngine();
void constructed;

const retrievers = ["full-scan", "indexed", "adaptive", "indexed-lexical"] as const;
const strategies = ["none", "mixed", "hybrid", "separate"] as const;
void SearchEngine.create({ retriever: retrievers[0], relationshipStrategy: strategies[0] });
void SearchEngine.create({
  retriever: {
    retrieve: () => [],
    retrieveAsync: async () => [],
    prepare: () => {},
    name: "custom",
  },
});

const searchOpts: SearchOptions = {
  limit: 5,
  relatedLimit: 3,
  explain: true,
  relationshipStrategy: DEFAULT_RELATIONSHIP_STRATEGY,
  candidateLimit: 50,
};

async function indexAndSearch(engine: SearchEngine): Promise<SearchResult[]> {
  await engine.index(documents);
  const hits: SearchResult[] = engine.search("wifi", searchOpts);
  const detailed: SearchDetailedResult = engine.searchDetailed("wifi", searchOpts);
  const asyncHits: SearchResult[] = await engine.searchAsync("wifi", searchOpts);
  const asyncDetailed: SearchDetailedResult = await engine.searchDetailedAsync("wifi", searchOpts);
  void detailed.results;
  void asyncHits;
  void asyncDetailed.related;
  return hits;
}

void created;
void indexAndSearch;

const equivalences: EquivalenceArtifact = parseEquivalences({
  format: "search-v2-equivalences",
  version: 1,
  entries,
});
const directionalMap: SearchEquivalenceMap = {
  qa: ["testing"],
  "quality assurance": ["testing"],
  docker: ["container", "containers"],
};
const directionalPlugin: SynonymPlugin = {
  name: "synonyms",
  expand: (token: string) => (token === "qa" ? [{ form: "testing" }] : []),
};
const normalizedEquivalences: NormalizedSearchEquivalences = normalizeSearchEquivalences(directionalMap);
const targetBound: 8 = MAX_SEARCH_EQUIVALENCE_TARGETS;
void directionalPlugin.expand;
void authored.plugins.find((plugin) => plugin.name === "synonyms")?.expand;
void normalizedEquivalences.entries;
void targetBound;
const parsedGraph: RelationshipArtifact = parseRelationships(relationships);
void equivalences.entries;
void parsedGraph.relationships;
void ARTIFACT_FORMATS.equivalences;
void ARTIFACT_FORMATS.lexicalIndex;
void ARTIFACT_VERSION;
void PUBLIC_EXPORTS;
void RELATIONSHIP_STRATEGIES;
void RETRIEVER_NAMES;
void InvalidConfigurationError;
void IndexStateError;
void abortError("Aborted");
void isAbortError(new Error("no"));
