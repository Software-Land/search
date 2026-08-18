/**
 * Durable relationship decisions. Generated output never writes this file.
 */

import { ALLOWED_TYPES } from "./types.js";
import { relationshipId, normalizeRef } from "./ids.js";

export const DECISION_FORMAT = "search-relationships-decisions";
export const ALLOWED_DECISIONS = new Set(["accept", "reject"]);

export class DecisionError extends Error {
  /**
   * @param {string} message
   * @param {string[]} [details]
   */
  constructor(message, details = []) {
    super(message);
    this.name = "DecisionError";
    this.details = details;
  }
}

/** @returns {import("../types.js").RelDecisionDoc} */
export function emptyDecisions() {
  return { format: DECISION_FORMAT, version: 1, relationships: [] };
}

/** @param {Record<string, unknown>} item @returns {import("../types.js").RelDecision} */
function normalizeItem(item) {
  const type = String(item.type || "editorial").toLowerCase();
  const source = normalizeRef(item.source);
  const target = normalizeRef(item.target);
  const directional = Boolean(item.directional);
  const id = typeof item.id === "string" && item.id ? item.id : relationshipId(type, source, target, { directional });
  return {
    id,
    source,
    target,
    type,
    decision: String(item.decision || "").toLowerCase(),
    directional,
    note: item.note ? String(item.note) : null,
    provenance: item.provenance ? String(item.provenance) : null,
    priority: item.priority == null ? null : Number(item.priority),
    manual: item.manual !== false,
  };
}

/** @param {unknown} raw @returns {import("../types.js").RelDecisionDoc} */
export function loadDecisions(raw) {
  if (raw == null) return emptyDecisions();
  if (typeof raw !== "object" || Array.isArray(raw)) throw new DecisionError("Decisions must be a JSON object");
  const rec = /** @type {Record<string, unknown>} */ (raw);
  if (rec.format && rec.format !== DECISION_FORMAT) {
    throw new DecisionError(`Expected format ${DECISION_FORMAT}, got ${rec.format}`);
  }
  const list = Array.isArray(rec.relationships) ? rec.relationships : [];
  return {
    format: DECISION_FORMAT,
    version: rec.version == null ? 1 : Number(rec.version) || 1,
    relationships: list.map((item) => normalizeItem(item && typeof item === "object" ? /** @type {Record<string, unknown>} */ (item) : {})),
  };
}

/** @param {unknown} raw @returns {import("../types.js").RelDecisionDoc} */
export function validateDecisions(raw) {
  const loaded = loadDecisions(raw);
  const errors = [];
  const byId = new Map();
  for (const item of loaded.relationships) {
    if (!ALLOWED_DECISIONS.has(item.decision)) {
      errors.push(`${item.id}: unknown decision "${item.decision}"`);
    }
    if (!item.source) errors.push(`${item.id || "?"}: missing source`);
    if (!item.target) errors.push(`${item.id || "?"}: missing target`);
    if (item.source && item.target && item.source === item.target) {
      errors.push(`${item.id}: source and target are the same`);
    }
    if (item.decision === "reject" && item.type === "*") {
      // pair-level reject of every type
    } else if (!ALLOWED_TYPES.has(item.type)) {
      errors.push(`${item.id}: unknown relationship type "${item.type}" (add it to RELATIONSHIP_TYPES to extend)`);
    }
    if (byId.has(item.id) && byId.get(item.id).decision !== item.decision) {
      errors.push(`${item.id}: both accept and reject`);
    }
    byId.set(item.id, item);
  }
  if (errors.length) throw new DecisionError(`Invalid relationship decisions: ${errors.join("; ")}`, errors);
  return loaded;
}

/** @param {unknown} raw @returns {import("../types.js").RelDecisionIndex} */
export function indexDecisions(raw) {
  const loaded = validateDecisions(raw);
  const byId = new Map();
  const rejectAllPairs = new Set();
  for (const item of loaded.relationships) {
    byId.set(item.id, item);
    if (item.decision === "reject" && item.type === "*") {
      rejectAllPairs.add(`${item.source}::${item.target}`);
    }
  }
  return { loaded, byId, rejectAllPairs };
}
