/**
 * Explicit decision ingestion. Resolves authored refs to document ids.
 * Does not mine candidates or assign review states.
 */

import { relationshipId, pairKey } from "./ids.js";
import { validateDecisions } from "./decisions.js";
import { resolveRef } from "./documents.js";
import { stableSort } from "./hash.js";
import type { DocIndex, RelDecisionDoc } from "../types.js";

export interface AcceptedDecision {
  id: string;
  type: string;
  resolvedSource: string;
  resolvedTarget: string;
  directional: boolean;
  provenance: string | null;
  priority: number | null;
}

export interface OrphanedDecision {
  id: string;
  type: string;
  source: string;
  target: string;
  decision: string;
}

export interface IngestedDecisions {
  accepted: AcceptedDecision[];
  rejectedIds: Set<string>;
  rejectAllPairs: Set<string>;
  orphaned: OrphanedDecision[];
  rejectedCount: number;
  decisions: RelDecisionDoc;
}

export function ingestDecisions(decisions: unknown, docIndex: DocIndex): IngestedDecisions {
  const loaded = validateDecisions(decisions);
  const accepted: AcceptedDecision[] = [];
  const orphaned: OrphanedDecision[] = [];
  const rejectedIds = new Set<string>();
  const rejectAllPairs = new Set<string>();
  let rejectedCount = 0;

  for (const item of loaded.relationships) {
    const src = resolveRef(item.source, docIndex);
    const tgt = resolveRef(item.target, docIndex);
    if (!src || !tgt) {
      orphaned.push({
        id: item.id,
        type: item.type,
        source: item.source,
        target: item.target,
        decision: item.decision,
      });
      continue;
    }

    const id = relationshipId(item.type, src.id, tgt.id, { directional: item.directional });
    if (item.decision === "reject") {
      rejectedCount += 1;
      if (item.type === "*") {
        rejectAllPairs.add(pairKey(src.id, tgt.id));
        rejectAllPairs.add(pairKey(tgt.id, src.id));
      } else {
        rejectedIds.add(id);
      }
      continue;
    }

    if (item.decision === "accept") {
      accepted.push({
        id,
        type: item.type,
        resolvedSource: src.id,
        resolvedTarget: tgt.id,
        directional: item.directional,
        provenance: item.provenance,
        priority: item.priority,
      });
    }
  }

  return {
    accepted: stableSort(accepted, (row) => row.id),
    rejectedIds,
    rejectAllPairs,
    orphaned: stableSort(orphaned, (row) => row.id),
    rejectedCount,
    decisions: loaded,
  };
}
