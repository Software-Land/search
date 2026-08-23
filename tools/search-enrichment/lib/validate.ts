import { acronymKey, expansionTokens, initialsMatch, normalizeExpansion, phraseKey } from "../../search-corpus/lib/text.js";
import { EnrichmentError } from "./errors.js";
import { INFERENCE_SCHEMA_VERSION } from "./prompt.js";
import type { InferenceProposal, InferenceRelation, LexicalInferenceResponse } from "../types.js";

const RELATIONS = new Set<InferenceRelation>(["initialism", "acronym", "alias", "reject"]);

function asExpansion(raw: unknown): string[] {
  if (Array.isArray(raw)) return normalizeExpansion(raw.map((w) => String(w).toLowerCase()));
  if (typeof raw === "string" && raw.trim()) return normalizeExpansion(expansionTokens(raw));
  return [];
}

function asAliases(raw: unknown): string[][] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new EnrichmentError("proposal aliases must be an array of token arrays");
  return raw.map((alias) => {
    if (!Array.isArray(alias)) throw new EnrichmentError("each alias must be a token array");
    return alias.map((w) => String(w).toLowerCase()).filter(Boolean);
  });
}

function asEvidenceRefs(raw: unknown): Array<{ documentId?: string; field?: string; snippet?: string }> | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new EnrichmentError("proposal evidenceRefs must be an array");
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new EnrichmentError("each evidenceRef must be an object");
    }
    const row = item as Record<string, unknown>;
    return {
      documentId: row.documentId == null ? undefined : String(row.documentId),
      field: row.field == null ? undefined : String(row.field),
      snippet: row.snippet == null ? undefined : String(row.snippet),
    };
  });
}

export function validateInferenceResponse(raw: unknown): LexicalInferenceResponse {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EnrichmentError("inference response must be a JSON object");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== INFERENCE_SCHEMA_VERSION) {
    throw new EnrichmentError(`expected schemaVersion ${INFERENCE_SCHEMA_VERSION}`, [String(rec.schemaVersion)]);
  }
  if (!Array.isArray(rec.proposals)) {
    throw new EnrichmentError("inference response.proposals must be an array");
  }
  const proposals: InferenceProposal[] = rec.proposals.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new EnrichmentError(`proposals[${i}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    const key = acronymKey(row.key);
    if (!key) throw new EnrichmentError(`proposals[${i}] missing key`);
    const expansion = asExpansion(row.expansion);
    const relation = String(row.relation || "") as InferenceRelation;
    if (!RELATIONS.has(relation)) {
      throw new EnrichmentError(`proposals[${i}] unknown relation "${row.relation}"`);
    }
    if (typeof row.ambiguous !== "boolean") {
      throw new EnrichmentError(`proposals[${i}] ambiguous must be boolean`);
    }
    const alternativesRaw = row.alternatives;
    if (!Array.isArray(alternativesRaw)) {
      throw new EnrichmentError(`proposals[${i}] alternatives must be an array`);
    }
    const alternatives = alternativesRaw.map((alt, j) => {
      if (!alt || typeof alt !== "object" || Array.isArray(alt)) {
        throw new EnrichmentError(`proposals[${i}].alternatives[${j}] must be an object`);
      }
      const a = alt as Record<string, unknown>;
      const exp = asExpansion(a.expansion);
      if (!exp.length) throw new EnrichmentError(`proposals[${i}].alternatives[${j}] missing expansion`);
      return { expansion: exp, note: a.note == null ? undefined : String(a.note) };
    });
    if (relation !== "reject" && expansion.length < 1) {
      throw new EnrichmentError(`proposals[${i}] non-reject proposal needs an expansion`);
    }
    if ((relation === "initialism" || relation === "acronym") && expansion.length && !initialsMatch(key, expansion)) {
      throw new EnrichmentError(`proposals[${i}] ${relation} initials do not match ${key} / ${phraseKey(expansion)}`);
    }
    return {
      key,
      expansion,
      relation,
      ambiguous: row.ambiguous,
      alternatives,
      aliases: asAliases(row.aliases),
      primary: row.primary == null ? null : String(row.primary),
      confidence: row.confidence == null ? null : Number(row.confidence),
      rationale: row.rationale == null ? undefined : String(row.rationale),
      evidenceRefs: asEvidenceRefs(row.evidenceRefs),
    };
  });
  return { schemaVersion: INFERENCE_SCHEMA_VERSION, proposals };
}
