/**
 * Public configuration constants and SearchEngine.create() validation.
 * Invalid values throw; they are not silently coerced to defaults.
 */

import { InvalidConfigurationError, IndexStateError } from "./errors.js";
import { createFullScanRetriever, createIndexedLexicalRetriever, createAdaptiveRetriever } from "./retrievers.js";
import type {
  AdaptiveOptions,
  RelationshipArtifact,
  RelationshipGraphApi,
  RelationshipStrategy,
  Retriever,
  Schema,
  SearchEngineOptions,
  SearchIndex,
  SearchPlugin,
} from "./types.js";

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

interface CreatedConfig {
  schema: Schema;
  plugins: SearchPlugin[];
  relationships: RelationshipArtifact | RelationshipGraphApi | null;
  relationshipStrategy: RelationshipStrategy;
  retriever: Retriever;
  candidateLimit: number | null;
  adaptive: AdaptiveOptions;
  retrievalScoreWeight: number;
}

export function requireStrategy(value: unknown, opts?: { field?: string; optional?: false }): RelationshipStrategy;
export function requireStrategy(value: unknown, opts: { field?: string; optional: true }): RelationshipStrategy | null;
export function requireStrategy(
  value: unknown,
  { field = "relationshipStrategy", optional = false }: { field?: string; optional?: boolean } = {}
): RelationshipStrategy | null {
  if (value == null || value === "") {
    if (optional) return null;
    throw new InvalidConfigurationError(`${field} is required`, {
      field,
      expected: RELATIONSHIP_STRATEGIES.join(" | "),
    });
  }
  const allowed: readonly string[] = RELATIONSHIP_STRATEGIES;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new InvalidConfigurationError(`${field} must be one of ${RELATIONSHIP_STRATEGIES.join(" | ")} (got ${JSON.stringify(value)})`, {
      field,
      expected: RELATIONSHIP_STRATEGIES.join(" | "),
    });
  }
  return value as RelationshipStrategy;
}

function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigurationError(`${field} must be a plain object`, { field, expected: "object" });
  }
}

export function validateSchema(schema?: unknown): Schema {
  if (schema == null) {
    return {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    };
  }
  assertPlainObject(schema, "schema");
  const textFields: string[] = [];
  for (const [name, spec] of Object.entries(schema)) {
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
        `schema.${name}.role must be "title" or "body" (got ${JSON.stringify(spec.role)}). Other roles are not a stable search contract.`,
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
  return schema as Schema;
}

function validateAdaptive(adaptive?: unknown): AdaptiveOptions {
  if (adaptive == null) return { documentThreshold: DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD };
  assertPlainObject(adaptive, "adaptive");
  for (const key of Object.keys(adaptive)) {
    if (key !== "documentThreshold") {
      throw new InvalidConfigurationError(`Unknown adaptive option "${key}"`, {
        field: `adaptive.${key}`,
        expected: "documentThreshold",
      });
    }
  }
  const raw = adaptive.documentThreshold;
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

function validateCandidateLimit(value?: unknown, field = "candidateLimit"): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidConfigurationError(`${field} must be a positive integer`, { field, expected: "positive integer" });
  }
  return n;
}

/**
 * Built-in retrievers by public name. Custom { retrieve } objects are experimental.
 */
export function resolvePublicRetriever(
  spec?: unknown,
  { candidateLimit, adaptive }: { candidateLimit?: number | null; adaptive?: AdaptiveOptions | null } = {}
): Retriever {
  const limit = candidateLimit || DEFAULT_CANDIDATE_LIMIT;
  const threshold = adaptive?.documentThreshold || DEFAULT_ADAPTIVE_DOCUMENT_THRESHOLD;
  if (spec == null || spec === "full-scan") return createFullScanRetriever();
  if (typeof spec === "object" && spec && "retrieve" in spec && typeof spec.retrieve === "function") {
    return spec as Retriever;
  }
  if (spec === "indexed" || spec === "indexed-lexical") {
    return createIndexedLexicalRetriever({ candidateLimit: limit });
  }
  if (spec === "adaptive") {
    return createAdaptiveRetriever({
      documentThreshold: threshold,
      indexedOptions: { candidateLimit: limit },
    });
  }
  throw new InvalidConfigurationError(
    `retriever must be one of ${RETRIEVER_NAMES.join(" | ")} (got ${JSON.stringify(spec)})`,
    { field: "retriever", expected: RETRIEVER_NAMES.join(" | ") }
  );
}

export function validateCreateOptions(options: unknown = {}): CreatedConfig {
  if (options == null || typeof options !== "object" || Array.isArray(options)) {
    throw new InvalidConfigurationError("SearchEngine.create() options must be a plain object", {
      field: "options",
      expected: "object",
    });
  }
  const opts = options as SearchEngineOptions & Record<string, unknown>;
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
    plugins: Array.isArray(opts.plugins) ? opts.plugins.filter((p): p is SearchPlugin => p != null) : [],
    relationships: opts.relationships == null ? null : opts.relationships,
    relationshipStrategy,
    retriever,
    candidateLimit,
    adaptive,
    retrievalScoreWeight,
  };
}

export function requireIndexed(engine: { _index?: SearchIndex | null } | null | undefined): SearchIndex {
  if (!engine || !engine._index) {
    throw new IndexStateError("SearchEngine.search requires index() first");
  }
  return engine._index;
}
