/**
 * Internal search-relationships contracts for checkJs.
 */

export interface RelDocument {
  id: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown> & {
    path?: unknown;
    dir?: unknown;
    links?: unknown;
    category?: unknown;
    prerequisite?: unknown;
    prerequisites?: unknown;
  };
}

export interface DocIndex {
  documents: RelDocument[];
  byId: Map<string, RelDocument>;
  byPath: Map<string, RelDocument>;
  bySlug: Map<string, RelDocument>;
}

export type RelationshipTypeName =
  | "semantic"
  | "editorial"
  | "manually-related"
  | "same-category"
  | "prerequisite"
  | "supersedes"
  | string;

export interface TypeSpec {
  symmetric: boolean;
  searchEligible: boolean;
  description: string;
}

export interface RelDecision {
  id: string;
  source: string;
  target: string;
  type: string;
  decision: string;
  directional: boolean;
  note: string | null;
  provenance: string | null;
  priority: number | null;
  manual: boolean;
}

export interface RelDecisionDoc {
  format: string;
  version: number;
  relationships: RelDecision[];
}

export interface RelDecisionIndex {
  loaded: RelDecisionDoc;
  byId: Map<string, RelDecision>;
  rejectAllPairs: Set<string>;
}

export type RelLifecycle =
  | "MANUAL_ACCEPTED"
  | "HUMAN_ACCEPTED"
  | "REVIEW_PENDING"
  | "HUMAN_REJECTED"
  | "CONFLICT"
  | "ORPHANED_DECISION"
  | string;

export interface RelEvidence {
  contentLinks?: number;
  metadataLinks?: number;
  declaredPrerequisite?: number;
  category?: unknown;
}

export interface RelCandidate {
  id?: string;
  type: string;
  source: string;
  target: string;
  directional?: boolean;
  status?: string;
  lifecycle?: RelLifecycle;
  note?: string | null;
  evidence?: RelEvidence;
  reasons?: string[];
  flags?: string[];
  provenance?: Array<Record<string, unknown>> | string;
  reviewBand?: string | null;
  reviewContributions?: Array<{ name: string; weight: number }>;
  resolvedSource?: string | null;
  resolvedTarget?: string | null;
  decisionRecord?: RelDecision;
}

export interface RelLifecycleResult {
  candidates: RelCandidate[];
  conflicts: unknown[];
  flags: unknown[];
  orphaned: RelCandidate[];
  decisions: RelDecisionDoc;
  rejectAllPairs: Set<string>;
  rejectedIds: Set<string>;
  usedDecisionIds: Set<string>;
}

export interface RelationshipEdge {
  target: string;
  type?: string;
  strength?: number;
  provenance?: string | null;
}

export interface RelationshipArtifact {
  format: string;
  version: number;
  relationships: Record<string, RelationshipEdge[]>;
}

export interface FlattenedEdge {
  source: string;
  target: string;
  type: string;
  strength: number | null;
  provenance: string | null;
}

export interface AnalyzeRelOptions {
  decisions?: unknown;
  mine?: boolean;
}

export interface CompileRelOptions {
  decisions?: unknown;
  semantic?: unknown;
  mine?: boolean;
  runtimeTypes?: readonly string[];
}

export interface MergeRelOptions {
  semantic?: unknown;
  domain?: unknown;
  life?: RelLifecycleResult | Record<string, unknown>;
  runtimeTypes?: readonly string[];
}

export interface RelInspectionDoc {
  format: string;
  version: number;
  lifecycle: Record<string, unknown[]>;
  pending: unknown[];
  orphaned: RelCandidate[];
  conflicts: unknown[];
  delta: unknown;
  queueStats: unknown;
  counts: Record<string, number>;
}
