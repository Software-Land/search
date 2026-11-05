/**
 * Compiled corpus-intelligence artifacts. Runtime consumes these objects;
 * it does not care whether a builder was manual, lexical, embedding, or LLM.
 *
 * Each artifact has a format identifier plus an integer schema `version`.
 * Example: format `search-relationships` with schema version 1.
 * This runtime reads schema version 1 only. Unknown or future schema versions fail closed.
 * Readers also accept the pre-0.8.0 identifier for the same schema. Writers emit the
 * identifier in `ARTIFACT_FORMATS`.
 */

import { ArtifactVersionError, ArtifactValidationError } from "./errors.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const ARTIFACT_FORMATS = {
  relationships: "search-relationships",
  corpusStats: "search-corpus-stats",
  lexicalIndex: "search-lexical-index",
} as const;

/** Explicit pre-0.8.0 spellings. Not derived by editing strings. */
const LEGACY_ARTIFACT_FORMATS = {
  relationships: "search-v2-relationships",
  corpusStats: "search-v2-corpus-stats",
  lexicalIndex: "search-v2-lexical-index",
} as const;

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
  const accepted =
    rec.format === format ||
    (format === ARTIFACT_FORMATS.relationships && rec.format === LEGACY_ARTIFACT_FORMATS.relationships) ||
    (format === ARTIFACT_FORMATS.corpusStats && rec.format === LEGACY_ARTIFACT_FORMATS.corpusStats) ||
    (format === ARTIFACT_FORMATS.lexicalIndex && rec.format === LEGACY_ARTIFACT_FORMATS.lexicalIndex);
  if (!accepted) {
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
    throw new ArtifactVersionError(`Invalid artifact schema version for ${format}: ${JSON.stringify(rec.version)}`, {
      format,
      version,
    });
  }
  if (version !== ARTIFACT_VERSION) {
    throw new ArtifactVersionError(
      `Unsupported ${format} schema version ${version}; this runtime reads schema version ${ARTIFACT_VERSION} only`,
      { format, version }
    );
  }
  return { ...rec, format, version };
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

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
