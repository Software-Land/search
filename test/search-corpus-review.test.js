import { compileCorpus, analyzeCorpus, LIFECYCLE, equivalenceId, synonymId, hashJson } from "../tools/search-corpus/index.js";

const cpuDocs = {
  documents: [
    { id: "a", title: "Central Processing Unit (CPU)", body: "The Central Processing Unit (CPU) fetches instructions." },
    { id: "b", title: "CPU cooling", body: "Keep the CPU cool." },
  ],
};

describe("search-corpus durable review", () => {
  test("candidate IDs are stable when evidence grows", () => {
    const first = compileCorpus({
      documents: [{ id: "a", title: "Central Processing Unit (CPU)", body: "CPU." }],
    });
    const second = compileCorpus(cpuDocs);
    const a = first.inspection.candidates.find((c) => c.key === "cpu");
    const b = second.inspection.candidates.find((c) => c.key === "cpu");
    expect(a.id).toBe(equivalenceId("cpu", ["central", "processing", "unit"]));
    expect(a.id).toBe(b.id);
    expect((b.evidence.titleCooccurrences || 0) + (b.evidence.bodyCooccurrences || 0)).toBeGreaterThanOrEqual(
      (a.evidence.titleCooccurrences || 0) + (a.evidence.bodyCooccurrences || 0)
    );
  });

  test("human accept survives extra occurrences", () => {
    const decisions = {
      equivalences: [{ decision: "accept", key: "api", expansion: ["application", "programming", "interface"] }],
    };
    const once = compileCorpus(
      {
        documents: [
          { id: "api", title: "What is an API?", body: "An application programming interface." },
        ],
      },
      { decisions }
    );
    const twice = compileCorpus(
      {
        documents: [
          { id: "api", title: "What is an API?", body: "An application programming interface." },
          { id: "other", title: "Notes", body: "The application programming interface is documented. API." },
        ],
      },
      { decisions }
    );
    expect(once.equivalences.entries.some((e) => e.key === "api")).toBe(true);
    expect(twice.equivalences.entries.some((e) => e.key === "api")).toBe(true);
    const row = twice.inspection.candidates.find((c) => c.key === "api" && c.expansionPhrase === "application programming interface");
    expect(row.lifecycle).toBe(LIFECYCLE.HUMAN_ACCEPTED);
    expect(row.id).toBe(once.inspection.candidates.find((c) => c.id === row.id).id);
  });

  test("accepted candidate with missing evidence becomes orphaned but still compiles if complete", () => {
    const decisions = {
      equivalences: [{ decision: "accept", key: "xyz", expansion: ["x", "y", "z"], manual: true }],
    };
    const result = compileCorpus({ documents: [{ id: "a", title: "Hello", body: "No acronym here." }] }, { decisions });
    const row = result.inspection.candidates.find((c) => c.key === "xyz");
    expect(row.lifecycle).toBe(LIFECYCLE.HUMAN_ACCEPTED);
    expect(row.flags).toContain("orphaned-but-complete");
    expect(result.equivalences.entries.some((e) => e.key === "xyz")).toBe(true);
  });

  test("new ambiguity invalidates a previously accepted expansion", () => {
    const decisions = {
      equivalences: [{ decision: "accept", key: "abc", expansion: ["alpha", "beta", "compiler"] }],
    };
    const one = compileCorpus(
      {
        documents: [{ id: "a", title: "Alpha Beta Compiler (ABC)", body: "Alpha Beta Compiler (ABC)." }],
      },
      { decisions }
    );
    expect(one.equivalences.entries.some((e) => e.key === "abc")).toBe(true);
    const two = compileCorpus(
      {
        documents: [
          { id: "a", title: "Alpha Beta Compiler (ABC)", body: "Alpha Beta Compiler (ABC)." },
          { id: "b", title: "Account Balance Check (ABC)", body: "Account Balance Check (ABC)." },
        ],
      },
      { decisions }
    );
    expect(two.equivalences.entries.some((e) => e.key === "abc")).toBe(false);
    expect(two.inspection.conflicts.some((c) => c.type === "ambiguity-invalidation" || c.key === "abc")).toBe(true);
  });

  test("human rejection persists across reruns", () => {
    const docs = cpuDocs;
    const decisions = { equivalences: [{ decision: "reject", key: "cpu" }] };
    const a = compileCorpus(docs, { decisions });
    const b = compileCorpus(docs, { decisions });
    expect(a.equivalences.entries.some((e) => e.key === "cpu")).toBe(false);
    expect(b.equivalences.entries.some((e) => e.key === "cpu")).toBe(false);
    const row = b.inspection.candidates.find((c) => c.key === "cpu");
    expect(row.lifecycle).toBe(LIFECYCLE.HUMAN_REJECTED);
  });

  test("rejected candidate with new explicit evidence is flagged, not auto-accepted", () => {
    const decisions = {
      equivalences: [
        { decision: "reject", key: "cpu", expansion: ["central", "processing", "unit"] },
      ],
    };
    const result = compileCorpus(cpuDocs, { decisions });
    const row = result.inspection.candidates.find((c) => c.key === "cpu");
    expect(row.lifecycle).toBe(LIFECYCLE.HUMAN_REJECTED);
    expect(row.flags).toContain("rejected-candidate-gained-strong-evidence");
    expect(result.equivalences.entries.some((e) => e.key === "cpu")).toBe(false);
  });

  test("manual-only definition compiles without a mined candidate", () => {
    const result = compileCorpus(
      { documents: [{ id: "n", title: "Notes", body: "nothing" }] },
      {
        decisions: {
          equivalences: [{ decision: "accept", key: "abc", expansion: ["some", "domain", "meaning"], manual: true }],
        },
      }
    );
    expect(result.equivalences.entries.some((e) => e.key === "abc" && e.expansion.join(" ") === "some domain meaning")).toBe(true);
  });

  test("malformed accept without expansion fails clearly", () => {
    expect(() =>
      compileCorpus(cpuDocs, {
        decisions: { equivalences: [{ decision: "accept", key: "cpu" }] },
      })
    ).toThrow(/accept without expansion/);
  });

  test("conflicting accepted expansions fail clearly", () => {
    expect(() =>
      compileCorpus(cpuDocs, {
        decisions: {
          equivalences: [
            { decision: "accept", key: "cpu", expansion: ["central", "processing", "unit"] },
            { decision: "accept", key: "cpu", expansion: ["other", "expansion", "here"] },
          ],
        },
      })
    ).toThrow(/conflicting accepted expansions/);
  });

  test("analyze then compile preserves decisions and is byte-stable", () => {
    const decisions = {
      equivalences: [{ decision: "accept", key: "cpu", expansion: ["central", "processing", "unit"] }],
    };
    const a = compileCorpus(cpuDocs, { decisions });
    const b = compileCorpus(cpuDocs, { decisions });
    expect(JSON.stringify(a.equivalences)).toBe(JSON.stringify(b.equivalences));
    expect(JSON.stringify(a.synonyms)).toBe(JSON.stringify(b.synonyms));
    expect(a.manifest.artifactHashes.equivalences).toBe(b.manifest.artifactHashes.equivalences);
    expect(hashJson(a.equivalences)).toBe(hashJson(b.equivalences));
    const analyzed = analyzeCorpus(cpuDocs, { decisions });
    expect(analyzed.inspection.candidates.find((c) => c.key === "cpu").id).toBe(
      a.inspection.candidates.find((c) => c.key === "cpu").id
    );
  });
});

describe("search-corpus synonym candidates", () => {
  test("negative relatedness is not proposed as synonymy", () => {
    const result = compileCorpus({
      documents: [
        { id: "a", title: "Authentication vs Authorization", body: "Authentication and authorization are different. TLS and VPN are related. IoT is not IO. TCP vs UDP." },
        { id: "b", title: "TLS and VPN", body: "Transport Layer Security. Virtual private network. Authentication. Authorization. Internet of Things. Input output." },
      ],
    });
    const pairs = result.inspection.synonymCandidates.map((s) => s.terms.join("::"));
    const forbidden = [
      ["authentication", "authorization"],
      ["tls", "vpn"],
      ["iot", "io"],
      ["tcp", "udp"],
    ];
    for (const [x, y] of forbidden) {
      expect(pairs.some((p) => p.includes(x) && p.includes(y))).toBe(false);
    }
    expect(pairs.some((p) => p.includes("auth") && p.includes("authorization"))).toBe(false);
    expect(result.synonyms.entries.length).toBe(0);
  });

  test("human-accepted synonym compiles to search-v2-synonyms and is symmetric", () => {
    const result = compileCorpus(
      {
        documents: [
          { id: "a", title: "Auth notes", body: "auth and authentication appear often in auth guides." },
          { id: "b", title: "Authentication", body: "authentication documents mention auth." },
        ],
      },
      {
        decisions: {
          synonyms: [{ decision: "accept", terms: ["authentication", "auth"], relation: "alias" }],
        },
      }
    );
    expect(result.synonyms.entries.some((e) => e.terms.includes("auth") && e.terms.includes("authentication"))).toBe(true);
    expect(synonymId(["authentication", "auth"])).toBe(synonymId(["auth", "authentication"]));
    expect(result.inspection.synonymCandidates.find((s) => s.terms.includes("auth")).lifecycle).toBe(LIFECYCLE.HUMAN_ACCEPTED);
  });

  test("alias candidates stay review until accepted", () => {
    const result = compileCorpus({
      documents: [
        { id: "a", title: "Authentication", body: "Use auth for authentication in this authentication guide." },
        { id: "b", title: "Auth setup", body: "auth authentication auth authentication" },
        { id: "c", title: "More authentication", body: "authentication and auth" },
      ],
    });
    const hit = result.inspection.synonymCandidates.find((s) => s.terms.includes("auth") && s.terms.includes("authentication"));
    expect(hit).toBeTruthy();
    expect(hit.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(result.synonyms.entries.length).toBe(0);
  });
});
