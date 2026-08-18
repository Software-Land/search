/**
 * Public configuration constants and SearchEngine.create() validation.
 * Invalid values throw; they are not silently coerced to defaults.
 */

import { InvalidConfigurationError, IndexStateError } from "./errors.js";
import { createFullScanRetriever, createIndexedLexicalRetriever, createAdaptiveRetriever } from "./retrievers.js";

export const RELATIONSHIP_STRATEGIES = Object.freeze(["none", "mixed", "hybrid", "separate"]);
export const DEFAULT_RELATIONSHIP_STRATEGY = "hybrid";

/** Names advertised in docs. "indexed-lexical" is an accepted alias of "indexed". */
export const RETRIEVER_NAMES = Object.freeze(["full-scan", "indexed", "adaptive"]);
export const DEFAULT_CANDIDATE_LIMIT = 200;
export const DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD = 1500;

const CREATE_KEYS = new Set([
  "schema",
  "plugins",
  "relationships",
  "relationshipStrategy",
  "retriever",
  "candidateLimit",
  "adaptive",
  "retrievalScoreWeight",
]);

const FORBIDDEN_SCHEMA_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * @overload
 * @param {unknown} value
 * @param {{ field?: string, optional?: false }} [opts]
 * @returns {import("./types.js").RelationshipStrategy}
 *
 * @overload
 * @param {unknown} value
 * @param {{ field?: string, optional: true }} opts
 * @returns {import("./types.js").RelationshipStrategy | null}
 *
 * @param {unknown} value
 * @param {{ field?: string, optional?: boolean }} [opts]
 * @returns {import("./types.js").RelationshipStrategy | null}
 */
export function requireStrategy(value, { field = "relationshipStrategy", optional = false } = {}) {
  if (value == null || value === "") {
    if (optional) return null;
    throw new InvalidConfigurationError(`${field} is required`, {
      field,
      expected: RELATIONSHIP_STRATEGIES.join(" | "),
    });
  }
  const allowed = /** @type {readonly string[]} */ (RELATIONSHIP_STRATEGIES);
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new InvalidConfigurationError(`${field} must be one of ${RELATIONSHIP_STRATEGIES.join(" | ")} (got ${JSON.stringify(value)})`, {
      field,
      expected: RELATIONSHIP_STRATEGIES.join(" | "),
    });
  }
  return /** @type {import("./types.js").RelationshipStrategy} */ (value);
}

/** @param {unknown} value @param {string} field */
function assertPlainObject(value, field) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigurationError(`${field} must be a plain object`, { field, expected: "object" });
  }
}

/** @param {unknown} [schema] @returns {import("./types.js").Schema} */
export function validateSchema(schema) {
  if (schema == null) {
    return {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    };
  }
  assertPlainObject(schema, "schema");
  const fields = /** @type {Record<string, { type?: unknown, role?: unknown } | null | undefined>} */ (schema);
  const textFields = [];
  for (const [name, spec] of Object.entries(fields)) {
    if (FORBIDDEN_SCHEMA_KEYS.has(name)) {
      throw new InvalidConfigurationError(`schema field name ${JSON.stringify(name)} is not allowed`, { field: "schema" });
    }
    if (spec == null) continue;
    assertPlainObject(spec, `schema.${name}`);
    if (spec.type != null && spec.type !== "text") {
      throw new InvalidConfigurationError(`schema.${name}.type must be "text" (got ${JSON.stringify(spec.type)})`, {
        field: `schema.${name}.type`,
        expected: "text",
      });
    }
    if (spec.role != null && spec.role !== "title" && spec.role !== "body") {
      throw new InvalidConfigurationError(
        `schema.${name}.role must be "title" or "body" (got ${JSON.stringify(spec.role)}). Other roles are not a stable Search V2 contract.`,
        { field: `schema.${name}.role`, expected: "title | body" }
      );
    }
    if ((spec.type || "text") === "text") textFields.push(name);
  }
  if (!textFields.length) {
    throw new InvalidConfigurationError('schema must include at least one { type: "text" } field', {
      field: "schema",
      expected: '{ title: { type: "text", role: "title" }, body: { type: "text", role: "body" } }',
    });
  }
  return /** @type {import("./types.js").Schema} */ (schema);
}

/** @param {unknown} [adaptive] @returns {import("./types.js").AdaptiveOptions} */
function validateAdaptive(adaptive) {
  if (adaptive == null) return { documentThreshold: DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD };
  assertPlainObject(adaptive, "adaptive");
  const rec = /** @type {Record<string, unknown>} */ (adaptive);
  for (const key of Object.keys(rec)) {
    if (key !== "documentThreshold") {
      throw new InvalidConfigurationError(`Unknown adaptive option "${key}"`, {
        field: `adaptive.${key}`,
        expected: "documentThreshold",
      });
    }
  }
  const raw = rec.documentThreshold;
  if (raw == null) return { documentThreshold: DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidConfigurationError("adaptive.documentThreshold must be a positive integer", {
      field: "adaptive.documentThreshold",
      expected: "positive integer",
    });
  }
  return { documentThreshold: n };
}

/** @param {unknown} [value] @param {string} [field] @returns {number | null} */
function validateCandidateLimit(value, field = "candidateLimit") {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidConfigurationError(`${field} must be a positive integer`, { field, expected: "positive integer" });
  }
  return n;
}

/**
 * Built-in retrievers by public name. Custom { retrieve } objects are experimental.
 * @param {unknown} [spec]
 * @param {{ candidateLimit?: number | null, adaptive?: import("./types.js").AdaptiveOptions | null }} [opts]
 * @returns {import("./types.js").Retriever}
 */
export function resolvePublicRetriever(spec, { candidateLimit, adaptive } = {}) {
  const limit = candidateLimit || DEFAULT_CANDIDATE_LIMIT;
  const threshold = adaptive?.documentThreshold || DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD;
  if (spec == null || spec === "full-scan") return createFullScanRetriever();
  if (typeof spec === "object" && spec && "retrieve" in spec && typeof spec.retrieve === "function") {
    return /** @type {import("./types.js").Retriever} */ (spec);
  }
  if (spec === "indexed" || spec === "indexed-lexical") {
    return createIndexedLexicalRetriever({ candidateLimit: limit });
  }
  if (spec === "adaptive") {
    return createAdaptiveRetriever(
      /** @type {import("./types.js").AdaptiveRetrieverOptions} */ ({
        documentThreshold: threshold,
        indexedOptions: { candidateLimit: limit },
      })
    );
  }
  throw new InvalidConfigurationError(
    `retriever must be one of ${RETRIEVER_NAMES.join(" | ")} (got ${JSON.stringify(spec)})`,
    { field: "retriever", expected: RETRIEVER_NAMES.join(" | ") }
  );
}

/**
 * @param {unknown} [options]
 * @returns {{
 *   schema: import("./types.js").Schema,
 *   plugins: import("./types.js").SearchPlugin[],
 *   relationships: import("./types.js").RelationshipArtifact | import("./types.js").RelationshipGraphApi | null,
 *   relationshipStrategy: import("./types.js").RelationshipStrategy,
 *   retriever: import("./types.js").Retriever,
 *   candidateLimit: number | null,
 *   adaptive: import("./types.js").AdaptiveOptions,
 *   retrievalScoreWeight: number,
 * }}
 */
export function validateCreateOptions(options = {}) {
  if (options == null || typeof options !== "object" || Array.isArray(options)) {
    throw new InvalidConfigurationError("SearchEngine.create() options must be a plain object", {
      field: "options",
      expected: "object",
    });
  }
  const opts = /** @type {import("./types.js").SearchEngineOptions & Record<string, unknown>} */ (options);
  for (const key of Object.keys(opts)) {
    if (!CREATE_KEYS.has(key)) {
      throw new InvalidConfigurationError(`Unknown SearchEngine.create() option "${key}"`, {
        field: key,
        expected: [...CREATE_KEYS].join(" | "),
      });
    }
  }
  const schema = validateSchema(opts.schema);
  if (opts.plugins != null && !Array.isArray(opts.plugins)) {
    throw new InvalidConfigurationError("plugins must be an array", { field: "plugins", expected: "array" });
  }
  const relationshipStrategy =
    opts.relationshipStrategy == null
      ? DEFAULT_RELATIONSHIP_STRATEGY
      : requireStrategy(opts.relationshipStrategy);
  const candidateLimit = validateCandidateLimit(opts.candidateLimit);
  const adaptive = validateAdaptive(opts.adaptive);
  let retrievalScoreWeight = 0;
  if (opts.retrievalScoreWeight != null) {
    const w = Number(opts.retrievalScoreWeight);
    if (!Number.isFinite(w) || w < 0) {
      throw new InvalidConfigurationError("retrievalScoreWeight must be a finite number ≥ 0", {
        field: "retrievalScoreWeight",
        expected: "number ≥ 0 (experimental; default 0)",
      });
    }
    retrievalScoreWeight = w;
  }
  const retriever = resolvePublicRetriever(opts.retriever, { candidateLimit, adaptive });
  return {
    schema,
    plugins: Array.isArray(opts.plugins) ? opts.plugins.filter((p) => p != null) : [],
    relationships: opts.relationships == null ? null : opts.relationships,
    relationshipStrategy,
    retriever,
    candidateLimit,
    adaptive,
    retrievalScoreWeight,
  };
}

/**
 * @param {{ _index?: import("./types.js").SearchIndex | null } | null | undefined} engine
 * @returns {import("./types.js").SearchIndex}
 */
export function requireIndexed(engine) {
  if (!engine || !engine._index) {
    throw new IndexStateError("SearchEngine.search requires index() first");
  }
  return engine._index;
}
