/**
 * search-relationships contracts for checkJs and the public barrel.
 */

export interface RelDocument {
  id: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown> & {
    path?: unknown;
    dir?: unknown;
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

export interface CompileRelOptions {
  domain?: unknown;
  semantic?: unknown;
  runtimeTypes?: readonly string[];
}

export interface MergeRelOptions {
  semantic?: unknown;
  domain?: unknown;
  runtimeTypes?: readonly string[];
}
