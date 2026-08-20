# Build-time tools

Search Core never imports these. Runtime users should not pay for them.

`npm run typecheck` typechecks Core, the browser Worker/client, TypeScript-migrated tools (`tools/search-lexical`, `tools/search-relationships`), and the remaining Node JS compilers (`tools/search-corpus`, `tools/search-semantic/index.js`) after `npm run build` (runtime JS is emitted to `dist/`; root and browser public declarations are generated into `dist/*.d.ts`; lexical and relationships JS/DTS are emitted beside their TypeScript source). The Python sources under `tools/search-semantic/lib` stay outside `tsc`. `npm run test:types` compiles consumer fixtures in `test/types/` against the public `package.json` `exports.types` surface after the same build.

## search-corpus (`tools/search-corpus`)

Lexical / domain compiler + durable review workflow.

```text
corpus JSON → analyze → inspection + pending queue
                         durable decisions.json  (source-controlled)
                         compile → equivalences.json + synonyms.json
```

Generated candidates are **not** runtime truth. Only trusted decisions (`AUTO_ACCEPTED` / human accept / explicit manual) enter artifacts, per current compiler semantics.

```bash
node tools/search-corpus/build.mjs analyze --input corpus.json --output dir
node tools/search-corpus/build.mjs compile --input corpus.json --output dir --decisions decisions.json
node tools/search-corpus/build.mjs review --pending --output dir
```

Public entry: `compileCorpus` / `analyzeCorpus` from `@software-land/search/corpus`. Internal miners are not a supported app API.

## search-lexical (`tools/search-lexical`)

Build-time integer n-gram counts (unigrams and short phrases) from the **body field only**, in the same tokenize → lemma → stop-strip → contiguous 1–2 gram space as Search Core phrase lookup. Title and body are never concatenated, so n-grams cannot span the title/body boundary. Duplicate document ids follow SearchEngine.index (last document wins) **before** collection counts. Policy `minN`, `maxN`, and `minCollectionCount` must be finite positive integers with `maxN >= minN`. Public entry: `compileLexicalFrequency` from `@software-land/search/lexical`. The runtime never imports this tool; it consumes `document.lexicalFrequency` maps produced by `attachLexicalFrequency`.

## search-semantic (`tools/search-semantic`)

Optional Python builder, shipped in the npm package: documents → offline embeddings or lexical neighbors → optional precision gate and mutual-neighbor filter → `search-v2-relationships` v1. Public Node entry: `compileSemantic` from `@software-land/search/semantic` (`precisionGate`, `mutual`). Search Core never imports this. Default embedding experiment used `all-MiniLM-L6-v2` as **tooling config**, not a Core API. See `tools/search-semantic/LICENSES.md`. Model weights are downloaded separately into a builder cache.

## search-relationships (`tools/search-relationships`)

Merges semantic graph + domain decisions. Stable relationship identity, direction, provenance, reject/conflict/orphan handling. Unreviewed editorial candidates do not enter the default runtime artifact.

```bash
node tools/search-relationships/build.mjs compile \
  --input corpus.json --decisions decisions.json \
  --semantic relationships-from-builder.json --output dir
```
