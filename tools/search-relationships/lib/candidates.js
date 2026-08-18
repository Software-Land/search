/**
 * Conservative relationship candidates only.
 * Co-occurrence is never sufficient. Content links / declared metadata are.
 */

import { relationshipId } from "./ids.js";
import { ALLOWED_TYPES } from "./types.js";
import { resolveRef } from "./documents.js";
import { stableSort } from "./hash.js";

const INTERNAL_LINK = /\[([^\]]+)\]\((\/[^)\s#]+)(?:#[^)]*)?\)/g;

/** @param {unknown} path */
function isSkippablePath(path) {
  const p = String(path || "").toLowerCase();
  if (!p.startsWith("/")) return true;
  if (p.startsWith("/glossary")) return true;
  if (p.startsWith("http")) return true;
  return false;
}

/**
 * Portable miner: markdown body links + document.metadata.links / category / prerequisite.
 * @param {import("../types.js").RelDocument[]} documents
 * @param {import("../types.js").DocIndex} docIndex
 * @returns {import("../types.js").RelCandidate[]}
 */
export function mineRelationshipCandidates(documents, docIndex) {
  /** @type {import("../types.js").RelCandidate[]} */
  const out = [];
  const seen = new Set();

  /** @param {import("../types.js").RelCandidate} row */
  function push(row) {
    if (!ALLOWED_TYPES.has(row.type)) return;
    if (!row.source || !row.target || row.source === row.target) return;
    const id = relationshipId(row.type, row.source, row.target, { directional: row.directional });
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ ...row, id });
  }

  for (const doc of documents) {
    INTERNAL_LINK.lastIndex = 0;
    let m;
    const body = String(doc.body || "");
    while ((m = INTERNAL_LINK.exec(body))) {
      const href = m[2];
      if (isSkippablePath(href)) continue;
      const target = resolveRef(href, docIndex);
      if (!target || target.id === doc.id) continue;
      push({
        type: "editorial",
        source: doc.id,
        target: target.id,
        directional: false,
        status: "review",
        evidence: { contentLinks: 1 },
        reasons: ["explicit content cross-reference"],
        provenance: [{ type: "content-link", snippet: m[0].slice(0, 160) }],
      });
    }

    const links = Array.isArray(doc.metadata?.links) ? doc.metadata.links : [];
    for (const link of links) {
      const rec = /** @type {Record<string, unknown>} */ (link && typeof link === "object" ? link : { target: link });
      const target = resolveRef(rec.target || rec.targetId || link, docIndex);
      if (!target || target.id === doc.id) continue;
      const linkType = typeof rec.type === "string" ? rec.type : "";
      push({
        type: linkType && ALLOWED_TYPES.has(linkType) ? linkType : "editorial",
        source: doc.id,
        target: target.id,
        directional: Boolean(rec.directional),
        status: "review",
        evidence: { metadataLinks: 1 },
        reasons: ["declared metadata link"],
        provenance: [{ type: "metadata-link" }],
      });
    }

    const prereq = doc.metadata?.prerequisite || doc.metadata?.prerequisites;
    const prereqs = Array.isArray(prereq) ? prereq : prereq ? [prereq] : [];
    for (const p of prereqs) {
      const target = resolveRef(p, docIndex);
      if (!target || target.id === doc.id) continue;
      push({
        type: "prerequisite",
        source: doc.id,
        target: target.id,
        directional: true,
        status: "review",
        evidence: { declaredPrerequisite: 1 },
        reasons: ["declared prerequisite metadata"],
        provenance: [{ type: "prerequisite-config" }],
      });
    }

    const category = doc.metadata?.category;
    if (category) {
      for (const other of documents) {
        if (other.id === doc.id) continue;
        if (other.metadata?.category !== category) continue;
        if (other.id < doc.id) continue;
        push({
          type: "same-category",
          source: doc.id,
          target: other.id,
          directional: false,
          status: "review",
          evidence: { category },
          reasons: ["shared category metadata"],
          provenance: [{ type: "same-category-metadata" }],
        });
      }
    }
  }

  return stableSort(out, (c) => c.id || "");
}

/** @param {import("../types.js").RelCandidate} c */
export function bandForCandidate(c) {
  const e = c.evidence || {};
  if ((e.declaredPrerequisite || 0) >= 1) return "HIGH";
  if ((e.contentLinks || 0) >= 1) return "HIGH";
  if ((e.metadataLinks || 0) >= 1) return "MEDIUM";
  if (e.category) return "MEDIUM";
  return "LOW";
}

/** @param {import("../types.js").RelCandidate[]} rows */
export function annotateCandidates(rows) {
  return rows.map((c) => ({
    ...c,
    reviewBand: c.reviewBand || bandForCandidate(c),
    reviewContributions: c.reviewContributions || [
      { name: bandForCandidate(c) === "HIGH" ? "explicit-reference" : "metadata", weight: bandForCandidate(c) === "HIGH" ? 1 : 0 },
    ],
  }));
}
