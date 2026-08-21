/**
 * Explicit domain relationships. Every record asserts that a typed edge exists.
 * Generated output never writes this file.
 */

import { ALLOWED_TYPES } from "./types.js";
import { relationshipId, normalizeRef } from "./ids.js";
import { resolveRef } from "./documents.js";
import { stableSort } from "./hash.js";
import type { DocIndex } from "../types.js";

export const DOMAIN_FORMAT = "search-relationships-domain";

export class RelationshipError extends Error {
  details?: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "RelationshipError";
    this.details = details;
  }
}

export interface DomainRecord {
  id: string;
  source: string;
  target: string;
  type: string;
  directional: boolean;
  note: string | null;
  provenance: string | null;
  priority: number | null;
}

export interface DomainDoc {
  format: string;
  version: number;
  relationships: DomainRecord[];
}

export interface ResolvedDomainRelationship {
  id: string;
  type: string;
  resolvedSource: string;
  resolvedTarget: string;
  directional: boolean;
  provenance: string | null;
  priority: number | null;
}

export function emptyDomain(): DomainDoc {
  return { format: DOMAIN_FORMAT, version: 1, relationships: [] };
}

function normalizeItem(item: Record<string, unknown>): DomainRecord {
  const type = item.type == null ? "" : String(item.type).trim().toLowerCase();
  const source = normalizeRef(item.source);
  const target = normalizeRef(item.target);
  const directional = Boolean(item.directional);
  const id =
    typeof item.id === "string" && item.id
      ? item.id
      : relationshipId(type || "?", source, target, { directional });
  return {
    id,
    source,
    target,
    type,
    directional,
    note: item.note ? String(item.note) : null,
    provenance: item.provenance ? String(item.provenance) : null,
    priority: item.priority == null ? null : Number(item.priority),
  };
}

export function loadDomain(raw: unknown): DomainDoc {
  if (raw == null) return emptyDomain();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RelationshipError("Domain relationships must be a JSON object");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.format && rec.format !== DOMAIN_FORMAT) {
    throw new RelationshipError(`Expected format ${DOMAIN_FORMAT}, got ${rec.format}`);
  }
  const list = Array.isArray(rec.relationships) ? rec.relationships : [];
  return {
    format: DOMAIN_FORMAT,
    version: rec.version == null ? 1 : Number(rec.version) || 1,
    relationships: list.map((item) =>
      normalizeItem(item && typeof item === "object" ? (item as Record<string, unknown>) : {})
    ),
  };
}

export function validateDomain(raw: unknown): DomainDoc {
  const loaded = loadDomain(raw);
  const errors: string[] = [];
  for (const item of loaded.relationships) {
    if (!item.source) errors.push(`${item.id || "?"}: missing source`);
    if (!item.target) errors.push(`${item.id || "?"}: missing target`);
    if (item.source && item.target && item.source === item.target) {
      errors.push(`${item.id}: source and target are the same`);
    }
    if (!item.type) {
      errors.push(`${item.id || "?"}: missing type`);
    } else if (!ALLOWED_TYPES.has(item.type)) {
      errors.push(`${item.id}: unknown relationship type "${item.type}" (add it to RELATIONSHIP_TYPES to extend)`);
    }
  }
  if (errors.length) throw new RelationshipError(`Invalid domain relationships: ${errors.join("; ")}`, errors);
  return loaded;
}

export function resolveDomain(
  raw: unknown,
  docIndex: DocIndex
): { loaded: DomainDoc; resolved: ResolvedDomainRelationship[] } {
  const loaded = validateDomain(raw);
  const errors: string[] = [];
  const resolved: ResolvedDomainRelationship[] = [];
  for (const item of loaded.relationships) {
    const src = resolveRef(item.source, docIndex);
    const tgt = resolveRef(item.target, docIndex);
    if (!src || !tgt) {
      const missing = [
        !src ? `unresolved source "${item.source}"` : null,
        !tgt ? `unresolved target "${item.target}"` : null,
      ]
        .filter(Boolean)
        .join(" and ");
      errors.push(`${item.id}: ${missing}`);
      continue;
    }
    resolved.push({
      id: relationshipId(item.type, src.id, tgt.id, { directional: item.directional }),
      type: item.type,
      resolvedSource: src.id,
      resolvedTarget: tgt.id,
      directional: item.directional,
      provenance: item.provenance,
      priority: item.priority,
    });
  }
  if (errors.length) {
    throw new RelationshipError(`Invalid domain relationships: ${errors.join("; ")}`, errors);
  }
  return { loaded, resolved: stableSort(resolved, (row) => row.id) };
}
