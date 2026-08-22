/**
 * Tiny catalog demo. No host catalog required.
 * Run: npm run example
 * (requires npm run build so dist/ exists)
 */
import { SearchEngine, morphology, dictionary } from "../../dist/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const documents = [
  { id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks." },
  { id: "bluetooth", title: "Bluetooth", body: "Connect wireless accessories." },
  { id: "connected-devices", title: "Connected devices", body: "Bluetooth, NFC, and USB accessories." },
  { id: "nfc", title: "NFC", body: "Tap and pay." },
  { id: "vpn", title: "VPN", body: "Virtual private network." },
];

const engine = SearchEngine.create({
  schema,
  plugins: [
    morphology(),
    dictionary({
      entries: [
        { key: "wifi", expansion: ["wi", "fi"], aliases: [["wi", "fi"]] },
        { key: "api", expansion: ["application", "programming", "interface"] },
      ],
    }),
  ],
  retriever: "adaptive",
  adaptive: { documentThreshold: 1500 },
  relationshipStrategy: "separate",
  relationships: {
    format: "search-v2-relationships",
    version: 1,
    relationships: {
      bluetooth: [
        { target: "connected-devices", type: "editorial", strength: 1, provenance: "manual" },
      ],
    },
  },
});

await engine.index(documents);

function show(label, query) {
  const { results, related } = engine.searchDetailed(query, { limit: 5, relatedLimit: 3, explain: true });
  console.log(`\n## ${label}  (${JSON.stringify(query)})`);
  for (const r of results) {
    console.log(`  ${r.rank}. ${r.title}  [${r.relevanceKind}/${r.directClass}]  sources=${(r.retrievalSources || []).join(",")}`);
  }
  if (related.length) {
    console.log("  related:");
    for (const r of related) console.log(`    - ${r.title} (${r.relationship?.type})`);
  }
}

show("direct", "bluetooth");
show("alias", "wifi");
show("literal", "NFC");
show("without alias this would miss hyphenated titles", "wireless");

const explained = engine.searchDetailed("bluetooth", { explain: true, limit: 1 });
JSON.stringify(explained.results[0].explanation);
console.log("\nexplanation JSON-serializable: ok");
