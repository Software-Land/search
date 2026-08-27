/**
 * Public search-corpus compiler API. Internal miners are not a supported app API.
 */
export {
  AnalyzeOptions,
  AnalyzeResult,
  CompileOptions,
  CorpusDocument,
  CorpusInput,
  ConfiguredConceptArtifact,
  GeneratedRelationshipMap,
  InspectionDoc,
  LoadedCorpus,
  VocabularyArtifact,
} from "./types.js";

export declare const COMPILER_VERSION: 1;
export declare const CONFIGURED_CONCEPT_FORMAT: "search-v2-configured-concepts";

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
export declare function parseConfiguredConcepts(obj?: unknown): import("./types.js").ConfiguredConceptArtifact;
export declare class ExternalConfiguredConceptError extends Error {
  details: string[];
}
export declare function reconcileExternalConfiguredConcepts(
  rows?: unknown,
  opts?: { strict?: boolean }
): {
  format: "search-corpus-external-configured-concept-reconciliation";
  version: 1;
  configuredConcepts: Array<{
    key: string;
    aliases: string[][];
    provenance?: string | null;
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
