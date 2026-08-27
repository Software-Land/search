import { compileCorpus, analyzeCorpus, LIFECYCLE, isInflectionPair } from "../tools/search-corpus/index.js";

function byKeyPhrase(result, key, phrase) {
  return result.inspection.candidates.filter(
    (c) => c.key === key && (!phrase || c.expansionPhrase === phrase)
  );
}

function pendingIds(result) {
  return (result.inspection.pending || []).map((p) => p.id);
}

describe("search-corpus review queue", () => {
  test("good 2-letter acronym survives short-token filtering", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "ci",
          title: "CI pipelines",
          body: "We practice continuous integration every day with CI.",
        },
      ],
    });
    const ci = byKeyPhrase(result, "ci", "continuous integration");
    expect(ci.length).toBeGreaterThan(0);
    expect(ci.every((c) => c.compilerDecision !== "short-token-weak-evidence")).toBe(true);
    const row = ci[0];
    if (row.lifecycle === LIFECYCLE.AUTO_ACCEPTED) {
      expect(result.configuredConcepts.some((e) => e.key === "ci")).toBe(true);
    } else {
      expect(row.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
      expect(row.reviewBand).toBe("HIGH");
      expect(result.configuredConcepts.some((e) => e.key === "ci")).toBe(false);
    }
  });

  test("explicit Continuous Integration (CI) may auto-accept only via unchanged rules", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "ci",
          title: "Continuous Integration (CI)",
          body: "Continuous Integration (CI) runs on every commit.",
        },
      ],
    });
    const ci = byKeyPhrase(result, "ci", "continuous integration")[0];
    expect(ci).toBeTruthy();
    expect(["AUTO_ACCEPTED", "REVIEW_PENDING"]).toContain(ci.lifecycle);
    if (ci.lifecycle === LIFECYCLE.REVIEW_PENDING) expect(ci.reviewBand).toBe("HIGH");
  });

  test("junk 2-letter coincidence is suppressed", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "cd",
          title: "CD Control Developers",
          body: "Notes about cycle of developing tools. CD is mentioned.",
        },
      ],
    });
    const junk = result.inspection.candidates.filter(
      (c) => c.key === "cd" && /control developers|cycle of developing/.test(c.expansionPhrase || "")
    );
    expect(junk.length).toBeGreaterThan(0);
    for (const row of junk) {
      expect(row.lifecycle).toBe("COMPILER_REJECTED");
      expect(row.reviewBand).not.toBe("HIGH");
    }
    expect(pendingIds(result).some((id) => /control-developers|cycle-of-developing/.test(id))).toBe(false);
  });

  test("three-letter strong acronym is a high-value review candidate, not auto-accepted", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "api",
          title: "What is an API?",
          body: "An application programming interface lets clients talk to a service. Every API needs a contract.",
        },
        {
          id: "other",
          title: "Service contracts",
          body: "The application programming interface is documented separately.",
        },
      ],
    });
    const api = byKeyPhrase(result, "api", "application programming interface")[0];
    expect(api.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(api.reviewBand).toBe("HIGH");
    expect(result.configuredConcepts.some((e) => e.key === "api")).toBe(false);
    expect(api.decisionSkeleton).toEqual({
      candidateId: api.id,
      decision: "accept",
      key: "api",
      expansion: ["application", "programming", "interface"],
    });
  });

  test("morphology inflections are not three synonym review tasks", () => {
    const result = compileCorpus({
      documents: [
        { id: "a", title: "Configure services", body: "configure the service. configured yesterday. configuring now." },
        { id: "b", title: "Configured hosts", body: "configured configure configuring the hosts." },
        { id: "c", title: "Configuring clusters", body: "configuring and configure and configured." },
      ],
    });
    const morph = result.inspection.synonymCandidates.filter((s) => {
      const t = new Set(s.terms || []);
      return (
        (t.has("configure") && t.has("configured")) ||
        (t.has("configure") && t.has("configuring")) ||
        (t.has("configured") && t.has("configuring"))
      );
    });
    expect(morph).toEqual([]);
    expect(isInflectionPair("configure", "configured")).toBe(true);
    expect(isInflectionPair("configure", "configuring")).toBe(true);
  });

  test("related but non-synonymous pairs stay out of the synonym miner", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "a",
          title: "Authentication vs Authorization",
          body: "Authentication and authorization are different. TLS and VPN are related.",
        },
        {
          id: "b",
          title: "TLS and VPN",
          body: "Transport Layer Security. Virtual private network. authentication authorization.",
        },
      ],
    });
    const pairs = result.inspection.synonymCandidates.map((s) => (s.terms || []).join("::"));
    expect(pairs.some((p) => p.includes("authentication") && p.includes("authorization"))).toBe(false);
    expect(pairs.some((p) => p.includes("tls") && p.includes("vpn"))).toBe(false);
    expect(result.relationshipMap).toEqual({});
  });

  test("auth / authentication is an alias review candidate", () => {
    const result = compileCorpus({
      documents: [
        { id: "a", title: "Authentication", body: "Use auth for authentication in this authentication guide." },
        { id: "b", title: "Auth setup", body: "auth authentication auth authentication" },
        { id: "c", title: "More authentication", body: "authentication and auth" },
      ],
    });
    const hit = result.inspection.synonymCandidates.find(
      (s) => s.terms.includes("auth") && s.terms.includes("authentication")
    );
    expect(hit).toBeTruthy();
    expect(hit.relation).toBe("alias");
    expect(hit.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(hit.reviewBand).not.toBe("HIGH");
    expect(["MEDIUM", "LOW"]).toContain(hit.reviewBand);
    expect(result.relationshipMap).toEqual({});
  });

  test("family grouping hides redundant expansions of an already accepted key", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "a",
          title: "Object Oriented Programming (OOP)",
          body: "Object Oriented Programming (OOP) is the default style.",
        },
        { id: "b", title: "OOP cooling", body: "Keep OOP examples small." },
        { id: "c", title: "OOP notes", body: "The object oriented paradigm is sometimes used as a synonym." },
      ],
    });
    const accepted = result.configuredConcepts.find((e) => e.key === "oop");
    expect(accepted).toBeTruthy();
    const paradigm = result.inspection.candidates.find(
      (c) => c.key === "oop" && c.expansionPhrase === "object oriented paradigm"
    );
    if (paradigm && paradigm.lifecycle === LIFECYCLE.REVIEW_PENDING) {
      expect(paradigm.familyRole).toBe("redundant-to-accepted");
      expect(pendingIds(result)).not.toContain(paradigm.id);
    }
    const pendingOop = (result.inspection.pending || []).filter((p) => p.key === "oop");
    expect(pendingOop.length).toBeLessThanOrEqual(1);
  });

  test("review priority does not change lifecycle", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "api",
          title: "What is an API?",
          body: "An application programming interface lets clients talk to a service. API.",
        },
        {
          id: "other",
          title: "Service contracts",
          body: "The application programming interface is documented separately.",
        },
      ],
    });
    const api = byKeyPhrase(result, "api", "application programming interface")[0];
    expect(api.reviewBand).toBe("HIGH");
    expect(api.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(api.reviewContributions.some((c) => c.name)).toBe(true);
  });

  test("tiny evidence growth is not a material review change", () => {
    const once = {
      documents: [
        { id: "a", title: "Central Processing Unit (CPU)", body: "The Central Processing Unit (CPU) fetches instructions." },
        { id: "b", title: "CPU cooling", body: "Keep the CPU cool." },
      ],
    };
    const twice = {
      documents: [
        ...once.documents,
        { id: "c", title: "CPU notes", body: "The CPU still fetches. Central processing unit mentioned again." },
      ],
    };
    const first = compileCorpus(once);
    const second = compileCorpus(twice, { previousInspection: first.inspection });
    const id = first.inspection.candidates.find((c) => c.key === "cpu").id;
    expect(second.inspection.candidates.find((c) => c.key === "cpu").id).toBe(id);
    expect(second.inspection.candidates.find((c) => c.key === "cpu").lifecycle).toBe(LIFECYCLE.AUTO_ACCEPTED);
    expect(second.inspection.delta.summary.newReviewCandidates).toBe(0);
    expect(second.inspection.delta.summary.newConflicts).toBe(0);
  });

  test("pending queue is priority-ordered with copyable skeletons", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "api",
          title: "What is an API?",
          body: "An application programming interface. API.",
        },
        {
          id: "other",
          title: "Service contracts",
          body: "The application programming interface is documented.",
        },
        {
          id: "ci",
          title: "CI pipelines",
          body: "continuous integration with CI.",
        },
      ],
    });
    const pending = result.inspection.pending;
    expect(pending.length).toBeGreaterThan(0);
    for (let i = 1; i < pending.length; i++) {
      const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      expect(rank[pending[i - 1].reviewBand]).toBeLessThanOrEqual(rank[pending[i].reviewBand]);
    }
    expect(pending[0].decisionSkeleton.candidateId).toBe(pending[0].id);
    expect(pending[0].decisionSkeleton.decision).toBe("accept");
  });

  test("optional-word expansion variants share a family; competing expansions do not", () => {
    const result = compileCorpus({
      documents: [
        { id: "a", title: "What is IO?", body: "Input output streams. IO." },
        { id: "b", title: "IO notes", body: "input and output appear in the body." },
      ],
    });
    const io = result.inspection.candidates.filter((c) => c.key === "io" && c.lifecycle === LIFECYCLE.REVIEW_PENDING);
    const andPhrase = io.find((c) => c.expansionPhrase === "input and output");
    const tight = io.find((c) => c.expansionPhrase === "input output");
    if (andPhrase && tight) {
      expect(andPhrase.familyId).toBe(tight.familyId);
      const pendingIo = (result.inspection.pending || []).filter((p) => p.key === "io");
      expect(pendingIo.filter((p) => p.familyRole === "canonical").length).toBeLessThanOrEqual(1);
    }
  });

  test("analyze then compile keeps stable IDs when evidence grows", () => {
    const small = analyzeCorpus({
      documents: [{ id: "a", title: "What is an API?", body: "An application programming interface. API." }],
    });
    const larger = analyzeCorpus({
      documents: [
        { id: "a", title: "What is an API?", body: "An application programming interface. API." },
        { id: "b", title: "API notes", body: "application programming interface again." },
      ],
    });
    const a = small.inspection.candidates.find((c) => c.key === "api");
    const b = larger.inspection.candidates.find((c) => c.key === "api");
    expect(a.id).toBe(b.id);
  });
});
