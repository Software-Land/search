/**
 * Internal configured-concept plugin compiler.
 * Public applications author `configuredConcepts` and call `compileAuthoredRelevance()`.
 * `dictionary()` is not a root export.
 *
 * Authored shape:
 * { key: "tls", aliases: [["transport","layer","security"], ["transport","layer"]] }
 *
 * aliases[0] is the canonical lexical sequence (sequence kind "expansion").
 * aliases[1...] are additional same-concept forms (sequence kind "alias").
 * standaloneRecall / topicalRecall are compiled from relationshipMap, not stored on the concept.
 */

import type { ConfiguredConcept, DictionarySequence, RelationshipArtifact } from "./types.js";
import {
  additionalConfiguredConceptAliases,
  canonicalConfiguredConceptForm,
  compileAuthoredConcept,
} from "./configuredAuthoring.js";
import { ARTIFACT_FORMATS, ARTIFACT_VERSION } from "./artifacts.js";
import {
  compileRelationshipMapInternal,
  mergeRelationships,
  type RelationshipDocumentRef,
} from "./relationshipMap.js";
import { synonyms as synonymsPlugin } from "./synonyms.js";

export interface DictionaryPlugin {
  name: "dictionary";
  byKey: Map<string, ConfiguredConcept>;
  sequences: DictionarySequence[];
  standaloneRecallByToken: Map<string, string>;
  topicalRecallByKey: Map<string, string[][]>;
  lexicon(): Set<string>;
}

export interface AuthoredRelevanceOptions {
  configuredConcepts?: unknown[];
  relationshipMap?: unknown;
  documents?: RelationshipDocumentRef[];
}

function dictionaryFromCompiled(
  list: ConfiguredConcept[],
  recall: {
    standaloneRecallByKey?: Map<string, string[]>;
    topicalRecallByKey?: Map<string, string[][]>;
  } = {}
): DictionaryPlugin {
  const byKey = new Map<string, ConfiguredConcept>();
  const sequences: DictionarySequence[] = [];

  for (const concept of list) {
    byKey.set(concept.key, concept);
    sequences.push({ concept, tokens: [concept.key], kind: "key" });
    const canonical = canonicalConfiguredConceptForm(concept);
    if (canonical.length) {
      sequences.push({ concept, tokens: canonical, kind: "expansion" });
    }
    for (const alias of additionalConfiguredConceptAliases(concept)) {
      sequences.push({ concept, tokens: alias, kind: "alias" });
    }
  }

  sequences.sort((a, b) => b.tokens.length - a.tokens.length);

  return {
    name: "dictionary",
    byKey,
    sequences,
    standaloneRecallByToken: compileStandaloneRecallLookup(recall.standaloneRecallByKey || new Map()),
    topicalRecallByKey: compileTopicalRecallLookup(recall.topicalRecallByKey || new Map()),
    lexicon() {
      const words = new Set<string>();
      for (const concept of list) {
        words.add(concept.key);
        for (const alias of concept.aliases || []) {
          for (const w of alias) words.add(w);
        }
      }
      return words;
    },
  };
}

export function dictionary({ entries = [] }: { entries?: unknown[] } = {}): DictionaryPlugin {
  const list: ConfiguredConcept[] = [];
  for (const raw of entries) {
    const concept = compileAuthoredConcept(raw);
    if (concept) list.push(concept);
  }
  return dictionaryFromCompiled(list);
}

export interface CompiledAuthoredRelevance {
  plugins: [DictionaryPlugin, ReturnType<typeof synonymsPlugin>];
  documentRelationships: RelationshipArtifact | null;
}

/**
 * Compile authored concepts + relationshipMap into SearchEngine inputs:
 * `plugins` (identity + equivalent recall) and `documentRelationships`
 * (editorial document edges, or null).
 */
export function compileAuthoredRelevance({
  configuredConcepts = [],
  relationshipMap,
  documents,
}: AuthoredRelevanceOptions = {}): CompiledAuthoredRelevance {
  const list: ConfiguredConcept[] = [];
  for (const raw of configuredConcepts) {
    const concept = compileAuthoredConcept(raw);
    if (concept) list.push(concept);
  }
  const compiled = compileRelationshipMapInternal(relationshipMap, { concepts: list, documents: documents || [] });
  const dictionaryPlugin = dictionaryFromCompiled(list, {
    standaloneRecallByKey: compiled.standaloneRecallByKey,
    topicalRecallByKey: compiled.topicalRecallByKey,
  });
  const synonyms = synonymsPlugin(compiled.synonymMap);
  return {
    plugins: [dictionaryPlugin, synonyms],
    documentRelationships: mergeRelationships(null, {
      format: ARTIFACT_FORMATS.relationships,
      version: ARTIFACT_VERSION,
      relationships: compiled.editorialRelationships,
    }),
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

export function compileTopicalRecallLookup(topicalRecallByKey: Map<string, string[][]>): Map<string, string[][]> {
  const lookup = new Map<string, string[][]>();
  for (const [key, forms] of topicalRecallByKey || []) {
    if (!key || !Array.isArray(forms) || !forms.length) continue;
    lookup.set(key, forms.map((form) => [...form]));
  }
  return lookup;
}

export function compileStandaloneRecallLookup(standaloneRecallByKey: Map<string, string[]>): Map<string, string> {
  const claimed = new Map<string, Set<string>>();
  for (const [key, tokens] of standaloneRecallByKey || []) {
    if (!key) continue;
    for (const token of tokens || []) {
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
