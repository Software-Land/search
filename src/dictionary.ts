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
  standaloneRecallByToken: Map<string, string>;
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
    standaloneRecallByToken: compileStandaloneRecallLookup(list),
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

function normalizeStandaloneRecallToken(raw: unknown): string | null {
  if (raw == null) return null;
  const token = String(raw).toLowerCase().trim();
  if (!token || /\s/.test(token)) return null;
  return token;
}

export function normalizeStandaloneRecall(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const token = normalizeStandaloneRecallToken(item);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Unique standalone token → configured key. Collisions fail closed
 * (the token is omitted). Insertion order is not a tie-break.
 */
export function compileStandaloneRecallLookup(entries: DictionaryEntry[]): Map<string, string> {
  const claimed = new Map<string, Set<string>>();
  for (const entry of entries || []) {
    const key = entry?.key;
    if (!key) continue;
    for (const token of entry.standaloneRecall || []) {
      let keys = claimed.get(token);
      if (!keys) {
        keys = new Set();
        claimed.set(token, keys);
      }
      keys.add(key);
    }
  }
  const lookup = new Map<string, string>();
  for (const [token, keys] of claimed) {
    if (keys.size !== 1) continue;
    lookup.set(token, keys.values().next().value as string);
  }
  return lookup;
}

function normalizeEntry(raw: unknown): DictionaryEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("key" in raw) || !raw.key) return null;
  const rec = raw as {
    key: unknown;
    expansion?: unknown;
    aliases?: unknown;
    primary?: unknown;
    standaloneRecall?: unknown;
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
    standaloneRecall: normalizeStandaloneRecall(rec.standaloneRecall),
    type: rec.type == null ? "equivalence" : String(rec.type),
    provenance: rec.provenance == null ? null : String(rec.provenance),
    confidence: rec.confidence == null ? null : Number(rec.confidence),
  };
}

export function entriesFromAcronymMap(
  acronymMap?: Record<
    string,
    {
      exp?: string[];
      aliases?: string[][];
      primary?: string | null;
      standaloneRecall?: string[];
    }
  > | null
) {
  return Object.entries(acronymMap || {}).map(([key, def]) => ({
    key,
    expansion: Array.isArray(def?.exp) ? def.exp : [],
    aliases: Array.isArray(def?.aliases) ? def.aliases : [],
    primary: def?.primary ?? null,
    standaloneRecall: Array.isArray(def?.standaloneRecall) ? def.standaloneRecall : [],
  }));
}
