/**
 * Search equivalences (synonym recall). Query interpretation only.
 *
 * Two public input shapes:
 * - Directional object map: Record<string, string[]>. New default.
 *   `qa -> testing` does not imply `testing -> qa`. One hop only.
 * - Legacy compiled artifact: { format, entries: [{ terms }] }. Symmetric
 *   within each terms group. Not reinterpreted as directional.
 *
 * Does not imply document relatedness (TLS ↛ VPN).
 */

import { parseSynonyms } from "./artifacts.js";
import { InvalidConfigurationError } from "./errors.js";
import {
  tokenize,
  leftoverAfterFoldable,
  hasUnsafeSymbolicSurface,
  FOLDABLE_EXPANSION_PUNCTUATION,
} from "./text.js";

type SynonymEntry = ReturnType<typeof parseSynonyms>["entries"][number];

interface SynonymLookupHit {
  others: string[];
  entry: SynonymEntry;
}

export interface SynonymForm {
  form: string;
  type: string;
  provenance: unknown;
  confidence: number | null;
}

export interface SynonymsPlugin {
  name: "synonyms";
  format: string;
  version: number;
  directionality: "directional" | "symmetric";
  lookup: Map<string, SynonymLookupHit[] | string[]>;
  expand(token: string): SynonymForm[];
}

export interface NormalizedSearchEquivalenceEntry {
  source: string;
  targets: string[];
}

export interface SearchEquivalenceRejection {
  source: string;
  target?: string;
  reason: string;
}

export interface NormalizedSearchEquivalences {
  entries: NormalizedSearchEquivalenceEntry[];
  rejected: SearchEquivalenceRejection[];
}

export type SearchEquivalenceMap = Record<string, string[]>;

/**
 * Generic bound on authored targets per normalized source. Existing
 * dictionary/equivalence validation has no analogous per-key fan-out cap;
 * 8 is the investigation recommendation (V1 max fan-out was well below this).
 */
export const MAX_SEARCH_EQUIVALENCE_TARGETS = 8;

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function lostSignificantSymbols(raw: string, tokens: string[]): boolean {
  const leftover = leftoverAfterFoldable(raw, FOLDABLE_EXPANSION_PUNCTUATION);
  if (!leftover) return false;
  const retained = tokens.join("");
  for (const ch of leftover) {
    if (ch && !retained.includes(ch)) return true;
  }
  return false;
}

/**
 * Canonical phrase for search-equivalence lookup/storage.
 * Exact contiguous tokens after Core tokenize. Empty / unsafe / tokenizer-
 * destructive symbolic surfaces return null (fail closed).
 */
export function canonicalizeSearchEquivalencePhrase(raw: unknown): string | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  if (hasUnsafeSymbolicSurface(trimmed)) return null;
  const tokens = tokenize(trimmed);
  if (!tokens.length) return null;
  if (lostSignificantSymbols(trimmed, tokens)) return null;
  return tokens.join(" ");
}

function reject(rejected: SearchEquivalenceRejection[], source: string, reason: string, target?: string) {
  const row: SearchEquivalenceRejection = { source, reason };
  if (target != null) row.target = target;
  rejected.push(row);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize a directional search-equivalence map.
 * Duplicate sources union targets. Exact duplicate targets dedupe.
 * Output entries are sorted by source; targets are sorted.
 */
export function normalizeSearchEquivalences(input?: unknown): NormalizedSearchEquivalences {
  const rejected: SearchEquivalenceRejection[] = [];
  const bySource = new Map<string, Set<string>>();
  if (input == null) return { entries: [], rejected };
  if (!isPlainObject(input)) {
    reject(rejected, "", "invalid-input");
    return { entries: [], rejected };
  }

  for (const [rawSource, rawTargets] of Object.entries(input)) {
    if (FORBIDDEN_KEYS.has(rawSource)) {
      reject(rejected, rawSource, "forbidden-key");
      continue;
    }
    const source = canonicalizeSearchEquivalencePhrase(rawSource);
    if (!source) {
      reject(rejected, String(rawSource || ""), "empty-or-unsafe-source");
      continue;
    }
    if (!Array.isArray(rawTargets) || !rawTargets.length) {
      reject(rejected, source, "empty-targets");
      continue;
    }
    if (!bySource.has(source)) bySource.set(source, new Set());
    const bucket = bySource.get(source)!;
    for (const rawTarget of rawTargets) {
      const target = canonicalizeSearchEquivalencePhrase(rawTarget);
      if (!target) {
        reject(rejected, source, "empty-or-unsafe-target", String(rawTarget ?? ""));
        continue;
      }
      if (target === source) {
        reject(rejected, source, "source-equals-target", target);
        continue;
      }
      bucket.add(target);
    }
    if (!bucket.size) {
      bySource.delete(source);
      if (!rejected.some((row) => row.source === source && row.reason === "empty-targets")) {
        reject(rejected, source, "empty-targets");
      }
    }
  }

  const entries: NormalizedSearchEquivalenceEntry[] = [];
  for (const source of [...bySource.keys()].sort()) {
    const all = [...bySource.get(source)!].sort();
    const targets = all.slice(0, MAX_SEARCH_EQUIVALENCE_TARGETS);
    for (const extra of all.slice(MAX_SEARCH_EQUIVALENCE_TARGETS)) {
      reject(rejected, source, "target-limit", extra);
    }
    if (targets.length) entries.push({ source, targets });
  }
  rejected.sort((a, b) => {
    const sourceCmp = a.source.localeCompare(b.source);
    if (sourceCmp) return sourceCmp;
    const reasonCmp = a.reason.localeCompare(b.reason);
    if (reasonCmp) return reasonCmp;
    return String(a.target || "").localeCompare(String(b.target || ""));
  });
  return { entries, rejected };
}

function isLegacySynonymInput(input: unknown): boolean {
  if (!isPlainObject(input)) return false;
  if (typeof input.format === "string") return true;
  if (!Array.isArray(input.entries)) return false;
  if (!input.entries.length) {
    const keys = Object.keys(input).filter((k) => k !== "entries" && k !== "format" && k !== "version");
    return keys.length === 0;
  }
  return input.entries.some((row) => row && typeof row === "object" && Array.isArray((row as { terms?: unknown }).terms));
}

function directionalPlugin(normalized: NormalizedSearchEquivalences): SynonymsPlugin {
  const lookup = new Map<string, string[]>();
  for (const entry of normalized.entries) lookup.set(entry.source, [...entry.targets]);
  return {
    name: "synonyms",
    format: "search-equivalence-map",
    version: 1,
    directionality: "directional",
    lookup,
    expand(token) {
      const key = canonicalizeSearchEquivalencePhrase(token);
      if (!key) return [];
      const targets = lookup.get(key) || [];
      return targets.map((form) => ({
        form,
        type: "search-equivalence",
        provenance: "synonym",
        confidence: null,
      }));
    },
  };
}

function symmetricPlugin(input: Record<string, unknown>): SynonymsPlugin {
  const parsed = parseSynonyms(
    input.format ? input : { format: "search-v2-synonyms", version: 1, entries: input.entries || [] }
  );
  const lookup = new Map<string, SynonymLookupHit[]>();
  for (const entry of parsed.entries) {
    for (const term of entry.terms) {
      const others = entry.terms.filter((t) => t !== term);
      if (!lookup.has(term)) lookup.set(term, []);
      lookup.get(term)!.push({ others, entry });
    }
  }
  return {
    name: "synonyms",
    format: parsed.format,
    version: parsed.version,
    directionality: "symmetric",
    lookup,
    expand(token) {
      const hits = (lookup.get(String(token || "").toLowerCase()) || []) as SynonymLookupHit[];
      const forms: SynonymForm[] = [];
      const seen = new Set<string>();
      for (const hit of hits) {
        for (const o of hit.others) {
          if (seen.has(o)) continue;
          seen.add(o);
          forms.push({
            form: o,
            type: String(hit.entry.type || "near-equivalence"),
            provenance: hit.entry.provenance || "synonym",
            confidence: hit.entry.confidence,
          });
        }
      }
      return forms;
    },
  };
}

/**
 * Provider-agnostic search-equivalence / synonym plugin.
 *
 * `synonyms({ qa: ["testing"] })` is directional.
 * `synonyms({ format, entries: [{ terms }] })` stays bidirectional.
 */
export function synonyms(
  input: SearchEquivalenceMap | Record<string, unknown> = {}
): SynonymsPlugin {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidConfigurationError("synonyms() expects a plain object map or a synonyms artifact", {
      field: "synonyms",
      expected: "Record<string, string[]> | { format, entries }",
    });
  }
  if (isLegacySynonymInput(input)) return symmetricPlugin(input);
  return directionalPlugin(normalizeSearchEquivalences(input));
}
