/**
 * Internal configured-concept plugin compiler.
 * Public applications author `configuredConcepts` and call `compileAuthoredRelevance()`.
 * `compileConfiguredConceptPlugin()` is not a root export.
 *
 * Authored shape:
 * { key: "tls", aliases: [["transport","layer","security"], ["transport","layer"]] }
 *
 * `key` compiles as the key sequence. Every alias compiles as an equal non-key
 * sequence kind "form". Alias array order is not a ranking signal.
 * standaloneRecall / topicalRecall are compiled from relationshipMap, not stored on the concept.
 */

import type { ConfiguredConcept, ConfiguredConceptSequence, RelationshipArtifact } from "./types.js";
import {
  allConfiguredConceptForms,
  compileAuthoredConcept,
  sequenceKey,
} from "./configuredAuthoring.js";
import { ARTIFACT_FORMATS, ARTIFACT_VERSION } from "./artifacts.js";
import {
  compileRelationshipMapInternal,
  mergeRelationships,
  type RelationshipDocumentRef,
} from "./relationshipMap.js";
import { synonyms as synonymsPlugin } from "./synonyms.js";

export interface ConfiguredConceptPlugin {
  name: "configured-concepts";
  byKey: Map<string, ConfiguredConcept>;
  sequences: ConfiguredConceptSequence[];
  standaloneRecallByToken: Map<string, string>;
  topicalRecallByKey: Map<string, string[][]>;
  lexicon(): Set<string>;
}

export interface AuthoredRelevanceOptions {
  configuredConcepts?: unknown[];
  relationshipMap?: unknown;
  documents?: RelationshipDocumentRef[];
}

function compileConfiguredConceptList(raw: unknown[]): ConfiguredConcept[] {
  const list: ConfiguredConcept[] = [];
  for (const row of raw) {
    const concept = compileAuthoredConcept(row);
    if (concept) list.push(concept);
  }
  return list;
}

function configuredConceptPluginFromNormalized(
  list: ConfiguredConcept[],
  recall: {
    standaloneRecallByKey?: Map<string, string[]>;
    topicalRecallByKey?: Map<string, string[][]>;
  } = {}
): ConfiguredConceptPlugin {
  const byKey = new Map<string, ConfiguredConcept>();
  const sequences: ConfiguredConceptSequence[] = [];

  for (const concept of list) {
    byKey.set(concept.key, concept);
    sequences.push({ concept, tokens: [concept.key], kind: "key" });
    for (const form of allConfiguredConceptForms(concept)) {
      if (!form.length) continue;
      sequences.push({ concept, tokens: form, kind: "form" });
    }
  }

  sequences.sort(
    (a, b) =>
      b.tokens.length - a.tokens.length ||
      sequenceKey(a.tokens).localeCompare(sequenceKey(b.tokens)) ||
      a.concept.key.localeCompare(b.concept.key) ||
      String(a.kind).localeCompare(String(b.kind))
  );

  return {
    name: "configured-concepts",
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

/**
 * Compile authored ConfiguredConcept rows into the internal recognition plugin.
 * Recall maps are empty unless supplied by compileAuthoredRelevance().
 */
export function compileConfiguredConceptPlugin({
  configuredConcepts = [],
}: { configuredConcepts?: unknown[] } = {}): ConfiguredConceptPlugin {
  return configuredConceptPluginFromNormalized(compileConfiguredConceptList(configuredConcepts));
}

export interface CompiledAuthoredRelevance {
  plugins: [ConfiguredConceptPlugin, ReturnType<typeof synonymsPlugin>];
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
  const list = compileConfiguredConceptList(configuredConcepts);
  const compiled = compileRelationshipMapInternal(relationshipMap, { concepts: list, documents: documents || [] });
  const plugin = configuredConceptPluginFromNormalized(list, {
    standaloneRecallByKey: compiled.standaloneRecallByKey,
    topicalRecallByKey: compiled.topicalRecallByKey,
  });
  const synonyms = synonymsPlugin(compiled.synonymMap);
  return {
    plugins: [plugin, synonyms],
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
