/**
 * Query-time configured-form token DAG.
 *
 * States are typed-token indexes 0..n. Every query has identity edges
 * i → i+1 labelled with originalSurface[i]. Each surface-faithful configured
 * span [i, j) adds a parallel edge i → j labelled with the configured key.
 *
 * Execution walks the DAG against document positions (see executeTokenGraph).
 * Paths are not materialized. Fan-out is the number of outgoing edges, not 2^k
 * enumerated phrases.
 *
 * One-token configured forms are included when the analyzer emitted them.
 * Analyzer already omits 1-token forms that are members of a longer peer form
 * (`isSingleFormWordAlias`). This module does not add a token-count gate.
 *
 * Typo-correction and final-token-prefix rewrites are not configured identity.
 */

import { typedSurfacePhraseTokens } from "./phraseEvidence.js";
import type { AnalyzedQuery, ConfiguredSpan, QueryToken } from "./types.js";

export interface GraphEdge {
  from: number;
  to: number;
  tokens: string[];
  source: "surface" | "configured";
  key: string | null;
}

export interface TokenGraph {
  typedTokens: string[];
  length: number;
  edges: GraphEdge[];
  edgesFrom: GraphEdge[][];
  configuredEdgeCount: number;
  maxFanout: number;
}

function rewriteBlocked(tok: QueryToken | undefined): boolean {
  const sources = tok?.sources || [];
  return sources.includes("typo-correction") || sources.includes("final-token-prefix");
}

/**
 * A span may introduce a configured edge only when the typed window actually
 * expressed that key/form. Analyzer rewrites are retrieval-only.
 */
export function configuredSpanIsTypedIdentity(query: AnalyzedQuery, span: ConfiguredSpan): boolean {
  const qtoks = query.tokens || [];
  const surface = typedSurfacePhraseTokens(query);
  if (!span || span.end <= span.start) return false;
  if (span.start < 0 || span.end > surface.length || span.end > qtoks.length) return false;
  for (let i = span.start; i < span.end; i++) {
    if (rewriteBlocked(qtoks[i])) return false;
  }
  const kinds = span.matchedKinds || [];
  const key = String(span.key || "").toLowerCase();
  const width = span.end - span.start;
  if (kinds.includes("key")) {
    return width === 1 && String(surface[span.start] || "").toLowerCase() === key;
  }
  if (kinds.includes("form")) {
    if (width === 1) {
      const tok = qtoks[span.start];
      const typed = String(surface[span.start] || "").toLowerCase();
      const lemma = String(tok?.lemma || "").toLowerCase();
      if (lemma === key && typed !== key) return false;
    }
    return true;
  }
  return false;
}

function edgeId(edge: GraphEdge): string {
  return `${edge.from}\t${edge.to}\t${edge.tokens.join("\0")}`;
}

export function buildTokenGraph(query: AnalyzedQuery): TokenGraph {
  const typedTokens = typedSurfacePhraseTokens(query);
  const n = typedTokens.length;
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: GraphEdge) => {
    if (!edge.tokens.length) return;
    const id = edgeId(edge);
    if (seen.has(id)) return;
    seen.add(id);
    edges.push(edge);
  };
  for (let i = 0; i < n; i++) {
    push({
      from: i,
      to: i + 1,
      tokens: [typedTokens[i]],
      source: "surface",
      key: null,
    });
  }
  const spans = (query.configuredSpans || []).filter((span) => configuredSpanIsTypedIdentity(query, span));
  for (const span of spans) {
    const key = String(span.key || "").toLowerCase();
    if (!key) continue;
    push({
      from: span.start,
      to: span.end,
      tokens: [key],
      source: "configured",
      key,
    });
  }
  const edgesFrom: GraphEdge[][] = Array.from({ length: n + 1 }, () => []);
  for (const edge of edges) {
    if (edge.from >= 0 && edge.from <= n) edgesFrom[edge.from].push(edge);
  }
  let maxFanout = 0;
  let configuredEdgeCount = 0;
  for (const row of edgesFrom) {
    if (row.length > maxFanout) maxFanout = row.length;
  }
  for (const edge of edges) {
    if (edge.source === "configured") configuredEdgeCount += 1;
  }
  return {
    typedTokens,
    length: n,
    edges,
    edgesFrom,
    configuredEdgeCount,
    maxFanout,
  };
}

/** True when executing the DAG (not a plain PhraseQuery) would use configured edges. */
export function queryHasTypedConfiguredGraph(query: AnalyzedQuery): boolean {
  const typed = typedSurfacePhraseTokens(query);
  if (typed.length < 2) return false;
  const spans = query.configuredSpans || [];
  for (const span of spans) {
    if (!configuredSpanIsTypedIdentity(query, span)) continue;
    const key = String(span.key || "").toLowerCase();
    if (!key) continue;
    const surface = typed.slice(span.start, span.end);
    if (surface.length === 1 && surface[0] === key) continue;
    return true;
  }
  return false;
}

export function emptyTokenGraph(typedTokens: string[]): TokenGraph {
  const n = typedTokens.length;
  return {
    typedTokens,
    length: n,
    edges: [],
    edgesFrom: Array.from({ length: n + 1 }, () => []),
    configuredEdgeCount: 0,
    maxFanout: 0,
  };
}
