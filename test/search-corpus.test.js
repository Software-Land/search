import fs from "node:fs";
import path from "node:path";
import { compileCorpus, spellingLexiconPlugin } from "../tools/search-corpus/index.js";
import { SearchEngine, english, dictionary } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";

import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));


const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

function walkJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walkJs(p));
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

function statusOf(result, key, phrase) {
  const all = [...result.inspection.accepted, ...result.inspection.review, ...result.inspection.rejected];
  return all.filter((c) => c.key === key && (!phrase || c.expansionPhrase === phrase));
}

describe("search-corpus isolation", () => {
  test("Search Core does not import search-corpus", () => {
    const root = path.join(__dirname, "../dist");
    for (const file of walkJs(root)) {
      const text = fs.readFileSync(file, "utf8").toLowerCase();
      expect(text.includes("search-corpus")).toBe(false);
    }
  });

  test("compiler does not import Search Core or search-semantic", () => {
    const root = path.join(__dirname, "../tools/search-corpus/lib");
    for (const file of walkJs(root)) {
      const text = fs.readFileSync(file, "utf8");
      expect(text.includes("src/search/")).toBe(false);
      expect(text.includes("search-semantic")).toBe(false);
      expect(text.includes("src/search-v2")).toBe(false);
    }
  });
});

describe("search-corpus synthetic mining", () => {
  test("explicit acronym is accepted", () => {
    const result = compileCorpus({
      documents: [
        { id: "a", title: "Central Processing Unit (CPU)", body: "The Central Processing Unit (CPU) fetches instructions." },
        { id: "b", title: "CPU cooling", body: "Keep the CPU cool." },
      ],
    });
    const cpu = result.inspection.accepted.find((c) => c.key === "cpu");
    expect(cpu).toBeTruthy();
    expect(cpu.expansion).toEqual(["central", "processing", "unit"]);
    expect(cpu.evidence.explicitDefinitions).toBeGreaterThanOrEqual(1);
    expect(result.equivalences.entries.some((e) => e.key === "cpu")).toBe(true);
  });

  test("ambiguous acronyms go to review, not runtime", () => {
    const result = compileCorpus({
      documents: [
        { id: "a", title: "Alpha Beta Compiler (ABC)", body: "Alpha Beta Compiler (ABC) is a toy language." },
        { id: "b", title: "Account Balance Check (ABC)", body: "Account Balance Check (ABC) is a ledger report." },
      ],
    });
    const abc = statusOf(result, "abc");
    expect(abc.every((c) => c.status === "review")).toBe(true);
    expect(result.equivalences.entries.some((e) => e.key === "abc")).toBe(false);
  });

  test("false initialism coincidence is rejected", () => {
    const result = compileCorpus({
      documents: [
        { id: "iot", title: "What is IoT?", body: "Internet of Things devices at the edge." },
        { id: "io", title: "What is IO?", body: "Input and output streams. Also mentions internet of things once." },
      ],
    });
    const ioAsIot = statusOf(result, "io", "internet of things");
    expect(ioAsIot.every((c) => c.status === "rejected" || c.initialsMatch === false)).toBe(true);
    expect(result.equivalences.entries.some((e) => e.key === "io" && e.expansion.includes("things"))).toBe(false);
  });

  test("related documents are not compiled as synonyms or equivalences", () => {
    const result = compileCorpus({
      documents: [
        { id: "tls", title: "TLS Configuration", body: "Transport Layer Security certificates. VPN is related." },
        { id: "vpn", title: "VPN Settings", body: "Virtual private network. TLS is mentioned." },
      ],
    });
    expect(result.equivalences.entries.some((e) => e.key === "tls" && e.expansion.includes("vpn"))).toBe(false);
    expect(result.inspection.synonymCandidates.some((s) => s.terms.includes("tls") && s.terms.includes("vpn"))).toBe(false);
    expect(result.inspection.synonymCandidates.length).toBeLessThan(20);
    const tls = statusOf(result, "tls", "transport layer security");
    expect(tls.some((c) => c.status === "review")).toBe(true);
    expect(result.equivalences.entries.some((e) => e.key === "tls")).toBe(false);
  });

  test("short literals stay in vocabulary and are not spelling-normalized", () => {
    const result = compileCorpus({
      documents: [
        { id: "s3", title: "S3 buckets and H2 database", body: "Use S3, H2, and k8s with gRPC and WebGL." },
      ],
    });
    const terms = new Map(result.vocabulary.terms.map((t) => [t.term, t]));
    expect(terms.get("s3")?.kind).toBe("literal");
    expect(terms.get("h2")?.kind).toBe("literal");
    expect(terms.get("k8s")?.kind).toBe("literal");
  });

  test("review candidates do not enter the runtime artifact", () => {
    const result = compileCorpus({
      documents: [
        { id: "ci", title: "CI pipelines", body: "We practice continuous integration every day with CI." },
      ],
    });
    const ci = statusOf(result, "ci", "continuous integration");
    expect(ci.some((c) => c.status === "review")).toBe(true);
    expect(result.equivalences.entries.some((e) => e.key === "ci")).toBe(false);
    const runtimeKeys = new Set(result.equivalences.entries.map((e) => e.key));
    for (const c of result.inspection.review) {
      expect(runtimeKeys.has(c.key) && result.equivalences.entries.find((e) => e.key === c.key)?.expansion.join(" ") === c.expansionPhrase).toBe(false);
    }
  });

  test("title+body co-occurrence is review, junk initialisms are rejected", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "api",
          title: "What is an API?",
          body: "An application programming interface lets clients talk to a service. Every API needs a contract. Mentions a post id once.",
        },
        {
          id: "other",
          title: "Service contracts",
          body: "The application programming interface is documented separately.",
        },
      ],
    });
    const api = statusOf(result, "api", "application programming interface");
    expect(api.some((c) => c.status === "review")).toBe(true);
    expect(result.equivalences.entries.some((e) => e.key === "api")).toBe(false);
    const junk = statusOf(result, "api", "post id");
    expect(junk.every((c) => c.status === "rejected" || c.length === 0)).toBe(true);
    expect(junk.length === 0 || junk.every((c) => c.status === "rejected")).toBe(true);
  });

  test("manual overrides outrank inference and report conflicts", () => {
    const docs = {
      documents: [
        { id: "a", title: "Foo Bar Baz (FBB)", body: "Foo Bar Baz (FBB) appears twice. Foo Bar Baz (FBB)." },
      ],
    };
    const auto = compileCorpus(docs);
    expect(auto.equivalences.entries.some((e) => e.key === "fbb")).toBe(true);
    const overridden = compileCorpus(docs, {
      overrides: {
        reject: [{ key: "fbb" }],
        add: [{ key: "xyz", expansion: ["x", "y", "z"] }],
      },
    });
    expect(overridden.equivalences.entries.some((e) => e.key === "fbb")).toBe(false);
    expect(overridden.equivalences.entries.some((e) => e.key === "xyz")).toBe(true);
  });

  test("builds are deterministic", () => {
    const docs = {
      documents: [
        { id: "b", title: "Beta", body: "Graphical User Interface (GUI) notes." },
        { id: "a", title: "Graphical User Interface (GUI)", body: "Graphical User Interface (GUI) again." },
      ],
    };
    const a = JSON.stringify(compileCorpus(docs).equivalences);
    const b = JSON.stringify(compileCorpus(docs).equivalences);
    expect(a).toBe(b);
  });
});

describe("search-corpus spelling plugin", () => {
  test("trusted vocabulary can correct a domain typo without touching s3", async () => {
    const engine = SearchEngine.create({
      schema,
      plugins: [
        english(),
        dictionary({ entries: [] }),
        spellingLexiconPlugin(["kubernetes", "authorization", "application"]),
      ],
    });
    await engine.index([
      { id: "k", title: "Cluster Notes", body: "kubernetis is misspelled on purpose" },
      { id: "s", title: "S3 buckets", body: "object storage" },
    ]);
    const k = analyzeQuery("kubernetis", {
      plugins: engine.plugins,
      lexicon: engine._index.titleTokenSet,
    });
    // title set may not include kubernetes; plugin lexicon should.
    const forms = k.concepts.flatMap((c) => c.forms);
    expect(forms).toContain("kubernetes");
    const s3 = analyzeQuery("s3", { plugins: engine.plugins, lexicon: engine._index.titleTokenSet });
    expect(s3.tokens[0].normalized).toBe("s3");
  });
});
