# Build-time tools

Search Core never imports these. Runtime users should not pay for them.

`npm run typecheck` typechecks Core, the browser Worker/client, and the Node JS compilers (`tools/search-corpus`, `tools/search-relationships`) under isolated `checkJs` projects. The Python semantic builder (`tools/search-semantic`) is excluded.

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

Public entry: `compileCorpus` / `analyzeCorpus` from `software-land-search/corpus`. Internal miners are not a supported app API.

## search-semantic (`tools/search-semantic`)

Optional Python builder: documents → offline embeddings or lexical neighbors → `search-v2-relationships` v1. No runtime model. Default embedding experiment used `all-MiniLM-L6-v2` as **tooling config**, not a Core API. See `tools/search-semantic/LICENSES.md`. Model weights are downloaded separately into `.cache/`.

## search-relationships (`tools/search-relationships`)

Merges semantic graph + domain decisions. Stable relationship identity, direction, provenance, reject/conflict/orphan handling. Unreviewed editorial candidates do not enter the default runtime artifact.

```bash
node tools/search-relationships/build.mjs compile \
  --input corpus.json --decisions decisions.json \
  --semantic relationships-from-builder.json --output dir
```
