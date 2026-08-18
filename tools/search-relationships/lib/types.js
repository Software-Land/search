/**
 * Small relationship taxonomy. Unknown types fail compile rather than
 * becoming an unbounded ontology.
 *
 * Search Core consumes a generic edge list; type stays explicit.
 * searchEligible types may feed search()/related rails.
 * Structural types are stored but omitted from the default runtime graph.
 */

export const ARTIFACT_FORMAT = "search-v2-relationships";

/** @type {Record<string, import("../types.js").TypeSpec>} */
export const RELATIONSHIP_TYPES = {
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
export const DEFAULT_RUNTIME_TYPES = Object.freeze(
  Object.entries(RELATIONSHIP_TYPES)
    .filter(([, spec]) => spec.searchEligible)
    .map(([type]) => type)
);

export const STRUCTURAL_TYPES = Object.freeze(
  Object.entries(RELATIONSHIP_TYPES)
    .filter(([, spec]) => !spec.searchEligible)
    .map(([type]) => type)
);

/** @param {unknown} type @returns {import("../types.js").TypeSpec | null} */
export function typeSpec(type) {
  const spec = /** @type {Record<string, import("../types.js").TypeSpec>} */ (RELATIONSHIP_TYPES);
  return spec[String(type || "")] || null;
}

/** @param {unknown} type @param {{ directional?: boolean }} [opts] */
export function isSymmetricType(type, { directional = false } = {}) {
  if (directional) return false;
  const spec = /** @type {Record<string, import("../types.js").TypeSpec>} */ (RELATIONSHIP_TYPES);
  return Boolean(spec[String(type || "")]?.symmetric);
}

/** Discrete explicit importance. Not a cosine. */
export const EXPLICIT_STRENGTH = 1;
