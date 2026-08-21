import { expansionTokens, phraseKey, acronymKey, initialsMatch } from "./text.js";
import type { EquivalenceCandidate } from "../types.js";

function pairId(key: unknown, expansion: unknown): string {
  return `${acronymKey(key)}::${phraseKey(Array.isArray(expansion) ? expansion.map((t) => String(t)) : expansionTokens(expansion))}`;
}

export function loadOverrides(raw: unknown): {
  accept: Array<{ key?: unknown; expansion?: unknown; aliases?: unknown }>;
  reject: Array<{ key?: unknown; expansion?: unknown }>;
  add: Array<{ key?: unknown; expansion?: unknown; aliases?: unknown }>;
} {
  if (!raw || typeof raw !== "object") {
    return { accept: [], reject: [], add: [] };
  }
  const rec = raw as { accept?: unknown; reject?: unknown; add?: unknown };
  return {
    accept: Array.isArray(rec.accept) ? rec.accept : [],
    reject: Array.isArray(rec.reject) ? rec.reject : [],
    add: Array.isArray(rec.add) ? rec.add : [],
  };
}

/**
 * Manual truth outranks automatic inference. Conflicts are reported, never
 * silently overwritten.
 */
export function applyOverrides(candidates: EquivalenceCandidate[], overrides: unknown) {
  const cfg = loadOverrides(overrides);
  const conflicts: Array<Record<string, unknown>> = [];
  const byId = new Map<string, EquivalenceCandidate>(candidates.map((c) => [pairId(c.key, c.expansion), { ...c }]));

  for (const rej of cfg.reject) {
    const key = acronymKey(rej.key);
    const expansion = Array.isArray(rej.expansion) ? (rej.expansion as string[]) : expansionTokens(rej.expansion || "");
    if (expansion.length) {
      const id = pairId(key, expansion);
      if (byId.has(id)) {
        const row = byId.get(id);
        if (!row) continue;
        row.status = "rejected";
        row.decision = "manual-reject";
        row.reasons = [`manual reject`, ...(row.reasons || [])];
        row.override = "reject";
      }
    } else {
      for (const [, row] of byId) {
        if (row.key === key) {
          row.status = "rejected";
          row.decision = "manual-reject";
          row.reasons = [`manual reject key`, ...(row.reasons || [])];
          row.override = "reject";
        }
      }
    }
  }

  for (const acc of cfg.accept) {
    const key = acronymKey(acc.key);
    const expansion = Array.isArray(acc.expansion) ? (acc.expansion as string[]) : expansionTokens(acc.expansion || "");
    const id = pairId(key, expansion);
    const existing = byId.get(id);
    const others = [...byId.values()].filter((c) => c.key === key && pairId(c.key, c.expansion) !== id && c.status === "accepted");
    if (others.length) {
      conflicts.push({
        key,
        type: "manual-accept-vs-automatic-accepted",
        automatic: others.map((o) => o.expansionPhrase),
        manual: phraseKey(expansion),
      });
      for (const o of others) {
        o.status = "review";
        o.decision = "manual-conflict-demoted";
        o.reasons = [`demoted: manual expansion preferred`, ...(o.reasons || [])];
      }
    }
    if (existing) {
      if (existing.status === "accepted" && existing.expansionPhrase !== phraseKey(expansion)) {
        conflicts.push({ key, type: "expansion-mismatch", automatic: existing.expansionPhrase, manual: phraseKey(expansion) });
      }
      existing.status = "accepted";
      existing.decision = "manual-accept";
      existing.override = "accept";
      existing.reasons = [`manual accept`, ...(existing.reasons || [])];
    } else {
      byId.set(id, {
        type: "equivalence-candidate",
        key,
        expansion,
        expansionPhrase: phraseKey(expansion),
        status: "accepted",
        decision: "manual-accept",
        initialsMatch: initialsMatch(key, expansion),
        evidence: { explicitDefinitions: 0, titleCooccurrences: 0, bodyCooccurrences: 0, supportingDocuments: 0, provenances: ["manual-seed"] },
        reasons: ["manual accept"],
        provenance: [{ type: "manual-seed", documentId: null, field: null, snippet: null }],
        override: "accept",
      });
    }
  }

  for (const add of cfg.add) {
    const key = acronymKey(add.key);
    const expansion = Array.isArray(add.expansion) ? (add.expansion as string[]) : expansionTokens(add.expansion || "");
    const id = pairId(key, expansion);
    const aliases = Array.isArray(add.aliases) ? add.aliases : [];
    byId.set(id, {
      type: "equivalence-candidate",
      key,
      expansion,
      expansionPhrase: phraseKey(expansion),
      aliases,
      status: "accepted",
      decision: "manual-add",
      initialsMatch: initialsMatch(key, expansion),
      evidence: { explicitDefinitions: 0, titleCooccurrences: 0, bodyCooccurrences: 0, supportingDocuments: 0, provenances: ["manual-seed"] },
      reasons: ["manual addition"],
      provenance: [{ type: "manual-seed", documentId: null, field: null, snippet: null }],
      override: "add",
    });
  }

  return { candidates: [...byId.values()], conflicts };
}
