/**
 * Synonym / near-equivalence plugin. Query interpretation only.
 * Does not imply document relatedness (TLS ↛ VPN).
 *
 * Entry: { terms: ["auth", "authentication"], type, provenance, confidence }
 */

import { parseSynonyms } from "./artifacts.js";

type SynonymEntry = ReturnType<typeof parseSynonyms>["entries"][number];

interface SynonymLookupHit {
  others: string[];
  entry: SynonymEntry;
}

export interface SynonymForm {
  form: string;
  type: SynonymEntry["type"];
  provenance: unknown;
  confidence: SynonymEntry["confidence"];
}

export interface SynonymsPlugin {
  name: "synonyms";
  format: string;
  version: number;
  lookup: Map<string, SynonymLookupHit[]>;
  expand(token: string): SynonymForm[];
}

export function synonyms(
  input: { entries?: unknown[]; format?: string; version?: number } | Record<string, unknown> = {}
): SynonymsPlugin {
  const parsed = Array.isArray(input.entries) || input.format
    ? parseSynonyms(input.format ? input : { format: "search-v2-synonyms", version: 1, entries: input.entries || [] })
    : parseSynonyms({ format: "search-v2-synonyms", version: 1, entries: input.entries || [] });

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
    lookup,
    expand(token) {
      const hits = lookup.get(String(token || "").toLowerCase()) || [];
      const forms: SynonymForm[] = [];
      for (const hit of hits) {
        for (const o of hit.others) {
          forms.push({
            form: o,
            type: hit.entry.type,
            provenance: hit.entry.provenance || "synonym",
            confidence: hit.entry.confidence,
          });
        }
      }
      return forms;
    },
  };
}
