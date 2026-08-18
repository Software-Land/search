"""Optional build-time embeddings. Vectors never leave the builder."""

from __future__ import annotations

import hashlib
from pathlib import Path


DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def cache_path(cache_dir: Path, model: str, doc_id: str, digest: str) -> Path:
    safe_model = model.replace("/", "__")
    safe_id = doc_id.replace("/", "_").replace("\\", "_")[:80]
    return cache_dir / safe_model / f"{digest}_{safe_id}.npy"


def _l2_normalize(vec):
    import numpy as np

    v = np.asarray(vec, dtype=np.float32).reshape(-1)
    n = float(np.linalg.norm(v))
    if n <= 0:
        return v
    return v / n


def _encode_fastembed(model_name: str, texts: list[str]):
    from fastembed import TextEmbedding

    model = TextEmbedding(model_name=model_name)
    dim = None
    rows = []
    for vec in model.embed(texts):
        v = _l2_normalize(vec)
        dim = int(v.shape[0])
        rows.append(v)
    return rows, dim, "fastembed"


def _encode_sentence_transformers(model_name: str, texts: list[str]):
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(model_name)
    dim = int(model.get_sentence_embedding_dimension())
    emb = model.encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    )
    return [_l2_normalize(row) for row in emb], dim, "sentence-transformers"


def _encode(model_name: str, texts: list[str]):
    errors = []
    try:
        return _encode_fastembed(model_name, texts)
    except Exception as exc:  # pragma: no cover - environment dependent
        errors.append(f"fastembed: {exc}")
    try:
        return _encode_sentence_transformers(model_name, texts)
    except Exception as exc:  # pragma: no cover
        errors.append(f"sentence-transformers: {exc}")
    raise SystemExit(
        "Embedding extras are required for --method embedding|combined.\n"
        "In an isolated venv: pip install -r tools/search-semantic/requirements-embed.txt\n"
        + "\n".join(errors)
    )


def load_or_embed(prepared: list[dict], *, model_name: str, cache_dir: Path):
    import numpy as np

    cache_dir.mkdir(parents=True, exist_ok=True)
    hits = 0
    to_encode = []
    to_encode_idx = []
    cached = [None] * len(prepared)
    dim = None

    for i, doc in enumerate(prepared):
        digest = content_hash(doc["text"])
        path = cache_path(cache_dir, model_name, doc["id"], digest)
        if path.exists():
            cached[i] = np.load(path)
            dim = int(cached[i].shape[0])
            hits += 1
        else:
            to_encode.append(doc["text"])
            to_encode_idx.append((i, path))

    backend = "cache-only"
    if to_encode:
        rows, emb_dim, backend = _encode(model_name, to_encode)
        dim = dim or emb_dim
        for row, (i, path) in zip(rows, to_encode_idx):
            cached[i] = np.asarray(row, dtype=np.float32)
            path.parent.mkdir(parents=True, exist_ok=True)
            np.save(path, cached[i])

    if dim is None:
        raise SystemExit("No documents to embed.")
    vectors = np.zeros((len(prepared), dim), dtype=np.float32)
    for i, row in enumerate(cached):
        vectors[i] = row
    meta = {
        "model": model_name,
        "backend": backend if to_encode else "cache",
        "dimensionality": dim,
        "normalization": "l2",
        "similarity": "cosine (dot of L2-normalized vectors)",
        "cacheHits": hits,
        "embeddedNow": len(to_encode),
        "note": "Model weights are downloaded into the builder cache, not shipped in the runtime artifact.",
    }
    return vectors, meta


def pairwise_embedding(ids: list[str], vectors) -> list[tuple[str, str, float]]:
    """Exact all-pairs cosine of L2-normalized rows. Separate from embedding generation."""
    sim = vectors @ vectors.T
    n = len(ids)
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            s = float(sim[i, j])
            if s > 0:
                pairs.append((ids[i], ids[j], s))
    return pairs
