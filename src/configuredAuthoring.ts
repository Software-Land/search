/**
 * 0.5.0 configured-concept authoring.
 *
 * Public entries are `{ key, aliases }`. aliases[0] is the canonical lexical
 * sequence and is compiled internally as sequence kind "expansion".
 * This module does not rank, retrieve, or rewrite query identity.
 */

import { InvalidConfigurationError } from "./errors.js";
import type { ConfiguredConcept } from "./types.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const REMOVED_AUTHORED_FIELDS = [
  "expansion",
  "exp",
  "primary",
  "standaloneRecall",
  "topicalRecall",
] as const;

export interface AuthoredConceptEntry {
  key: string;
  aliases: string[][];
  type?: string;
  provenance?: string | null;
  confidence?: number | null;
}

export interface LegacyConfiguredEntry {
  key?: unknown;
  expansion?: unknown;
  exp?: unknown;
  aliases?: unknown;
  primary?: unknown;
  standaloneRecall?: unknown;
  topicalRecall?: unknown;
  type?: unknown;
  provenance?: unknown;
  confidence?: unknown;
}

export interface MigratedStandaloneRelationship {
  sourceToken: string;
  concept: string;
}

export interface MigratedTopicalRelationship {
  concept: string;
  form: string[];
}

export interface MigratedConfiguredEntry {
  entry: AuthoredConceptEntry;
  discardedPrimary: string | null;
  standaloneRelationships: MigratedStandaloneRelationship[];
  topicalRelationships: MigratedTopicalRelationship[];
}

export function sequenceKey(tokens: readonly string[] | null | undefined): string {
  return (tokens || []).map((t) => String(t).toLowerCase()).join("\u001f");
}

export function sequencesEqual(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  return sequenceKey(a) === sequenceKey(b);
}

function asToken(raw: unknown): string | null {
  if (raw == null) return null;
  const token = String(raw).toLowerCase().trim();
  if (!token || /\s/.test(token)) return null;
  return token;
}

function asSequence(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const token = asToken(item);
    if (!token) return [];
    out.push(token);
  }
  return out;
}

function dedupeSequences(sequences: string[][]): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const seq of sequences) {
    if (!seq.length) continue;
    const key = sequenceKey(seq);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([...seq]);
  }
  return out;
}

/**
 * One-shot helper for 0.4 / early-0.5 `{ key, exp|expansion, aliases, primary, type, provenance, confidence, standaloneRecall, topicalRecall }`.
 * Runtime search does not call this. aliases[0] is the former canonical expansion,
 * preserving existing alias order. Exact duplicate sequences are dropped, not reordered.
 * Identity metadata `type` / `provenance` / `confidence` is preserved when supplied.
 * `primary` is discarded and is not mapped to any relationship.
 */
export function migrateConfiguredEntry(raw: unknown): MigratedConfiguredEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidConfigurationError("configured entry must be a plain object", {
      field: "entry",
      expected: "{ key, aliases }",
    });
  }
  const rec = raw as LegacyConfiguredEntry;
  const key = rec.key == null ? "" : String(rec.key).toLowerCase().trim();
  if (!key || FORBIDDEN_KEYS.has(key)) {
    throw new InvalidConfigurationError("configured entry is missing a usable key", {
      field: "key",
      expected: "non-empty string",
    });
  }
  const canonical = asSequence(rec.exp != null ? rec.exp : rec.expansion);
  const rest = Array.isArray(rec.aliases)
    ? rec.aliases.map((alias) => asSequence(alias)).filter((alias) => alias.length)
    : [];
  const aliases = dedupeSequences(canonical.length ? [canonical, ...rest] : rest);
  const discardedPrimary = rec.primary == null || rec.primary === "" ? null : String(rec.primary);
  const standaloneRelationships: MigratedStandaloneRelationship[] = [];
  if (Array.isArray(rec.standaloneRecall)) {
    const seen = new Set<string>();
    for (const item of rec.standaloneRecall) {
      const token = asToken(item);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      standaloneRelationships.push({ sourceToken: token, concept: key });
    }
  }
  const topicalRelationships: MigratedTopicalRelationship[] = [];
  if (Array.isArray(rec.topicalRecall)) {
    const seen = new Set<string>();
    for (const item of rec.topicalRecall) {
      const form = asSequence(item);
      if (!form.length) continue;
      const formKey = sequenceKey(form);
      if (seen.has(formKey)) continue;
      seen.add(formKey);
      topicalRelationships.push({ concept: key, form });
    }
  }
  const entry: AuthoredConceptEntry = { key, aliases };
  if (rec.type != null) entry.type = String(rec.type);
  if ("provenance" in rec) {
    entry.provenance = rec.provenance == null ? null : String(rec.provenance);
  }
  if ("confidence" in rec) {
    entry.confidence = rec.confidence == null ? null : Number(rec.confidence);
  }
  return {
    entry,
    discardedPrimary,
    standaloneRelationships,
    topicalRelationships,
  };
}

export function authoredConceptRemovedFields(raw: object): string[] {
  return REMOVED_AUTHORED_FIELDS.filter((field) => field in raw);
}

/** Canonical lexical sequence. Sequence kind "expansion". */
export function canonicalConfiguredConceptForm(concept?: { aliases?: string[][] } | null): string[] {
  const form = concept?.aliases?.[0];
  return Array.isArray(form) ? form : [];
}

/** Additional same-concept forms. Sequence kind "alias". */
export function additionalConfiguredConceptAliases(concept?: { aliases?: string[][] } | null): string[][] {
  const aliases = concept?.aliases;
  if (!Array.isArray(aliases) || aliases.length < 2) return [];
  return aliases.slice(1);
}

/**
 * Compile a public `{ key, aliases }` row into a compiler-owned ConfiguredConcept.
 * aliases[0] is the canonical lexical sequence; aliases[1...] are additional forms.
 * Sequence kinds "expansion" / "alias" are derived at index build, not stored.
 */
export function compileAuthoredConcept(raw: unknown): ConfiguredConcept | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("key" in raw) || !(raw as { key?: unknown }).key) {
    return null;
  }
  const rec = raw as LegacyConfiguredEntry & { key: unknown };
  const removed = authoredConceptRemovedFields(rec);
  if (removed.length) {
    throw new InvalidConfigurationError(
      `authored configured entries must be { key, aliases }; found ${removed.join(", ")}. Use migrateConfiguredEntry() for a one-shot conversion; aliases[0] is the canonical lexical sequence.`,
      { field: removed[0], expected: "aliases" }
    );
  }
  const key = String(rec.key).toLowerCase().trim();
  if (!key || FORBIDDEN_KEYS.has(key)) return null;
  const aliases = dedupeSequences(
    Array.isArray(rec.aliases) ? rec.aliases.map((alias) => asSequence(alias)).filter((alias) => alias.length) : []
  );
  const compiled: ConfiguredConcept = { key, aliases };
  if (rec.type != null) compiled.type = String(rec.type);
  if ("provenance" in rec) {
    compiled.provenance = rec.provenance == null ? null : String(rec.provenance);
  }
  if ("confidence" in rec) {
    compiled.confidence = rec.confidence == null ? null : Number(rec.confidence);
  }
  return compiled;
}
