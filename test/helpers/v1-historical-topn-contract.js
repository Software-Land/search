/**
 * V2 against the OSS-mirrored Software.Land V1 historical top-N contract
 * (query / expectedTop / topN). Software.Land tests/search-scenarios.js
 * scenario.v1 is the product source (224 rows). The OSS historical mirror is
 * the complete 223-row freeze excluding overlay-owned queries (currently `integ`).
 * This helper hashes that mirror so the two repos cannot silently diverge.
 * It does not run search.
 */
import { createHash } from "node:crypto";

export const V1_HISTORICAL_TOPN_CONTRACT_SHA256 =
  "435f0dd66b4e32806e6c5d515538e52338cfb1cb2a32f2f72f9b9d205a39429e";
export const V1_HISTORICAL_TOPN_INVENTORY_COUNT = 223;
export const V1_HISTORICAL_TOPN_ENFORCED_COUNT = 222;
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
