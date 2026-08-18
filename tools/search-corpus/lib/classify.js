import { documentSupportsPairIndexed, indexDocuments } from "./acronyms.js";
import { stableSort } from "./text.js";

/** @param {Array<{ documentId?: string | null }>} hits */
function uniqueDocs(hits) {
  return new Set(hits.map((h) => h.documentId));
}

/** @param {Array<{ documentId?: string | null, provenance?: string, snippet?: string | null, field?: string | null }>} hits */
function capProvenance(hits) {
  const seen = new Set();
  const out = [];
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

/** @param {import("../types.js").EquivalenceCandidate} row @param {import("../types.js").IndexedDocument[]} indexedDocs */
function summarizeEvidence(row, indexedDocs) {
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
    provenances: [...new Set(hits.map((h) => h.provenance).filter((p) => typeof p === "string"))].sort(),
  };
}

/** @param {unknown} key */
function shortTokenNeedsMoreEvidence(key) {
  return String(key || "").length <= 3;
}

/** @param {unknown} key @param {string[]} expansion */
function strictInitialsMatch(key, expansion) {
  const k = String(key || "").toLowerCase();
  const init = (expansion || []).map((t) => (t[0] || "")).join("");
  return k.length > 0 && k === init;
}

/** @param {import("../types.js").EquivalenceEvidence} ev @param {Partial<import("../types.js").EquivalenceCandidate>} [item] */
function hasStrongShortTokenEvidence(ev, item = {}) {
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

/** @param {import("../types.js").EquivalenceEvidence} evidence @param {string} status @param {string[]} [extra] */
function reasonsFrom(evidence, status, extra = []) {
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
 * @param {import("../types.js").EquivalenceCandidate[]} rawRows
 * @param {import("../types.js").CorpusDocument[]} documents
 */
export function classifyCandidates(rawRows, documents) {
  const indexedDocs = indexDocuments(documents);
  /** @type {Map<string, import("../types.js").EquivalenceCandidate>} */
  const merged = new Map();
  for (const row of rawRows) {
    const id = `${row.key}::${row.expansionPhrase}`;
    const existing = merged.get(id);
    if (!existing) merged.set(id, { ...row, hits: [...(row.hits || [])] });
    else existing.hits = [...(existing.hits || []), ...(row.hits || [])];
  }

  /** @type {Map<string, import("../types.js").EquivalenceCandidate[]>} */
  const byKey = new Map();
  for (const row of merged.values()) {
    const evidence = summarizeEvidence(row, indexedDocs);
    const item = { ...row, evidence };
    if (!byKey.has(row.key)) byKey.set(row.key, []);
    (byKey.get(row.key) || []).push(item);
  }

  const out = [];
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
