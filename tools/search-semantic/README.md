# search-semantic (optional build-time compiler)

Offline compiler that emits the existing search relationship artifact:

```text
corpus JSON
  → document preparation
  → relationship signal providers (lexical | embedding | combined)
  → directed top-K + threshold
  → optional precision gate (prefix false-friends, contrastive vs-pairs)
  → optional mutual-neighbor filter
  → search-relationships artifact, schema version 1
```

The search runtime must not import this package. A user can run Search Core with **zero** relationship artifact.

This directory ships in the npm tarball. The runtime import graph still does not include it. Use `@software-land/search/semantic` from Node build scripts.

## Setup

Lexical baseline (stdlib only):

```bash
python3 tools/search-semantic/build.py \
  --input corpus.json \
  --method lexical \
  --top-k 5 \
  --min-score 0.2 \
  --output graph.json
```

Embeddings (isolated venv — do not add these to the JavaScript runtime):

```bash
python3 -m venv tools/search-semantic/.venv
tools/search-semantic/.venv/bin/pip install -r tools/search-semantic/requirements-embed.txt
```

Model weights are **downloaded** into the builder cache (`tools/search-semantic/.cache/`), not redistributed and never written into the runtime JSON.

The builder core accepts portable `{id,title,body}` documents. `build.py` is the public CLI.

## Default embedding model

| Field | Value |
| --- | --- |
| Model | `sentence-transformers/all-MiniLM-L6-v2` |
| Dimensionality | 384 |
| Normalization | L2 |
| Similarity | cosine (dot of normalized vectors) |
| Pairwise | exact all-pairs (no ANN) |
| Typical backend | FastEmbed / ONNX Runtime |

See `LICENSES.md` (descriptive, not legal advice): model Apache-2.0; weights downloaded; FastEmbed Apache-2.0; ONNX Runtime MIT.

## Neighbor selection

Directed top-K **and** a minimum score. Documents with no strong neighbor get an empty list. Cosine is symmetric; top-K lists are not forced-symmetric unless `--mutual` is chosen.

`--precision-gate` drops prefix false-friends (IoT ↔ IO) and contrastive `vs` pairs that share no content token of length ≥ 4. `--mutual` then keeps A→B only when B also retains A. Both default off.

## OpenAI provider

`--embedding-provider openai` is opt-in. The default remains FastEmbed, including when `OPENAI_API_KEY` is unset or present. The initial OpenAI configuration is `text-embedding-3-large` and 3072 dimensions. `text-embedding-3-small` requires `--dimensions`. `text-embedding-ada-002` always returns 1536 dimensions: omit `--dimensions` or pass 1536. The Ada request does not include a `dimensions` field. Any other Ada dimension is rejected before a request.

```bash
OPENAI_API_KEY=... python3 tools/search-semantic/build.py \
  --input corpus.json \
  --method embedding \
  --embedding-provider openai \
  --model text-embedding-3-large \
  --dimensions 3072 \
  --top-k 5 \
  --min-score 0.3 \
  --cache-dir .cache/openai \
  --output graph.json
```

From the Node launcher, the same flags are `--embedding-provider`, `--model`, `--dimensions`, and `--openai-api-base`. `compileSemantic` accepts `embeddingProvider`, `model`, `dimensions`, `apiKey`, and `apiBase`.

Requests stay inside the Embeddings API limits (2048 inputs, 8192 tokens per input, 300,000 tokens per request). Counts for `text-embedding-3-large`, `text-embedding-3-small`, and `text-embedding-ada-002` use `cl100k_base`. The Node launcher and this CLI share one Python implementation. The rank file is not in the repository or the npm package. The first time uncached inputs need a count, the builder downloads `https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken` directly, with a 60-second timeout. That request does not send `OPENAI_API_KEY` and does not use `--openai-api-base`. The bytes are cached only after SHA-256 matches `223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7`. The default directory is `build/search-semantic/tokenizers/` under the working directory of the command. Direct Python builds and `prepare_tokenizer.py` use that process working directory. The Node launcher records it before asynchronous setup and passes an absolute path, because Python is started inside the installed package. Set `TIKTOKEN_CACHE_DIR` to move the cache. A nonempty relative value is resolved against that same working directory; an absolute value stays absolute. An empty `TIKTOKEN_CACHE_DIR` does not store the file and does not skip the checksum. `DATA_GYM_CACHE_DIR` applies only when `TIKTOKEN_CACHE_DIR` is unset. The cache file name is the SHA-1 of the asset URL, `9b5ad71b2ce5302211f9c61530b329a4922fc6a4`, which is the same key tiktoken uses. To prewarm a machine that cannot download during the build, copy a verified file to `build/search-semantic/tokenizers/9b5ad71b2ce5302211f9c61530b329a4922fc6a4` in the project directory, or set `TIKTOKEN_CACHE_DIR` to a directory that already holds that file. Deleting the project’s `build` directory removes the ranks, so the next count that needs them acquires the file again. The cache is separate from temporary compilation output and from embedding-vector caches. `python3 tools/search-semantic/prepare_tokenizer.py` acquires and verifies the same cache. It does not need an API key, and a verified file already in the cache is not downloaded again. A verified cache hit does not contact the network. A failed download or a checksum mismatch stops before any embeddings request and leaves an existing output file unchanged. A model without that mapping fails before any request. The builder budget is 250,000 counted tokens per request. Special-token-like strings in document text are counted as ordinary text. Embedding-3 requests include `dimensions`. The Ada request omits it and still checks every returned vector against 1536. Transient HTTP failures retry up to five times. Response rows are reordered by `index`. Vectors are checked for coverage, dimension, and finite values, then L2-normalized. Pairwise cosine, top-K, the precision gate, mutual filtering, and artifact serialization are the existing compiler steps.

Cache files are named by a hash of provider, model, dimensions, preparation revision, and the exact prepared text. A cache hit does not call the API. The relationship JSON does not contain vectors or the API key. If generation fails, an existing output file is left unchanged and FastEmbed is not run as a substitute.

`min-score` is the caller's choice. Evaluate it again when the model changes. This package does not ship a corpus-specific threshold.

The OpenAI path installs `requirements-openai.txt` (NumPy and tiktoken) into the builder venv. It does not install FastEmbed and does not download a local embedding model. FastEmbed also uses NumPy, through `requirements-embed.txt`. tiktoken is only installed for the OpenAI path. The tokenizer ranks are a separate public download, cached under `build/search-semantic/tokenizers/` in the project directory unless `TIKTOKEN_CACHE_DIR` is set. Deleting the project’s `build` directory requires the ranks to be acquired again the next time a count needs them. Before `npm test` or `npm run test:python`, install this requirements file and run `python3 tools/search-semantic/prepare_tokenizer.py` from that same project directory. Those test commands use the prepared file and do not download it. On a restricted network, copy the verified ranks into the cache path above and run that same prepare command. A live embeddings request is not part of the default test run. Set `SEARCH_SEMANTIC_OPENAI_LIVE=1` only when you intend to call the API.
