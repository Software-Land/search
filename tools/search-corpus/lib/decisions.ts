/**
 * Durable review decisions. This file is source data; generated output
 * must never write it.
 *
 * Absence of a decision means REVIEW_PENDING (or AUTO_ACCEPTED / compiler-rejected).
 * There is no separate "defer" state.
 */

import { acronymKey, expansionTokens, phraseKey } from "./text.js";
import { equivalenceId, synonymId, normalizeTerms } from "./ids.js";
import type { DecisionDoc, DecisionIndex, DecisionOverrides, EquivalenceDecision, SynonymDecision } from "../types.js";

export const DECISION_FORMAT = "search-corpus-decisions";
export const ALLOWED_DECISIONS = new Set(["accept", "reject"]);
export const ALLOWED_RELATIONS = new Set(["synonym", "alias", "surface-variant"]);

export class DecisionError extends Error {
  details: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "DecisionError";
    this.details = details;
  }
}

function asExpansion(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((w) => String(w).toLowerCase()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) return expansionTokens(raw);
  return [];
}

function expansionFromAuthored(item: { expansion?: unknown; aliases?: unknown } | null | undefined): string[] {
  const fromExp = asExpansion(item?.expansion);
  if (fromExp.length) return fromExp;
  const aliases = Array.isArray(item?.aliases) ? item.aliases : [];
  const forms = aliases.map(asExpansion).filter((form) => form.length);
  if (!forms.length) return [];
  forms.sort((a, b) => phraseKey(a).localeCompare(phraseKey(b)));
  return forms[0];
}

function asTerms(raw: unknown): string[] {
  if (Array.isArray(raw)) return normalizeTerms(raw);
  if (typeof raw === "string") return normalizeTerms(raw.split(/[\s,]+/));
  return [];
}

/**
 * Accept either:
 *   { equivalences: [...], synonyms: [...] }
 *   { equivalences: { api: { decision, expansion } }, synonyms: { "a::b": { decision } } }
 *   compact decision overrides: { accept, reject, add }
 */
export function loadDecisions(raw: unknown): DecisionDoc {
  if (raw == null) {
    return emptyDecisions();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DecisionError("Decisions must be a JSON object");
  }
  const rec = raw as Record<string, unknown> & DecisionOverrides;
  if (rec.accept || rec.reject || rec.add) {
    return loadDecisions(overridesToDecisions(rec));
  }
  if (rec.format && rec.format !== DECISION_FORMAT) {
    throw new DecisionError(`Expected format ${DECISION_FORMAT}, got ${rec.format}`);
  }
  const equivalences = normalizeEquivalenceList(rec.equivalences);
  const synonyms = normalizeSynonymList(rec.synonyms);
  return {
    format: DECISION_FORMAT,
    version: rec.version == null ? 1 : Number(rec.version) || 1,
    equivalences,
    synonyms,
  };
}

export function emptyDecisions(): DecisionDoc {
  return { format: DECISION_FORMAT, version: 1, equivalences: [], synonyms: [] };
}

export function overridesToDecisions(overrides: DecisionOverrides): DecisionDoc {
  const equivalences: EquivalenceDecision[] = [];
  for (const rej of overrides.reject || []) {
    const key = acronymKey(rej.key);
    const expansion = expansionFromAuthored(rej);
    equivalences.push({
      id: equivalenceId(key, expansion),
      type: "equivalence",
      decision: "reject",
      key,
      expansion,
      expansionPhrase: phraseKey(expansion),
      aliases: [],
      manual: true,
    });
  }
  for (const acc of [...(overrides.accept || []), ...(overrides.add || [])]) {
    const key = acronymKey(acc.key);
    const expansion = expansionFromAuthored(acc);
    equivalences.push({
      id: equivalenceId(key, expansion),
      type: "equivalence",
      decision: "accept",
      key,
      expansion,
      expansionPhrase: phraseKey(expansion),
    aliases: Array.isArray(acc.aliases) ? acc.aliases : [],
    manual: true,
    primary: acc.primary == null ? null : String(acc.primary),
  });
  }
  return { format: DECISION_FORMAT, version: 1, equivalences, synonyms: [] };
}

function normalizeEquivalenceList(raw: unknown): EquivalenceDecision[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((item) => normalizeEquivalenceItem(item as Record<string, unknown>));
  if (typeof raw === "object") {
    return Object.entries(raw).map(([k, v]) => {
      const item: Record<string, unknown> = v && typeof v === "object" ? { ...(v as Record<string, unknown>) } : { decision: v };
      if (!item.key) item.key = item.id ? undefined : k;
      if (!item.id && k.startsWith("equivalence:")) item.id = k;
      if (!item.key && item.id) {
        const parts = String(item.id).split(":");
        item.key = parts[1];
      }
      if (!item.key) item.key = k;
      return normalizeEquivalenceItem(item);
    });
  }
  throw new DecisionError("equivalences must be an array or object");
}

function normalizeEquivalenceItem(item: Record<string, unknown>): EquivalenceDecision {
  const key = acronymKey(typeof item.key === "string" ? item.key : "");
  const expansion = expansionFromAuthored(item);
  const id = typeof item.id === "string" && item.id ? item.id : equivalenceId(key, expansion);
  return {
    id,
    type: "equivalence",
    decision: String(item.decision || "").toLowerCase(),
    key,
    expansion,
    expansionPhrase: phraseKey(expansion),
    aliases: Array.isArray(item.aliases) ? item.aliases : [],
    manual: Boolean(item.manual),
    primary: item.primary == null ? null : String(item.primary),
    provenance: item.provenance == null ? null : String(item.provenance),
  };
}

function normalizeSynonymList(raw: unknown): SynonymDecision[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((item) => normalizeSynonymItem(item as Record<string, unknown>));
  if (typeof raw === "object") {
    return Object.entries(raw).map(([k, v]) => {
      const item: Record<string, unknown> = v && typeof v === "object" ? { ...(v as Record<string, unknown>) } : { decision: v };
      if (!item.terms && k.includes(":")) {
        item.terms = k.replace(/^synonym:/, "").split(":");
      }
      return normalizeSynonymItem(item);
    });
  }
  throw new DecisionError("synonyms must be an array or object");
}

function normalizeSynonymItem(item: Record<string, unknown>): SynonymDecision {
  const terms = asTerms(item.terms);
  const id = typeof item.id === "string" && item.id ? item.id : synonymId(terms);
  const relation = String(item.relation || item.type || "synonym").toLowerCase();
  return {
    id,
    type: "synonym",
    decision: String(item.decision || "").toLowerCase(),
    terms,
    relation: relation === "near-equivalence" ? "synonym" : relation,
    manual: Boolean(item.manual),
    directional: Boolean(item.directional),
  };
}

/**
 * Fail clearly on malformed decisions. Do not guess.
 */
export function validateDecisions(decisions: unknown): DecisionDoc {
  const loaded = loadDecisions(decisions);
  const errors: string[] = [];

  const eqIds = new Map<string, EquivalenceDecision>();
  const acceptByKey = new Map<string, EquivalenceDecision[]>();
  for (const item of loaded.equivalences) {
    if (!ALLOWED_DECISIONS.has(item.decision)) {
      errors.push(`equivalence ${item.id || item.key}: unknown decision "${item.decision}"`);
    }
    if (!item.key) errors.push(`equivalence missing key`);
    if (item.decision === "accept" && item.expansion.length < 1) {
      errors.push(`equivalence ${item.key}: accept without expansion`);
    }
    if (eqIds.has(item.id)) {
      const prev = eqIds.get(item.id);
      if (prev && prev.decision !== item.decision) {
        errors.push(`equivalence ${item.id}: both accept and reject`);
      }
    }
    eqIds.set(item.id, item);
    if (item.decision === "accept") {
      if (!acceptByKey.has(item.key)) acceptByKey.set(item.key, []);
      acceptByKey.get(item.key)!.push(item);
    }
  }
  for (const [key, items] of acceptByKey) {
    const phrases = [...new Set(items.map((i: EquivalenceDecision) => i.expansionPhrase).filter(Boolean))];
    if (phrases.length >= 2) {
      errors.push(`equivalence ${key}: conflicting accepted expansions (${phrases.join(" vs ")})`);
    }
  }

  const synIds = new Map<string, SynonymDecision>();
  for (const item of loaded.synonyms) {
    if (!ALLOWED_DECISIONS.has(item.decision)) {
      errors.push(`synonym ${item.id}: unknown decision "${item.decision}"`);
    }
    if (item.decision === "accept" && item.terms.length < 2) {
      errors.push(`synonym ${item.id || "?"}: accept without two terms`);
    }
    if (item.relation && !ALLOWED_RELATIONS.has(item.relation)) {
      errors.push(`synonym ${item.id}: unknown relation type "${item.relation}"`);
    }
    if (synIds.has(item.id) && synIds.get(item.id)!.decision !== item.decision) {
      errors.push(`synonym ${item.id}: both accept and reject`);
    }
    synIds.set(item.id, item);
  }

  if (errors.length) throw new DecisionError(`Invalid review decisions: ${errors.join("; ")}`, errors);
  return loaded;
}

export function indexDecisions(decisions: unknown): DecisionIndex {
  const loaded = validateDecisions(decisions);
  const eqById = new Map<string, EquivalenceDecision>();
  const eqRejectKeys = new Set<string>();
  const eqByKey = new Map<string, EquivalenceDecision[]>();
  for (const item of loaded.equivalences) {
    eqById.set(item.id, item);
    if (!eqByKey.has(item.key)) eqByKey.set(item.key, []);
    eqByKey.get(item.key)!.push(item);
    if (item.decision === "reject" && item.expansion.length === 0) eqRejectKeys.add(item.key);
  }
  const synById = new Map<string, SynonymDecision>();
  for (const item of loaded.synonyms) synById.set(item.id, item);
  return { loaded, eqById, eqRejectKeys, eqByKey, synById };
}
