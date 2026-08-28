# Contributing

Issues and pull requests are welcome. This is a small pre-1.0 search runtime. Keep changes focused.

## Before substantial work

Open an issue first for public API changes, ranking/constraint changes, or retrieval policy changes. Small bugfixes and docs do not need that.

## What belongs here

- Deterministic, model-free runtime search. Do not add query-time neural, embedding, or LLM dependencies.
- Neural / semantic / lemma-model tooling stays at **build time**. Core consumes data (`Record<string, string>` lemmas, compiled artifacts), not those generators.
- Ranking changes need regression evidence (existing exact-order tests, Software.Land real-corpus contracts/regressions, or a newly justified case). Do not retune scores or boosts against the toy relevance fixture.
- Do not expose internal analyzed-query, feature-vector, or index representations without a compatibility reason.
- Software.Land fixtures under `test/fixtures/software-land/` are production-derived test data, not default package policy. Historical `expectedTop` / `titlePrefix` / `topN` rows are executable Software.Land relevance contracts in `test/software-land-historical-relevance.test.js`. They are not Core default ranking policy and are not the exact-output oracle.

## Tests

Include tests for the behavior you change. Ranking and retrieval changes should not weaken:

- exact-order SCC tests
- the 98 strict V2 + 60 regression Software.Land cases
- the Software.Land historical relevance suite (`expectedTop` / `titlePrefix` membership). That suite may be red while known relevance gaps remain; do not skip or rewrite those contracts to go green.

## Development commands

From `package.json`:

```bash
npm install
npm run build
npm run typecheck
npm run test:types
npm test
npm run test:js
npm run test:python
npm run example
npm run smoke:import
npm run smoke:pack
```

`npm test` runs the Jest suite and the Python semantic-compiler unit tests. A checkout needs `npm run build` before runtime tests.

Development-only workloads (not npm scripts, not in the tarball):

```bash
node --expose-gc benchmarks/memory/run.mjs --mode routine
node benchmarks/ranking/run.mjs
node benchmarks/relevance/run.mjs
```

Document new performance workloads next to those harnesses. Builtin ranking is sparse in the constraint-signature count; worst case remains Θ(C²) in the **candidate** count C. Corpus size N is a retrieval problem. Do not present full-scan of a large high-DF corpus as scalable ranking.

Chromium Worker coverage lives in `test/chromium-pack/` and is isolated from root runtime dependencies. Playwright is not a production dependency.

## License

Contributions are under the current [LICENSE](LICENSE) (Business Source License 1.1 for 0.5.0+). See also [COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md). Versions through 0.4.0 remain Apache-2.0.
