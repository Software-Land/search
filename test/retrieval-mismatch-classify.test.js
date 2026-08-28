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
    expect(cause(["exact-title"])).toBe("exact-title path");
    expect(cause(["configured-concept"])).toBe("configured-concept path");
    expect(cause(["equivalent-recall"])).toBe("equivalent-recall path");
    expect(cause(["standalone-recall"])).toBe("standalone-recall path");
    expect(cause(["topical-recall"])).toBe("topical-recall path");
    expect(cause(["relationship"])).toBe("relationship path");
  });

  test("keeps configured identity ahead of equivalent and related recall", () => {
    expect(cause(["configured-concept", "equivalent-recall", "standalone-recall", "topical-recall"])).toBe(
      "configured-concept path"
    );
    expect(cause(["equivalent-recall", "standalone-recall", "topical-recall"])).toBe("equivalent-recall path");
    expect(cause(["standalone-recall", "topical-recall"])).toBe("standalone-recall path");
  });

  test("keeps exact-title ahead of co-occurring lexical and relationship sources", () => {
    expect(cause(["exact-title", "title-token", "title-prefix"])).toBe("exact-title path");
    expect(cause(["exact-title", "relationship"])).toBe("exact-title path");
    expect(cause(["title-token", "relationship"])).toBe("title-token posting / prefix semantics");
    expect(cause(["contextual-title-prefix", "relationship"])).toBe("contextual prefix");
  });
});
