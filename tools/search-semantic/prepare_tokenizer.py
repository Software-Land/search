#!/usr/bin/env python3
"""Acquire the verified cl100k_base tokenizer in the persistent cache.

Uses the production loader. Does not call the embeddings API, require an API
key, install FastEmbed, or download embedding-model weights. A verified cache
hit does not contact the network.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lib.openai_embeddings import cl100k_tokenizer_bytes, tokenizer_cache_file


def main() -> None:
    destination = tokenizer_cache_file()
    if destination is None:
        raise SystemExit(
            "Refusing to prepare the cl100k_base tokenizer because the cache directory is empty. "
            "An empty TIKTOKEN_CACHE_DIR does not fall through to DATA_GYM_CACHE_DIR or "
            "build/search-semantic/tokenizers in the working directory, "
            "and an empty DATA_GYM_CACHE_DIR does not fall through when TIKTOKEN_CACHE_DIR is unset. "
            "Set TIKTOKEN_CACHE_DIR to a nonempty directory, or unset it and set DATA_GYM_CACHE_DIR, "
            "or unset both to use build/search-semantic/tokenizers under the current working directory. "
            "Preparation does not skip checksum validation."
        )
    data = cl100k_tokenizer_bytes()
    verified = destination.read_bytes()
    if verified != data:
        raise SystemExit(f"prepared tokenizer at {destination} does not match the verified bytes")
    print(f"prepared cl100k_base tokenizer at {destination} ({len(verified)} bytes)")


if __name__ == "__main__":
    main()
