import { loadDocuments, indexDocuments } from "./documents.js";
import { emptyDomain, resolveDomain, RelationshipError } from "./domain.js";
import { compileDomain, filterRelationships } from "./compile.js";
import { mergeRelationshipArtifacts } from "./merge.js";
import { DEFAULT_RUNTIME_TYPES } from "./types.js";
import { hashJson } from "./hash.js";
import type { CompileRelOptions, RelationshipArtifact, RelationshipEdge } from "../types.js";

export const COMPILER_VERSION: 2 = 2;

function countEdges(artifact: unknown): number {
  if (!artifact || typeof artifact !== "object") return 0;
  const rec = artifact as { relationships?: Record<string, unknown[] | undefined> };
  return Object.values(rec.relationships || {}).reduce((n, list) => n + (list?.length || 0), 0);
}

function countPairs(artifact: unknown): number {
  const pairs = new Set<string>();
  if (!artifact || typeof artifact !== "object") return 0;
  const rec = artifact as { relationships?: Record<string, Array<{ target?: string }> | undefined> };
  for (const [s, edges] of Object.entries(rec.relationships || {})) {
    for (const e of edges || []) {
      const a = s < (e.target || "") ? s : e.target || "";
      const b = s < (e.target || "") ? e.target || "" : s;
      pairs.add(`${a}::${b}`);
    }
  }
  return pairs.size;
}

function emptySemantic(): RelationshipArtifact {
  return { format: "search-v2-relationships", version: 1, relationships: {} as Record<string, RelationshipEdge[]> };
}

export function compileRelationships(
  input?: unknown,
  { domain = null, semantic = null, runtimeTypes = DEFAULT_RUNTIME_TYPES }: CompileRelOptions = {}
) {
  const documents = loadDocuments(input);
  const docIndex = indexDocuments(documents);
  const resolvedDomain = resolveDomain(domain || emptyDomain(), docIndex);
  const domainArtifact = compileDomain(resolvedDomain.resolved);
  const merged = mergeRelationshipArtifacts({
    semantic,
    domain: domainArtifact,
    runtimeTypes,
  });
  const semanticArtifact =
    semantic && typeof semantic === "object" ? (semantic as RelationshipArtifact) : emptySemantic();
  const manifest = {
    format: "search-relationships-manifest",
    version: 1,
    compilerVersion: COMPILER_VERSION,
    corpusHash: hashJson(documents.map((d) => ({ id: d.id, title: d.title, path: d.metadata?.path || null }))),
    domainHash: hashJson(resolvedDomain.loaded),
    semanticHash: semantic ? hashJson(semantic) : null,
    counts: {
      domainRelationships: resolvedDomain.resolved.length,
      domainEdges: countEdges(domainArtifact),
      semanticEdges: countEdges(semantic),
      mergedTypedEdges: countEdges(merged.full),
      mergedPairs: countPairs(merged.full),
      runtimeEdges: countEdges(merged.runtime),
    },
    artifactHash: hashJson(merged.runtime),
  };
  return {
    domain: domainArtifact,
    semantic: semanticArtifact,
    merged: merged.full,
    runtime: merged.runtime,
    manifest,
  };
}

export { filterRelationships, RelationshipError };
