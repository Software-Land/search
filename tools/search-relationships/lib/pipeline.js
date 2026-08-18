import { loadDocuments, indexDocuments } from "./documents.js";
import { loadDecisions, emptyDecisions, DecisionError } from "./decisions.js";
import { applyLifecycle } from "./lifecycle.js";
import { compileTrusted, inspectLifecycle, filterRelationships } from "./compile.js";
import { mergeRelationshipArtifacts } from "./merge.js";
import { mineRelationshipCandidates, annotateCandidates } from "./candidates.js";
import { DEFAULT_RUNTIME_TYPES } from "./types.js";
import { hashJson } from "./hash.js";

export const COMPILER_VERSION = 1;

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** @param {unknown} n */
function round(n) {
  return Number(Number(n).toFixed(3));
}

/** @param {unknown} input @param {import("../types.js").AnalyzeRelOptions} [opts] */
export function analyzeRelationships(input, { decisions = null, mine = true } = {}) {
  const t0 = now();
  const documents = loadDocuments(input);
  const docIndex = indexDocuments(documents);
  const tLoad = now();
  const mined = mine ? annotateCandidates(mineRelationshipCandidates(documents, docIndex)) : [];
  const tMine = now();
  const decisionDoc = loadDecisions(decisions || emptyDecisions());
  const life = applyLifecycle(mined, decisionDoc, docIndex);
  const inspection = inspectLifecycle(life, {
    queueStats: {
      raw: mined.length,
      pending: life.candidates.filter((c) => c.lifecycle === "REVIEW_PENDING").length,
      high: mined.filter((c) => c.reviewBand === "HIGH").length,
      medium: mined.filter((c) => c.reviewBand === "MEDIUM").length,
      low: mined.filter((c) => c.reviewBand === "LOW").length,
    },
  });
  return {
    documents,
    docIndex,
    decisionDoc,
    life,
    inspection,
    timings: {
      loadMs: round(tLoad - t0),
      candidateMs: round(tMine - tLoad),
      totalMs: round(now() - t0),
    },
    corpusHash: hashJson(documents.map((d) => ({ id: d.id, title: d.title, path: d.metadata?.path || null }))),
    decisionsHash: hashJson(decisionDoc),
  };
}

/** @param {unknown} input @param {import("../types.js").CompileRelOptions} [opts] */
export function compileRelationships(input, { decisions = null, semantic = null, mine = true, runtimeTypes = DEFAULT_RUNTIME_TYPES } = {}) {
  const analysis = analyzeRelationships(input, { decisions, mine });
  const t0 = now();
  const domain = compileTrusted(analysis.life);
  const tDomain = now();
  const merged = mergeRelationshipArtifacts({ semantic, domain, life: analysis.life, runtimeTypes });
  const tMerge = now();
  const manifest = {
    format: "search-relationships-manifest",
    version: 1,
    compilerVersion: COMPILER_VERSION,
    corpusHash: analysis.corpusHash,
    decisionsHash: analysis.decisionsHash,
    semanticHash: semantic ? hashJson(semantic) : null,
    counts: {
      ...analysis.inspection.counts,
      domainEdges: countEdges(domain),
      semanticEdges: countEdges(semantic),
      mergedTypedEdges: countEdges(merged.full),
      mergedPairs: countPairs(merged.full),
      runtimeEdges: countEdges(merged.runtime),
    },
    artifactHash: hashJson(merged.runtime),
    timings: {
      ...analysis.timings,
      domainCompileMs: round(tDomain - t0),
      mergeMs: round(tMerge - tDomain),
    },
  };
  return {
    ...analysis,
    domain,
    semantic: semantic && typeof semantic === "object"
      ? /** @type {import("../types.js").RelationshipArtifact} */ (semantic)
      : { format: "search-v2-relationships", version: 1, relationships: /** @type {Record<string, import("../types.js").RelationshipEdge[]>} */ ({}) },
    merged: merged.full,
    runtime: merged.runtime,
    manifest,
  };
}

/** @param {unknown} artifact */
function countEdges(artifact) {
  if (!artifact || typeof artifact !== "object") return 0;
  const rec = /** @type {{ relationships?: Record<string, unknown[] | undefined> }} */ (artifact);
  return Object.values(rec.relationships || {}).reduce((n, list) => n + (list?.length || 0), 0);
}

/** @param {unknown} artifact */
function countPairs(artifact) {
  const pairs = new Set();
  if (!artifact || typeof artifact !== "object") return 0;
  const rec = /** @type {{ relationships?: Record<string, Array<{ target?: string }> | undefined> }} */ (artifact);
  for (const [s, edges] of Object.entries(rec.relationships || {})) {
    for (const e of edges || []) {
      const a = s < (e.target || "") ? s : e.target || "";
      const b = s < (e.target || "") ? e.target || "" : s;
      pairs.add(`${a}::${b}`);
    }
  }
  return pairs.size;
}

export { filterRelationships, DecisionError };
