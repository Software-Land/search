import {
  compileCorpus,
  LIFECYCLE,
  normalizeExternalEquivalences,
  classifyExpansionRelation,
  ExternalEquivalenceError,
} from "../tools/search-corpus/index.js";
import { acronymKey, expansionTokens } from "../tools/search-corpus/lib/text.js";

describe("normalizeExternalEquivalences", () => {
  test("normalizes key/expansion, aliases, primary, and sorts deterministically", () => {
    const result = normalizeExternalEquivalences([
      {
        key: "ML",
        expansion: "Machine Learning",
        aliases: [["ml"]],
        primary: "Learning",
        evidenceDocumentIds: ["b", "a"],
        provenance: "application-generated",
      },
      {
        key: "API",
        expansion: ["Application", "Programming", "Interface"],
        aliases: [["app", "programming", "interface"]],
        primary: "interface",
      },
    ]);
    expect(result.entries.map((e) => e.key)).toEqual(["api", "ml"]);
    expect(result.entries[0].expansion).toEqual(["application", "programming", "interface"]);
    expect(result.entries[0].aliases).toEqual([["app", "programming", "interface"]]);
    expect(result.entries[0].primary).toBe("interface");
    expect(result.entries[0].standaloneRecall).toEqual([]);
    expect(result.entries[1].expansion).toEqual(["machine", "learning"]);
    expect(result.entries[1].evidenceDocumentIds).toEqual(["a", "b"]);
    expect(result.entries[1].provenance).toBe("application-generated");
  });

  test("collapses duplicate key+expansion and merges evidence", () => {
    const result = normalizeExternalEquivalences([
      { key: "fps", expansion: "frames per second", evidenceDocumentIds: ["d1"] },
      { key: "FPS", expansion: ["frames", "per", "second"], evidenceDocumentIds: ["d2"], aliases: [["frame", "rate"]] },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].key).toBe("fps");
    expect(result.entries[0].evidenceDocumentIds).toEqual(["d1", "d2"]);
    expect(result.entries[0].aliases).toEqual([["frame", "rate"]]);
  });

  test("skips empty alias entries instead of rejecting the row", () => {
    const result = normalizeExternalEquivalences([
      { key: "fps", expansion: "frames per second", aliases: [[], [""], ["frame", "rate"]] },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].aliases).toEqual([["frame", "rate"]]);
  });

  test("skips expansions that tokenize to only function words", () => {
    const result = normalizeExternalEquivalences([
      { key: "fps", expansion: "frames per second" },
      { key: "i.e.", expansion: "that is" },
    ]);
    expect(result.entries.map((e) => e.key)).toEqual(["fps", "ie"]);
    expect(result.entries.find((e) => e.key === "ie").expansion).toEqual(["that", "is"]);
    expect(result.rejected).toEqual([]);
  });

  test("preserves leading not in Not Only SQL", () => {
    const result = normalizeExternalEquivalences([{ key: "NoSQL", expansion: "Not Only SQL" }]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].key).toBe("nosql");
    expect(result.entries[0].expansion).toEqual(["not", "only", "sql"]);
  });

  test("rejects empty key and empty expansion", () => {
    expect(() => normalizeExternalEquivalences([{ key: "", expansion: ["frames", "per", "second"] }])).toThrow(
      ExternalEquivalenceError
    );
    expect(() => normalizeExternalEquivalences([{ key: "fps", expansion: [] }])).toThrow(ExternalEquivalenceError);
    expect(() => normalizeExternalEquivalences([{ key: "fps", expansion: "   " }])).toThrow(ExternalEquivalenceError);
  });

  test("records legitimate same-key alternatives as unresolved ambiguity instead of deleting the key", () => {
    const result = normalizeExternalEquivalences([
      { key: "cd", expansion: "continuous deployment", evidenceDocumentIds: ["a"] },
      { key: "cd", expansion: "continuous delivery", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.unresolved).toEqual([
      {
        key: "cd",
        kind: "ambiguous",
        expansions: [
          ["continuous", "delivery"],
          ["continuous", "deployment"],
        ],
        evidenceDocumentIds: ["a", "b"],
        eligible: false,
      },
    ]);
    expect(result.reconciliations[0]).toMatchObject({ key: "cd", kind: "ambiguous", eligible: false });
  });

  test("non-strict mode records rejects and unresolved alternatives without throwing", () => {
    const result = normalizeExternalEquivalences(
      [
        { key: "", expansion: ["x"] },
        { key: "cd", expansion: "continuous deployment" },
        { key: "cd", expansion: "continuous delivery" },
      ],
      { strict: false }
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.unresolved.map((row) => row.key)).toEqual(["cd"]);
    expect(result.entries).toHaveLength(0);
  });

  test("collapses trivially compatible variants into one canonical expansion plus alias", () => {
    const result = normalizeExternalEquivalences([
      { key: "grpc", expansion: "grpc remote procedure calls", evidenceDocumentIds: ["a"] },
      { key: "grpc", expansion: "google remote procedure call", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.unresolved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    const row = result.entries[0];
    expect(row.key).toBe("grpc");
    expect(row.expansion).toEqual(["google", "remote", "procedure", "call"]);
    expect(row.aliases).toEqual([["grpc", "remote", "procedure", "calls"]]);
    expect(row.evidenceDocumentIds).toEqual(["a", "b"]);
    expect(result.reconciliations[0]).toMatchObject({ key: "grpc", kind: "compatible", eligible: true });
  });

  test("collapses punctuation and function-word compatible variants", () => {
    const result = normalizeExternalEquivalences([
      { key: "iot", expansion: "internet of things", evidenceDocumentIds: ["a"] },
      { key: "iot", expansion: "internet things", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].expansion).toEqual(["internet", "things"]);
    expect(result.entries[0].aliases).toEqual([["internet", "of", "things"]]);
  });

  test("collapses plural/singular compatible variants", () => {
    const result = normalizeExternalEquivalences([
      { key: "api", expansion: "application programming interface" },
      { key: "api", expansion: "application programming interfaces" },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.unresolved).toHaveLength(0);
    expect(result.entries[0].aliases.length).toBe(1);
  });

  test("keeps CI/CD delivery vs deployment as ambiguity, not an auto-unioned alias", () => {
    const result = normalizeExternalEquivalences([
      {
        key: "cicd",
        expansion: "continuous integration and continuous delivery",
        evidenceDocumentIds: ["doc-a"],
      },
      {
        key: "cicd",
        expansion: "continuous integration and continuous deployment",
        evidenceDocumentIds: ["doc-b"],
      },
    ]);
    expect(result.entries.find((row) => row.key === "cicd")).toBeUndefined();
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].kind).toBe("ambiguous");
    expect(result.unresolved[0].expansions).toEqual([
      ["continuous", "integration", "and", "continuous", "delivery"],
      ["continuous", "integration", "and", "continuous", "deployment"],
    ]);
    expect(result.reconciliations[0].aliases || []).toEqual([]);
  });

  test("records genuinely conflicting meanings as unresolved conflict, not an entry", () => {
    const result = normalizeExternalEquivalences([
      { key: "ts", expansion: "typescript", evidenceDocumentIds: ["a"] },
      { key: "ts", expansion: "timestamp", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.unresolved[0]).toMatchObject({ key: "ts", kind: "conflict", eligible: false });
    expect(result.conflicts).toHaveLength(1);
  });

  test("single-expansion rows marked ambiguous stay inspectable and not runtime-eligible", () => {
    const result = normalizeExternalEquivalences([
      {
        key: "rag",
        expansion: "retrieval augmented generation",
        ambiguous: true,
        alternatives: [{ expansion: "red amber green" }],
      },
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.unresolved[0]).toMatchObject({ key: "rag", kind: "ambiguous", eligible: false });
  });
});

describe("classifyExpansionRelation", () => {
  test("classifies identical, compatible, ambiguous, and conflicting pairs", () => {
    expect(classifyExpansionRelation("fps", "frames per second", ["frames", "per", "second"])).toBe("identical");
    expect(
      classifyExpansionRelation("grpc", "grpc remote procedure calls", "google remote procedure call")
    ).toBe("compatible");
    expect(
      classifyExpansionRelation(
        "cicd",
        "continuous integration and continuous delivery",
        "continuous integration and continuous deployment"
      )
    ).toBe("ambiguous");
    expect(classifyExpansionRelation("ts", "typescript", "timestamp")).toBe("conflict");
  });

  test("treats British/American spelling variants as compatible, not conflict", () => {
    expect(classifyExpansionRelation("ack", "acknowledgement", "acknowledgment")).toBe("compatible");
    expect(classifyExpansionRelation("ack", "acknowledgment", "acknowledgement")).toBe("compatible");
    expect(classifyExpansionRelation("en", "colour", "color")).toBe("compatible");
    expect(classifyExpansionRelation("en", "behaviour", "behavior")).toBe("compatible");
    expect(classifyExpansionRelation("opt", "optimisation", "optimization")).toBe("compatible");
  });

  test("treats conventional abbreviation plus shared content tokens as compatible", () => {
    expect(classifyExpansionRelation("techdebt", "tech debt", "technical debt")).toBe("compatible");
    expect(classifyExpansionRelation("techdebt", "technical debt", "tech debt")).toBe("compatible");
  });

  test("does not collapse distinct meanings as spelling or abbreviation variants", () => {
    expect(classifyExpansionRelation("auth", "authentication", "authorization")).toBe("conflict");
    expect(classifyExpansionRelation("dc", "data center", "divide and conquer")).toBe("conflict");
    expect(classifyExpansionRelation("dev", "developer", "development")).toBe("conflict");
    expect(classifyExpansionRelation("p99", "tail latency", "99th percentile")).toBe("conflict");
    expect(
      classifyExpansionRelation(
        "cicd",
        "continuous integration and continuous delivery",
        "continuous integration and continuous deployment"
      )
    ).toBe("ambiguous");
  });
});

describe("normalizeExternalEquivalences spelling and abbreviation compatibility", () => {
  test("collapses acknowledgement/acknowledgment into one eligible ack entry plus alias", () => {
    const result = normalizeExternalEquivalences([
      { key: "ack", expansion: "acknowledgement", evidenceDocumentIds: ["cf"] },
      { key: "ack", expansion: "acknowledgment", evidenceDocumentIds: ["r"] },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.unresolved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    const row = result.entries[0];
    expect(row.key).toBe("ack");
    expect(row.expansion).toEqual(["acknowledgement"]);
    expect(row.aliases).toEqual([["acknowledgment"]]);
    expect(row.evidenceDocumentIds).toEqual(["cf", "r"]);
    expect(result.reconciliations[0]).toMatchObject({ key: "ack", kind: "compatible", eligible: true });
  });

  test("does not destructively fold symbolic compact forms while keeping separator forms", () => {
    expect(acronymKey("A*")).toBe("");
    expect(acronymKey("C++")).toBe("");
    expect(acronymKey("C#")).toBe("");
    expect(acronymKey("O(1)")).toBe("");
    expect(acronymKey("CI/CD")).toBe("cicd");
    expect(acronymKey("TCP/IP")).toBe("tcpip");
    expect(acronymKey("i.e.")).toBe("ie");
    expect(acronymKey("APIs")).toBe("api");

    const result = normalizeExternalEquivalences(
      [
        { key: "A*", expansion: "a star search" },
        { key: "C++", expansion: "c plus plus" },
        { key: "C#", expansion: "c sharp" },
        { key: "O(1)", expansion: "constant time" },
        { key: "CI/CD", expansion: "continuous integration continuous deployment" },
        { key: "TCP/IP", expansion: "transmission control protocol internet protocol" },
      ],
      { strict: false }
    );
    expect(result.entries.map((row) => row.key).sort()).toEqual(["cicd", "tcpip"]);
    expect(result.entries.find((row) => row.key === "a")).toBeUndefined();
    expect(result.entries.find((row) => row.key === "c")).toBeUndefined();
    expect(result.entries.find((row) => row.key === "o1")).toBeUndefined();
    expect(result.rejected).toHaveLength(4);
    expect(result.rejected.every((row) => row.reason === "empty key")).toBe(true);
  });

  test("significant symbols in expansions become spoken tokens instead of disappearing", () => {
    expect(expansionTokens("C++")).toEqual(["c", "plus", "plus"]);
    expect(expansionTokens("C#")).toEqual(["c", "sharp"]);
    expect(expansionTokens("F#")).toEqual(["f", "sharp"]);
    expect(expansionTokens("A*")).toEqual(["a", "star"]);
    expect(expansionTokens("CI/CD")).toEqual(["ci", "cd"]);
    expect(expansionTokens("TCP/IP")).toEqual(["tcp", "ip"]);
    expect(expansionTokens("O(1)")).toEqual([]);
    expect(expansionTokens("O(n)")).toEqual([]);
    expect(expansionTokens("O(n^2)")).toEqual([]);
    expect(expansionTokens("O(n²)")).toEqual([]);
    expect(expansionTokens("too long; didn't read")).toEqual(["too", "long", "didnt", "read"]);

    const spoken = normalizeExternalEquivalences(
      [
        { key: "cpp", expansion: "C++" },
        { key: "csharp", expansion: "C#" },
        { key: "fsharp", expansion: "F#" },
        { key: "astar", expansion: "A*" },
        { key: "cpp", expansion: "C plus plus", aliases: [["c++"]] },
      ],
      { strict: false }
    );
    expect(spoken.entries.find((row) => row.key === "cpp").expansion).toEqual(["c", "plus", "plus"]);
    expect(spoken.entries.find((row) => row.key === "cpp").aliases).toEqual([]);
    expect(spoken.entries.find((row) => row.key === "csharp").expansion).toEqual(["c", "sharp"]);
    expect(spoken.entries.find((row) => row.key === "fsharp").expansion).toEqual(["f", "sharp"]);
    expect(spoken.entries.find((row) => row.key === "astar").expansion).toEqual(["a", "star"]);
    expect(spoken.rejected).toEqual([]);
  });

  test("distinct symbolic compact keys do not collapse onto one ordinary key", () => {
    expect(acronymKey("O(n)")).toBe("");
    expect(acronymKey("O(n^2)")).toBe("");
    expect(acronymKey("O(n²)")).toBe("");
    expect(acronymKey("O(1)")).toBe("");
    expect(acronymKey("on")).toBe("on");

    const result = normalizeExternalEquivalences(
      [
        { key: "O(n)", expansion: "linear time" },
        { key: "O(n^2)", expansion: "quadratic time" },
        { key: "O(n²)", expansion: "quadratic time" },
        { key: "cpp", expansion: "C++" },
      ],
      { strict: false }
    );
    expect(result.entries.map((row) => row.key).sort()).toEqual(["cpp"]);
    expect(result.entries.find((row) => row.key === "on")).toBeUndefined();
    expect(result.entries.find((row) => row.key === "o1")).toBeUndefined();
    expect(result.entries.find((row) => row.key === "cpp").expansion).toEqual(["c", "plus", "plus"]);
    expect(result.rejected.filter((row) => row.reason === "empty key")).toHaveLength(3);
  });

  test("unsafe symbolic expansions are rejected rather than stripped", () => {
    const result = normalizeExternalEquivalences(
      [
        { key: "onotation", expansion: "O(n)" },
        { key: "onotation2", expansion: "O(n^2)" },
        { key: "tldr", expansion: "too long; didn't read" },
      ],
      { strict: false }
    );
    expect(result.entries.map((row) => row.key)).toEqual(["tldr"]);
    expect(result.entries[0].expansion).toEqual(["too", "long", "didnt", "read"]);
    expect(result.rejected.map((row) => row.reason)).toEqual([
      "unsafe symbolic expansion",
      "unsafe symbolic expansion",
    ]);
  });

  test("collapses tech debt / technical debt into one eligible entry plus alias", () => {
    const result = normalizeExternalEquivalences([
      { key: "techdebt", expansion: "tech debt", evidenceDocumentIds: ["a"] },
      { key: "techdebt", expansion: "technical debt", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.unresolved).toHaveLength(0);
    const row = result.entries[0];
    expect(row.expansion).toEqual(["tech", "debt"]);
    expect(row.aliases).toEqual([["technical", "debt"]]);
    expect(result.reconciliations[0]).toMatchObject({ key: "techdebt", kind: "compatible", eligible: true });
  });

  test("standaloneRecall round-trips unique tokens and rejects malformed values", () => {
    const result = normalizeExternalEquivalences([
      {
        key: "http",
        expansion: "hypertext transfer protocol",
        standaloneRecall: ["Hypertext", "hypertext", "", "hypertext transfer"],
      },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].standaloneRecall).toEqual(["hypertext"]);
  });

  test("public input is {key, expansion, aliases, primary}; expansions[] is not a substitute", () => {
    expect(() =>
      normalizeExternalEquivalences([{ key: "cd", expansions: [["continuous", "delivery"]] }])
    ).toThrow(ExternalEquivalenceError);
    const ok = normalizeExternalEquivalences([
      { key: "cd", expansion: "continuous delivery", aliases: [], primary: null },
    ]);
    expect(ok.entries).toHaveLength(1);
    expect(ok.entries[0]).toMatchObject({
      key: "cd",
      expansion: ["continuous", "delivery"],
      aliases: [],
      primary: null,
    });
    expect(ok.entries[0].standaloneRecall).toEqual([]);
    expect(ok.entries[0].expansions).toBeUndefined();
  });
});

describe("deterministic fps mining still holds after enrichment removal", () => {
  test("200FPS + independent fps mines frames per second as review, not trusted", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "200-fps",
          title: "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
          body: [
            "A **200 FPS front-end** produces a new frame approximately every **5 milliseconds**.",
            "Producing 200 frames per second does not guarantee that users will see 200 distinct frames.",
            "Frame rate describes how frequently new images are produced. FPS is the usual unit.",
            "Achieving 200 frames per second requires the display to refresh fast enough.",
            "High FPS budgets leave little room for layout. Another frames per second mention appears here.",
          ].join(" "),
        },
      ],
    });
    const fps = result.inspection.candidates.find(
      (c) => c.key === "fps" && c.expansionPhrase === "frames per second"
    );
    expect(fps).toBeTruthy();
    expect(fps.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(result.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });
});
