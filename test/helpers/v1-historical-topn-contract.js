/**
 * Checked-in historical V1 top-N membership contract (query / expectedTop / topN,
 * plus optional within). "V1" names that historical expectation generation.
 * Artifact schema version is the integer `version` field on a serialized artifact.
 * The historical mirror is the 215-row source snapshot in
 * this package, excluding overlay-owned queries (currently `integ`). This helper
 * hashes that mirror. It does not run search.
 */
import { createHash } from "node:crypto";

export const V1_HISTORICAL_TOPN_CONTRACT_SHA256 =
  "59561f315e944172ab83852f3762be29b00bfa4b96a6163c781f1a0f4d309632";
export const V1_HISTORICAL_TOPN_INVENTORY_COUNT = 215;
export const V1_HISTORICAL_TOPN_ENFORCED_COUNT = 214;
export const V1_HISTORICAL_TOPN_OBSOLETE_QUERY = "open";

export function historicalV1Fields(row) {
  return row?.v1 && typeof row.v1 === "object" ? row.v1 : {};
}

export function normalizeV1HistoricalTopNRow(row, index) {
  const v1 = historicalV1Fields(row);
  const normalized = {
    index: Number.isInteger(row?.index) ? row.index : index,
    query: String(row?.query ?? ""),
    expectedTop: Array.isArray(v1.expectedTop) ? v1.expectedTop.map((title) => String(title)) : null,
    titlePrefix: v1.titlePrefix ? String(v1.titlePrefix) : null,
    topN: v1.topN ?? 5,
  };
  if (Array.isArray(v1.within) && v1.within.length) {
    normalized.within = v1.within.map((entry) => ({
      title: String(entry.title),
      topN: entry.topN ?? 10,
    }));
  }
  return normalized;
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
