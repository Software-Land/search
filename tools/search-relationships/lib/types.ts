/**
 * Small relationship taxonomy. Unknown types fail compile rather than
 * becoming an unbounded ontology.
 *
 * Search Core consumes a generic edge list; type stays explicit.
 * searchEligible types may feed search()/related rails.
 * Structural types are stored but omitted from the default runtime graph.
 */

import type { TypeSpec } from "../types.js";

export const ARTIFACT_FORMAT = "search-v2-relationships";

export const RELATIONSHIP_TYPES: Record<string, TypeSpec> = {
  semantic: {
    symmetric: false,
    searchEligible: true,
    description: "Offline embedding/lexical document relatedness. Directed top-K lists are not silently symmetrized.",
  },
  editorial: {
    symmetric: true,
    searchEligible: true,
    description: "Domain author says the target is useful to discover from the source. Symmetric unless directional: true.",
  },
  "manually-related": {
    symmetric: true,
    searchEligible: true,
    description: "Generic human-asserted relatedness without a more specific type.",
  },
  "same-category": {
    symmetric: true,
    searchEligible: false,
    description: "Shared category/tag. Stored; not a default ranking signal.",
  },
  prerequisite: {
    symmetric: false,
    searchEligible: false,
    description: "Source requires or follows from target. Direction is source → target as authored.",
  },
  supersedes: {
    symmetric: false,
    searchEligible: false,
    description: "Source replaces target. Directional.",
  },
};

export const ALLOWED_TYPES = new Set(Object.keys(RELATIONSHIP_TYPES));

/** Types that may enter Search Core search()/related by default. */
export const DEFAULT_RUNTIME_TYPES: readonly string[] = Object.freeze(
  Object.entries(RELATIONSHIP_TYPES)
    .filter(([, spec]) => spec.searchEligible)
    .map(([type]) => type)
);

export const STRUCTURAL_TYPES: readonly string[] = Object.freeze(
  Object.entries(RELATIONSHIP_TYPES)
    .filter(([, spec]) => !spec.searchEligible)
    .map(([type]) => type)
);

export function typeSpec(type: unknown): TypeSpec | null {
  return RELATIONSHIP_TYPES[String(type || "")] || null;
}

export function isSymmetricType(type: unknown, { directional = false }: { directional?: boolean } = {}): boolean {
  if (directional) return false;
  return Boolean(RELATIONSHIP_TYPES[String(type || "")]?.symmetric);
}

/** Discrete explicit importance. Not a cosine. */
export const EXPLICIT_STRENGTH = 1;
