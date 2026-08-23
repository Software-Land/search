import { analyzeCorpus, compileAnalysis } from "../../search-corpus/lib/pipeline.js";
import { compileInspection } from "../../search-corpus/lib/compile.js";
import { annotateReviewQueue } from "../../search-corpus/lib/queue.js";
import { LIFECYCLE } from "../../search-corpus/lib/lifecycle.js";
import type { AnalyzeResult, EquivalenceCandidate, InspectionDoc } from "../../search-corpus/types.js";
import { cacheKeyFor, createFileCache } from "./cache.js";
import { EnrichmentError } from "./errors.js";
import {
  DEFAULT_MAX_CONTEXT_CHARS,
  DEFAULT_MAX_DISCOVERY_DOCUMENTS,
  DEFAULT_MAX_DISCOVERY_PROPOSALS,
  ingestDiscoveryProposal,
  knownEquivalencesFromAnalysis,
  requestFromDocument,
} from "./discovery.js";
import { findCandidate, requestFromCandidate, selectOpportunities } from "./opportunities.js";
import { expansionsEqual, shouldAutoAcceptVerified } from "./policy.js";
import { validateInferenceResponse } from "./validate.js";
import type { EnrichCorpusOptions, EnrichCorpusResult, EnrichmentProposalRecord, InferenceProposal } from "../types.js";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EnrichmentError(`inference timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function dispositionFor(
  proposal: InferenceProposal | undefined,
  candidate: EquivalenceCandidate | null
): EnrichmentProposalRecord["disposition"] {
  if (!proposal) return "invalid";
  if (!candidate) return "model-only";
  if (proposal.relation === "reject") return "rejected-by-model";
  if (proposal.ambiguous || proposal.alternatives.some((alt) => !expansionsEqual(alt.expansion, proposal.expansion))) {
    return "ambiguous";
  }
  if (!expansionsEqual(proposal.expansion, candidate.expansion || [])) return "disagree";
  return "agree";
}

function rebuildInspection(analysis: AnalyzeResult): InspectionDoc {
  const acceptedKeys = new Set(
    analysis.life.equivalences
      .filter((c) => c.lifecycle === LIFECYCLE.AUTO_ACCEPTED || c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED)
      .map((c) => c.key)
      .filter((k): k is string => Boolean(k))
  );
  analysis.life = {
    ...analysis.life,
    equivalences: annotateReviewQueue(analysis.life.equivalences, { acceptedKeys }),
    synonyms: annotateReviewQueue(analysis.life.synonyms, { acceptedKeys }),
  };
  analysis.inspection = compileInspection(analysis.life, { delta: analysis.inspection.delta });
  return analysis.inspection;
}

function applyVerifiedAccept(candidate: EquivalenceCandidate, proposal: InferenceProposal): void {
  candidate.lifecycle = LIFECYCLE.AUTO_ACCEPTED;
  candidate.status = "accepted";
  candidate.compilerStatus = "accepted";
  candidate.compilerDecision = "verified-enrichment";
  candidate.flags = [...new Set([...(candidate.flags || []), "verified-enrichment"])];
  if (proposal.aliases?.length) candidate.aliases = proposal.aliases;
  if (proposal.primary != null) candidate.primary = proposal.primary;
}

/**
 * Optional model-assisted review. Never writes decisions.json.
 * compileCorpus remains deterministic and does not call this.
 */
export async function enrichCorpus(input: unknown, options: EnrichCorpusOptions): Promise<EnrichCorpusResult> {
  if (!options?.provider) throw new EnrichmentError("enrichCorpus requires a provider");
  const autoAcceptVerified = Boolean(options.autoAcceptVerified);
  const cache = options.cache || (options.cacheDir ? createFileCache(options.cacheDir) : null);
  const cacheStats = { hits: 0, misses: 0, writes: 0 };
  const analysis = analyzeCorpus(input, {
    decisions: options.decisions,
    previousInspection: options.previousInspection as InspectionDoc | null,
  });
  const opportunities = selectOpportunities(analysis, { maxOpportunities: options.maxOpportunities });
  const proposals: EnrichmentProposalRecord[] = [];

  for (const candidate of opportunities) {
    const request = requestFromCandidate(candidate);
    const key = cacheKeyFor(request, options.provider);
    let cacheHit = false;
    let raw: unknown;
    const cached = cache?.get(key) || null;
    if (cached) {
      cacheHit = true;
      cacheStats.hits += 1;
      raw = cached;
    } else {
      cacheStats.misses += 1;
      raw = await withTimeout(options.provider.infer(request), options.timeoutMs || 0);
    }
    const response = validateInferenceResponse(raw);
    if (cache && !cacheHit) {
      cache.set(key, response);
      cacheStats.writes += 1;
    }
    for (const proposal of response.proposals) {
      const mined = findCandidate(analysis.life.equivalences, proposal.key, proposal.expansion);
      const samePair =
        mined && mined.key === candidate.key && expansionsEqual(mined.expansion || [], candidate.expansion || []);
      const target = samePair ? candidate : mined && mined.key === proposal.key ? mined : null;
      const disposition = dispositionFor(proposal, target);
      const verdict = shouldAutoAcceptVerified({
        enabled: autoAcceptVerified,
        candidate: target,
        proposal,
        peers: analysis.life.equivalences,
      });
      if (verdict.ok && target) applyVerifiedAccept(target, proposal);
      proposals.push({
        request,
        response: { schemaVersion: response.schemaVersion, proposals: [proposal] },
        disposition,
        autoAccepted: verdict.ok,
        cacheHit,
        reasons: verdict.reasons,
      });
    }
  }

  const discover = options.discover !== false;
  if (discover) {
    const maxContextChars = options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
    const maxDiscoveryProposals = options.maxDiscoveryProposals ?? DEFAULT_MAX_DISCOVERY_PROPOSALS;
    const maxDiscoveryDocuments = options.maxDiscoveryDocuments ?? DEFAULT_MAX_DISCOVERY_DOCUMENTS;
    const documents = (analysis.documentRecords || []).filter((d) => d && (d.title || d.body));
    const known = knownEquivalencesFromAnalysis(analysis.life.equivalences);
    for (const doc of documents.slice(0, Math.max(0, maxDiscoveryDocuments))) {
      const request = requestFromDocument(doc, {
        maxContextChars,
        maxProposals: maxDiscoveryProposals,
        knownEquivalences: known,
      });
      const key = cacheKeyFor(request, options.provider);
      let cacheHit = false;
      let raw: unknown;
      const cached = cache?.get(key) || null;
      if (cached) {
        cacheHit = true;
        cacheStats.hits += 1;
        raw = cached;
      } else {
        cacheStats.misses += 1;
        raw = await withTimeout(options.provider.infer(request), options.timeoutMs || 0);
      }
      const response = validateInferenceResponse(raw);
      if (cache && !cacheHit) {
        cache.set(key, response);
        cacheStats.writes += 1;
      }
      const limited = response.proposals.slice(0, Math.max(0, maxDiscoveryProposals));
      for (const proposal of limited) {
        const result = ingestDiscoveryProposal({
          proposal,
          doc,
          documents: analysis.documentRecords || [],
          rows: analysis.life.equivalences,
          autoAcceptVerified,
        });
        const disposition = result.ingested
          ? dispositionFor(proposal, result.candidate)
          : "model-only";
        proposals.push({
          request,
          response: { schemaVersion: response.schemaVersion, proposals: [proposal] },
          disposition,
          autoAccepted: result.autoAccepted,
          cacheHit,
          reasons: result.reasons,
        });
      }
    }
  }

  rebuildInspection(analysis);
  return {
    analysis,
    inspection: analysis.inspection,
    compiled: compileAnalysis(analysis),
    proposals,
    cacheStats,
  };
}
