# Licenses (descriptive, not legal advice)

This package is optional build-time tooling. Model weights are downloaded into
`tools/search-semantic/.cache/` and are **not** redistributed in git or in the
Search V2 runtime artifact.

| Component | Typical license | Notes |
| --- | --- | --- |
| Builder code in this directory | Apache-2.0 (same as this repository) | Stdlib lexical path has no extra deps |
| NumPy | BSD | Embedding path only |
| FastEmbed | Apache-2.0 | Embedding path only |
| ONNX Runtime | MIT | Transitive via FastEmbed |
| `sentence-transformers/all-MiniLM-L6-v2` | Apache-2.0 | [Hugging Face model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2). Weights downloaded, not vendored. |

The JavaScript runtime (`src/`) does not depend on any of the embedding stack.
