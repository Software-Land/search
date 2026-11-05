# Licenses (descriptive, not legal advice)

This package is optional build-time tooling. Model weights are downloaded into
`tools/search-semantic/.cache/` and are **not** redistributed in git or in the
search runtime artifact.

| Component | Typical license | Notes |
| --- | --- | --- |
| Builder code in this directory | BUSL-1.1 (this repository's LICENSE) | Stdlib lexical path has no extra deps |
| NumPy | BSD | FastEmbed and the optional OpenAI embedding path |
| tiktoken | MIT | Optional OpenAI token counting only. `cl100k_base` ranks are not redistributed. The first count downloads `https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken` and keeps it only when SHA-256 is `223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7`. The default cache is `build/search-semantic/tokenizers/` in the caller’s working directory. Deleting that project’s `build` directory requires the ranks to be acquired again. |
| FastEmbed | Apache-2.0 | Embedding path only |
| ONNX Runtime | MIT | Transitive via FastEmbed |
| `sentence-transformers/all-MiniLM-L6-v2` | Apache-2.0 | [Hugging Face model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2). Weights downloaded, not vendored. |
| OpenAI Embeddings API | OpenAI terms | Optional provider. No SDK and no local weights. Vectors are cached by the builder and are not written into the runtime artifact. |

The published Search Core runtime does not depend on any of the embedding stack.
