/**
 * Canonical V1 E2E historical top-N contract (query / expectedTop / topN).
 * Software.Land tests/search-scenarios.js scenario.v1 is the source of truth.
 * This helper freezes the OSS mirror and hashes it so the two repos cannot
 * silently diverge. It does not run search.
 */
import { createHash } from "node:crypto";

export const V1_HISTORICAL_TOPN_CONTRACT_SHA256 =
  "fb1dc6c27d6f3b961e3c86954193267f9613d7403efff87f2a29cf426190c511";
export const V1_HISTORICAL_TOPN_INVENTORY_COUNT = 215;
export const V1_HISTORICAL_TOPN_ENFORCED_COUNT = 214;
export const V1_HISTORICAL_TOPN_OBSOLETE_QUERY = "open";

export function historicalV1Fields(row) {
  return row?.v1 && typeof row.v1 === "object" ? row.v1 : {};
}

export function normalizeV1HistoricalTopNRow(row, index) {
  const v1 = historicalV1Fields(row);
  return {
    index: Number.isInteger(row?.index) ? row.index : index,
    query: String(row?.query ?? ""),
    expectedTop: Array.isArray(v1.expectedTop) ? v1.expectedTop.map((title) => String(title)) : null,
    titlePrefix: v1.titlePrefix ? String(v1.titlePrefix) : null,
    topN: v1.topN ?? 5,
  };
}

export function classifyHistoricalScenario(row) {
  const raw = String(row?.classification || "").trim().toUpperCase();
  return raw === "B" || raw === "C" ? raw : "A";
}

export function isEnforcedV1HistoricalTopNRow(row) {
  return classifyHistoricalScenario(row) !== "C";
}

export function enforcedV1HistoricalTopNRows(inventoryRows) {
  return (inventoryRows || [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isEnforcedV1HistoricalTopNRow(row))
    .map(({ row, index }) => normalizeV1HistoricalTopNRow(row, index));
}

export function hashV1HistoricalTopNRows(rows) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
