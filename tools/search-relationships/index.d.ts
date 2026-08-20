/**
 * Public search-relationships compiler API.
 */
export {
  AnalyzeRelOptions,
  CompileRelOptions,
  MergeRelOptions,
  RelDocument,
  RelationshipArtifact,
  RelationshipEdge,
} from "./types.js";

export declare const COMPILER_VERSION: 1;

export declare const LIFECYCLE: {
  readonly MANUAL_ACCEPTED: "MANUAL_ACCEPTED";
  readonly HUMAN_ACCEPTED: "HUMAN_ACCEPTED";
  readonly REVIEW_PENDING: "REVIEW_PENDING";
  readonly HUMAN_REJECTED: "HUMAN_REJECTED";
  readonly CONFLICT: "CONFLICT";
  readonly ORPHANED_DECISION: "ORPHANED_DECISION";
};

export declare const RELATIONSHIP_TYPES: Record<string, { symmetric: boolean; searchEligible: boolean; description: string }>;
export declare const DEFAULT_RUNTIME_TYPES: readonly string[];
export declare const STRUCTURAL_TYPES: readonly string[];

export declare class DecisionError extends Error {
  details?: string[];
}

export declare function analyzeRelationships(input?: unknown, opts?: import("./types.js").AnalyzeRelOptions): Record<string, unknown>;
export declare function compileRelationships(input?: unknown, opts?: import("./types.js").CompileRelOptions): Record<string, unknown>;
export declare function filterRelationships(artifact?: unknown, types?: readonly string[]): unknown;
export declare function relationshipId(type: string, source: string, target: string, opts?: { directional?: boolean }): string;
export declare function loadDecisions(input?: unknown): unknown;
export declare function validateDecisions(input?: unknown): unknown;
export declare function hashJson(value?: unknown): string;
export declare function mergeRelationshipArtifacts(opts?: import("./types.js").MergeRelOptions): unknown;
