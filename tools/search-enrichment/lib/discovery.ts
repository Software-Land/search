import { extractDocumentAcronymSurfaces } from "../../search-corpus/lib/acronyms.js";
import { evidenceForPair } from "../../search-corpus/lib/classify.js";
import { attachEquivalenceIds } from "../../search-corpus/lib/lifecycle.js";
import { LIFECYCLE } from "../../search-corpus/lib/lifecycle.js";
import {
  acronymKey,
  initialsMatch,
  normalizeExpansion,
  phraseKey,
  tokenize,
} from "../../search-corpus/lib/text.js";
import type { CorpusDocument, EquivalenceCandidate } from "../../search-corpus/types.js";
import { INFERENCE_SCHEMA_VERSION, PROMPT_ID } from "./prompt.js";
import { shouldAutoAcceptVerified } from "./policy.js";
import type { InferenceProposal, LexicalInferenceRequest } from "../types.js";

export const DEFAULT_MAX_CONTEXT_CHARS = 4000;
export const DEFAULT_MAX_DISCOVERY_PROPOSALS = 8;
export const DEFAULT_MAX_DISCOVERY_DOCUMENTS = 200;

export function boundText(text: unknown, maxChars: number): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, Math.floor(maxChars)));
}

function documentText(doc: CorpusDocument): string {
  return `${doc.title || ""}\n${doc.body || ""}`;
}

export function documentAttestsKey(doc: CorpusDocument, key: string): boolean {
  const k = acronymKey(key);
  if (!k) return false;
  const surfaces = extractDocumentAcronymSurfaces(doc);
  const keys = new Set(
    [...surfaces.title, ...surfaces.body].map((s) => acronymKey(s)).filter(Boolean)
  );
  if (keys.has(k)) return true;
  const tokens = new Set(tokenize(documentText(doc)));
  return tokens.has(k);
}

export function documentAttestsExpansion(doc: CorpusDocument, expansion: string[]): boolean {
  const tokens = tokenize(documentText(doc));
  const phrase = ` ${phraseKey(normalizeExpansion(expansion))} `;
  return ` ${tokens.join(" ")} `.includes(phrase);
}

export function documentAttestsProposal(
  doc: CorpusDocument,
  proposal: Pick<InferenceProposal, "key" | "expansion">
): { hasKey: boolean; hasExpansion: boolean } {
  return {
    hasKey: documentAttestsKey(doc, proposal.key),
    hasExpansion: documentAttestsExpansion(doc, proposal.expansion || []),
  };
}

function trustedEquivalences(rows: EquivalenceCandidate[]): Array<{ key: string; expansion: string[] }> {
  return rows
    .filter(
      (c) =>
        (c.lifecycle === LIFECYCLE.AUTO_ACCEPTED || c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED) &&
        c.key &&
        (c.expansion || []).length
    )
    .slice(0, 32)
    .map((c) => ({ key: c.key, expansion: [...(c.expansion || [])] }));
}

export function requestFromDocument(
  doc: CorpusDocument,
  {
    maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
    maxProposals = DEFAULT_MAX_DISCOVERY_PROPOSALS,
    knownEquivalences = [],
  }: {
    maxContextChars?: number;
    maxProposals?: number;
    knownEquivalences?: Array<{ key: string; expansion: string[] }>;
  } = {}
): LexicalInferenceRequest {
  const cap = Math.max(0, maxContextChars);
  const title = boundText(doc.title, cap);
  const context = boundText(doc.body, cap);
  const surfaces = extractDocumentAcronymSurfaces(doc);
  const observed = [
    ...new Set([...surfaces.title, ...surfaces.body].map((s) => acronymKey(s)).filter(Boolean)),
  ]
    .sort()
    .slice(0, 64);
  return {
    schemaVersion: INFERENCE_SCHEMA_VERSION,
    promptId: PROMPT_ID,
    task: "discover-equivalences",
    key: "",
    minedExpansion: [],
    evidence: {},
    alternatives: [],
    documentId: doc.id,
    title,
    context,
    observedAcronyms: observed,
    knownEquivalences: knownEquivalences.slice(0, 32),
    maxProposals: Math.max(0, maxProposals),
  };
}

export function knownEquivalencesFromAnalysis(rows: EquivalenceCandidate[]): Array<{ key: string; expansion: string[] }> {
  return trustedEquivalences(rows);
}

function findExactPair(
  rows: EquivalenceCandidate[],
  key: string,
  expansion: string[]
): EquivalenceCandidate | null {
  const phrase = phraseKey(expansion);
  return (
    rows.find((c) => c.key === key && (c.expansionPhrase || phraseKey(c.expansion || [])) === phrase) || null
  );
}

function synthesizeCandidate(
  proposal: InferenceProposal,
  documents: CorpusDocument[],
  sourceDoc: CorpusDocument
): EquivalenceCandidate {
  const expansion = normalizeExpansion(proposal.expansion);
  const key = acronymKey(proposal.key);
  const evidence = evidenceForPair(key, expansion, documents);
  const phrase = phraseKey(expansion);
  const hit = {
    documentId: sourceDoc.id,
    field: "body" as const,
    provenance: "model-discovery",
    snippet: phrase.slice(0, 160),
  };
  const raw: EquivalenceCandidate = {
    type: "equivalence-candidate",
    key,
    expansion,
    expansionPhrase: phrase,
    initialsMatch: initialsMatch(key, expansion),
    hits: [hit],
    evidence: {
      ...evidence,
      provenances: [...new Set([...(evidence.provenances || []), "model-discovery"])],
    },
    status: "review",
    decision: "model-discovery",
    reasons: ["model-discovery"],
    provenance: [
      {
        type: "model-discovery",
        documentId: sourceDoc.id,
        field: "body",
        snippet: phrase.slice(0, 160),
      },
    ],
    flags: ["model-discovery"],
  };
  const attached = attachEquivalenceIds([raw])[0];
  attached.lifecycle = LIFECYCLE.REVIEW_PENDING;
  attached.status = "review";
  attached.compilerStatus = "review";
  attached.compilerDecision = "model-discovery";
  return attached;
}

export function ingestDiscoveryProposal({
  proposal,
  doc,
  documents,
  rows,
  autoAcceptVerified,
}: {
  proposal: InferenceProposal;
  doc: CorpusDocument;
  documents: CorpusDocument[];
  rows: EquivalenceCandidate[];
  autoAcceptVerified: boolean;
}): {
  ingested: boolean;
  autoAccepted: boolean;
  candidate: EquivalenceCandidate | null;
  reasons: string[];
} {
  if (proposal.relation === "reject") {
    return { ingested: false, autoAccepted: false, candidate: null, reasons: ["model rejected the pair"] };
  }
  const attested = documentAttestsProposal(doc, proposal);
  if (!attested.hasKey && !attested.hasExpansion) {
    return {
      ingested: false,
      autoAccepted: false,
      candidate: null,
      reasons: ["proposal is not attested in the source document"],
    };
  }
  const existing = findExactPair(rows, proposal.key, proposal.expansion || []);
  let target = existing;
  if (!target) {
    target = synthesizeCandidate(proposal, documents, doc);
    rows.push(target);
  }
  const verdict = shouldAutoAcceptVerified({
    enabled: autoAcceptVerified,
    candidate: target,
    proposal,
    peers: rows,
  });
  if (verdict.ok && target) {
    target.lifecycle = LIFECYCLE.AUTO_ACCEPTED;
    target.status = "accepted";
    target.compilerStatus = "accepted";
    target.compilerDecision = "verified-enrichment";
    target.flags = [...new Set([...(target.flags || []), "verified-enrichment"])];
    if (proposal.aliases?.length) target.aliases = proposal.aliases;
    if (proposal.primary != null) target.primary = proposal.primary;
  }
  return {
    ingested: true,
    autoAccepted: verdict.ok,
    candidate: target,
    reasons: verdict.reasons.length ? verdict.reasons : ["model-discovery"],
  };
}
