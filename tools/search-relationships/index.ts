/**
 * Public search-relationships compiler API.
 * Implementation lives under ./lib; this barrel freezes the v0.2.2 types.
 */
import {
  analyzeRelationships as analyzeRelationshipsImpl,
  compileRelationships as compileRelationshipsImpl,
  filterRelationships as filterRelationshipsImpl,
} from "./lib/pipeline.js";
import { relationshipId as relationshipIdImpl } from "./lib/ids.js";
import {
  RELATIONSHIP_TYPES as relationshipTypesImpl,
  DEFAULT_RUNTIME_TYPES as defaultRuntimeTypesImpl,
  STRUCTURAL_TYPES as structuralTypesImpl,
} from "./lib/types.js";
import { loadDecisions as loadDecisionsImpl, validateDecisions as validateDecisionsImpl } from "./lib/decisions.js";
import { hashJson as hashJsonImpl } from "./lib/hash.js";
import { mergeRelationshipArtifacts as mergeRelationshipArtifactsImpl } from "./lib/merge.js";
import { LIFECYCLE as lifecycleImpl } from "./lib/lifecycle.js";

export type {
  AnalyzeRelOptions,
  CompileRelOptions,
  MergeRelOptions,
  RelDocument,
  RelationshipArtifact,
  RelationshipEdge,
} from "./types.js";

export const COMPILER_VERSION: 1 = 1;

export const LIFECYCLE: {
  readonly MANUAL_ACCEPTED: "MANUAL_ACCEPTED";
  readonly HUMAN_ACCEPTED: "HUMAN_ACCEPTED";
  readonly REVIEW_PENDING: "REVIEW_PENDING";
  readonly HUMAN_REJECTED: "HUMAN_REJECTED";
  readonly CONFLICT: "CONFLICT";
  readonly ORPHANED_DECISION: "ORPHANED_DECISION";
} = lifecycleImpl;

export const RELATIONSHIP_TYPES: Record<string, { symmetric: boolean; searchEligible: boolean; description: string }> =
  relationshipTypesImpl;
export const DEFAULT_RUNTIME_TYPES: readonly string[] = defaultRuntimeTypesImpl;
export const STRUCTURAL_TYPES: readonly string[] = structuralTypesImpl;

export class DecisionError extends Error {
  details?: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "DecisionError";
    this.details = details;
  }
}

export function analyzeRelationships(
  input?: unknown,
  opts?: import("./types.js").AnalyzeRelOptions
): Record<string, unknown> {
  return analyzeRelationshipsImpl(input, opts) as Record<string, unknown>;
}

export function compileRelationships(
  input?: unknown,
  opts?: import("./types.js").CompileRelOptions
): Record<string, unknown> {
  return compileRelationshipsImpl(input, opts) as Record<string, unknown>;
}

export function filterRelationships(artifact?: unknown, types?: readonly string[]): unknown {
  return filterRelationshipsImpl(artifact as never, types as never);
}

export function relationshipId(
  type: string,
  source: string,
  target: string,
  opts?: { directional?: boolean }
): string {
  return relationshipIdImpl(type, source, target, opts);
}

export function loadDecisions(input?: unknown): unknown {
  return loadDecisionsImpl(input);
}

export function validateDecisions(input?: unknown): unknown {
  return validateDecisionsImpl(input);
}

export function hashJson(value?: unknown): string {
  return hashJsonImpl(value);
}

export function mergeRelationshipArtifacts(opts?: import("./types.js").MergeRelOptions): unknown {
  return mergeRelationshipArtifactsImpl(opts);
}
