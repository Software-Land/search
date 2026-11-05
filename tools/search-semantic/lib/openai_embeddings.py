"""Optional offline OpenAI embeddings.

Imported only when the embedding provider is ``openai``. The default FastEmbed
provider does not import this module. No credential is written to a cache file,
report, or relationship artifact. A failure does not call another provider.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import struct
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

OPENAI_EMBEDDING_MODEL = "text-embedding-3-large"
OPENAI_EMBEDDING_DIMENSIONS = 3072
ADA_EMBEDDING_MODEL = "text-embedding-ada-002"
ADA_EMBEDDING_DIMENSIONS = 1536
OPENAI_EMBEDDING_LIMITS = {
    "maxInputsPerRequest": 2048,
    "maxTokensPerInput": 8192,
    "maxTokensPerRequest": 300_000,
}
BATCH_INPUTS = 64
BATCH_TOKEN_BUDGET = 250_000
MAX_ATTEMPTS = 5
# text-embedding-3-* and ada-002 use cl100k_base. The ranks are downloaded from
# the public encodings asset the first time token counting needs them.
# tiktoken's read_file_cached is not used: it depends on requests, has no
# timeout, stores the default cache in the temporary directory, and skips the
# checksum when the cache directory is disabled. The cache key matches tiktoken.
# TIKTOKEN_CACHE_DIR, then DATA_GYM_CACHE_DIR when the first variable is unset,
# match its lookup. An empty value disables persistence and does not fall
# through. The default directory does not match tiktoken: it is
# <working-directory>/build/search-semantic/tokenizers, from the process
# working directory when the path is resolved. It is not this file's location.
CL100K_URL = "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken"
CL100K_SHA256 = "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7"
TOKENIZER_DOWNLOAD_TIMEOUT_SEC = 60
CL100K_PAT_STR = (
    r"""'(?i:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?+\p{L}++|\p{N}{1,3}+| ?[^\s\p{L}\p{N}]++[\r\n]*+|\s++$|\s*[\r\n]|\s+(?!\S)|\s"""
)
CL100K_SPECIAL_TOKENS = {
    "<|endoftext|>": 100257,
    "<|fim_prefix|>": 100258,
    "<|fim_middle|>": 100259,
    "<|fim_suffix|>": 100260,
    "<|endofprompt|>": 100276,
}
MODEL_ENCODINGS = {
    "text-embedding-3-large": "cl100k_base",
    "text-embedding-3-small": "cl100k_base",
    "text-embedding-ada-002": "cl100k_base",
}
_ENCODINGS: dict[str, object] = {}
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}
DEFAULT_API_BASE = "https://api.openai.com/v1"
DEFAULT_TIMEOUT_SEC = 120

_SECRET_RE = re.compile(r"sk-[A-Za-z0-9_-]+|Bearer\s+\S+", re.IGNORECASE)


def redact(value: object) -> str:
    return _SECRET_RE.sub("[redacted]", str(value or ""))


def _directory_setting(value: str) -> Path | None:
    """Resolve one override against the process working directory.

    Empty disables persistence. Absolute paths stay absolute. Relative paths
    resolve from the current working directory, which is the caller's
    directory for a direct Python invocation.
    """
    if value == "":
        return None
    return Path(os.path.abspath(value))


def default_tokenizer_cache_dir() -> Path:
    """Project-local ranks cache for the process working directory.

    Separate from temporary compilation output and from the installed package
    location. Deleting the project's build directory removes it.
    """
    return Path(os.path.abspath(os.path.join("build", "search-semantic", "tokenizers")))


def tokenizer_cache_dir() -> Path | None:
    """Return the directory that holds the verified ranks file.

    ``TIKTOKEN_CACHE_DIR`` is tiktoken's cache setting. ``DATA_GYM_CACHE_DIR``
    is its older name and is used only when the first variable is unset.
    An empty value disables persistence. It does not disable checksum checks
    and it does not fall through to another directory.
    """
    if "TIKTOKEN_CACHE_DIR" in os.environ:
        return _directory_setting(os.environ["TIKTOKEN_CACHE_DIR"])
    if "DATA_GYM_CACHE_DIR" in os.environ:
        return _directory_setting(os.environ["DATA_GYM_CACHE_DIR"])
    return default_tokenizer_cache_dir()


def tokenizer_cache_name() -> str:
    """tiktoken names the cache file with the SHA-1 of the asset URL."""
    return hashlib.sha1(CL100K_URL.encode()).hexdigest()


def tokenizer_cache_file() -> Path | None:
    directory = tokenizer_cache_dir()
    if directory is None:
        return None
    return directory / tokenizer_cache_name()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ranks_from_tokenizer_bytes(data: bytes) -> dict[bytes, int]:
    digest = _sha256(data)
    if digest != CL100K_SHA256:
        raise SystemExit(
            f"cl100k_base tokenizer hash {digest} does not match {CL100K_SHA256}. "
            "Token limits are not estimated and the file was not used."
        )
    ranks: dict[bytes, int] = {}
    for line in data.splitlines():
        if not line:
            continue
        token, rank = line.split()
        ranks[base64.b64decode(token)] = int(rank)
    if len(ranks) != 100256:
        raise SystemExit(f"cl100k_base tokenizer has {len(ranks)} ranks, expected 100256")
    return ranks


def _read_verified_tokenizer(path: Path) -> bytes | None:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError:
        return None
    if _sha256(data) != CL100K_SHA256:
        return None
    return data


def publish_verified_tokenizer(path: Path, data: bytes) -> None:
    """Atomically publish verified ranks. A concurrent verified publish is success."""
    if _sha256(data) != CL100K_SHA256:
        raise SystemExit(
            f"refusing to cache cl100k_base tokenizer hash {_sha256(data)}; expected {CL100K_SHA256}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".partial", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        if _read_verified_tokenizer(path) is not None:
            return
        raise
    if _read_verified_tokenizer(path) is None:
        raise SystemExit(f"cached cl100k_base tokenizer at {path} failed checksum validation")


def _tokenizer_download_failure(exc: Exception) -> SystemExit:
    """Describe a failed ranks download using the loader's selected cache.

    The Node wrapper starts Python in the installed package, so the guidance
    must not assume that the process working directory is the project. An empty
    override selects no directory and must not name one the loader ignores.
    """
    destination = tokenizer_cache_file()
    if destination is None:
        guidance = (
            "No persistent tokenizer cache is selected, so the download cannot be stored. "
            "An empty TIKTOKEN_CACHE_DIR does not fall through to DATA_GYM_CACHE_DIR or any other directory, "
            "and an empty DATA_GYM_CACHE_DIR does not fall through when TIKTOKEN_CACHE_DIR is unset. "
            "Choose a nonempty directory and set TIKTOKEN_CACHE_DIR to it, "
            "or unset TIKTOKEN_CACHE_DIR and set DATA_GYM_CACHE_DIR to a nonempty directory, "
            "or unset both before starting the command. "
            "Then restore download access or prewarm that selected cache, and rerun the original build command."
        )
    else:
        guidance = (
            f"Copy the verified tokenizer file to {destination}, then rerun the original build command."
        )
    return SystemExit(
        "Could not download the cl100k_base tokenizer from "
        f"{CL100K_URL}. Token limits are not estimated, text is not truncated, "
        "and no embedding request is sent. "
        f"{guidance} "
        f"{redact(exc)}"
    )


def _download_cl100k_tokenizer() -> bytes:
    request = urllib.request.Request(
        CL100K_URL,
        headers={"User-Agent": "software-land-search-openai-builder"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=TOKENIZER_DOWNLOAD_TIMEOUT_SEC) as response:
            data = response.read()
    except Exception as exc:
        raise _tokenizer_download_failure(exc) from exc
    digest = _sha256(data)
    if digest != CL100K_SHA256:
        raise SystemExit(
            f"downloaded cl100k_base tokenizer hash {digest} does not match {CL100K_SHA256}. "
            "The download was not cached, token limits are not estimated, and no embedding request is sent."
        )
    return data


def cl100k_tokenizer_bytes() -> bytes:
    """Return verified cl100k_base ranks, from the persistent cache or one public download.

    Importing this module does not call this function. Cached embedding vectors
    do not call it either.
    """
    path = tokenizer_cache_file()
    if path is not None:
        cached = _read_verified_tokenizer(path)
        if cached is not None:
            return cached
    data = _download_cl100k_tokenizer()
    if path is None:
        return data
    publish_verified_tokenizer(path, data)
    published = _read_verified_tokenizer(path)
    if published is None:
        raise SystemExit(f"cached cl100k_base tokenizer at {path} failed checksum validation")
    return published


def encoding_name_for_model(model: str) -> str:
    name = MODEL_ENCODINGS.get(model)
    if name:
        return name
    supported = ", ".join(sorted(MODEL_ENCODINGS))
    raise SystemExit(
        f"OpenAI model {model!r} has no supported tokenizer, so input and request token limits cannot be enforced. "
        f"Supported models: {supported}. "
        "This does not estimate tokens, truncate input, or fall back to another provider."
    )


def encoding_for_model(model: str):
    name = encoding_name_for_model(model)
    cached = _ENCODINGS.get(name)
    if cached is not None:
        return cached
    if name != "cl100k_base":
        raise SystemExit(f"tokenizer {name} is not available")
    try:
        import tiktoken
    except ImportError as exc:
        raise SystemExit(
            "OpenAI token limits need tiktoken. "
            "Install tools/search-semantic/requirements-openai.txt in the builder environment. "
            "This does not fall back to another provider."
        ) from exc
    ranks = ranks_from_tokenizer_bytes(cl100k_tokenizer_bytes())
    encoding = tiktoken.Encoding(
        name="cl100k_base",
        pat_str=CL100K_PAT_STR,
        mergeable_ranks=ranks,
        special_tokens=CL100K_SPECIAL_TOKENS,
    )
    _ENCODINGS[name] = encoding
    return encoding


def count_tokens(text: str, model: str = OPENAI_EMBEDDING_MODEL) -> int:
    """Count tokens the embeddings tokenizer assigns to ordinary document text.

    Special-token-like strings stay ordinary text. They are not rejected and
    they are not collapsed into a single special-token id.
    """
    return len(encoding_for_model(model).encode_ordinary(text))


def cache_key(*, model: str, dimensions: int, preprocessing: str, text: str) -> str:
    material = "\n".join(["openai", model, str(dimensions), preprocessing, text])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def vector_cache_path(cache_dir: Path, key: str) -> Path:
    return cache_dir / "openai" / f"{key}.npy"


def _l2_normalize(values: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in values))
    if norm <= 0:
        raise SystemExit("OpenAI returned a zero vector")
    return [value / norm for value in values]


def write_float32_npy(path: Path, values: list[float]) -> None:
    payload = struct.pack(f"<{len(values)}f", *values)
    header_body = "{'descr': '<f4', 'fortran_order': False, 'shape': (%d,), }" % len(values)
    pad = (64 - ((10 + len(header_body.encode("latin1")) + 1) % 64)) % 64
    header = (header_body + (" " * pad) + "\n").encode("latin1")
    prefix = b"\x93NUMPY" + bytes((1, 0)) + struct.pack("<H", len(header))
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".partial", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(prefix + header + payload)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def read_float32_npy(path: Path, dimensions: int) -> list[float]:
    blob = path.read_bytes()
    if len(blob) < 10 or blob[1:6] != b"NUMPY":
        raise SystemExit(f"cache file is not an npy vector: {path.name}")
    major = blob[6]
    if major == 1:
        header_len = struct.unpack_from("<H", blob, 8)[0]
        header_start = 10
    else:
        header_len = struct.unpack_from("<I", blob, 8)[0]
        header_start = 12
    data = blob[header_start + header_len :]
    if len(data) != dimensions * 4:
        raise SystemExit(f"cached vector byte length {len(data)} does not match {dimensions} float32 values")
    return list(struct.unpack(f"<{dimensions}f", data))


def validate_vector(values: list[float], dimensions: int, label: str) -> None:
    if len(values) != dimensions:
        raise SystemExit(f"{label} vector length {len(values)} != {dimensions}")
    for index, value in enumerate(values):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise SystemExit(f"{label} vector has a non-finite value at {index}")


def batches_of(items: list[dict], model: str = OPENAI_EMBEDDING_MODEL) -> list[list[dict]]:
    batches: list[list[dict]] = []
    current: list[dict] = []
    tokens = 0
    limit = OPENAI_EMBEDDING_LIMITS["maxTokensPerInput"]
    budget = min(BATCH_TOKEN_BUDGET, OPENAI_EMBEDDING_LIMITS["maxTokensPerRequest"])
    encoding = encoding_for_model(model)
    for item in items:
        count = len(encoding.encode_ordinary(item["text"]))
        if count > limit:
            raise SystemExit(
                f"input for {item['id']} is {count} tokens, above the {limit} token embeddings limit"
            )
        overflow = (
            len(current) >= BATCH_INPUTS
            or len(current) >= OPENAI_EMBEDDING_LIMITS["maxInputsPerRequest"]
            or tokens + count > budget
        )
        if current and overflow:
            batches.append(current)
            current = []
            tokens = 0
        current.append(item)
        tokens += count
    if current:
        batches.append(current)
    return batches


def _default_transport(url: str, payload: dict, timeout: float, api_key: str):
    class _RejectRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise urllib.error.HTTPError(req.full_url, code, f"redirect refused: {code}", headers, fp)

    opener = urllib.request.build_opener(_RejectRedirect)
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers.items()), exc.read()


def _retry_delay(attempt: int, headers: dict) -> float:
    raw = None
    for key, value in headers.items():
        if str(key).lower() == "retry-after":
            raw = value
            break
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        seconds = -1
    if seconds >= 0:
        return min(seconds, 20)
    return min(0.5 * (2**attempt), 8)


def _embed_batch(*, batch, api_key, api_base, model, dimensions, transport, sleeper, timeout):
    url = api_base.rstrip("/") + "/embeddings"
    payload = {
        "model": model,
        "input": [item["text"] for item in batch],
        "encoding_format": "float",
    }
    # text-embedding-ada-002 rejects the dimensions parameter. Its output size is fixed.
    if model != ADA_EMBEDDING_MODEL:
        payload["dimensions"] = dimensions
    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            status, headers, raw = transport(url, payload, timeout, api_key)
        except Exception as exc:
            last_error = SystemExit(f"OpenAI embeddings request failed: {redact(exc)}")
            if attempt == MAX_ATTEMPTS - 1:
                raise last_error
            sleeper(_retry_delay(attempt, {}))
            continue
        if status != 200:
            body = redact(raw.decode("utf-8", errors="replace"))[:300]
            last_error = SystemExit(f"OpenAI embeddings HTTP {status}: {body}")
            if status not in RETRYABLE_STATUS or attempt == MAX_ATTEMPTS - 1:
                raise last_error
            sleeper(_retry_delay(attempt, headers or {}))
            continue
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"OpenAI embeddings returned invalid JSON: {redact(exc)}") from exc
        rows = parsed.get("data") if isinstance(parsed, dict) else None
        if not isinstance(rows, list) or len(rows) != len(batch):
            raise SystemExit(f"OpenAI embeddings returned {0 if not isinstance(rows, list) else len(rows)} vectors for {len(batch)} inputs")
        ordered: list[list[float] | None] = [None] * len(batch)
        for row in rows:
            index = row.get("index") if isinstance(row, dict) else None
            if isinstance(index, bool) or not isinstance(index, int) or index < 0 or index >= len(batch) or ordered[index] is not None:
                raise SystemExit("OpenAI embeddings response index does not align with the request batch")
            embedding = row.get("embedding")
            if not isinstance(embedding, list):
                raise SystemExit(f"{batch[index]['id']} vector is missing")
            validate_vector(embedding, dimensions, batch[index]["id"])
            ordered[index] = [float(value) for value in embedding]
        response_model = str(parsed.get("model") or model)
        if not response_model.startswith(model):
            raise SystemExit(f"OpenAI returned model {response_model}, expected {model}")
        usage = parsed.get("usage") or {}
        prompt_tokens = usage.get("prompt_tokens", usage.get("total_tokens", 0))
        try:
            prompt_tokens = int(prompt_tokens or 0)
        except (TypeError, ValueError):
            prompt_tokens = 0
        return {"vectors": ordered, "model": response_model, "promptTokens": prompt_tokens}
    raise last_error or SystemExit("OpenAI embeddings request failed")


def _resolve_dimensions(model: str, dimensions: int | None) -> int:
    encoding_name_for_model(model)
    if model == ADA_EMBEDDING_MODEL:
        if dimensions is None or dimensions == ADA_EMBEDDING_DIMENSIONS:
            return ADA_EMBEDDING_DIMENSIONS
        raise SystemExit(
            f"OpenAI model {model} has a fixed output dimension of {ADA_EMBEDDING_DIMENSIONS}. "
            f"Requested {dimensions} is rejected before a request."
        )
    if dimensions is not None:
        if dimensions < 1:
            raise SystemExit("OpenAI embedding dimensions must be a positive integer")
        return dimensions
    if model == OPENAI_EMBEDDING_MODEL:
        return OPENAI_EMBEDDING_DIMENSIONS
    raise SystemExit(f"--dimensions is required for OpenAI model {model}")


def embed_openai(
    prepared: list[dict],
    *,
    model_name: str,
    dimensions: int | None,
    cache_dir: Path,
    preprocessing: str,
    api_key: str | None,
    api_base: str | None,
    transport=None,
    sleeper=None,
    timeout: float = DEFAULT_TIMEOUT_SEC,
):
    model = model_name or OPENAI_EMBEDDING_MODEL
    dims = _resolve_dimensions(model, dimensions)
    if not prepared:
        raise SystemExit("No documents to embed.")
    seen = set()
    for doc in prepared:
        doc_id = str(doc.get("id") or "")
        if not doc_id or doc_id in seen:
            raise SystemExit(f"duplicate or missing document id: {doc_id}")
        seen.add(doc_id)
        if not str(doc.get("text") or "").strip():
            raise SystemExit(f"empty embedding input for {doc_id}")

    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    vectors: list[list[float] | None] = [None] * len(prepared)
    pending_by_key: dict[str, dict] = {}
    cache_hits = 0
    for index, doc in enumerate(prepared):
        key = cache_key(model=model, dimensions=dims, preprocessing=preprocessing, text=doc["text"])
        file = vector_cache_path(cache_dir, key)
        if file.exists():
            cached = read_float32_npy(file, dims)
            validate_vector(cached, dims, doc["id"])
            vectors[index] = cached
            cache_hits += 1
            continue
        slot = pending_by_key.get(key)
        if slot is None:
            pending_by_key[key] = {"id": doc["id"], "text": doc["text"], "key": key, "file": file, "indexes": [index]}
        else:
            slot["indexes"].append(index)
    pending = list(pending_by_key.values())
    prompt_tokens = 0
    api_calls = 0
    response_models: list[str] = []
    started = time.perf_counter()
    if pending:
        if not api_key:
            raise SystemExit("Missing OPENAI_API_KEY. Embedding generation does not fall back to another provider.")
        post = transport or _default_transport
        pause = sleeper or time.sleep
        base = (api_base or DEFAULT_API_BASE).strip().rstrip("/")
        for batch in batches_of(pending, model):
            result = _embed_batch(
                batch=batch,
                api_key=api_key,
                api_base=base,
                model=model,
                dimensions=dims,
                transport=post,
                sleeper=pause,
                timeout=timeout,
            )
            api_calls += 1
            prompt_tokens += result["promptTokens"]
            if result["model"] not in response_models:
                response_models.append(result["model"])
            normalized = [_l2_normalize(raw) for raw in result["vectors"]]
            for item, values in zip(batch, normalized):
                write_float32_npy(item["file"], values)
                reread = read_float32_npy(item["file"], dims)
                validate_vector(reread, dims, item["id"])
                for index in item["indexes"]:
                    vectors[index] = reread
    if any(row is None for row in vectors):
        raise SystemExit("embedding coverage is incomplete")
    try:
        import numpy as np
    except ImportError as exc:
        raise SystemExit(
            "OpenAI embedding compilation needs NumPy. "
            "Install tools/search-semantic/requirements-openai.txt in the builder environment. "
            "This does not fall back to another provider."
        ) from exc
    matrix = np.asarray(vectors, dtype=np.float32)
    meta = {
        "provider": "openai",
        "model": model,
        "responseModels": response_models,
        "dimensionality": dims,
        "normalization": "l2",
        "similarity": "cosine (dot of L2-normalized vectors)",
        "preprocessing": preprocessing,
        "cacheHits": cache_hits,
        "embeddedNow": len(pending),
        "apiCalls": api_calls,
        "promptTokens": prompt_tokens,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
        "note": "Vectors stay in the builder cache. The relationship artifact contains no vectors and no credentials.",
    }
    return matrix, meta
