/**
 * Authored directional relationshipMap.
 *
 * equivalent  → existing one-hop search-equivalence recall semantics
 * related     → existing standalone-recall, topical-recall, or editorial document edges
 *
 * Generated MiniLM / semantic edges are not authored here.
 */

import { InvalidConfigurationError } from "./errors.js";
import { sequenceKey } from "./configuredAuthoring.js";
import { ARTIFACT_FORMATS, ARTIFACT_VERSION, parseRelationships } from "./artifacts.js";
import type { DictionaryEntry, RelationshipArtifact, RelationshipEdge } from "./types.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const KINDS = new Set(["equivalent", "related"]);
const ENDPOINT_KEYS = new Set(["form", "concept", "document"]);
const NUMERIC_FIELDS = ["strength", "weight", "score", "priority", "boost"];

export type RelationshipKind = "equivalent" | "related";

export type RelationshipEndpoint =
  | { form: string | string[] }
  | { concept: string }
  | { document: string };

export interface AuthoredRelationshipEdge {
  to: RelationshipEndpoint;
  kind: RelationshipKind;
}

export type RelationshipMap = Record<string, AuthoredRelationshipEdge[]>;

export interface RelationshipDocumentRef {
  id?: unknown;
  title?: unknown;
  path?: unknown;
  slug?: unknown;
}

export type EditorialRelationshipEdge = {
  target: string;
  type: "editorial";
  strength: 1;
  provenance: "manual";
};

/** Internal compileRelationshipMap() projection. Internal recall maps stay private. */
export interface CompiledRelationshipMap {
  synonymMap: Record<string, string[]>;
  editorialRelationships: Record<string, EditorialRelationshipEdge[]>;
}

export interface CompiledRelationshipInternals extends CompiledRelationshipMap {
  standaloneRecallByKey: Map<string, string[]>;
  topicalRecallByKey: Map<string, string[][]>;
}

export interface CompileRelationshipMapOptions {
  concepts?: Iterable<DictionaryEntry | { key?: string } | string> | Map<string, unknown> | null;
  documents?: Iterable<RelationshipDocumentRef> | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string, field: string, expected: string): never {
  throw new InvalidConfigurationError(message, { field, expected });
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function ownedList<T>(record: Record<string, T[]>, key: string): T[] {
  const existing = record[key];
  if (Array.isArray(existing)) return existing;
  const next: T[] = [];
  record[key] = next;
  return next;
}

/** Reject prototype-pollution keys after the same trim used for storage. */
function assertOrdinarySourceKey(raw: string): string {
  const trimmed = raw.trim();
  if (FORBIDDEN_KEYS.has(raw) || FORBIDDEN_KEYS.has(trimmed) || FORBIDDEN_KEYS.has(trimmed.toLowerCase())) {
    fail("forbidden relationshipMap key", "relationshipMap", "ordinary source key");
  }
  return trimmed;
}

function conceptKeySet(concepts: CompileRelationshipMapOptions["concepts"]): Set<string> {
  const keys = new Set<string>();
  if (!concepts) return keys;
  if (concepts instanceof Map) {
    for (const key of concepts.keys()) keys.add(String(key).toLowerCase());
    return keys;
  }
  for (const item of concepts) {
    if (typeof item === "string") keys.add(item.toLowerCase());
    else if (item && typeof item === "object" && "key" in item && item.key) keys.add(String(item.key).toLowerCase());
  }
  return keys;
}

function formTokens(form: unknown, field: string): string[] {
  if (typeof form === "string") {
    const trimmed = form.trim().toLowerCase();
    if (!trimmed) fail("form endpoint is empty", field, "non-empty token or token array");
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (!tokens.length) fail("form endpoint is empty", field, "non-empty token or token array");
    return tokens;
  }
  if (!Array.isArray(form) || !form.length) {
    fail("form endpoint must be a string or non-empty string array", field, "string | string[]");
  }
  const tokens: string[] = [];
  for (const item of form) {
    const token = String(item ?? "").toLowerCase().trim();
    if (!token || /\s/.test(token)) {
      fail("malformed form token", field, "non-empty tokens without internal whitespace");
    }
    tokens.push(token);
  }
  return tokens;
}

function formPhrase(form: unknown, field: string): string {
  if (typeof form === "string") {
    const trimmed = form.trim();
    if (!trimmed) fail("form endpoint is empty", field, "non-empty form phrase");
    return trimmed;
  }
  return formTokens(form, field).join(" ");
}

function singleToken(raw: string, field: string): string {
  const token = raw.toLowerCase().trim();
  if (!token || /\s/.test(token)) {
    fail("related concept source must be a single token", field, "one token");
  }
  return token;
}

function documentCatalog(documents: CompileRelationshipMapOptions["documents"]): {
  byId: Map<string, string>;
  byAlias: Map<string, string[]>;
} {
  const byId = new Map<string, string>();
  const byAlias = new Map<string, string[]>();
  function addAlias(alias: string, id: string) {
    const key = alias.toLowerCase().trim();
    if (!key) return;
    const ids = byAlias.get(key) || [];
    if (!ids.includes(id)) ids.push(id);
    byAlias.set(key, ids);
  }
  for (const doc of documents || []) {
    if (!doc || typeof doc !== "object") continue;
    const id = doc.id == null ? "" : String(doc.id).trim();
    if (!id) continue;
    byId.set(id, id);
    addAlias(id, id);
    if (doc.title != null) addAlias(String(doc.title), id);
    if (doc.path != null) addAlias(String(doc.path), id);
    if (doc.slug != null) addAlias(String(doc.slug), id);
  }
  return { byId, byAlias };
}

function resolveDocument(
  raw: unknown,
  catalog: ReturnType<typeof documentCatalog>,
  field: string
): string {
  const ref = String(raw ?? "").trim();
  if (!ref) fail("document endpoint is empty", field, "document id or unique title/path");
  if (catalog.byId.has(ref)) return catalog.byId.get(ref) as string;
  const ids = catalog.byAlias.get(ref.toLowerCase()) || [];
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) {
    fail(`ambiguous document reference ${JSON.stringify(ref)}`, field, "unique document id");
  }
  fail(`unknown document ${JSON.stringify(ref)}`, field, "known document id");
}

function endpointKind(to: unknown, field: string): "form" | "concept" | "document" {
  if (!isPlainObject(to)) fail("relationship endpoint must be a typed object", field, "{ form | concept | document }");
  const keys = Object.keys(to).filter((k) => ENDPOINT_KEYS.has(k));
  if (keys.length !== 1) {
    fail("relationship endpoint must have exactly one of form, concept, document", field, "{ form } | { concept } | { document }");
  }
  return keys[0] as "form" | "concept" | "document";
}

function pushUnique(list: string[], value: string) {
  if (!list.includes(value)) list.push(value);
}

function pushUniqueForm(list: string[][], form: string[]) {
  const key = sequenceKey(form);
  if (list.some((item) => sequenceKey(item) === key)) return;
  list.push([...form]);
}

function emptyCompiledInternals(): CompiledRelationshipInternals {
  return {
    synonymMap: emptyRecord(),
    standaloneRecallByKey: new Map(),
    topicalRecallByKey: new Map(),
    editorialRelationships: emptyRecord(),
  };
}

function projectCompiledRelationshipMap(compiled: CompiledRelationshipInternals): CompiledRelationshipMap {
  return {
    synonymMap: compiled.synonymMap,
    editorialRelationships: compiled.editorialRelationships,
  };
}

/**
 * Full compiler used by compileAuthoredRelevance().
 * Not a public export.
 */
export function compileRelationshipMapInternal(
  raw: unknown,
  { concepts, documents }: CompileRelationshipMapOptions = {}
): CompiledRelationshipInternals {
  if (raw == null) {
    return emptyCompiledInternals();
  }
  if (!isPlainObject(raw)) {
    fail("relationshipMap must be a plain object", "relationshipMap", "Record<source, edges>");
  }

  const conceptKeys = conceptKeySet(concepts);
  const catalog = documentCatalog(documents);
  const synonymMap = emptyRecord<string[]>();
  const standaloneRecallByKey = new Map<string, string[]>();
  const topicalRecallByKey = new Map<string, string[][]>();
  const editorialRelationships = emptyRecord<
    CompiledRelationshipMap["editorialRelationships"][string]
  >();

  for (const [sourceRaw, edgesRaw] of Object.entries(raw)) {
    assertOrdinarySourceKey(sourceRaw);
    const sourceField = `relationshipMap.${sourceRaw}`;
    if (!Array.isArray(edgesRaw)) {
      fail("relationshipMap values must be edge arrays", sourceField, "AuthoredRelationshipEdge[]");
    }
    edgesRaw.forEach((edge, index) => {
      const field = `${sourceField}[${index}]`;
      if (!isPlainObject(edge)) fail("relationship edge must be a plain object", field, "{ to, kind }");
      for (const numeric of NUMERIC_FIELDS) {
        if (numeric in edge) {
          fail("authored relationships must not carry numeric weights", `${field}.${numeric}`, "omit weight fields");
        }
      }
      const kind = edge.kind;
      if (typeof kind !== "string" || !KINDS.has(kind)) {
        fail(`unsupported relationship kind ${JSON.stringify(kind)}`, `${field}.kind`, "equivalent | related");
      }
      const endpointType = endpointKind(edge.to, `${field}.to`);
      const to = edge.to as Record<string, unknown>;

      if (kind === "equivalent") {
        if (endpointType === "document") {
          fail("equivalent relationships cannot target documents", `${field}.to`, "{ form } | { concept }");
        }
        let target: string;
        if (endpointType === "concept") {
          const concept = String(to.concept ?? "").toLowerCase().trim();
          if (!concept) fail("concept endpoint is empty", `${field}.to.concept`, "configured concept key");
          if (!conceptKeys.has(concept)) {
            fail(`unknown concept ${JSON.stringify(concept)}`, `${field}.to.concept`, "configured concept key");
          }
          target = concept;
        } else {
          target = formPhrase(to.form, `${field}.to.form`);
        }
        const source = sourceRaw.trim();
        if (!source) fail("equivalent source is empty", sourceField, "non-empty source phrase");
        pushUnique(ownedList(synonymMap, source), target);
        return;
      }

      if (endpointType === "concept") {
        const concept = String(to.concept ?? "").toLowerCase().trim();
        if (!concept) fail("concept endpoint is empty", `${field}.to.concept`, "configured concept key");
        if (!conceptKeys.has(concept)) {
          fail(`unknown concept ${JSON.stringify(concept)}`, `${field}.to.concept`, "configured concept key");
        }
        const token = singleToken(sourceRaw, sourceField);
        const tokens = standaloneRecallByKey.get(concept) || [];
        pushUnique(tokens, token);
        standaloneRecallByKey.set(concept, tokens);
        return;
      }

      if (endpointType === "form") {
        const concept = sourceRaw.toLowerCase().trim();
        if (!conceptKeys.has(concept)) {
          fail(`unknown concept ${JSON.stringify(concept)}`, sourceField, "configured concept key");
        }
        const form = formTokens(to.form, `${field}.to.form`);
        const forms = topicalRecallByKey.get(concept) || [];
        pushUniqueForm(forms, form);
        topicalRecallByKey.set(concept, forms);
        return;
      }

      const sourceId = resolveDocument(sourceRaw, catalog, sourceField);
      const targetId = resolveDocument(to.document, catalog, `${field}.to.document`);
      if (sourceId === targetId) {
        fail("document related source and target must differ", field, "distinct document ids");
      }
      const list = ownedList(editorialRelationships, sourceId);
      if (!list.some((edgeRow) => edgeRow.target === targetId)) {
        list.push({ target: targetId, type: "editorial", strength: 1, provenance: "manual" });
      }
    });
  }

  return { synonymMap, standaloneRecallByKey, topicalRecallByKey, editorialRelationships };
}

/**
 * Public compiler. Returns synonym and editorial records only.
 * Standalone/topical maps remain compiler internals.
 */
export function compileRelationshipMap(
  raw: unknown,
  options: CompileRelationshipMapOptions = {}
): CompiledRelationshipMap {
  return projectCompiledRelationshipMap(compileRelationshipMapInternal(raw, options));
}

function cloneRelationshipEdge(edge: RelationshipEdge): RelationshipEdge {
  return {
    target: edge.target,
    type: edge.type,
    strength: edge.strength,
    provenance: edge.provenance,
  };
}

function sameTypedEdge(left: RelationshipEdge, right: RelationshipEdge): boolean {
  return left.target === right.target && String(left.type || "") === String(right.type || "");
}

/**
 * Compile authored editorial edges onto a base artifact. Not a root export;
 * public composition uses mergeRelationships() on RelationshipArtifact values.
 */
function mergeEditorialRelationships(
  base: unknown,
  extra?: Record<string, RelationshipEdge[]> | null
): RelationshipArtifact | null {
  const extraEntries = Object.entries(extra || {}).filter(([, edges]) => Array.isArray(edges) && edges.length);
  if (!extraEntries.length) {
    return base == null ? null : parseRelationships(base);
  }
  const parsed =
    base == null
      ? { format: ARTIFACT_FORMATS.relationships, version: ARTIFACT_VERSION, relationships: {} }
      : parseRelationships(base);
  const relationships = emptyRecord<RelationshipEdge[]>();
  for (const [source, edges] of Object.entries(parsed.relationships || {})) {
    relationships[source] = (edges || []).map(cloneRelationshipEdge);
  }
  for (const [source, edges] of extraEntries) {
    const list = ownedList(relationships, source);
    for (const edge of edges) {
      if (list.some((existing) => sameTypedEdge(existing, edge))) continue;
      list.push(cloneRelationshipEdge(edge));
    }
  }
  return {
    format: ARTIFACT_FORMATS.relationships,
    version: ARTIFACT_VERSION,
    relationships,
  };
}

/**
 * Merge two `search-v2-relationships` artifacts without mutating callers.
 * Same source/target/type keeps the first edge. Distinct types remain distinct.
 * Either argument may be null/omitted.
 */
export function mergeRelationships(base: unknown = null, extra: unknown = null): RelationshipArtifact | null {
  if (extra == null) {
    return base == null ? null : parseRelationships(base);
  }
  const extraParsed = parseRelationships(extra);
  return mergeEditorialRelationships(base, extraParsed.relationships);
}

export function applyCompiledRelationships(
  entries: DictionaryEntry[],
  compiled: CompiledRelationshipInternals
): DictionaryEntry[] {
  for (const entry of entries) {
    const standalone = compiled.standaloneRecallByKey.get(entry.key);
    if (standalone?.length) {
      const seen = new Set(entry.standaloneRecall || []);
      const next = [...(entry.standaloneRecall || [])];
      for (const token of standalone) {
        if (seen.has(token)) continue;
        seen.add(token);
        next.push(token);
      }
      entry.standaloneRecall = next;
    }
    const topical = compiled.topicalRecallByKey.get(entry.key);
    if (topical?.length) {
      const seen = new Set((entry.topicalRecall || []).map((form) => sequenceKey(form)));
      const next = [...(entry.topicalRecall || []).map((form) => [...form])];
      for (const form of topical) {
        const key = sequenceKey(form);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push([...form]);
      }
      entry.topicalRecall = next;
    }
  }
  return entries;
}
