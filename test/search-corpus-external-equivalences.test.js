import {
  compileCorpus,
  LIFECYCLE,
  reconcileExternalConfiguredConcepts,
  ExternalConfiguredConceptError,
} from "../tools/search-corpus/index.js";
import { classifyExpansionRelation } from "../tools/search-corpus/lib/externalEquivalences.js";
import { acronymKey, expansionTokens } from "../tools/search-corpus/lib/text.js";
import { compileAuthoredRelevance } from "../dist/index.js";

function extraAliases(concept) {
  return (concept.aliases || []).slice(1);
}

function forbiddenConceptFields(row) {
  return [
    "expansion",
    "primary",
    "standaloneRecall",
    "topicalRecall",
    "evidenceDocumentIds",
    "ambiguous",
    "alternatives",
  ].filter((key) => Object.prototype.hasOwnProperty.call(row, key));
}

describe("reconcileExternalConfiguredConcepts", () => {
  test("canonicalizes keys, candidate expansions, and aliases deterministically", () => {
    const result = reconcileExternalConfiguredConcepts([
      {
        key: "ML",
        expansion: "Machine Learning",
        aliases: [["ml"]],
        evidenceDocumentIds: ["b", "a"],
        provenance: "application-generated",
      },
      {
        key: "API",
        aliases: [["Application", "Programming", "Interface"], ["app", "programming", "interface"]],
      },
    ]);
    expect(result.configuredConcepts.map((e) => e.key)).toEqual(["api", "ml"]);
    expect(result.format).toBe("search-corpus-external-configured-concept-reconciliation");
    expect(result.configuredConcepts[0].aliases[0]).toEqual(["application", "programming", "interface"]);
    expect(extraAliases(result.configuredConcepts[0])).toEqual([["app", "programming", "interface"]]);
    expect(forbiddenConceptFields(result.configuredConcepts[0])).toEqual([]);
    expect(result.configuredConcepts[1].aliases[0]).toEqual(["machine", "learning"]);
    expect(result.reconciliations.find((row) => row.key === "ml").evidenceDocumentIds).toEqual(["a", "b"]);
    expect(result.configuredConcepts[1].provenance).toBe("application-generated");
    expect(result).not.toHaveProperty("entries");
    expect(result.configuredConcepts[1].provenance).toBe("application-generated");
  });

  test("collapses duplicate key+expansion and merges evidence", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "fps", expansion: "frames per second", evidenceDocumentIds: ["d1"] },
      { key: "FPS", expansion: "frames per second", evidenceDocumentIds: ["d2"], aliases: [["frame", "rate"]] },
    ]);
    expect(result.configuredConcepts).toHaveLength(1);
    expect(result.configuredConcepts[0].key).toBe("fps");
    expect(result.reconciliations[0].evidenceDocumentIds).toEqual(["d1", "d2"]);
    expect(extraAliases(result.configuredConcepts[0])).toEqual([["frame", "rate"]]);
  });

  test("skips empty alias entries instead of rejecting the row", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "fps", expansion: "frames per second", aliases: [[], [""], ["frame", "rate"]] },
    ]);
    expect(result.configuredConcepts).toHaveLength(1);
    expect(result.configuredConcepts[0].aliases).toEqual([["frames", "per", "second"], ["frame", "rate"]]);
  });

  test("skips expansions that tokenize to only function words", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "fps", expansion: "frames per second" },
      { key: "i.e.", expansion: "that is" },
    ]);
    expect(result.configuredConcepts.map((e) => e.key)).toEqual(["fps", "ie"]);
    expect(result.configuredConcepts.find((e) => e.key === "ie").aliases[0]).toEqual(["that", "is"]);
    expect(result.rejected).toEqual([]);
  });

  test("preserves leading not in Not Only SQL", () => {
    const result = reconcileExternalConfiguredConcepts([{ key: "NoSQL", expansion: "Not Only SQL" }]);
    expect(result.configuredConcepts).toHaveLength(1);
    expect(result.configuredConcepts[0].key).toBe("nosql");
    expect(result.configuredConcepts[0].aliases[0]).toEqual(["not", "only", "sql"]);
  });

  test("rejects empty key and empty expansion", () => {
    expect(() => reconcileExternalConfiguredConcepts([{ key: "", aliases: [["frames", "per", "second"]]}])).toThrow(
      ExternalConfiguredConceptError
    );
    expect(() => reconcileExternalConfiguredConcepts([{ key: "fps", aliases: [[]]}])).toThrow(ExternalConfiguredConceptError);
    expect(() => reconcileExternalConfiguredConcepts([{ key: "fps", expansion: "   " }])).toThrow(ExternalConfiguredConceptError);
  });

  test("records legitimate same-key alternatives as unresolved ambiguity instead of deleting the key", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "cd", expansion: "continuous deployment", evidenceDocumentIds: ["a"] },
      { key: "cd", expansion: "continuous delivery", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.configuredConcepts).toHaveLength(0);
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
    const result = reconcileExternalConfiguredConcepts(
      [
        { key: "", aliases: [["x"]]},
        { key: "cd", expansion: "continuous deployment" },
        { key: "cd", expansion: "continuous delivery" },
      ],
      { strict: false }
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.unresolved.map((row) => row.key)).toEqual(["cd"]);
    expect(result.configuredConcepts).toHaveLength(0);
  });

  test("collapses trivially compatible variants into one canonical expansion plus alias", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "grpc", expansion: "grpc remote procedure calls", evidenceDocumentIds: ["a"] },
      { key: "grpc", expansion: "google remote procedure call", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.configuredConcepts).toHaveLength(1);
    expect(result.unresolved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    const row = result.configuredConcepts[0];
    expect(row.key).toBe("grpc");
    expect(row.aliases[0]).toEqual(["google", "remote", "procedure", "call"]);
    expect(extraAliases(row)).toEqual([["grpc", "remote", "procedure", "calls"]]);
    expect(result.reconciliations[0].evidenceDocumentIds).toEqual(["a", "b"]);
    expect(result.reconciliations[0]).toMatchObject({ key: "grpc", kind: "compatible", eligible: true });
  });

  test("collapses punctuation and function-word compatible variants", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "iot", expansion: "internet of things", evidenceDocumentIds: ["a"] },
      { key: "iot", expansion: "internet things", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.configuredConcepts).toHaveLength(1);
    expect(result.configuredConcepts[0].aliases[0]).toEqual(["internet", "things"]);
    expect(extraAliases(result.configuredConcepts[0])).toEqual([["internet", "of", "things"]]);
  });

  test("collapses plural/singular compatible variants", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "api", expansion: "application programming interface" },
      { key: "api", expansion: "application programming interfaces" },
    ]);
    expect(result.configuredConcepts).toHaveLength(1);
    expect(result.unresolved).toHaveLength(0);
    expect(extraAliases(result.configuredConcepts[0]).length).toBe(1);
  });

  test("keeps CI/CD delivery vs deployment as ambiguity, not an auto-unioned alias", () => {
    const result = reconcileExternalConfiguredConcepts([
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
    expect(result.configuredConcepts.find((row) => row.key === "cicd")).toBeUndefined();
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].kind).toBe("ambiguous");
    expect(result.unresolved[0].expansions).toEqual([
      ["continuous", "integration", "and", "continuous", "delivery"],
      ["continuous", "integration", "and", "continuous", "deployment"],
    ]);
    expect(result.reconciliations[0].aliases || []).toEqual([]);
  });

  test("records genuinely conflicting meanings as unresolved conflict, not an entry", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "ts", expansion: "typescript", evidenceDocumentIds: ["a"] },
      { key: "ts", expansion: "timestamp", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.configuredConcepts).toHaveLength(0);
    expect(result.unresolved[0]).toMatchObject({ key: "ts", kind: "conflict", eligible: false });
    expect(result.conflicts).toHaveLength(1);
  });

  test("single-expansion rows marked ambiguous stay inspectable and not runtime-eligible", () => {
    const result = reconcileExternalConfiguredConcepts([
      {
        key: "rag",
        expansion: "retrieval augmented generation",
        ambiguous: true,
        alternatives: [{ expansion: "red amber green" }],
      },
    ]);
    expect(result.configuredConcepts).toHaveLength(0);
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

describe("reconcileExternalConfiguredConcepts spelling and abbreviation compatibility", () => {
  test("collapses acknowledgement/acknowledgment into one eligible ack entry plus alias", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "ack", expansion: "acknowledgement", evidenceDocumentIds: ["cf"] },
      { key: "ack", expansion: "acknowledgment", evidenceDocumentIds: ["r"] },
    ]);
    expect(result.configuredConcepts).toHaveLength(1);
    expect(result.unresolved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    const row = result.configuredConcepts[0];
    expect(row.key).toBe("ack");
    expect(row.aliases[0]).toEqual(["acknowledgement"]);
    expect(extraAliases(row)).toEqual([["acknowledgment"]]);
    expect(result.reconciliations[0].evidenceDocumentIds).toEqual(["cf", "r"]);
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

    const result = reconcileExternalConfiguredConcepts(
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
    expect(result.configuredConcepts.map((row) => row.key).sort()).toEqual(["cicd", "tcpip"]);
    expect(result.configuredConcepts.find((row) => row.key === "a")).toBeUndefined();
    expect(result.configuredConcepts.find((row) => row.key === "c")).toBeUndefined();
    expect(result.configuredConcepts.find((row) => row.key === "o1")).toBeUndefined();
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

    const spoken = reconcileExternalConfiguredConcepts(
      [
        { key: "cpp", expansion: "C++" },
        { key: "csharp", expansion: "C#" },
        { key: "fsharp", expansion: "F#" },
        { key: "astar", expansion: "A*" },
        { key: "cpp", expansion: "C plus plus", aliases: [["c++"]] },
      ],
      { strict: false }
    );
    expect(spoken.configuredConcepts.find((row) => row.key === "cpp").aliases[0]).toEqual(["c", "plus", "plus"]);
    expect(extraAliases(spoken.configuredConcepts.find((row) => row.key === "cpp"))).toEqual([]);
    expect(spoken.configuredConcepts.find((row) => row.key === "csharp").aliases[0]).toEqual(["c", "sharp"]);
    expect(spoken.configuredConcepts.find((row) => row.key === "fsharp").aliases[0]).toEqual(["f", "sharp"]);
    expect(spoken.configuredConcepts.find((row) => row.key === "astar").aliases[0]).toEqual(["a", "star"]);
    expect(spoken.rejected).toEqual([]);
  });

  test("distinct symbolic compact keys do not collapse onto one ordinary key", () => {
    expect(acronymKey("O(n)")).toBe("");
    expect(acronymKey("O(n^2)")).toBe("");
    expect(acronymKey("O(n²)")).toBe("");
    expect(acronymKey("O(1)")).toBe("");
    expect(acronymKey("on")).toBe("on");

    const result = reconcileExternalConfiguredConcepts(
      [
        { key: "O(n)", expansion: "linear time" },
        { key: "O(n^2)", expansion: "quadratic time" },
        { key: "O(n²)", expansion: "quadratic time" },
        { key: "cpp", expansion: "C++" },
      ],
      { strict: false }
    );
    expect(result.configuredConcepts.map((row) => row.key).sort()).toEqual(["cpp"]);
    expect(result.configuredConcepts.find((row) => row.key === "on")).toBeUndefined();
    expect(result.configuredConcepts.find((row) => row.key === "o1")).toBeUndefined();
    expect(result.configuredConcepts.find((row) => row.key === "cpp").aliases[0]).toEqual(["c", "plus", "plus"]);
    expect(result.rejected.filter((row) => row.reason === "empty key")).toHaveLength(3);
  });

  test("unsafe symbolic expansions are rejected rather than stripped", () => {
    const result = reconcileExternalConfiguredConcepts(
      [
        { key: "onotation", expansion: "O(n)" },
        { key: "onotation2", expansion: "O(n^2)" },
        { key: "tldr", expansion: "too long; didn't read" },
      ],
      { strict: false }
    );
    expect(result.configuredConcepts.map((row) => row.key)).toEqual(["tldr"]);
    expect(result.configuredConcepts[0].aliases[0]).toEqual(["too", "long", "didnt", "read"]);
    expect(result.rejected.map((row) => row.reason)).toEqual([
      "unsafe symbolic expansion",
      "unsafe symbolic expansion",
    ]);
  });

  test("collapses tech debt / technical debt into one eligible entry plus alias", () => {
    const result = reconcileExternalConfiguredConcepts([
      { key: "techdebt", expansion: "tech debt", evidenceDocumentIds: ["a"] },
      { key: "techdebt", expansion: "technical debt", evidenceDocumentIds: ["b"] },
    ]);
    expect(result.configuredConcepts).toHaveLength(1);
    expect(result.unresolved).toHaveLength(0);
    const row = result.configuredConcepts[0];
    expect(row.aliases[0]).toEqual(["tech", "debt"]);
    expect(extraAliases(row)).toEqual([["technical", "debt"]]);
    expect(result.reconciliations[0]).toMatchObject({ key: "techdebt", kind: "compatible", eligible: true });
  });

  test("rejects standaloneRecall as a wrong-layer candidate field", () => {
    expect(() =>
      reconcileExternalConfiguredConcepts([
        {
          key: "http",
          expansion: "hypertext transfer protocol",
          standaloneRecall: ["hypertext"],
        },
      ])
    ).toThrow(/standaloneRecall/);
  });

  test("rejects topicalRecall as a wrong-layer candidate field", () => {
    expect(() =>
      reconcileExternalConfiguredConcepts([
        {
          key: "appsec",
          expansion: "application security",
          topicalRecall: [["authentication"]],
        },
      ])
    ).toThrow(/topicalRecall/);
  });

  test("rejects primary as a stale candidate field", () => {
    expect(() =>
      reconcileExternalConfiguredConcepts([
        { key: "ml", expansion: "machine learning", primary: "learning" },
      ])
    ).toThrow(/primary/);
  });

  test("candidate expansion projects to aliases[0] and feeds compileAuthoredRelevance", () => {
    expect(() =>
      reconcileExternalConfiguredConcepts([{ key: "cd", expansions: [["continuous", "delivery"]] }])
    ).toThrow(ExternalConfiguredConceptError);
    const ok = reconcileExternalConfiguredConcepts([
      { key: "cd", expansion: "continuous delivery", aliases: [] },
    ]);
    expect(ok.configuredConcepts).toHaveLength(1);
    expect(ok.configuredConcepts[0]).toEqual({
      key: "cd",
      aliases: [["continuous", "delivery"]],
      provenance: "external",
    });
    expect(forbiddenConceptFields(ok.configuredConcepts[0])).toEqual([]);
    expect(ok.configuredConcepts[0].expansions).toBeUndefined();
    const authored = compileAuthoredRelevance({
      configuredConcepts: ok.configuredConcepts,
    });
    expect(authored.plugins.length).toBe(2);
  });

  test("related recall remains authored on relationshipMap, not candidate rows", () => {
    const reconciled = reconcileExternalConfiguredConcepts([
      { key: "http", aliases: [["hypertext", "transfer", "protocol"]] },
    ]);
    const authored = compileAuthoredRelevance({
      configuredConcepts: reconciled.configuredConcepts,
      relationshipMap: {
        hypertext: [{ kind: "related", to: { concept: "http" } }],
      },
    });
    const dictionaryPlugin = authored.plugins.find((plugin) => plugin.name === "dictionary");
    expect(dictionaryPlugin.standaloneRecallByToken.get("hypertext")).toBe("http");
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
    expect(result.configuredConcepts.some((e) => e.key === "fps")).toBe(false);
  });
});
