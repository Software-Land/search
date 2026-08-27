/**
 * Configured concept dictionary. Search logic consumes this generically;
 * host-specific acronyms/concepts are data, not engine code.
 *
 * Public authoring shape:
 * { key: "tls", aliases: [["transport","layer","security"], ["transport","layer"]] }
 *
 * aliases[0] compiles internally as sequence kind "expansion".
 * standaloneRecall / topicalRecall are compiled from relationshipMap, not authored here.
 */

import type { DictionaryEntry, DictionarySequence } from "./types.js";
import { compileAuthoredConcept } from "./configuredAuthoring.js";
import {
  applyCompiledRelationships,
  compileRelationshipMapInternal,
  type CompiledRelationshipMap,
  type RelationshipDocumentRef,
} from "./relationshipMap.js";
import { synonyms as synonymsPlugin } from "./synonyms.js";

export interface DictionaryPlugin {
  name: "dictionary";
  entries: DictionaryEntry[];
  byKey: Map<string, DictionaryEntry>;
  sequences: DictionarySequence[];
  standaloneRecallByToken: Map<string, string>;
  topicalRecallByKey: Map<string, string[][]>;
  lexicon(): Set<string>;
}

export interface AuthoredRelevanceOptions {
  entries?: unknown[];
  relationshipMap?: unknown;
  documents?: RelationshipDocumentRef[];
}

function dictionaryFromCompiled(list: DictionaryEntry[]): DictionaryPlugin {
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
    topicalRecallByKey: compileTopicalRecallLookup(list),
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

export function dictionary({ entries = [] }: { entries?: unknown[] } = {}): DictionaryPlugin {
  const list: DictionaryEntry[] = [];
  for (const raw of entries) {
    const entry = compileAuthoredConcept(raw);
    if (entry) list.push(entry);
  }
  return dictionaryFromCompiled(list);
}

export interface CompiledAuthoredRelevance {
  dictionary: DictionaryPlugin;
  synonymMap: Record<string, string[]>;
  synonyms: ReturnType<typeof synonymsPlugin>;
  editorialRelationships: CompiledRelationshipMap["editorialRelationships"];
}

/**
 * Compile authored concepts + relationshipMap onto the dictionary plugin and
 * the low-level one-hop recall plugin (`synonyms` field). Editorial document
 * edges are returned for the caller to merge with the generated semantic artifact.
 */
export function compileAuthoredRelevance({
  entries = [],
  relationshipMap,
  documents,
}: AuthoredRelevanceOptions = {}): CompiledAuthoredRelevance {
  const list: DictionaryEntry[] = [];
  for (const raw of entries) {
    const entry = compileAuthoredConcept(raw);
    if (entry) list.push(entry);
  }
  const compiled = compileRelationshipMapInternal(relationshipMap, { concepts: list, documents: documents || [] });
  applyCompiledRelationships(list, compiled);
  return {
    dictionary: dictionaryFromCompiled(list),
    synonymMap: compiled.synonymMap,
    synonyms: synonymsPlugin(compiled.synonymMap),
    editorialRelationships: compiled.editorialRelationships,
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

function normalizeTopicalToken(raw: unknown): string | null {
  if (raw == null) return null;
  const token = String(raw).toLowerCase().trim();
  if (!token || /\s/.test(token)) return null;
  return token;
}

/**
 * Reviewed topical phrase forms. Each form is a tokenized phrase.
 * Empty, blank, non-array, and space-containing tokens are dropped.
 * Duplicate forms (same token sequence) are removed in first-seen order.
 */
export function normalizeTopicalRecall(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!Array.isArray(item) || !item.length) continue;
    const form: string[] = [];
    let malformed = false;
    for (const tok of item) {
      const token = normalizeTopicalToken(tok);
      if (!token) {
        malformed = true;
        break;
      }
      form.push(token);
    }
    if (malformed || !form.length) continue;
    const key = form.join("\u001f");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(form);
  }
  return out;
}

export function compileTopicalRecallLookup(entries: DictionaryEntry[]): Map<string, string[][]> {
  const lookup = new Map<string, string[][]>();
  for (const entry of entries || []) {
    const key = entry?.key;
    if (!key) continue;
    const forms = Array.isArray(entry.topicalRecall) ? entry.topicalRecall : [];
    if (!forms.length) continue;
    lookup.set(key, forms.map((form) => [...form]));
  }
  return lookup;
}

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

export function entriesFromAcronymMap(
  acronymMap?: Record<string, { aliases?: string[][] } | null | undefined> | null
) {
  return Object.entries(acronymMap || {}).map(([key, def]) => ({
    key,
    aliases: Array.isArray(def?.aliases) ? def.aliases : [],
  }));
}
