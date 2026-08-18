import { stableSort } from "./text.js";

/** @param {Array<{ id?: string } | null | undefined>} rows */
function indexById(rows) {
  /** @type {Map<string, import("../types.js").CorpusCandidate>} */
  const m = new Map();
  for (const r of rows || []) {
    if (r?.id) m.set(r.id, /** @type {import("../types.js").CorpusCandidate} */ (r));
  }
  return m;
}

/** @param {import("../types.js").CorpusCandidate | null | undefined} row */
function explicitCount(row) {
  return row?.evidence?.explicitDefinitions || 0;
}

/** @param {import("../types.js").CorpusCandidate | null | undefined} row */
function hasTitleEvidence(row) {
  return (row?.evidence?.titleCooccurrences || 0) >= 1 || (row?.evidence?.titleKeyBodyPhrase || 0) >= 1;
}

/**
 * Support-count drift (7 → 8) is not a semantic review event.
 * Material = lifecycle, band, ambiguity, new explicit definition, new title evidence,
 * competing expansion, or a rejected candidate gaining strong evidence.
 * @param {import("../types.js").CorpusCandidate | null | undefined} prev
 * @param {import("../types.js").CorpusCandidate | null | undefined} cur
 */
export function isMaterialChange(prev, cur) {
  if (!prev || !cur) return false;
  if (prev.lifecycle !== cur.lifecycle) return true;
  if ((prev.reviewBand || null) !== (cur.reviewBand || null)) return true;
  if (explicitCount(prev) === 0 && explicitCount(cur) >= 1) return true;
  if (!hasTitleEvidence(prev) && hasTitleEvidence(cur)) return true;
  const prevAmb = (prev.flags || []).includes("competing-expansion") || prev.lifecycle === "CONFLICT";
  const curAmb = (cur.flags || []).includes("competing-expansion") || cur.lifecycle === "CONFLICT";
  if (!prevAmb && curAmb) return true;
  if (
    !(prev.flags || []).includes("rejected-candidate-gained-strong-evidence") &&
    (cur.flags || []).includes("rejected-candidate-gained-strong-evidence")
  ) {
    return true;
  }
  return false;
}

/** @param {import("../types.js").CorpusCandidate | null | undefined} row */
function bandOf(row) {
  return row?.reviewBand || null;
}

/**
 * Incremental change summary vs a previous inspection snapshot.
 * @param {import("../types.js").InspectionDoc | null | undefined} current
 * @param {import("../types.js").InspectionDoc | null | undefined} previous
 * @returns {import("../types.js").InspectionDelta}
 */
export function diffInspections(current, previous) {
  const curEq = indexById(current?.candidates || []);
  const prevEq = indexById(previous?.candidates || []);
  const curSyn = indexById(current?.synonymCandidates || current?.synonymPending || []);
  const prevSyn = indexById(previous?.synonymCandidates || previous?.synonymPending || []);

  /** @type {string[]} */
  const newReview = [];
  /** @type {string[]} */
  const existingUnresolved = [];
  /** @type {string[]} */
  const evidenceChanged = [];
  /** @type {string[]} */
  const materialChanges = [];
  /** @type {string[]} */
  const newConflicts = [];
  /** @type {string[]} */
  const orphaned = [];
  /** @type {Record<string, string[]>} */
  const newByBand = { HIGH: [], MEDIUM: [], LOW: [] };
  /** @type {Array<{ id: string, from: string | null, to: string | null }>} */
  const promoted = [];
  /** @type {Array<{ id: string, from: string | null, to: string | null }>} */
  const demoted = [];

  /** @type {Record<string, number>} */
  const BAND_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

  /**
   * @param {string} id
   * @param {import("../types.js").CorpusCandidate} row
   * @param {import("../types.js").CorpusCandidate | undefined} prev
   */
  function consider(id, row, prev) {
    if (row.lifecycle === "REVIEW_PENDING" && !prev) {
      newReview.push(id);
      if (row.reviewBand && newByBand[row.reviewBand]) newByBand[row.reviewBand].push(id);
    } else if (row.lifecycle === "REVIEW_PENDING") existingUnresolved.push(id);
    if (prev && isMaterialChange(prev, row)) materialChanges.push(id);
    if (prev && JSON.stringify(prev.evidence || {}) !== JSON.stringify(row.evidence || {})) {
      evidenceChanged.push(id);
    }
    if (row.lifecycle === "CONFLICT" && prev?.lifecycle !== "CONFLICT") newConflicts.push(id);
    if (prev && bandOf(prev) && bandOf(row) && bandOf(prev) !== bandOf(row)) {
      const nextBand = bandOf(row);
      const prevBand = bandOf(prev);
      if ((BAND_RANK[nextBand || ""] ?? 9) < (BAND_RANK[prevBand || ""] ?? 9)) {
        promoted.push({ id, from: prevBand, to: nextBand });
      } else {
        demoted.push({ id, from: prevBand, to: nextBand });
      }
    }
  }

  for (const [id, row] of curEq) consider(id, row, prevEq.get(id));
  for (const [id, row] of curSyn) consider(id, row, prevSyn.get(id));

  const allPrev = new Set([...prevEq.keys(), ...prevSyn.keys()]);
  const allCur = new Set([...curEq.keys(), ...curSyn.keys()]);
  for (const id of allPrev) {
    if (!allCur.has(id) && (previous?.candidates || []).concat(previous?.synonymCandidates || []).find((r) => r.id === id)?.decisionRecord) {
      orphaned.push(id);
    }
  }
  for (const row of current?.orphaned || []) if (row.id) orphaned.push(row.id);

  const summary = {
    newReviewCandidates: newReview.length,
    existingUnresolved: existingUnresolved.length,
    acceptedCandidatesChangedEvidence: evidenceChanged.filter((id) => {
      const row = curEq.get(id);
      return row && (row.lifecycle === "AUTO_ACCEPTED" || row.lifecycle === "HUMAN_ACCEPTED");
    }).length,
    materialChanges: materialChanges.length,
    supportOnlyChanges: evidenceChanged.filter((id) => !materialChanges.includes(id)).length,
    newHigh: newByBand.HIGH.length,
    newMedium: newByBand.MEDIUM.length,
    newLow: newByBand.LOW.length,
    promotedToHigh: promoted.filter((p) => p.to === "HIGH").length,
    demoted: demoted.length,
    newConflicts: newConflicts.length,
    orphanedDecisions: [...new Set(orphaned)].length,
  };

  return {
    summary,
    newReview: stableSort(newReview, (x) => x),
    existingUnresolved: stableSort(existingUnresolved, (x) => x),
    evidenceChanged: stableSort(materialChanges, (x) => x),
    supportOnlyChanges: stableSort(
      evidenceChanged.filter((id) => !materialChanges.includes(id)),
      (x) => x
    ),
    newHigh: stableSort(newByBand.HIGH, (x) => x),
    newMedium: stableSort(newByBand.MEDIUM, (x) => x),
    newLow: stableSort(newByBand.LOW, (x) => x),
    promoted: stableSort(promoted.map((p) => p.id), (x) => x),
    demoted: stableSort(demoted.map((p) => p.id), (x) => x),
    newConflicts: stableSort(newConflicts, (x) => x),
    orphanedDecisions: stableSort([...new Set(orphaned)], (x) => x),
  };
}
