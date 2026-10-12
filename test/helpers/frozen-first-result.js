/**
 * Historical query-result oracle #1, with the accepted 0.7.0 exception.
 *
 * query-result-oracle.json stays the freeze. For `open` that freeze is
 * Knowledge Graph (`br`). Live 0.7.0 does not have to repeat that rank:
 * SAML vs OAuth (id `7`) must appear in the first 10 results. Every other
 * query keeps its frozen first-result id. Failure objects include the query.
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

export function summarizeFrozenFirstResults(engine, oracle) {
  const open = oracle.rows.find((row) => row.query === OPEN_QUERY);
  const mismatches = [];
  for (const row of oracle.rows) {
    if (row.query === OPEN_QUERY) continue;
    const actual = engine.search(row.query, { limit: 1 })[0]?.id ?? null;
    const expected = row.results[0]?.id ?? null;
    if (actual !== expected) {
      mismatches.push({ query: row.query, expected, actual });
    }
  }
  const hits = engine.search(OPEN_QUERY, { limit: OPEN_TOP_N });
  const accepted = hits.find((hit) => hit.id === OPEN_ACCEPTED_CONTRACT.id);
  return {
    frozenOpen: {
      query: open?.query ?? null,
      id: open?.results[0]?.id ?? null,
      title: open?.results[0]?.title ?? null,
    },
    otherCount: oracle.rows.filter((row) => row.query !== OPEN_QUERY).length,
    mismatches,
    acceptedOpen: {
      query: OPEN_QUERY,
      id: accepted?.id ?? null,
      title: accepted?.title ?? null,
      withinFirst10: Boolean(accepted),
    },
  };
}

export const FROZEN_FIRST_RESULT_CONTRACT = {
  frozenOpen: OPEN_FROZEN_FIRST,
  otherCount: 214,
  mismatches: [],
  acceptedOpen: OPEN_ACCEPTED_CONTRACT,
};
