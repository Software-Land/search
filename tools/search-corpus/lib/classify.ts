import { documentSupportsPairIndexed, indexDocuments } from "./acronyms.js";
import { stableSort } from "./text.js";
import type { CorpusDocument, EquivalenceCandidate, EquivalenceEvidence, EvidenceHit, IndexedDocument } from "../types.js";

function uniqueDocs(hits: Array<{ documentId?: string | null }>): Set<string | null | undefined> {
  return new Set(hits.map((h) => h.documentId));
}

function capProvenance(hits: Array<{ documentId?: string | null; provenance?: string; snippet?: string | null; field?: string | null }>): EvidenceHit[] {
  const seen = new Set<string>();
  const out: EvidenceHit[] = [];
  for (const h of hits) {
    const id = `${h.documentId}|${h.provenance}|${h.snippet}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      type: h.provenance,
      documentId: h.documentId,
      field: h.field,
      snippet: h.snippet,
    });
    if (out.length >= 8) break;
  }
  return out;
}

function summarizeEvidence(row: EquivalenceCandidate, indexedDocs: IndexedDocument[]): EquivalenceEvidence {
  const hits = row.hits || [];
  const explicitHits = hits.filter((h) => String(h.provenance || "").startsWith("explicit"));
  const explicitDocs = uniqueDocs(explicitHits);
  let titleCooccurrences = 0;
  let bodyCooccurrences = 0;
  let titleHasKey = 0;
  let titleKeyBodyPhrase = 0;
  let expansionDf = 0;
  let keyDf = 0;
  const phrase = ` ${row.expansionPhrase || (row.expansion || []).join(" ")} `;
  for (const idx of indexedDocs) {
    if (idx.allJoined.includes(phrase)) expansionDf += 1;
    const sup = documentSupportsPairIndexed(idx, row.key, row.expansion || []);
    if (sup.hasKey) keyDf += 1;
    if (sup.titleHasKey && sup.hasPhrase) {
      titleCooccurrences += 1;
      if (!sup.titleHasPhrase) titleKeyBodyPhrase += 1;
    } else if (sup.hasKey && sup.hasPhrase) bodyCooccurrences += 1;
    if (sup.titleHasKey) titleHasKey += 1;
  }
  return {
    explicitDefinitions: explicitDocs.size,
    explicitMentions: explicitHits.length,
    titleCooccurrences,
    bodyCooccurrences,
    titleOccurrencesOfKey: titleHasKey,
    titleKeyBodyPhrase,
    expansionDf,
    keyDf,
    supportingDocuments: explicitDocs.size + titleCooccurrences + bodyCooccurrences,
    provenances: [...new Set(hits.map((h) => h.provenance).filter((p): p is string => typeof p === "string"))].sort(),
  };
}

function shortTokenNeedsMoreEvidence(key: unknown): boolean {
  return String(key || "").length <= 3;
}

function strictInitialsMatch(key: unknown, expansion: string[]): boolean {
  const k = String(key || "").toLowerCase();
  const init = (expansion || []).map((t) => t[0] || "").join("");
  return k.length > 0 && k === init;
}

function hasStrongShortTokenEvidence(ev: EquivalenceEvidence, item: Partial<EquivalenceCandidate> = {}): boolean {
  if ((ev.explicitDefinitions || 0) >= 1) return true;
  // 2/3-letter keys matching an ngram only after dropping of/and are coincidences
  // (cd → cycle of developing). Explicit definitions may still use optional words.
  if (shortTokenNeedsMoreEvidence(item.key) && !strictInitialsMatch(item.key, item.expansion || [])) {
    return false;
  }
  if ((ev.titleCooccurrences || 0) >= 1 && (ev.bodyCooccurrences || 0) >= 1) return true;
  if ((ev.titleKeyBodyPhrase || 0) >= 1) return true;
  if ((ev.expansionDf || 0) >= 2 && (ev.titleOccurrencesOfKey || 0) >= 1) return true;
  return false;
}

function reasonsFrom(evidence: EquivalenceEvidence, status: string, extra: string[] = []): string[] {
  const reasons = [...extra];
  if (evidence.explicitDefinitions) {
    reasons.push(
      `${evidence.explicitDefinitions} explicit definition${evidence.explicitDefinitions === 1 ? "" : "s"}`
    );
  }
  if (evidence.titleCooccurrences) {
    reasons.push(
      `${evidence.titleCooccurrences} title co-occurrence${evidence.titleCooccurrences === 1 ? "" : "s"}`
    );
  }
  if (evidence.bodyCooccurrences) {
    reasons.push(
      `${evidence.bodyCooccurrences} body co-occurrence${evidence.bodyCooccurrences === 1 ? "" : "s"}`
    );
  }
  if (status === "accepted") reasons.unshift("exact initialism");
  return reasons;
}

/**
 * Conservative status:
 *   accepted — repeated or title-backed explicit definitions, unambiguous
 *   review   — real evidence, not enough to trust automatically
 *   rejected — coincidence, failed initials, relatedness, or too weak
 */
export function classifyCandidates(rawRows: EquivalenceCandidate[], documents: CorpusDocument[]): EquivalenceCandidate[] {
  const indexedDocs = indexDocuments(documents);
  const merged = new Map<string, EquivalenceCandidate>();
  for (const row of rawRows) {
    const id = `${row.key}::${row.expansionPhrase}`;
    const existing = merged.get(id);
    if (!existing) merged.set(id, { ...row, hits: [...(row.hits || [])] });
    else existing.hits = [...(existing.hits || []), ...(row.hits || [])];
  }

  const byKey = new Map<string, EquivalenceCandidate[]>();
  for (const row of merged.values()) {
    const evidence = summarizeEvidence(row, indexedDocs);
    const item = { ...row, evidence };
    if (!byKey.has(row.key)) byKey.set(row.key, []);
    (byKey.get(row.key) || []).push(item);
  }

  const out: EquivalenceCandidate[] = [];
  for (const [key, items] of byKey) {
    const explicitItems = items.filter((i) => (i.evidence?.explicitDefinitions || 0) >= 1 && i.initialsMatch);
    const ambiguous = explicitItems.length >= 2;

    for (const item of items) {
      const ev = item.evidence || {};
      let status = "rejected";
      let decision = "weak-or-no-evidence";

      if (!item.initialsMatch) {
        status = "rejected";
        decision = "initials-do-not-match";
      } else if ((ev.explicitDefinitions || 0) >= 1 && !ambiguous) {
        if ((ev.explicitDefinitions || 0) >= 2) {
          status = "accepted";
          decision = "repeated-explicit-definition";
        } else if ((ev.titleCooccurrences || 0) >= 1 || (ev.explicitMentions || 0) >= 2 || (ev.titleOccurrencesOfKey || 0) >= 1) {
          status = "accepted";
          decision = "explicit-definition-with-title-or-repeat";
        } else {
          status = "review";
          decision = "single-explicit-definition";
        }
      } else if (ambiguous && (ev.explicitDefinitions || 0) >= 1) {
        status = "review";
        decision = "ambiguous-expansions";
      } else if ((ev.titleCooccurrences || 0) >= 1) {
        if (shortTokenNeedsMoreEvidence(key) && !hasStrongShortTokenEvidence(ev, item)) {
          status = "rejected";
          decision = "short-token-weak-evidence";
        } else {
          status = "review";
          decision = "title-backed-cooccurrence";
        }
      } else if ((ev.titleOccurrencesOfKey || 0) >= 1 && (ev.bodyCooccurrences || 0) >= 1) {
        if (shortTokenNeedsMoreEvidence(key) && !hasStrongShortTokenEvidence(ev, item)) {
          status = "rejected";
          decision = "short-token-weak-evidence";
        } else {
          status = "review";
          decision = "title-key-with-body-phrase";
        }
      } else if ((ev.bodyCooccurrences || 0) >= 2) {
        if (shortTokenNeedsMoreEvidence(key) && !hasStrongShortTokenEvidence(ev, item)) {
          status = "rejected";
          decision = "short-token-weak-evidence";
        } else {
          status = "review";
          decision = "repeated-body-cooccurrence";
        }
      } else if ((ev.explicitDefinitions || 0) >= 1) {
        status = "review";
        decision = "ambiguous-expansions";
      } else {
        status = "rejected";
        decision = "initialism-coincidence";
      }

      if (ambiguous && status === "accepted") {
        status = "review";
        decision = "ambiguous-expansions";
      }

      out.push({
        type: "equivalence-candidate",
        key,
        expansion: item.expansion,
        expansionPhrase: item.expansionPhrase,
        status,
        decision,
        initialsMatch: item.initialsMatch,
        evidence: ev,
        reasons: reasonsFrom(ev, status, ambiguous ? ["multiple expansions for this key"] : []),
        provenance: capProvenance(item.hits || []),
      });
    }
  }

  return stableSort(out, (c) => `${c.status}:${c.key}:${c.expansionPhrase}`);
}
