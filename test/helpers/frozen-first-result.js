/**
 * Historical query-result oracle #1, with the accepted 0.7.0 divergences.
 *
 * query-result-oracle.json stays the freeze. All 215 rows are still searched.
 * `open` still records Knowledge Graph (`br`). Live search must keep SAML vs
 * OAuth (id `7`) in the first 10 and does not require it first.
 * `institute standards` still records Software Engineer vs Software Developer
 * (`9`). Live search occupies `nist` and returns TLS 1.2 Vulnerability (`ai`)
 * first.
 * `quality ass` still records Functional vs Procedural (`O`). This helper runs
 * on the configured-concepts-only engine, which occupies `qa` and returns no
 * results. The authored-relevance contract, Load vs Stress Testing within the
 * first 2, stays in the historical suite.
 * The other 212 queries keep their frozen first-result id.
 */

export const OPEN_QUERY = "open";
export const OPEN_FROZEN_FIRST = {
  query: OPEN_QUERY,
  id: "br",
  title: "What is a Knowledge Graph?",
};
export const OPEN_ACCEPTED_CONTRACT = {
  query: OPEN_QUERY,
  id: "7",
  title: "SAML vs OAuth",
  withinFirst10: true,
};
const OPEN_TOP_N = 10;

export const INSTITUTE_STANDARDS_QUERY = "institute standards";
export const INSTITUTE_STANDARDS_FROZEN_FIRST = {
  query: INSTITUTE_STANDARDS_QUERY,
  id: "9",
  title: "Software Engineer vs Software Developer",
};
export const INSTITUTE_STANDARDS_ACCEPTED = {
  query: INSTITUTE_STANDARDS_QUERY,
  occupiedKey: "nist",
  id: "ai",
  title: "TLS 1.2 Vulnerability",
};

export const QUALITY_ASS_QUERY = "quality ass";
export const QUALITY_ASS_FROZEN_FIRST = {
  query: QUALITY_ASS_QUERY,
  id: "O",
  title: "Functional vs Procedural",
};
export const QUALITY_ASS_ACCEPTED = {
  query: QUALITY_ASS_QUERY,
  resultIds: [],
  candidateCount: 0,
};

const DIVERGENCE_QUERIES = new Set([
  OPEN_QUERY,
  INSTITUTE_STANDARDS_QUERY,
  QUALITY_ASS_QUERY,
]);

function frozenFirst(oracle, query) {
  const row = oracle.rows.find((item) => item.query === query);
  return {
    query: row?.query ?? null,
    id: row?.results[0]?.id ?? null,
    title: row?.results[0]?.title ?? null,
  };
}

export function summarizeFrozenFirstResults(engine, oracle) {
  const mismatches = [];
  for (const row of oracle.rows) {
    if (DIVERGENCE_QUERIES.has(row.query)) continue;
    const actual = engine.search(row.query, { limit: 1 })[0]?.id ?? null;
    const expected = row.results[0]?.id ?? null;
    if (actual !== expected) {
      mismatches.push({ query: row.query, expected, actual });
    }
  }
  const openHits = engine.search(OPEN_QUERY, { limit: OPEN_TOP_N });
  const acceptedOpen = openHits.find((hit) => hit.id === OPEN_ACCEPTED_CONTRACT.id);
  const institutePrepared = engine._prepareQuery(INSTITUTE_STANDARDS_QUERY);
  const instituteHit = engine.search(INSTITUTE_STANDARDS_QUERY, { limit: 1 })[0] ?? null;
  const quality = engine.searchDetailed(QUALITY_ASS_QUERY, { limit: 10 });
  return {
    rowCount: oracle.rows.length,
    frozenOpen: frozenFirst(oracle, OPEN_QUERY),
    frozenInstituteStandards: frozenFirst(oracle, INSTITUTE_STANDARDS_QUERY),
    frozenQualityAss: frozenFirst(oracle, QUALITY_ASS_QUERY),
    strictCount: oracle.rows.filter((row) => !DIVERGENCE_QUERIES.has(row.query)).length,
    mismatches,
    acceptedOpen: {
      query: OPEN_QUERY,
      id: acceptedOpen?.id ?? null,
      title: acceptedOpen?.title ?? null,
      withinFirst10: Boolean(acceptedOpen),
    },
    acceptedInstituteStandards: {
      query: INSTITUTE_STANDARDS_QUERY,
      occupiedKey: institutePrepared.configuredSequenceIntent?.key ?? null,
      id: instituteHit?.id ?? null,
      title: instituteHit?.title ?? null,
    },
    acceptedQualityAss: {
      query: QUALITY_ASS_QUERY,
      resultIds: quality.results.map((hit) => hit.id),
      candidateCount: quality.meta.candidateCount,
    },
  };
}

export const FROZEN_FIRST_RESULT_CONTRACT = {
  rowCount: 215,
  frozenOpen: OPEN_FROZEN_FIRST,
  frozenInstituteStandards: INSTITUTE_STANDARDS_FROZEN_FIRST,
  frozenQualityAss: QUALITY_ASS_FROZEN_FIRST,
  strictCount: 212,
  mismatches: [],
  acceptedOpen: OPEN_ACCEPTED_CONTRACT,
  acceptedInstituteStandards: INSTITUTE_STANDARDS_ACCEPTED,
  acceptedQualityAss: QUALITY_ASS_ACCEPTED,
};
