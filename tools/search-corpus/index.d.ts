/**
 * Public search-corpus compiler API. Internal miners are not a supported app API.
 */
export {
  AnalyzeOptions,
  AnalyzeResult,
  CompileOptions,
  CorpusDocument,
  CorpusInput,
  EquivalenceArtifact,
  InspectionDoc,
  LoadedCorpus,
  SynonymArtifact,
  VocabularyArtifact,
} from "./types.js";

export declare const COMPILER_VERSION: 1;

export declare const LIFECYCLE: {
  readonly AUTO_ACCEPTED: "AUTO_ACCEPTED";
  readonly REVIEW_PENDING: "REVIEW_PENDING";
  readonly HUMAN_ACCEPTED: "HUMAN_ACCEPTED";
  readonly HUMAN_REJECTED: "HUMAN_REJECTED";
  readonly CONFLICT: "CONFLICT";
  readonly ORPHANED_DECISION: "ORPHANED_DECISION";
};

export declare class DecisionError extends Error {
  details: string[];
}

export declare function analyzeCorpus(input?: unknown, opts?: import("./types.js").AnalyzeOptions): import("./types.js").AnalyzeResult;
export declare function compileAnalysis(analysis: import("./types.js").AnalyzeResult): Record<string, unknown>;
export declare function compileCorpus(input?: unknown, opts?: import("./types.js").CompileOptions): Record<string, unknown>;
export declare function loadCorpus(input?: unknown): import("./types.js").LoadedCorpus;
export declare function spellingLexiconPlugin(options?: unknown): unknown;
export declare function dictionaryEntriesFromEquivalences(equivalences?: unknown): unknown[];
export declare class ExternalEquivalenceError extends Error {
  details: string[];
}
export declare function classifyExpansionRelation(
  key?: unknown,
  left?: unknown,
  right?: unknown
): "identical" | "compatible" | "ambiguous" | "conflict";
export declare function normalizeExternalEquivalences(
  rows?: unknown,
  opts?: { strict?: boolean }
): {
  format: "search-corpus-external-equivalences";
  version: 1;
  entries: Array<{
    key: string;
    expansion: string[];
    aliases: string[][];
    evidenceDocumentIds: string[];
    ambiguous: boolean;
    alternatives: Array<{ expansion: string[]; note?: string }>;
    provenance: string;
  }>;
  rejected: Array<{ index: number; reason: string }>;
  conflicts: Array<{ key: string; expansions: string[][] }>;
  unresolved: Array<{
    key: string;
    kind: "ambiguous" | "conflict";
    expansions: string[][];
    evidenceDocumentIds: string[];
    eligible: false;
  }>;
  reconciliations: Array<{
    key: string;
    kind: "identical" | "compatible" | "ambiguous" | "conflict";
    eligible: boolean;
    canonicalExpansion?: string[];
    aliases?: string[][];
    expansions: string[][];
    evidenceDocumentIds: string[];
  }>;
};
export declare function loadDecisions(input?: unknown): unknown;
export declare function validateDecisions(input?: unknown): unknown;
export declare function equivalenceId(candidate?: unknown): string;
export declare function synonymId(candidate?: unknown): string;
export declare function hashJson(value?: unknown): string;
export declare function annotateReviewQueue(inspection?: unknown): unknown;
export declare function sortPending(rows?: unknown): unknown;
export declare function decisionSkeleton(candidate?: unknown): unknown;
export declare function isInflectionPair(a?: unknown, b?: unknown): boolean;
export declare function isMaterialChange(previous?: unknown, next?: unknown): boolean;
