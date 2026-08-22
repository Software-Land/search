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
  dictionary,
  english,
  morphology,
  isAbortError,
  parseEquivalences,
  parseRelationships,
  parseSynonyms,
  type EquivalenceArtifact,
  type EquivalenceEntry,
  type RelationshipArtifact,
  type Schema,
  type SearchDetailedResult,
  type SearchDocument,
  type SearchEngineOptions,
  type SearchOptions,
  type SearchResult,
  type SynonymArtifact,
  type EnglishPlugin,
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

const entries: EquivalenceEntry[] = [{ key: "wifi", expansion: ["wi", "fi"], aliases: [["wi", "fi"]] }];

const morphologyPlugin: EnglishPlugin = morphology();
const englishPlugin: unknown = english();
const dictionaryPlugin: unknown = dictionary({ entries });
const morphologyWithLemmas: EnglishPlugin = morphology({ lemmas: { widgets: "widget" } });
const englishWithLemmas: unknown = english({ lemmas: { widgets: "widget" } });
void morphologyPlugin.lemma;

const options: SearchEngineOptions = {
  schema,
  plugins: [morphologyPlugin, englishPlugin, dictionaryPlugin, morphologyWithLemmas, englishWithLemmas],
  relationships,
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
const synonyms: SynonymArtifact = parseSynonyms({
  format: "search-v2-synonyms",
  version: 1,
  entries: [{ terms: ["auth", "authentication"] }],
});
const parsedGraph: RelationshipArtifact = parseRelationships(relationships);
void equivalences.entries;
void synonyms.entries;
void parsedGraph.relationships;
void ARTIFACT_FORMATS.equivalences;
void ARTIFACT_VERSION;
void PUBLIC_EXPORTS;
void RELATIONSHIP_STRATEGIES;
void RETRIEVER_NAMES;
void InvalidConfigurationError;
void IndexStateError;
void abortError("Aborted");
void isAbortError(new Error("no"));
