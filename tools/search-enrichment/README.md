# search-enrichment (optional build-time helper)

Provider-agnostic lexical review for search-corpus candidates. **Not** Search Core. Never writes `decisions.json`. `compileCorpus` stays deterministic.

```js
import { enrichCorpus, createFunctionProvider } from "@software-land/search/enrichment";

const result = await enrichCorpus(corpus, {
  provider: createFunctionProvider((request) => ({
    schemaVersion: "search-enrichment-inference-v1",
    proposals: [
      {
        key: request.key,
        expansion: request.minedExpansion,
        relation: "initialism",
        ambiguous: false,
        alternatives: [],
      },
    ],
  })),
  autoAcceptVerified: false,
});
```

`autoAcceptVerified` is off by default. Model-only proposals never auto-accept. When enabled, auto-accept requires a mined or document-attested candidate, strong independent deterministic corpus evidence, a strict initials relationship, corpus occurrence of both key and expansion, no viable competing expansion (including pending rivals), and exact unambiguous model agreement. Model numeric `confidence` is diagnostic only. Provenance is `verified-enrichment` (`AUTO_ACCEPTED`), not `HUMAN_ACCEPTED`.

`enrichCorpus` also runs bounded per-document `discover-equivalences` (default on). Each request carries a truncated title/context, observed acronym surfaces, and optional known equivalences — never the whole corpus. One-sided model proposals stay `REVIEW_PENDING`. Discovery calls use the same cache identity (bounded input + provider/model + prompt/schema versions + inference params; no secrets). Disable with `discover: false`. Caps: `maxContextChars`, `maxDiscoveryProposals`, `maxDiscoveryDocuments`.

Expansion-only helper requests (attested phrase, no mined key) still use `requestFromPhrase` / task `propose-expansion`. The compiler does not enumerate corpus n-grams into invented keys.

```bash
node tools/search-enrichment/build.mjs enrich --input corpus.json --output dir \
  --provider openai-compat --base-url http://127.0.0.1:8000/v1 --model local-model
```

HTTP auth is opt-in via explicit `--api-key`. The CLI does not read `SEARCH_ENRICHMENT_API_KEY` or `OPENAI_API_KEY`. There is no default hosted endpoint.
