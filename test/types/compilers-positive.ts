import {
  COMPILER_VERSION as CORPUS_COMPILER_VERSION,
  LIFECYCLE,
  analyzeCorpus,
  compileAnalysis,
  compileCorpus,
  loadCorpus,
  type AnalyzeResult,
  type CompileOptions,
  type CorpusDocument,
} from "@software-land/search/corpus";
import {
  COMPILER_VERSION as REL_COMPILER_VERSION,
  compileRelationships,
  filterRelationships,
  type CompileRelOptions,
} from "@software-land/search/relationships";
import {
  DEFAULT_METHOD,
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
  attachLexicalFrequency,
  compileLexicalFrequency,
  lookupNgramCount,
  resolveLexicalPolicy,
  saturatingFrequency,
  type LexicalFrequencyArtifact,
} from "@software-land/search/lexical";

const documents: CorpusDocument[] = [{ id: "a", title: "CPU", body: "central" }];
const compileOpts: CompileOptions = {};
const corpus: Record<string, unknown> = compileCorpus({ documents }, compileOpts);
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
  { format: "search-v2-relationships", version: 1, relationships: {} },
  ["semantic", "editorial"]
);
void REL_COMPILER_VERSION;
const relCompilerVersion: 2 = REL_COMPILER_VERSION;
void relCompilerVersion;
void relationships;
void filteredRel;

const semanticOpts: CompileSemanticOptions = {
  method: DEFAULT_METHOD,
  precisionGate: true,
  mutual: true,
};
export async function runSemantic(input: unknown): Promise<CompileSemanticResult> {
  void semanticRoot();
  void semanticBuilderPath();
  return compileSemantic(input, semanticOpts);
}

const artifact: LexicalFrequencyArtifact = compileLexicalFrequency(
  [{ id: "a", body: "machine learning machine learning" }],
  { lemma: (token: string) => token }
);
const attached = attachLexicalFrequency([{ id: "a", body: "x" }], artifact);
void LEX_COMPILER_VERSION;
void LEXICAL_FREQUENCY_FORMAT;
void DEFAULT_LEXICAL_POLICY.minN;
void resolveLexicalPolicy(null);
void lookupNgramCount(artifact.documents.a?.ngrams, "machine learn");
void saturatingFrequency(2);
void attached;
