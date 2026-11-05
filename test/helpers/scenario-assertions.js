/**
 * Executable Software.Land scenario assertions.
 * Unsupported fields and assertion-free rows throw. They are not skipped.
 */
import {
  evaluateHistoricalRelevance,
  formatHistoricalRelevanceFailure,
} from "../historical-relevance.js";

const ALLOWED_FIELDS = new Set([
  "query",
  "name",
  "kind",
  "origin",
  "classification",
  "exactFirst",
  "exactFirstId",
  "requiredWithin",
  "requiredAnyWithin",
  "requiredAnyTop",
  "titlePrefix",
  "titlePrefixTopN",
  "mustNotDominate",
  "requiredRelatedAny",
  "relationship",
  "ambiguousExactFirstKeys",
  "resultCollector",
  "absentWithin",
  "precedes",
  "requiredDocuments",
]);

function fail(message) {
  throw new Error(message);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function extraKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function assertTitleList(value, label) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item)) {
    fail(`${label} must be a non-empty list of titles`);
  }
}

function assertTopN(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer`);
}

function assertWindow(value, label, { allowIds = false } = {}) {
  assertPlainObject(value, label);
  const allowed = allowIds ? ["titles", "topN", "ids"] : ["titles", "topN"];
  const extra = extraKeys(value, allowed);
  if (extra.length) fail(`${label} has unsupported fields: ${extra.join(", ")}`);
  assertTitleList(value.titles, `${label}.titles`);
  assertTopN(value.topN, `${label}.topN`);
  if (value.ids !== undefined) assertTitleList(value.ids, `${label}.ids`);
}

function hasExecutableAssertion(row) {
  return Boolean(
    row.exactFirst
    || row.exactFirstId
    || (Array.isArray(row.requiredWithin) && row.requiredWithin.length)
    || (Array.isArray(row.requiredAnyWithin) && row.requiredAnyWithin.length)
    || row.requiredAnyTop
    || row.titlePrefix
    || row.mustNotDominate
    || row.requiredRelatedAny
    || row.relationship
    || row.absentWithin
    || (Array.isArray(row.precedes) && row.precedes.length)
    || (Array.isArray(row.requiredDocuments) && row.requiredDocuments.length)
    || (Array.isArray(row.ambiguousExactFirstKeys) && row.ambiguousExactFirstKeys.length)
  );
}

export function validateExportedScenario(row) {
  assertPlainObject(row, "Scenario assertion");
  for (const key of Object.keys(row)) {
    if (!ALLOWED_FIELDS.has(key)) fail(`Unsupported assertion field ${JSON.stringify(key)}`);
  }
  if (typeof row.query !== "string" || !row.query) fail("Scenario assertion requires a query");
  if (row.mustNotDominate !== undefined) {
    assertPlainObject(row.mustNotDominate, "mustNotDominate");
    const extra = extraKeys(row.mustNotDominate, ["primary", "titles"]);
    if (extra.length) fail(`mustNotDominate has unsupported fields: ${extra.join(", ")}`);
    if (typeof row.mustNotDominate.primary !== "string" || !row.mustNotDominate.primary) {
      fail("mustNotDominate.primary is required");
    }
    assertTitleList(row.mustNotDominate.titles, "mustNotDominate.titles");
  }
  if (row.absentWithin !== undefined) assertWindow(row.absentWithin, "absentWithin");
  if (row.precedes !== undefined) {
    if (!Array.isArray(row.precedes) || !row.precedes.length) fail("precedes must be a non-empty array");
    row.precedes.forEach((pair, index) => {
      assertPlainObject(pair, `precedes[${index}]`);
      const extra = extraKeys(pair, ["earlier", "later", "topN", "whenLaterVisible"]);
      if (extra.length) fail(`precedes[${index}] has unsupported fields: ${extra.join(", ")}`);
      if (typeof pair.earlier !== "string" || !pair.earlier || typeof pair.later !== "string" || !pair.later) {
        fail(`precedes[${index}] requires earlier and later titles`);
      }
      if (pair.whenLaterVisible !== undefined && pair.whenLaterVisible !== true) {
        fail(`precedes[${index}].whenLaterVisible must be true when present`);
      }
      assertTopN(pair.topN, `precedes[${index}].topN`);
    });
  }
  if (row.requiredDocuments !== undefined) {
    if (!Array.isArray(row.requiredDocuments) || !row.requiredDocuments.length) {
      fail("requiredDocuments must be a non-empty array");
    }
    row.requiredDocuments.forEach((doc, index) => {
      assertPlainObject(doc, `requiredDocuments[${index}]`);
      const extra = extraKeys(doc, ["id", "title", "topN"]);
      if (extra.length) fail(`requiredDocuments[${index}] has unsupported fields: ${extra.join(", ")}`);
      if (typeof doc.id !== "string" || !doc.id || typeof doc.title !== "string" || !doc.title) {
        fail(`requiredDocuments[${index}] requires id and title`);
      }
      assertTopN(doc.topN, `requiredDocuments[${index}].topN`);
    });
  }
  if (row.requiredAnyTop !== undefined) assertWindow(row.requiredAnyTop, "requiredAnyTop", { allowIds: true });
  if (row.requiredWithin !== undefined) {
    if (!Array.isArray(row.requiredWithin)) fail("requiredWithin must be an array");
    row.requiredWithin.forEach((item, index) => {
      assertPlainObject(item, `requiredWithin[${index}]`);
      const extra = extraKeys(item, ["title", "topN", "id"]);
      if (extra.length) fail(`requiredWithin[${index}] has unsupported fields: ${extra.join(", ")}`);
      if (typeof item.title !== "string" || !item.title) fail(`requiredWithin[${index}] requires a title`);
      assertTopN(item.topN, `requiredWithin[${index}].topN`);
      if (item.id !== undefined && (typeof item.id !== "string" || !item.id)) {
        fail(`requiredWithin[${index}].id must be a string`);
      }
    });
  }
  if (row.requiredAnyWithin !== undefined) {
    if (!Array.isArray(row.requiredAnyWithin)) fail("requiredAnyWithin must be an array");
    row.requiredAnyWithin.forEach((item, index) => {
      assertPlainObject(item, `requiredAnyWithin[${index}]`);
      const extra = extraKeys(item, ["title", "topN"]);
      if (extra.length) fail(`requiredAnyWithin[${index}] has unsupported fields: ${extra.join(", ")}`);
      if (typeof item.title !== "string" || !item.title) fail(`requiredAnyWithin[${index}] requires a title`);
      assertTopN(item.topN, `requiredAnyWithin[${index}].topN`);
    });
  }
  if (row.requiredRelatedAny !== undefined) {
    assertPlainObject(row.requiredRelatedAny, "requiredRelatedAny");
    const extra = extraKeys(row.requiredRelatedAny, ["titles", "topN", "minCount"]);
    if (extra.length) fail(`requiredRelatedAny has unsupported fields: ${extra.join(", ")}`);
    assertTitleList(row.requiredRelatedAny.titles, "requiredRelatedAny.titles");
    assertTopN(row.requiredRelatedAny.topN, "requiredRelatedAny.topN");
    assertTopN(row.requiredRelatedAny.minCount, "requiredRelatedAny.minCount");
  }
  if (row.relationship !== undefined) {
    assertPlainObject(row.relationship, "relationship");
    for (const key of ["title", "relevanceKind", "type", "provenance", "sourceTitle"]) {
      if (typeof row.relationship[key] !== "string" || !row.relationship[key]) {
        fail(`relationship.${key} is required`);
      }
    }
    const extra = extraKeys(row.relationship, ["title", "relevanceKind", "type", "provenance", "sourceTitle"]);
    if (extra.length) fail(`relationship has unsupported fields: ${extra.join(", ")}`);
  }
  if (row.ambiguousExactFirstKeys !== undefined) {
    assertTitleList(row.ambiguousExactFirstKeys, "ambiguousExactFirstKeys");
  }
  if (row.resultCollector !== undefined && (typeof row.resultCollector !== "string" || !row.resultCollector)) {
    fail("resultCollector must be a non-empty string");
  }
  if (row.titlePrefix !== undefined && (typeof row.titlePrefix !== "string" || !row.titlePrefix)) {
    fail("titlePrefix must be a non-empty string");
  }
  if (row.titlePrefixTopN !== undefined) assertTopN(row.titlePrefixTopN, "titlePrefixTopN");
  if (row.exactFirst !== undefined && (typeof row.exactFirst !== "string" || !row.exactFirst)) {
    fail("exactFirst must be a title");
  }
  if (row.exactFirstId !== undefined && (typeof row.exactFirstId !== "string" || !row.exactFirstId)) {
    fail("exactFirstId must be a document id");
  }
  if (!hasExecutableAssertion(row)) {
    fail(`Assertion-free row is not executable coverage: ${JSON.stringify(row.query)}`);
  }
}

function titlesOf(results) {
  return (Array.isArray(results) ? results : []).map((hit) => hit?.title);
}

export function assertExportedScenario(results, row) {
  validateExportedScenario(row);
  const hits = Array.isArray(results) ? results : [];
  const titles = titlesOf(hits);
  if (row.exactFirst && titles[0] !== row.exactFirst) {
    fail(`Expected ${JSON.stringify(row.exactFirst)} first for ${JSON.stringify(row.query)}, got ${JSON.stringify(titles[0] || null)}`);
  }
  if (row.exactFirstId && hits[0]?.id !== row.exactFirstId) {
    fail(`Expected document ${JSON.stringify(row.exactFirstId)} first for ${JSON.stringify(row.query)}`);
  }
  for (const req of row.requiredWithin || []) {
    const idx = req.id ? hits.findIndex((hit) => hit?.id === req.id) : titles.indexOf(req.title);
    if (idx < 0 || idx + 1 > req.topN) {
      fail(`Missing required article ${JSON.stringify(req.title)} within the top ${req.topN} for ${JSON.stringify(row.query)}`);
    }
    if (req.id && hits[idx]?.title !== req.title) {
      fail(`Document ${JSON.stringify(req.id)} has title ${JSON.stringify(hits[idx]?.title || null)}, expected ${JSON.stringify(req.title)}`);
    }
  }
  for (const req of row.requiredAnyWithin || []) {
    const idx = titles.indexOf(req.title);
    if (idx < 0 || idx + 1 > req.topN) {
      fail(`Missing required article ${JSON.stringify(req.title)} within the top ${req.topN} for ${JSON.stringify(row.query)}`);
    }
  }
  if (row.requiredAnyTop) {
    const windowHits = hits.slice(0, row.requiredAnyTop.topN);
    const window = windowHits.map((hit) => hit?.title);
    for (const title of row.requiredAnyTop.titles) {
      if (!window.includes(title)) {
        fail(`Missing required article ${JSON.stringify(title)} within the top ${row.requiredAnyTop.topN} for ${JSON.stringify(row.query)}`);
      }
    }
    for (const id of row.requiredAnyTop.ids || []) {
      if (!windowHits.some((hit) => hit?.id === id)) {
        fail(`Missing required document ${JSON.stringify(id)} within the top ${row.requiredAnyTop.topN} for ${JSON.stringify(row.query)}`);
      }
    }
  }
  if (row.titlePrefix) {
    const topN = row.titlePrefixTopN ?? 10;
    const window = titles.slice(0, topN);
    if (!window.length || window.some((title) => !String(title || "").startsWith(row.titlePrefix))) {
      fail(`Expected titles starting with ${JSON.stringify(row.titlePrefix)} within the top ${topN} for ${JSON.stringify(row.query)}`);
    }
  }
  if (row.mustNotDominate) {
    const primaryIdx = titles.indexOf(row.mustNotDominate.primary);
    if (primaryIdx < 0) {
      fail(`Comparison target ${JSON.stringify(row.mustNotDominate.primary)} was not visible for ${JSON.stringify(row.query)}`);
    }
    for (const forbidden of row.mustNotDominate.titles) {
      const idx = titles.indexOf(forbidden);
      if (idx >= 0 && idx <= primaryIdx) {
        fail(`${forbidden} must not dominate ${row.mustNotDominate.primary}`);
      }
    }
  }
  if (row.absentWithin) {
    const window = titles.slice(0, row.absentWithin.topN);
    for (const title of row.absentWithin.titles) {
      if (window.includes(title)) {
        fail(`${title} must stay outside the top ${row.absentWithin.topN} for ${JSON.stringify(row.query)}`);
      }
    }
  }
  if (row.precedes) {
    for (const pair of row.precedes) {
      const window = titles.slice(0, pair.topN);
      const earlierAt = window.indexOf(pair.earlier);
      const laterAt = window.indexOf(pair.later);
      if (earlierAt < 0 || (laterAt >= 0 && earlierAt >= laterAt) || (laterAt < 0 && pair.whenLaterVisible !== true)) {
        fail(`${pair.earlier} must precede ${pair.later} within the top ${pair.topN} for ${JSON.stringify(row.query)}`);
      }
    }
  }
  if (row.requiredDocuments) {
    for (const doc of row.requiredDocuments) {
      const hit = hits.slice(0, doc.topN).find((item) => item?.id === doc.id);
      if (!hit || hit.title !== doc.title) {
        fail(`Missing required document ${doc.id} (${doc.title}) within the top ${doc.topN} for ${JSON.stringify(row.query)}`);
      }
    }
  }
  if (row.requiredRelatedAny) {
    const window = titles.slice(0, row.requiredRelatedAny.topN);
    const matched = row.requiredRelatedAny.titles.filter((title) => window.includes(title));
    if (matched.length < row.requiredRelatedAny.minCount) {
      fail(`Missing required related articles within the top ${row.requiredRelatedAny.topN} for ${JSON.stringify(row.query)}`);
    }
  }
}

function requireOne(rows, predicate, label) {
  const matches = (Array.isArray(rows) ? rows : []).filter(predicate);
  if (matches.length !== 1) fail(`${label} (${matches.length} matches)`);
  return matches[0];
}

function browserTitleIdRows(actual) {
  const titles = actual?.titles;
  const ids = actual?.ids;
  if (!Array.isArray(titles) || !Array.isArray(ids) || titles.length !== ids.length) {
    fail("sharde browser result does not have aligned title and id rows");
  }
  return titles.map((title, index) => ({ title, id: ids[index] }));
}

/**
 * Explained `sharde` control. Historical rows 136 and 140 supply membership.
 * The strict scenario supplies Sharding first, Hot Shards within two, and
 * Throughput vs Latency within ten. Missing fixture rows throw.
 */
export function assertExplainedShardeControl(actual, historicalRows, strictCases) {
  for (const index of [136, 140]) {
    const row = requireOne(
      historicalRows,
      (item) => item?.index === index && item?.query === "sharde",
      `historical sharde row ${index} is missing`
    );
    const evaluation = evaluateHistoricalRelevance(row, actual?.titles || []);
    if (!evaluation.ok) fail(formatHistoricalRelevanceFailure(evaluation));
  }
  const strict = requireOne(
    strictCases,
    (item) => item?.query === "sharde" && item?.origin === "scenario",
    "strict sharde scenario is missing"
  );
  assertExportedScenario(browserTitleIdRows(actual), strict);
}
