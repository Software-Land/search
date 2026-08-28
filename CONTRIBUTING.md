# Contributing

Issues, discussion, and documentation feedback are welcome. This is a small
pre-1.0 search runtime. Keep changes focused.

## Contributor terms

The project [LICENSE](LICENSE) governs **use** of Software.Land's released
code. It does not by itself give Software.Land the right to include outside
code in separately licensed commercial distributions. See
[COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md).

- Issues, discussion, bug reports, and documentation suggestions may be
  submitted in the ordinary way.
- External **code** contributions are reviewed, but Software.Land will not
  merge them until appropriate contributor terms covering commercial relicensing
  have been accepted.
- Submitting code solely under Business Source License 1.1 is not sufficient
  for acceptance.
- Software.Land may require a contributor license agreement or equivalent
  contributor-rights agreement before accepting code. No such agreement is
  published in this repository yet.

Versions through 0.4.0 remain Apache-2.0.

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
