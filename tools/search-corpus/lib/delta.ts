import { stableSort } from "./text.js";
import type { CorpusCandidate, InspectionDelta, InspectionDoc } from "../types.js";

function indexById(rows: Array<{ id?: string } | null | undefined> | undefined): Map<string, CorpusCandidate> {
  const m = new Map<string, CorpusCandidate>();
  for (const r of rows || []) {
    if (r?.id) m.set(r.id, r as CorpusCandidate);
  }
  return m;
}

function explicitCount(row: CorpusCandidate | null | undefined): number {
  return row?.evidence?.explicitDefinitions || 0;
}

function hasTitleEvidence(row: CorpusCandidate | null | undefined): boolean {
  return (row?.evidence?.titleCooccurrences || 0) >= 1 || (row?.evidence?.titleKeyBodyPhrase || 0) >= 1;
}

/**
 * Support-count drift (7 → 8) is not a semantic review event.
 * Material = lifecycle, band, ambiguity, new explicit definition, new title evidence,
 * competing expansion, or a rejected candidate gaining strong evidence.
 */
export function isMaterialChange(prev?: unknown, next?: unknown): boolean {
  const prevRow = prev as CorpusCandidate | null | undefined;
  const cur = next as CorpusCandidate | null | undefined;
  if (!prevRow || !cur) return false;
  if (prevRow.lifecycle !== cur.lifecycle) return true;
  if ((prevRow.reviewBand || null) !== (cur.reviewBand || null)) return true;
  if (explicitCount(prevRow) === 0 && explicitCount(cur) >= 1) return true;
  if (!hasTitleEvidence(prevRow) && hasTitleEvidence(cur)) return true;
  const prevAmb = (prevRow.flags || []).includes("competing-expansion") || prevRow.lifecycle === "CONFLICT";
  const curAmb = (cur.flags || []).includes("competing-expansion") || cur.lifecycle === "CONFLICT";
  if (!prevAmb && curAmb) return true;
  if (
    !(prevRow.flags || []).includes("rejected-candidate-gained-strong-evidence") &&
    (cur.flags || []).includes("rejected-candidate-gained-strong-evidence")
  ) {
    return true;
  }
  return false;
}

function bandOf(row: CorpusCandidate | null | undefined): string | null {
  return row?.reviewBand || null;
}

/**
 * Incremental change summary vs a previous inspection snapshot.
 */
export function diffInspections(current?: InspectionDoc | null, previous?: InspectionDoc | null): InspectionDelta {
  const curEq = indexById(current?.candidates || []);
  const prevEq = indexById(previous?.candidates || []);
  const curSyn = indexById(current?.synonymCandidates || current?.synonymPending || []);
  const prevSyn = indexById(previous?.synonymCandidates || previous?.synonymPending || []);

  const newReview: string[] = [];
  const existingUnresolved: string[] = [];
  const evidenceChanged: string[] = [];
  const materialChanges: string[] = [];
  const newConflicts: string[] = [];
  const orphaned: string[] = [];
  const newByBand: Record<string, string[]> = { HIGH: [], MEDIUM: [], LOW: [] };
  const promoted: Array<{ id: string; from: string | null; to: string | null }> = [];
  const demoted: Array<{ id: string; from: string | null; to: string | null }> = [];

  const BAND_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

  function consider(id: string, row: CorpusCandidate, prev: CorpusCandidate | undefined) {
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
