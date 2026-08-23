import fs from "node:fs";
import path from "node:path";
import { hashJson } from "../../search-corpus/lib/hash.js";
import { INFERENCE_SCHEMA_VERSION, PROMPT_ID, SYSTEM_PROMPT } from "./prompt.js";
import type { EnrichmentCache, LexicalInferenceProvider, LexicalInferenceRequest, LexicalInferenceResponse } from "../types.js";

function canonicalEvidence(evidence: Record<string, unknown> | undefined) {
  const e = evidence || {};
  return {
    explicitDefinitions: Number(e.explicitDefinitions || 0),
    titleCooccurrences: Number(e.titleCooccurrences || 0),
    bodyCooccurrences: Number(e.bodyCooccurrences || 0),
    titleOccurrencesOfKey: Number(e.titleOccurrencesOfKey || 0),
    titleKeyBodyPhrase: Number(e.titleKeyBodyPhrase || 0),
    expansionDf: Number(e.expansionDf || 0),
    keyDf: Number(e.keyDf || 0),
    withinDocumentRepeats: Number(e.withinDocumentRepeats || 0),
  };
}

export function cacheKeyFor(
  request: LexicalInferenceRequest,
  provider: Pick<LexicalInferenceProvider, "id" | "model" | "temperature" | "seed">
): string {
  return hashJson({
    schemaVersion: INFERENCE_SCHEMA_VERSION,
    promptId: PROMPT_ID,
    promptHash: hashJson(SYSTEM_PROMPT),
    task: request.task,
    key: request.key,
    minedExpansion: request.minedExpansion,
    phrase: request.phrase || request.minedExpansion,
    alternatives: request.alternatives || [],
    evidence: canonicalEvidence(request.evidence),
    documentId: request.documentId || "",
    title: request.title || "",
    context: request.context || "",
    observedAcronyms: request.observedAcronyms || [],
    knownEquivalences: request.knownEquivalences || [],
    maxProposals: request.maxProposals ?? 0,
    provider: provider.id,
    model: provider.model || null,
    temperature: provider.temperature ?? 0,
    seed: provider.seed ?? null,
  });
}

export function createMemoryCache(): EnrichmentCache {
  const map = new Map<string, LexicalInferenceResponse>();
  return {
    get(key) {
      return map.get(key) || null;
    },
    set(key, value) {
      map.set(key, value);
    },
  };
}

export function createFileCache(dir: string): EnrichmentCache {
  fs.mkdirSync(dir, { recursive: true });
  return {
    get(key) {
      const file = path.join(dir, `${key}.json`);
      if (!fs.existsSync(file)) return null;
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as LexicalInferenceResponse;
      } catch {
        return null;
      }
    },
    set(key, value) {
      const file = path.join(dir, `${key}.json`);
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
    },
  };
}
