/**
 * Diagnostic-only: classifyMismatch labels for public retrievalSources.
 * Does not change search ranking or the frozen query-result oracle.
 */
import { classifyMismatch } from "../scripts/compare-retrieval-modes.mjs";

function cause(sources, extra = []) {
  return classifyMismatch({
    missing: ["Missing Title"],
    extra,
    missingSources: [sources],
    extraSources: extra.length ? [["indexed-lexical"]] : [],
  });
}

describe("retrieval mismatch diagnostic labels", () => {
  test("maps public retrieval sources to distinct diagnostic paths", () => {
    expect(cause(["configured-concept"])).toBe("configured-concept path");
    expect(cause(["equivalent-recall"])).toBe("equivalent-recall path");
    expect(cause(["standalone-recall"])).toBe("standalone-recall path");
    expect(cause(["topical-recall"])).toBe("topical-recall path");
  });

  test("keeps configured identity ahead of equivalent and related recall", () => {
    expect(cause(["configured-concept", "equivalent-recall", "standalone-recall", "topical-recall"])).toBe(
      "configured-concept path"
    );
    expect(cause(["equivalent-recall", "standalone-recall", "topical-recall"])).toBe("equivalent-recall path");
    expect(cause(["standalone-recall", "topical-recall"])).toBe("standalone-recall path");
  });
});
