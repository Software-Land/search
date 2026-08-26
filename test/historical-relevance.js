/**
 * Software.Land historical expectedTop / titlePrefix semantics.
 * Mirrors tests/search-e2e-result-helpers.js membership-within-topN.
 * expectedTop is normalized title identity within first min(topN, 10).
 * titlePrefix remains prefix-specific. Not Core default ranking policy.
 */

export const HISTORICAL_RENDERED_LIMIT = 10;

export function normaliseHistoricalTitle(str) {
  return String(str || "")
    .replace(/\u200B/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function historicalExpectation(row) {
  return row?.v1 && typeof row.v1 === "object" ? row.v1 : {};
}

export function isHistoricalRelevanceApplicable(row) {
  if (String(row?.classification || "").trim().toUpperCase() === "C") return false;
  const historical = historicalExpectation(row);
  if (historical.titlePrefix) return true;
  return Array.isArray(historical.expectedTop) && historical.expectedTop.length > 0;
}

function titleMatches(haystack, needle) {
  return normaliseHistoricalTitle(haystack) === normaliseHistoricalTitle(needle);
}

function classifyMissingTitle(title, allTitles, topN) {
  const rank = allTitles.findIndex((got) => titleMatches(got, title));
  if (rank === -1) return { title, kind: "not-retrieved" };
  if (topN === 1 && rank !== 0) {
    return { title, kind: "primary-not-first", rank: rank + 1 };
  }
  return { title, kind: "outside-topN", rank: rank + 1 };
}

export function evaluateHistoricalRelevance(row, titles) {
  const historical = historicalExpectation(row);
  const allTitles = Array.isArray(titles) ? titles.map((title) => String(title || "")) : [];
  const rendered = allTitles.slice(0, HISTORICAL_RENDERED_LIMIT);

  if (historical.titlePrefix) {
    const topN = historical.topN ?? 5;
    const window = rendered.slice(0, topN);
    const prefix = normaliseHistoricalTitle(historical.titlePrefix);
    const mismatches = window.filter((title) => !normaliseHistoricalTitle(title).startsWith(prefix));
    const ok = window.length > 0 && mismatches.length === 0;
    return {
      ok,
      query: row.query,
      index: row.index,
      expected: { titlePrefix: historical.titlePrefix, topN },
      missing: mismatches,
      window,
      kinds: ok ? [] : ["titlePrefix"],
    };
  }

  const expectedTitles = Array.isArray(historical.expectedTop) ? historical.expectedTop : [];
  const topN = historical.topN ?? 5;
  const window = rendered.slice(0, topN);
  const missing = expectedTitles.filter(
    (title) => !window.some((got) => titleMatches(got, title))
  );
  const ok = missing.length === 0 && window.length >= expectedTitles.length;
  const missingDetails = missing.map((title) => classifyMissingTitle(title, allTitles, topN));
  const kinds = [...new Set(missingDetails.map((item) => item.kind))];
  if (!ok && !kinds.length) kinds.push("outside-topN");
  return {
    ok,
    query: row.query,
    index: row.index,
    expected: { expectedTop: expectedTitles, topN },
    missing,
    missingDetails,
    window,
    kinds: ok ? [] : kinds,
  };
}

export function formatHistoricalRelevanceFailure(evaluation) {
  const expected = evaluation.expected || {};
  const lines = [
    `historical relevance failed for query ${JSON.stringify(evaluation.query)} (row ${evaluation.index})`,
    expected.titlePrefix
      ? `expected titlePrefix ${JSON.stringify(expected.titlePrefix)} topN ${expected.topN}`
      : `expectedTop ${JSON.stringify(expected.expectedTop)} topN ${expected.topN}`,
    `missing ${JSON.stringify(evaluation.missing)}`,
    `window ${JSON.stringify(evaluation.window)}`,
    evaluation.kinds?.length ? `kinds ${evaluation.kinds.join(",")}` : null,
    evaluation.missingDetails?.length ? `details ${JSON.stringify(evaluation.missingDetails)}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}
