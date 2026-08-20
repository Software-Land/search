/**
 * Configured equivalence dictionary. Search logic consumes this generically;
 * Host-specific acronyms are data, not engine code.
 *
 * Entry shape:
 * { key: "tls", expansion: ["transport","layer","security"], aliases: [["..."]] }
 */

import type { DictionaryEntry, DictionarySequence } from "./types.js";

export interface DictionaryPlugin {
  name: "dictionary";
  entries: DictionaryEntry[];
  byKey: Map<string, DictionaryEntry>;
  sequences: DictionarySequence[];
  lexicon(): Set<string>;
}

export function dictionary({ entries = [] }: { entries?: unknown[] } = {}): DictionaryPlugin {
  const list: DictionaryEntry[] = [];
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (entry) list.push(entry);
  }
  const byKey = new Map<string, DictionaryEntry>();
  const sequences: DictionarySequence[] = [];

  for (const entry of list) {
    byKey.set(entry.key, entry);
    sequences.push({ entry, tokens: [entry.key], kind: "key" });
    if (entry.expansion.length) {
      sequences.push({ entry, tokens: entry.expansion, kind: "expansion" });
    }
    for (const alias of entry.aliases) {
      sequences.push({ entry, tokens: alias, kind: "alias" });
    }
  }

  sequences.sort((a, b) => b.tokens.length - a.tokens.length);

  return {
    name: "dictionary",
    entries: list,
    byKey,
    sequences,
    lexicon() {
      const words = new Set<string>();
      for (const entry of list) {
        words.add(entry.key);
        for (const w of entry.expansion) words.add(w);
        for (const alias of entry.aliases) {
          for (const w of alias) words.add(w);
        }
      }
      return words;
    },
  };
}

function normalizeEntry(raw: unknown): DictionaryEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("key" in raw) || !raw.key) return null;
  const rec = raw as {
    key: unknown;
    expansion?: unknown;
    aliases?: unknown;
    primary?: unknown;
    type?: unknown;
    provenance?: unknown;
    confidence?: unknown;
  };
  const key = String(rec.key).toLowerCase();
  const expansion = Array.isArray(rec.expansion)
    ? rec.expansion.map((w) => String(w).toLowerCase())
    : [];
  const aliases = Array.isArray(rec.aliases)
    ? rec.aliases
        .filter((a) => Array.isArray(a) && a.length)
        .map((a) => (a as unknown[]).map((w) => String(w).toLowerCase()))
    : [];
  return {
    key,
    expansion,
    aliases,
    primary: rec.primary == null ? null : String(rec.primary),
    type: rec.type == null ? "equivalence" : String(rec.type),
    provenance: rec.provenance == null ? null : String(rec.provenance),
    confidence: rec.confidence == null ? null : Number(rec.confidence),
  };
}

export function entriesFromAcronymMap(
  acronymMap?: Record<string, { exp?: string[]; aliases?: string[][]; primary?: string | null }> | null
) {
  return Object.entries(acronymMap || {}).map(([key, def]) => ({
    key,
    expansion: Array.isArray(def?.exp) ? def.exp : [],
    aliases: Array.isArray(def?.aliases) ? def.aliases : [],
    primary: def?.primary ?? null,
  }));
}
