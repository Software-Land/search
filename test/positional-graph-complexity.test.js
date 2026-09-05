/**
 * Token-DAG execution is automaton-style: O(V * L * E), not O(paths).
 */
import { emptyExecutionStats, matchTokenGraphFrequency } from "../dist/retrieval/positionalQueries.js";

function diamondGraph(diamonds, { deadEnd = false } = {}) {
  let length = diamonds * 2;
  const edgesFrom = Array.from({ length: length + 2 }, () => []);
  for (let i = 0; i < diamonds; i++) {
    const a = i * 2;
    const mid = a + 1;
    const b = a + 2;
    edgesFrom[a].push({ to: mid, tokens: ["a"] });
    edgesFrom[mid].push({ to: b, tokens: ["a"] });
    edgesFrom[a].push({ to: b, tokens: ["a", "a"] });
  }
  if (deadEnd) {
    edgesFrom[length].push({ to: length + 1, tokens: ["z"] });
    length += 1;
  }
  return { length, edgesFrom };
}

describe("token-DAG execution complexity", () => {
  test("converging prefixes share a suffix cell when both branches are forced", () => {
    const graph = diamondGraph(2, { deadEnd: true });
    const stats = emptyExecutionStats();
    const freq = matchTokenGraphFrequency(["a", "a", "a", "a"], graph, false, stats);
    expect(freq).toBe(0);
    expect(stats.graphDedupHits).toBeGreaterThan(0);
    expect(stats.graphStatesVisited).toBeLessThan(40);
  });

  test("20 overlapping diamonds stay polynomial, not 2^20 path enumeration", () => {
    const diamonds = 20;
    const graph = diamondGraph(diamonds, { deadEnd: true });
    const tokens = Array.from({ length: diamonds * 2 }, () => "a");
    const stats = emptyExecutionStats();
    const freq = matchTokenGraphFrequency(tokens, graph, false, stats);
    expect(freq).toBe(0);
    const enumeratedPaths = 2 ** diamonds;
    const work = stats.graphStatesVisited + stats.graphDedupHits;
    expect(work).toBeLessThan(enumeratedPaths / 100);
    expect(stats.graphStatesVisited).toBeLessThanOrEqual((graph.length + 1) * (tokens.length + 1));
    expect(stats.graphDedupHits).toBeGreaterThan(diamonds);
  });
});
