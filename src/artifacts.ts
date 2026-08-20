/**
 * Compiled corpus-intelligence artifacts. Runtime consumes these objects;
 * it does not care whether a builder was manual, lexical, embedding, or LLM.
 *
 * Tiny format versioning: `format` + integer `version`.
 * This runtime reads version 1 only. Unknown or future versions fail closed.
 */

import { ArtifactVersionError, ArtifactValidationError } from "./errors.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const ARTIFACT_FORMATS = {
  equivalences: "search-v2-equivalences",
  synonyms: "search-v2-synonyms",
  relationships: "search-v2-relationships",
  corpusStats: "search-v2-corpus-stats",
};

export const ARTIFACT_VERSION = 1;

type ArtifactRecord = { format: string; version: number } & Record<string, unknown>;

export function assertArtifact(
  obj: unknown,
  format: string,
  opts?: { optional?: false }
): ArtifactRecord;
export function assertArtifact(
  obj: unknown,
  format: string,
  opts: { optional: true }
): ArtifactRecord | null;
export function assertArtifact(
  obj: unknown,
  format: string,
  { optional = false }: { optional?: boolean } = {}
): ArtifactRecord | null {
  if (obj == null) {
    if (optional) return null;
    throw new ArtifactValidationError(`Missing artifact ${format}`, { format });
  }
  if (typeof obj !== "object" || Array.isArray(obj)) {
    throw new ArtifactValidationError(`Artifact ${format} must be a plain object`, { format });
  }
  const rec = obj as Record<string, unknown>;
  if (!rec.format) {
    throw new ArtifactValidationError(`Artifact ${format} is missing required field "format"`, {
      format,
      field: "format",
    });
  }
  if (rec.format !== format) {
    throw new ArtifactValidationError(`Expected format ${format}, got ${JSON.stringify(rec.format)}`, { format, field: "format" });
  }
  const version = rec.version == null ? null : Number(rec.version);
  if (version == null) {
    throw new ArtifactValidationError(`Artifact ${format} is missing required field "version"`, {
      format,
      field: "version",
    });
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new ArtifactVersionError(`Invalid artifact version for ${format}: ${JSON.stringify(rec.version)}`, {
      format,
      version,
    });
  }
  if (version !== ARTIFACT_VERSION) {
    throw new ArtifactVersionError(
      `Unsupported ${format} version ${version}; this runtime reads version ${ARTIFACT_VERSION} only`,
      { format, version }
    );
  }
  return { ...rec, format, version };
}

/**
 * Equivalence / acronym artifact. Affects query interpretation, not relatedness.
 * { format, version, entries: [{ key, expansion, aliases, type, provenance, confidence }] }
 */
export function parseEquivalences(obj?: unknown) {
  if (obj == null) return { format: ARTIFACT_FORMATS.equivalences, version: 1, entries: [] };
  const art = assertArtifact(obj, ARTIFACT_FORMATS.equivalences, { optional: false });
  const entries = Array.isArray(art.entries) ? art.entries : [];
  return {
    format: ARTIFACT_FORMATS.equivalences,
    version: art.version,
    entries: entries
      .filter((e) => e && typeof e === "object" && (e as { key?: unknown }).key)
      .map((e) => {
        const row = e as {
          key: unknown;
          type?: unknown;
          expansion?: unknown;
          aliases?: unknown;
          provenance?: unknown;
          confidence?: unknown;
          primary?: unknown;
        };
        return {
        key: String(row.key).toLowerCase(),
        type: row.type || "equivalence",
        expansion: Array.isArray(row.expansion) ? row.expansion.map((w) => String(w).toLowerCase()) : [],
        aliases: Array.isArray(row.aliases) ? row.aliases : [],
        provenance: row.provenance || null,
        confidence: row.confidence == null ? null : Number(row.confidence),
        primary: row.primary ?? null,
      };
      }),
  };
}

/**
 * Synonym / near-equivalence artifact. Affects query interpretation.
 * Distinct from document relationships.
 * { format, version, entries: [{ terms, type, provenance, confidence }] }
 */
export function parseSynonyms(obj?: unknown) {
  if (obj == null) return { format: ARTIFACT_FORMATS.synonyms, version: 1, entries: [] };
  const art = assertArtifact(obj, ARTIFACT_FORMATS.synonyms);
  const entries = Array.isArray(art.entries) ? art.entries : [];
  return {
    format: ARTIFACT_FORMATS.synonyms,
    version: art.version,
    entries: entries
      .filter((e) => e && typeof e === "object" && Array.isArray((e as { terms?: unknown }).terms) && (e as { terms: unknown[] }).terms.length >= 2)
      .map((e) => {
        const row = e as { terms: unknown[]; type?: unknown; provenance?: unknown; confidence?: unknown };
        return {
        terms: row.terms.map((t) => String(t).toLowerCase()),
        type: row.type || "near-equivalence",
        provenance: row.provenance || null,
        confidence: row.confidence == null ? null : Number(row.confidence),
      };
      }),
  };
}

export interface ParsedRelationshipEdge {
  target: string;
  type: string;
  strength: number;
  provenance: string | null;
}

/**
 * Document-document relationship graph. Does not participate in query rewriting.
 * { format, version, relationships: { [sourceId]: [{ target, type, strength, provenance }] } }
 */
export function parseRelationships(obj?: unknown) {
  if (obj == null) {
    return { format: ARTIFACT_FORMATS.relationships, version: 1, relationships: {} };
  }
  const art = assertArtifact(obj, ARTIFACT_FORMATS.relationships);
  const raw = art.relationships && typeof art.relationships === "object" && !Array.isArray(art.relationships) ? art.relationships : {};
  const relationships: Record<string, ParsedRelationshipEdge[]> = {};
  for (const [source, list] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(source)) continue;
    if (!Array.isArray(list)) continue;
    relationships[String(source)] = list
      .filter((e) => e && typeof e === "object" && (e as { target?: unknown }).target)
      .map((e) => {
        const row = e as { target: unknown; type?: unknown; strength?: unknown; provenance?: unknown };
        return {
        target: String(row.target),
        type: typeof row.type === "string" ? row.type : "related",
        strength: clamp01(row.strength == null ? 1 : Number(row.strength)),
        provenance: row.provenance == null ? null : String(row.provenance),
      };
      });
  }
  return {
    format: ARTIFACT_FORMATS.relationships,
    version: art.version,
    relationships,
  };
}

export function parseCorpusStats(obj?: unknown) {
  if (obj == null) return { format: ARTIFACT_FORMATS.corpusStats, version: 1, stats: {} };
  const art = assertArtifact(obj, ARTIFACT_FORMATS.corpusStats);
  return {
    format: ARTIFACT_FORMATS.corpusStats,
    version: art.version,
    stats: art.stats && typeof art.stats === "object" ? art.stats : {},
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
