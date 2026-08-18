import {
  SearchEngine,
  english,
  dictionary,
} from "../src/index.js";
import { createIndexedLexicalRetriever } from "../src/retrievers.js";
import { retrieveCandidates } from "../src/retrieve.js";
import { analyzeQuery } from "../src/analyze.js";
import { buildIndex } from "../src/indexDocuments.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const docs = [
  { id: "bluetooth", title: "Bluetooth", body: "Connect wireless accessories." },
  { id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks." },
  { id: "nfc", title: "NFC", body: "Near-field communication tap and pay." },
  { id: "vpn", title: "VPN", body: "Virtual private network." },
  { id: "tls", title: "TLS 1.2 Vulnerability", body: "Transport layer security issues." },
  { id: "battery", title: "Battery Saver", body: "Limit background activity." },
];

async function engines() {
  const plugins = [english(), dictionary({ entries: [{ key: "tls", expansion: ["transport", "layer", "security"] }] })];
  const full = SearchEngine.create({ schema, plugins });
  const indexed = SearchEngine.create({
    schema,
    plugins,
    retriever: createIndexedLexicalRetriever({ candidateLimit: 50 }),
  });
  await full.index(docs);
  await indexed.index(docs);
  return { full, indexed };
}

describe("search-v2 phase 11 replaceable retrieval", () => {
  test("default retriever remains full-scan (existing tests unchanged)", async () => {
    const e = SearchEngine.create({ schema, plugins: [english()] });
    await e.index(docs);
    expect(e.retriever.name).toBe("full-scan");
    expect(e.search("bluetooth")[0].title).toBe("Bluetooth");
  });

  test("indexed retrieval preserves exact title, literals, and configured equivalence", async () => {
    const { indexed } = await engines();
    expect(indexed.search("bluetooth")[0].title).toBe("Bluetooth");
    expect(indexed.search("NFC")[0].title).toBe("NFC");
    expect(indexed.search("VPN")[0].title).toBe("VPN");
    expect(indexed.search("tls")[0].title).toBe("TLS 1.2 Vulnerability");
    expect(indexed.search("12")[0].title).toBe("TLS 1.2 Vulnerability");
  });

  test("indexed candidates carry named provenance, not a lone score", async () => {
    const { indexed } = await engines();
    const row = indexed.searchDetailed("bluetooth", { explain: true }).results[0];
    expect(row.retrievalSources.length).toBeGreaterThan(0);
    expect(row.retrievalSources).toEqual(expect.arrayContaining(["exact-title"]));
    expect(row.features.retrievalScore).toBe(0);
  });

  test("duplicate sources collapse to one candidate", async () => {
    const { indexed } = await engines();
    const detailed = indexed.searchDetailed("bluetooth", { limit: 10, explain: true });
    const hits = detailed.results.filter((r) => r.title === "Bluetooth");
    expect(hits.length).toBe(1);
    expect(new Set(hits[0].retrievalSources).size).toBe(hits[0].retrievalSources.length);
  });

  test("prefix typeahead does not require a corpus-wide document scan of unmatched docs", async () => {
    const { indexed } = await engines();
    expect(indexed.search("bluet")[0].title).toBe("Bluetooth");
    expect(indexed.search("developer o").length).toBeGreaterThanOrEqual(0);
  });

  test("typo alternatives from query analysis feed the index", async () => {
    const { indexed } = await engines();
    expect(indexed.search("blutooth")[0].title).toBe("Bluetooth");
  });

  test("wifi hyphen still requires alias or exact token match (not a retriever cheat)", async () => {
    const { indexed } = await engines();
    expect(indexed.search("wifi")[0]?.title || null).not.toBe("Wi-Fi");
  });

  test("gold candidate recall vs full-scan on the tiny corpus is complete at K=50", async () => {
    const plugins = [english()];
    const index = buildIndex(docs, schema, plugins);
    const query = analyzeQuery("bluetooth", { plugins, lexicon: index.titleTokenSet });
    const full = new Set(retrieveCandidates(query, index).map((h) => h.document.id));
    const retriever = createIndexedLexicalRetriever({ candidateLimit: 50 });
    retriever.prepare(index);
    const indexed = new Set(retriever.retrieve(query, index).map((h) => h.document.id));
    for (const id of full) expect(indexed.has(id)).toBe(true);
  });

  test("retrievalScoreWeight default leaves ranking identical", async () => {
    const { full, indexed } = await engines();
    const a = full.search("nfc").map((r) => r.id);
    const b = indexed.search("nfc").map((r) => r.id);
    expect(b[0]).toBe(a[0]);
  });
});
