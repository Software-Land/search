/**
 * Public search-relationships compiler API.
 * Implementation lives under ./lib.
 */
import { compileRelationships as compileRelationshipsImpl, filterRelationships as filterRelationshipsImpl } from "./lib/pipeline.js";
export { COMPILER_VERSION } from "./lib/pipeline.js";
import { relationshipId as relationshipIdImpl } from "./lib/ids.js";
import {
  RELATIONSHIP_TYPES as relationshipTypesImpl,
  DEFAULT_RUNTIME_TYPES as defaultRuntimeTypesImpl,
  STRUCTURAL_TYPES as structuralTypesImpl,
} from "./lib/types.js";
import { loadDecisions as loadDecisionsImpl, validateDecisions as validateDecisionsImpl } from "./lib/decisions.js";
import { hashJson as hashJsonImpl } from "./lib/hash.js";
import { mergeRelationshipArtifacts as mergeRelationshipArtifactsImpl } from "./lib/merge.js";

export { DecisionError } from "./lib/decisions.js";

export type {
  CompileRelOptions,
  MergeRelOptions,
  RelDocument,
  RelationshipArtifact,
  RelationshipEdge,
} from "./types.js";

export const RELATIONSHIP_TYPES: Record<string, { symmetric: boolean; searchEligible: boolean; description: string }> =
  relationshipTypesImpl;
export const DEFAULT_RUNTIME_TYPES: readonly string[] = defaultRuntimeTypesImpl;
export const STRUCTURAL_TYPES: readonly string[] = structuralTypesImpl;

export function compileRelationships(
  input?: unknown,
  opts?: import("./types.js").CompileRelOptions
): Record<string, unknown> {
  return compileRelationshipsImpl(input, opts) as Record<string, unknown>;
}

export function filterRelationships(artifact?: unknown, types?: readonly string[]): unknown {
  return filterRelationshipsImpl(artifact as never, types);
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
