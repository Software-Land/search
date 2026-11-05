import {
  COMPILER_VERSION as CORPUS_COMPILER_VERSION,
  LIFECYCLE,
  analyzeCorpus,
  compileAnalysis,
  compileCorpus,
  parseConfiguredConcepts,
  CONFIGURED_CONCEPT_FORMAT,
  loadCorpus,
  reconcileExternalConfiguredConcepts,
  ExternalConfiguredConceptError,
  type AnalyzeResult,
  type CompileOptions,
  type ConfiguredConceptArtifact,
  type CorpusDocument,
  type GeneratedRelationshipMap,
} from "@software-land/search/corpus";
import {
  COMPILER_VERSION as REL_COMPILER_VERSION,
  compileRelationships,
  filterRelationships,
  type CompileRelOptions,
} from "@software-land/search/relationships";
import {
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_METHOD,
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
  compileSemantic,
  semanticBuilderPath,
  semanticRoot,
  type CompileSemanticOptions,
  type CompileSemanticResult,
} from "@software-land/search/semantic";
import {
  COMPILER_VERSION as LEX_COMPILER_VERSION,
  DEFAULT_LEXICAL_POLICY,
  LEXICAL_FREQUENCY_FORMAT,
  LEXICAL_INDEX_FORMAT,
  LEXICAL_INDEX_VERSION,
  attachLexicalFrequency,
  compileLexicalIndex,
  compileLexicalFrequency,
  lookupNgramCount,
  resolveLexicalPolicy,
  saturatingFrequency,
  type LexicalFrequencyArtifact,
  type LexicalIndexArtifact,
} from "@software-land/search/lexical";

const documents: CorpusDocument[] = [{ id: "a", title: "CPU", body: "central" }];
const compileOpts: CompileOptions = {};
const corpus: Record<string, unknown> = compileCorpus({ documents }, compileOpts);
void corpus.configuredConcepts;
const configuredArtifact: ConfiguredConceptArtifact = parseConfiguredConcepts({
  format: CONFIGURED_CONCEPT_FORMAT,
  version: 1,
  entries: [{ key: "cpu", aliases: [["central", "processing", "unit"]] }],
  compileWarnings: [],
});
void configuredArtifact.entries[0].key;
const legacyConfigured: ConfiguredConceptArtifact = {
  format: "search-v2-configured-concepts",
  version: 1,
  entries: [],
  compileWarnings: [],
};
const parsedLegacyFormat: "search-configured-concepts" = parseConfiguredConcepts(legacyConfigured).format;
const writtenConceptFormat: "search-configured-concepts" = CONFIGURED_CONCEPT_FORMAT;
void parsedLegacyFormat;
void writtenConceptFormat;
const generatedEquivalence: GeneratedRelationshipMap = (corpus.relationshipMap || {}) as GeneratedRelationshipMap;
void generatedEquivalence;
const analysis: AnalyzeResult = analyzeCorpus({ documents });
const compiledFromAnalysis: Record<string, unknown> = compileAnalysis(analysis);
const loaded = loadCorpus({ documents });
void CORPUS_COMPILER_VERSION;
void LIFECYCLE.AUTO_ACCEPTED;
void corpus;
void compiledFromAnalysis;
void loaded.documents;

const relOpts: CompileRelOptions = { semantic: null, domain: null };
const relationships: Record<string, unknown> = compileRelationships({ documents: [] }, relOpts);
const filteredRel = filterRelationships(
  { format: "search-relationships", version: 1, relationships: {} },
  ["semantic", "editorial"]
);
const filteredLegacyRel = filterRelationships(
  { format: "search-v2-relationships", version: 1, relationships: {} },
  ["semantic"]
);
void filteredLegacyRel;
void REL_COMPILER_VERSION;
const relCompilerVersion: 2 = REL_COMPILER_VERSION;
void relCompilerVersion;
void relationships;
void filteredRel;

const semanticOpts: CompileSemanticOptions = {
  method: DEFAULT_METHOD,
  embeddingProvider: DEFAULT_EMBEDDING_PROVIDER,
  precisionGate: true,
  mutual: true,
};
const openaiSemanticOpts: CompileSemanticOptions = {
  method: "embedding",
  embeddingProvider: "openai",
  model: OPENAI_EMBEDDING_MODEL,
  dimensions: OPENAI_EMBEDDING_DIMENSIONS,
  apiBase: "https://api.openai.com/v1",
};
void openaiSemanticOpts;
export async function runSemantic(input: unknown): Promise<CompileSemanticResult> {
  void semanticRoot();
  void semanticBuilderPath();
  return compileSemantic(input, semanticOpts);
}

const artifact = compileLexicalFrequency(
  [{ id: "a", body: "machine learning machine learning" }],
  { lemma: (token: string) => token }
);
const frequencyAsInput: LexicalFrequencyArtifact = artifact;
const writtenFrequencyFormat: "search-lexical-frequency" = artifact.format;
const legacyFrequency: LexicalFrequencyArtifact = { ...artifact, format: "search-v2-lexical-frequency" };
void frequencyAsInput;
void writtenFrequencyFormat;
void attachLexicalFrequency([{ id: "a", body: "x" }], legacyFrequency);
const attached = attachLexicalFrequency([{ id: "a", body: "x" }], artifact);
void LEX_COMPILER_VERSION;
void LEXICAL_FREQUENCY_FORMAT;
void DEFAULT_LEXICAL_POLICY.minN;
void resolveLexicalPolicy(null);
void lookupNgramCount(artifact.documents.a?.ngrams, "machine learn");
void saturatingFrequency(2);
void attached;

const lexicalIndex = compileLexicalIndex(
  [{ id: "a", title: "Machine Learning", body: "machine learning" }],
  {
    lemma: (token: string) => token,
    analyzerId: "test-identity-v1",
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
  }
);
const lexicalIndexVersion: 1 = LEXICAL_INDEX_VERSION;
const lexicalIndexAsInput: LexicalIndexArtifact = lexicalIndex;
const writtenLexicalFormat: "search-lexical-index" = lexicalIndex.format;
const legacyLexicalIndex: LexicalIndexArtifact = { ...lexicalIndex, format: "search-v2-lexical-index" };
void lexicalIndexAsInput;
void writtenLexicalFormat;
void legacyLexicalIndex;
void LEXICAL_INDEX_FORMAT;
void lexicalIndexVersion;
void lexicalIndex.corpus.documentCount;

const reconciled = reconcileExternalConfiguredConcepts([
  {
    key: "API",
    aliases: [["application", "programming", "interface"], ["app", "programming", "interface"]],
    evidenceDocumentIds: ["doc-1"],
    provenance: "application-generated",
  },
]);
void reconciled.configuredConcepts[0].key;
void reconciled.configuredConcepts[0].aliases;
void reconciled.unresolved;
void reconciled.reconciliations;
try {
  reconcileExternalConfiguredConcepts([{ key: "", aliases: [["x"]]}]);
} catch (err) {
  if (!(err instanceof ExternalConfiguredConceptError)) throw err;
}
