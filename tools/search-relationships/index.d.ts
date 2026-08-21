/**
 * Public search-relationships compiler API.
 */
export {
  CompileRelOptions,
  MergeRelOptions,
  RelDocument,
  RelationshipArtifact,
  RelationshipEdge,
} from "./types.js";

export declare const COMPILER_VERSION: 2;

export declare const RELATIONSHIP_TYPES: Record<string, { symmetric: boolean; searchEligible: boolean; description: string }>;
export declare const DEFAULT_RUNTIME_TYPES: readonly string[];
export declare const STRUCTURAL_TYPES: readonly string[];

export declare class DecisionError extends Error {
  details?: string[];
}

export declare function compileRelationships(input?: unknown, opts?: import("./types.js").CompileRelOptions): Record<string, unknown>;
export declare function filterRelationships(artifact?: unknown, types?: readonly string[]): unknown;
export declare function relationshipId(type: string, source: string, target: string, opts?: { directional?: boolean }): string;
export declare function loadDecisions(input?: unknown): unknown;
export declare function validateDecisions(input?: unknown): unknown;
export declare function hashJson(value?: unknown): string;
export declare function mergeRelationshipArtifacts(opts?: import("./types.js").MergeRelOptions): unknown;
