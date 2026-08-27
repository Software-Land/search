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
  compileAuthoredRelevance,
  mergeRelationships,
  isAbortError,
  parseRelationships,
  type ConfiguredConcept,
  type RelationshipArtifact,
  type Schema,
  type SearchDetailedResult,
  type SearchDocument,
  type SearchEngineOptions,
  type SearchOptions,
  type SearchResult,
  type EnglishPlugin,
  type LexicalIndexArtifact,
  type RelationshipMap,
  type MigratedConfiguredEntry,
  type CompiledAuthoredRelevance,
  type SearchPlugin,
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

const entries: ConfiguredConcept[] = [
  { key: "wifi", aliases: [["wi", "fi"]] },
];

const morphologyPlugin: EnglishPlugin = morphology();
const authoredIdentity: CompiledAuthoredRelevance = compileAuthoredRelevance({ configuredConcepts: entries });
const identityPlugin: SearchPlugin | undefined = authoredIdentity.plugins[0];
if (!identityPlugin) throw new Error("compileAuthoredRelevance must include configured-identity plugins");
void identityPlugin.lexicon?.();
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
  plugins: [morphologyPlugin, ...authoredIdentity.plugins, morphologyWithLemmas],
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

const parsedGraph: RelationshipArtifact = parseRelationships(relationships);
void parsedGraph.relationships;
void ARTIFACT_FORMATS.relationships;
void ARTIFACT_FORMATS.lexicalIndex;
void ARTIFACT_VERSION;
void PUBLIC_EXPORTS;
void RELATIONSHIP_STRATEGIES;
void RETRIEVER_NAMES;
void InvalidConfigurationError;
void IndexStateError;
void abortError("Aborted");
void isAbortError(new Error("no"));
