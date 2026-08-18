# search-semantic (optional build-time compiler)

Offline compiler that emits the existing Search V2 relationship artifact:

```text
corpus JSON
  → document preparation
  → relationship signal providers (lexical | embedding | combined)
  → directed top-K + threshold
  → search-v2-relationships v1
```

Search V2 runtime must not import this package. A user can run search-core with **zero** relationship artifact.

This directory is **not** part of the npm import graph.

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

The builder core accepts portable `{id,title,body}` documents. `build.py` is the public CLI. Investigation-era experiment drivers are not part of this tree.

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
