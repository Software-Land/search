import { relationshipId } from "./ids.js";
import { isSymmetricType } from "./types.js";
import { indexDecisions } from "./decisions.js";
import { resolveRef } from "./documents.js";
import { stableSort } from "./hash.js";

export const LIFECYCLE = {
  MANUAL_ACCEPTED: "MANUAL_ACCEPTED",
  HUMAN_ACCEPTED: "HUMAN_ACCEPTED",
  REVIEW_PENDING: "REVIEW_PENDING",
  HUMAN_REJECTED: "HUMAN_REJECTED",
  CONFLICT: "CONFLICT",
  ORPHANED_DECISION: "ORPHANED_DECISION",
};

/** @param {import("../types.js").RelDecision} item @param {import("../types.js").RelDocument | null} src @param {import("../types.js").RelDocument | null} tgt */
function resolvedId(item, src, tgt) {
  if (src && tgt) return relationshipId(item.type, src.id, tgt.id, { directional: item.directional });
  return item.id;
}

/** @param {import("../types.js").RelCandidate[] | null | undefined} candidates @param {unknown} decisions @param {import("../types.js").DocIndex} docIndex @returns {import("../types.js").RelLifecycleResult} */
export function applyLifecycle(candidates, decisions, docIndex) {
  const idx = indexDecisions(decisions);
  /** @type {unknown[]} */
  const flags = [];
  /** @type {unknown[]} */
  const conflicts = [];
  /** @type {import("../types.js").RelCandidate[]} */
  const orphaned = [];
  /** @type {Map<string, import("../types.js").RelCandidate>} */
  const byId = new Map();

  for (const raw of candidates || []) {
    const src = resolveRef(raw.source, docIndex);
    const tgt = resolveRef(raw.target, docIndex);
    const id = raw.id || (src && tgt ? relationshipId(raw.type, src.id, tgt.id, { directional: raw.directional }) : null);
    if (!id) continue;
    byId.set(id, {
      ...raw,
      id,
      resolvedSource: src?.id || null,
      resolvedTarget: tgt?.id || null,
      flags: [],
    });
  }

  const usedDecisionIds = new Set();

  for (const item of idx.loaded.relationships) {
    const src = resolveRef(item.source, docIndex);
    const tgt = resolveRef(item.target, docIndex);
    const id = resolvedId(item, src, tgt);
    usedDecisionIds.add(item.id);
    const existing = byId.get(id) || {
      type: item.type,
      id,
      source: item.source,
      target: item.target,
      directional: item.directional,
      note: item.note,
      evidence: {},
      reasons: ["decision has no generated candidate"],
      flags: ["manual-seed"],
      resolvedSource: src?.id || null,
      resolvedTarget: tgt?.id || null,
    };
    existing.decisionRecord = item;
    existing.resolvedSource = src?.id || null;
    existing.resolvedTarget = tgt?.id || null;

    if (item.decision === "reject") {
      existing.lifecycle = src && tgt ? LIFECYCLE.HUMAN_REJECTED : LIFECYCLE.ORPHANED_DECISION;
      existing.status = "rejected";
      if (!src || !tgt) {
        existing.flags = [...(existing.flags || []), "orphaned-decision"];
        orphaned.push(existing);
      }
      byId.set(id, existing);
      continue;
    }

    if (item.decision === "accept") {
      if (!src || !tgt) {
        existing.lifecycle = LIFECYCLE.ORPHANED_DECISION;
        existing.status = "rejected";
        existing.flags = [...(existing.flags || []), "orphaned-decision"];
        orphaned.push(existing);
      } else {
        const mined = Array.isArray(existing.provenance) && existing.provenance.length;
        existing.lifecycle = mined ? LIFECYCLE.HUMAN_ACCEPTED : LIFECYCLE.MANUAL_ACCEPTED;
        existing.status = "accepted";
        if (!mined) existing.flags = [...new Set([...(existing.flags || []), "manual-addition"])];
      }
      byId.set(id, existing);
    }
  }

  for (const c of byId.values()) {
    if (c.lifecycle) continue;
    c.lifecycle = LIFECYCLE.REVIEW_PENDING;
    c.status = "review";
  }

  const rows = stableSort([...byId.values()], (c) => c.id || "");
  const rejectedIds = new Set(
    rows.filter((r) => r.lifecycle === LIFECYCLE.HUMAN_REJECTED).map((r) => r.id || "").filter(Boolean)
  );
  return {
    candidates: rows,
    conflicts,
    flags,
    orphaned,
    decisions: idx.loaded,
    rejectAllPairs: idx.rejectAllPairs,
    rejectedIds,
    usedDecisionIds,
  };
}

/** @param {import("../types.js").RelLifecycleResult} life */
export function trustedRows(life) {
  return (life.candidates || []).filter(
    (c) =>
      (c.lifecycle === LIFECYCLE.MANUAL_ACCEPTED || c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED) &&
      c.resolvedSource &&
      c.resolvedTarget
  );
}

export { isSymmetricType };
