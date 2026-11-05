import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request as urllib_request
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import build as semantic_build
from lib.embedding import cache_path, content_hash, embed_prepared
from lib.openai_embeddings import (
    ADA_EMBEDDING_DIMENSIONS,
    ADA_EMBEDDING_MODEL,
    CL100K_PAT_STR,
    CL100K_SHA256,
    CL100K_SPECIAL_TOKENS,
    CL100K_URL,
    OPENAI_EMBEDDING_DIMENSIONS,
    OPENAI_EMBEDDING_MODEL,
    TOKENIZER_DOWNLOAD_TIMEOUT_SEC,
    batches_of,
    cache_key,
    cl100k_tokenizer_bytes,
    embed_openai,
    encoding_name_for_model,
    publish_verified_tokenizer,
    ranks_from_tokenizer_bytes,
    read_float32_npy,
    tokenizer_cache_file,
    tokenizer_cache_name,
    vector_cache_path,
    write_float32_npy,
)
from lib.prepare import prepare_text

import lib.openai_embeddings as openai_embeddings

PREPARE_TOKENIZER = ROOT / "prepare_tokenizer.py"
PROJECT_TOKENIZER_CACHE = Path("build") / "search-semantic" / "tokenizers"


@contextmanager
def pushd(directory: Path):
    previous = os.getcwd()
    os.chdir(directory)
    try:
        yield
    finally:
        os.chdir(previous)


def write_download_block(root: Path) -> Path:
    """Block tokenizer downloads and fail embeddings HTTP immediately."""
    block = root / "netblock"
    block.mkdir(exist_ok=True)
    (block / "sitecustomize.py").write_text(
        "import urllib.request\n"
        "def urlopen(*_args, **_kwargs):\n"
        "    raise OSError('tokenizer download blocked')\n"
        "urllib.request.urlopen = urlopen\n"
        "class _Resp:\n"
        "    status = 400\n"
        "    headers = {}\n"
        "    def read(self):\n"
        "        return b'blocked'\n"
        "    def __enter__(self):\n"
        "        return self\n"
        "    def __exit__(self, *_args):\n"
        "        return False\n"
        "class _Opener:\n"
        "    def open(self, request, timeout=None):\n"
        "        return _Resp()\n"
        "def build_opener(*_args, **_kwargs):\n"
        "    return _Opener()\n"
        "urllib.request.build_opener = build_opener\n",
        encoding="utf-8",
    )
    return block


def env_without_tokenizer_overrides(block: Path | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env.pop("TIKTOKEN_CACHE_DIR", None)
    env.pop("DATA_GYM_CACHE_DIR", None)
    env.pop("OPENAI_API_KEY", None)
    if block is not None:
        env["PYTHONPATH"] = str(block) + os.pathsep + env.get("PYTHONPATH", "")
    return env


def read_prepared_tokenizer() -> bytes:
    """Verified ranks from the production cache. This does not download.

    Callers that change ``TIKTOKEN_CACHE_DIR`` or ``DATA_GYM_CACHE_DIR`` must
    capture the result first. An empty cache variable does not fall through.
    """
    path = tokenizer_cache_file()
    if path is None:
        raise AssertionError(
            "cl100k_base tokenizer preparation is disabled because the cache directory is empty. "
            "An empty TIKTOKEN_CACHE_DIR does not fall through to DATA_GYM_CACHE_DIR or "
            "build/search-semantic/tokenizers in the working directory. "
            "An empty DATA_GYM_CACHE_DIR does not fall through when TIKTOKEN_CACHE_DIR is unset. "
            "Set a nonempty directory and run `python3 tools/search-semantic/prepare_tokenizer.py`. "
            "This test does not download the tokenizer and does not skip the exact-token checks."
        )
    if not path.is_file():
        raise AssertionError(
            f"verified cl100k_base tokenizer is not prepared at {path}. "
            "Run `python3 tools/search-semantic/prepare_tokenizer.py` before the tests, "
            "or copy a verified file to that path. "
            "This test does not download the tokenizer and does not skip the exact-token checks."
        )
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise AssertionError(
            f"prepared tokenizer at {path} could not be read: {exc}. "
            "This test does not download a replacement and does not skip the exact-token checks."
        ) from exc
    try:
        ranks_from_tokenizer_bytes(data)
    except SystemExit as exc:
        raise AssertionError(
            f"prepared tokenizer at {path} failed verification: {exc}. "
            "This test does not download a replacement and does not skip the exact-token checks."
        ) from exc
    return data


def reference_token_count(text: str) -> int:
    """cl100k_base count from the fixture captured before tests change the cache."""
    import base64

    import tiktoken

    fixture = getattr(reference_token_count, "fixture", None)
    if not isinstance(fixture, (bytes, bytearray)):
        raise AssertionError(
            "cl100k_base fixture was not captured before tests changed the tokenizer cache. "
            "This test does not download the tokenizer and does not skip the exact-token checks."
        )
    encoder = getattr(reference_token_count, "encoder", None)
    if encoder is None:
        ranks = {}
        for line in bytes(fixture).splitlines():
            if not line:
                continue
            token, rank = line.split()
            ranks[base64.b64decode(token)] = int(rank)
        encoder = tiktoken.Encoding(
            name="cl100k_base",
            pat_str=CL100K_PAT_STR,
            mergeable_ranks=ranks,
            special_tokens=dict(CL100K_SPECIAL_TOKENS),
        )
        reference_token_count.encoder = encoder
    return len(encoder.encode_ordinary(text))


class _TokenizerResponse:
    def __init__(self, data: bytes):
        self._data = data

    def read(self) -> bytes:
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


DOCS = [
    {"id": "tls", "title": "TLS 1.2 Vulnerability", "body": "transport layer security certificates https encryption"},
    {"id": "vpn", "title": "What is VPN?", "body": "virtual private network tunnels encrypted traffic tls"},
    {"id": "noise", "title": "About this Blog", "body": "welcome to the site navigation footer"},
]


def prepared(text="alpha"):
    return [
        {"id": "a", "text": text, "title": "A"},
        {"id": "b", "text": "beta", "title": "B"},
    ]


def vector(seed, dimensions=4):
    values = [((seed + index) % 7) / 7 for index in range(dimensions)]
    if all(value == 0 for value in values):
        values[0] = 1
    return values


def response(batch_inputs, dimensions=4, model=OPENAI_EMBEDDING_MODEL, reverse=False, prompt_tokens=11):
    rows = []
    for index, text in enumerate(batch_inputs):
        rows.append({"index": index, "embedding": vector(sum(ord(ch) for ch in text), dimensions)})
    if reverse:
        rows.reverse()
    body = {
        "model": model,
        "data": rows,
        "usage": {"prompt_tokens": prompt_tokens, "total_tokens": prompt_tokens},
    }
    return 200, {}, json.dumps(body).encode("utf-8")


class OpenAIProviderTests(unittest.TestCase):
    prepared_tokenizer: bytes

    @classmethod
    def setUpClass(cls):
        # Capture before setUp points the cache variables at an isolated directory
        # and before any test changes the working directory.
        cls.prepared_tokenizer = read_prepared_tokenizer()
        reference_token_count.fixture = cls.prepared_tokenizer
        reference_token_count.encoder = None

    def setUp(self):
        self._saved_env = {
            "TIKTOKEN_CACHE_DIR": os.environ.get("TIKTOKEN_CACHE_DIR"),
            "DATA_GYM_CACHE_DIR": os.environ.get("DATA_GYM_CACHE_DIR"),
            "OPENAI_API_BASE": os.environ.get("OPENAI_API_BASE"),
            "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY"),
        }
        self._token_cache = tempfile.TemporaryDirectory()
        cache_dir = Path(self._token_cache.name)
        (cache_dir / tokenizer_cache_name()).write_bytes(self.prepared_tokenizer)
        os.environ["TIKTOKEN_CACHE_DIR"] = str(cache_dir)
        os.environ.pop("DATA_GYM_CACHE_DIR", None)
        openai_embeddings._ENCODINGS.clear()
        self._urlopen = urllib_request.urlopen

    def tearDown(self):
        urllib_request.urlopen = self._urlopen
        openai_embeddings._ENCODINGS.clear()
        self._token_cache.cleanup()
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_default_cache_identity_is_unchanged(self):
        text = "Title: TLS\nTitle: TLS\nBody: certificates"
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
        self.assertEqual(content_hash(text), digest)
        path = cache_path(Path("/cache"), "sentence-transformers/all-MiniLM-L6-v2", "tls", digest)
        self.assertEqual(
            path,
            Path("/cache") / "sentence-transformers__all-MiniLM-L6-v2" / f"{digest}_tls.npy",
        )

    def test_cache_reuse_skips_the_api_and_aligns_reversed_indexes(self):
        calls = []

        def transport(url, payload, timeout, api_key):
            calls.append(payload["input"])
            self.assertEqual(api_key, "sk-test-secret")
            self.assertTrue(url.endswith("/embeddings"))
            self.assertEqual(payload["dimensions"], 4)
            return response(payload["input"], reverse=True)

        with tempfile.TemporaryDirectory() as tmp:
            first, meta = embed_openai(
                prepared(),
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp),
                preprocessing="title@1",
                api_key="sk-test-secret",
                api_base="http://127.0.0.1/v1",
                transport=transport,
                sleeper=lambda _delay: None,
            )
            self.assertEqual(len(calls), 1)
            self.assertEqual(meta["cacheHits"], 0)
            self.assertEqual(meta["embeddedNow"], 2)
            self.assertEqual(meta["apiCalls"], 1)
            self.assertEqual(meta["promptTokens"], 11)
            self.assertEqual(meta["dimensionality"], 4)
            self.assertNotIn("sk-test-secret", json.dumps(meta))

            def fail_transport(*_args):
                raise AssertionError("cached inputs called the API")

            second, again = embed_openai(
                prepared(),
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp),
                preprocessing="title@1",
                api_key="",
                api_base="http://127.0.0.1/v1",
                transport=fail_transport,
                sleeper=lambda _delay: None,
            )
            self.assertEqual(again["cacheHits"], 2)
            self.assertEqual(again["apiCalls"], 0)
            self.assertEqual(first.tolist(), second.tolist())

    def test_identical_text_is_embedded_once(self):
        calls = []

        def transport(url, payload, timeout, api_key):
            calls.append(list(payload["input"]))
            return response(payload["input"])

        docs = [{"id": "a", "text": "same"}, {"id": "b", "text": "same"}]
        with tempfile.TemporaryDirectory() as tmp:
            matrix, meta = embed_openai(
                docs,
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp),
                preprocessing="title@1",
                api_key="sk-test",
                api_base="http://127.0.0.1/v1",
                transport=transport,
                sleeper=lambda _delay: None,
            )
        self.assertEqual(calls, [["same"]])
        self.assertEqual(meta["embeddedNow"], 1)
        self.assertEqual(matrix[0].tolist(), matrix[1].tolist())

    def test_synchronized_writers_leave_one_valid_cache_vector(self):
        text = "shared cache input"
        key = cache_key(
            model=OPENAI_EMBEDDING_MODEL,
            dimensions=4,
            preprocessing="title@1",
            text=text,
        )
        values = [0.5, 0.5, 0.5, 0.5]
        with tempfile.TemporaryDirectory() as tmp:
            path = vector_cache_path(Path(tmp), key)
            barrier = threading.Barrier(2)
            errors = []

            def write_once():
                try:
                    barrier.wait(timeout=5)
                    write_float32_npy(path, values)
                except Exception as exc:
                    errors.append(exc)

            threads = [threading.Thread(target=write_once) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(errors, [])
            self.assertEqual(read_float32_npy(path, 4), values)
            self.assertEqual(list(path.parent.glob("*partial*")), [])

            import numpy as np

            loaded = np.load(path)
            self.assertEqual(loaded.dtype.name, "float32")
            self.assertEqual(loaded.shape, (4,))
            self.assertEqual(loaded.tolist(), values)

            def fail_transport(*_args):
                raise AssertionError("cached input called the API")

            matrix, meta = embed_openai(
                [{"id": "a", "text": text}],
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp),
                preprocessing="title@1",
                api_key="",
                api_base="http://127.0.0.1/v1",
                transport=fail_transport,
                sleeper=lambda _delay: None,
            )
            self.assertEqual(meta["cacheHits"], 1)
            self.assertEqual(meta["apiCalls"], 0)
            self.assertEqual(meta["embeddedNow"], 0)
            self.assertEqual(matrix[0].tolist(), values)

    def test_invalid_response_is_not_cached_or_retried_as_success(self):
        calls = {"n": 0}

        def transport(url, payload, timeout, api_key):
            calls["n"] += 1
            body = {"model": OPENAI_EMBEDDING_MODEL, "data": [{"index": 0, "embedding": [1, 2, 3]}], "usage": {}}
            return 200, {}, json.dumps(body).encode("utf-8")

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit) as raised:
                embed_openai(
                    [{"id": "a", "text": "alpha"}],
                    model_name=OPENAI_EMBEDDING_MODEL,
                    dimensions=4,
                    cache_dir=Path(tmp),
                    preprocessing="title@1",
                    api_key="sk-test",
                    api_base="http://127.0.0.1/v1",
                    transport=transport,
                    sleeper=lambda _delay: None,
                )
            self.assertIn("vector length", str(raised.exception))
            self.assertEqual(list(Path(tmp).rglob("*.npy")), [])
        self.assertEqual(calls["n"], 1)

    def test_retries_are_bounded_and_authentication_failure_is_not_retried(self):
        retry_calls = {"n": 0}

        def flaky(url, payload, timeout, api_key):
            retry_calls["n"] += 1
            if retry_calls["n"] < 3:
                return 429, {"Retry-After": "0"}, b"slow down sk-test-secret"
            return response(payload["input"])

        delays = []
        with tempfile.TemporaryDirectory() as tmp:
            embed_openai(
                [{"id": "a", "text": "alpha"}],
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp),
                preprocessing="title@1",
                api_key="sk-test-secret",
                api_base="http://127.0.0.1/v1",
                transport=flaky,
                sleeper=delays.append,
            )
        self.assertEqual(retry_calls["n"], 3)
        self.assertEqual(delays, [0, 0])

        auth_calls = {"n": 0}

        def denied(url, payload, timeout, api_key):
            auth_calls["n"] += 1
            return 401, {}, b"bad key sk-test-secret"

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit) as raised:
                embed_openai(
                    [{"id": "a", "text": "alpha"}],
                    model_name=OPENAI_EMBEDDING_MODEL,
                    dimensions=4,
                    cache_dir=Path(tmp),
                    preprocessing="title@1",
                    api_key="sk-test-secret",
                    api_base="http://127.0.0.1/v1",
                    transport=denied,
                    sleeper=lambda _delay: None,
                )
            message = str(raised.exception)
            self.assertIn("HTTP 401", message)
            self.assertNotIn("sk-test-secret", message)
            self.assertIn("[redacted]", message)
            self.assertEqual(list(Path(tmp).rglob("*.npy")), [])
        self.assertEqual(auth_calls["n"], 1)

    def test_missing_key_does_not_call_the_api_or_another_provider(self):
        def transport(*_args):
            raise AssertionError("missing key called the API")

        def forbidden(*_args, **_kwargs):
            raise AssertionError("OpenAI failure called FastEmbed")

        import lib.embedding as embedding

        original = embedding.load_or_embed
        embedding.load_or_embed = forbidden
        try:
            with self.assertRaises(SystemExit) as raised:
                embed_prepared(
                    [{"id": "a", "text": "alpha"}],
                    provider="openai",
                    model_name=OPENAI_EMBEDDING_MODEL,
                    cache_dir=Path("/tmp"),
                    dimensions=4,
                    preprocessing="title@1",
                    api_key="",
                    transport=transport,
                    sleeper=lambda _delay: None,
                )
        finally:
            embedding.load_or_embed = original
        self.assertIn("does not fall back", str(raised.exception))

    def test_batch_limits_follow_the_embeddings_api(self):
        items = [{"id": str(i), "text": "x" * 16} for i in range(3)]
        import lib.openai_embeddings as openai

        original = openai.BATCH_INPUTS
        openai.BATCH_INPUTS = 2
        try:
            batches = batches_of(items)
        finally:
            openai.BATCH_INPUTS = original
        self.assertEqual([len(batch) for batch in batches], [2, 1])

    def test_tokenizer_counts_are_offline_and_model_specific(self):
        import urllib.request

        def refuse_download(*_args, **_kwargs):
            raise AssertionError("tokenizer download")

        original = urllib.request.urlopen
        urllib.request.urlopen = refuse_download
        try:
            self.assertEqual(encoding_name_for_model("text-embedding-3-large"), "cl100k_base")
            self.assertEqual(encoding_name_for_model("text-embedding-3-small"), "cl100k_base")
            self.assertEqual(encoding_name_for_model("text-embedding-ada-002"), "cl100k_base")
            sample = "Numbers 7\n123456789012"
            self.assertEqual(reference_token_count(sample), reference_token_count(sample))
            self.assertGreater(reference_token_count("<|endoftext|>"), 1)
            self.assertEqual(len(batches_of([{"id": "special", "text": "<|endoftext|>"}])), 1)
            hello = "hello tokenizer"
            hello_count = reference_token_count(hello)
            import lib.openai_embeddings as openai_mod

            original_budget = openai_mod.BATCH_TOKEN_BUDGET
            openai_mod.BATCH_TOKEN_BUDGET = hello_count
            try:
                split = batches_of([{"id": "a", "text": hello}, {"id": "b", "text": hello}])
            finally:
                openai_mod.BATCH_TOKEN_BUDGET = original_budget
            self.assertEqual([len(batch) for batch in split], [1, 1])
            with self.assertRaises(SystemExit) as raised:
                batches_of([{"id": "a", "text": "hello"}], model="text-embedding-unknown")
        finally:
            urllib.request.urlopen = original
        self.assertIn("no supported tokenizer", str(raised.exception))
        self.assertIn("text-embedding-3-large", str(raised.exception))

    def test_character_estimate_undercount_is_rejected_at_the_input_limit(self):
        text = " ".join(["123456789012"] * 2049)
        estimate = math.ceil(len(text) / 4)
        actual = reference_token_count(text)
        self.assertLess(estimate, 8192)
        self.assertGreater(actual, 8192)
        with self.assertRaises(SystemExit) as raised:
            batches_of([{"id": "over", "text": text}])
        self.assertIn(str(actual), str(raised.exception))
        self.assertIn("8192", str(raised.exception))

    def test_digit_corpus_splits_into_requests_the_api_accepts(self):
        prepared_bytes = self.prepared_tokenizer
        token_cache = tempfile.TemporaryDirectory()
        self.addCleanup(token_cache.cleanup)
        os.environ["TIKTOKEN_CACHE_DIR"] = token_cache.name
        cache_file = Path(token_cache.name) / tokenizer_cache_name()
        cache_file.write_bytes(prepared_bytes)
        self.assertEqual(hashlib.sha256(cache_file.read_bytes()).hexdigest(), CL100K_SHA256)
        openai_embeddings._ENCODINGS.clear()

        def refuse_network(*_args, **_kwargs):
            raise AssertionError("network access")

        urllib_request.urlopen = refuse_network
        documents = [
            {"id": str(i), "title": "Numbers " + str(i), "body": " ".join(["123456789012"] * 1200)}
            for i in range(64)
        ]
        prepared_docs = [{"id": doc["id"], "text": prepare_text(doc, "title_full")} for doc in documents]
        counts = [reference_token_count(item["text"]) for item in prepared_docs]
        self.assertEqual(set(counts), {6003})
        self.assertEqual(sum(counts), 384192)
        self.assertEqual(sum(math.ceil(len(item["text"]) / 4) for item in prepared_docs), 249792)
        calls = []

        def transport(url, payload, timeout, api_key):
            total = sum(reference_token_count(text) for text in payload["input"])
            calls.append({"inputs": len(payload["input"]), "tokens": total})
            if any(reference_token_count(text) > 8192 for text in payload["input"]) or total > 300_000:
                return 400, {}, b'{"error":{"message":"maximum tokens exceeded"}}'
            return response(payload["input"], dimensions=4, prompt_tokens=total)

        with tempfile.TemporaryDirectory() as tmp:
            _matrix, meta = embed_openai(
                prepared_docs,
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp),
                preprocessing="title_full@1",
                api_key="sk-test",
                api_base="http://127.0.0.1/v1",
                transport=transport,
                sleeper=lambda _delay: None,
            )
            self.assertEqual([(call["inputs"], call["tokens"]) for call in calls], [(41, 246123), (23, 138069)])
            self.assertEqual(meta["apiCalls"], 2)
            self.assertEqual(sum(call["tokens"] for call in calls), 384192)

            def fail_transport(*_args):
                raise AssertionError("cached corpus called the API")

            _again, cached = embed_openai(
                prepared_docs,
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp),
                preprocessing="title_full@1",
                api_key="",
                api_base="http://127.0.0.1/v1",
                transport=fail_transport,
                sleeper=lambda _delay: None,
            )
        self.assertEqual(cached["cacheHits"], 64)
        self.assertEqual(cached["apiCalls"], 0)
        first = prepared_docs[0]["text"]
        self.assertEqual(
            cache_key(
                model=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                preprocessing="title_full@1",
                text=first,
            ),
            hashlib.sha256(
                "\n".join(["openai", OPENAI_EMBEDDING_MODEL, "4", "title_full@1", first]).encode("utf-8")
            ).hexdigest(),
        )

    def test_documented_model_defaults_to_3072_dimensions(self):
        self.assertEqual(OPENAI_EMBEDDING_MODEL, "text-embedding-3-large")
        self.assertEqual(OPENAI_EMBEDDING_DIMENSIONS, 3072)
        with self.assertRaises(SystemExit) as raised:
            embed_openai(
                [{"id": "a", "text": "alpha"}],
                model_name="text-embedding-3-small",
                dimensions=None,
                cache_dir=Path("/tmp"),
                preprocessing="title@1",
                api_key="sk-test",
                api_base="http://127.0.0.1/v1",
                transport=lambda *_args: (_ for _ in ()).throw(AssertionError("request")),
                sleeper=lambda _delay: None,
            )
        self.assertIn("--dimensions is required", str(raised.exception))

    def test_ada_002_uses_fixed_dimensions_and_omits_the_request_parameter(self):
        calls = []

        def transport(url, payload, timeout, api_key):
            calls.append(payload)
            if "dimensions" in payload:
                return 400, {}, b'{"error":{"message":"dimensions is not supported for this model"}}'
            if payload.get("model") != ADA_EMBEDDING_MODEL:
                return 400, {}, b'{"error":{"message":"unexpected model"}}'
            return response(payload["input"], dimensions=ADA_EMBEDDING_DIMENSIONS, model=ADA_EMBEDDING_MODEL)

        def reject_transport(*_args):
            raise AssertionError("request was sent")

        with tempfile.TemporaryDirectory() as tmp:
            matrix, meta = embed_openai(
                [{"id": "a", "text": "ada input"}],
                model_name=ADA_EMBEDDING_MODEL,
                dimensions=None,
                cache_dir=Path(tmp),
                preprocessing="title@1",
                api_key="sk-test",
                api_base="http://127.0.0.1/v1",
                transport=transport,
                sleeper=lambda _delay: None,
            )
            self.assertEqual(meta["apiCalls"], 1)
            self.assertEqual(matrix.shape, (1, ADA_EMBEDDING_DIMENSIONS))
            self.assertNotIn("dimensions", calls[0])
            self.assertEqual(calls[0]["model"], ADA_EMBEDDING_MODEL)

            _again, cached = embed_openai(
                [{"id": "a", "text": "ada input"}],
                model_name=ADA_EMBEDDING_MODEL,
                dimensions=ADA_EMBEDDING_DIMENSIONS,
                cache_dir=Path(tmp),
                preprocessing="title@1",
                api_key="",
                api_base="http://127.0.0.1/v1",
                transport=reject_transport,
                sleeper=lambda _delay: None,
            )
            self.assertEqual(cached["cacheHits"], 1)
            self.assertEqual(cached["apiCalls"], 0)
            self.assertEqual(
                cache_key(
                    model=ADA_EMBEDDING_MODEL,
                    dimensions=ADA_EMBEDDING_DIMENSIONS,
                    preprocessing="title@1",
                    text="ada input",
                ),
                hashlib.sha256(
                    "\n".join(["openai", ADA_EMBEDDING_MODEL, "1536", "title@1", "ada input"]).encode("utf-8")
                ).hexdigest(),
            )

        with self.assertRaises(SystemExit) as invalid:
            embed_openai(
                [{"id": "a", "text": "ada input"}],
                model_name=ADA_EMBEDDING_MODEL,
                dimensions=3072,
                cache_dir=Path("/tmp"),
                preprocessing="title@1",
                api_key="sk-test",
                api_base="http://127.0.0.1/v1",
                transport=reject_transport,
                sleeper=lambda _delay: None,
            )
        self.assertIn("1536", str(invalid.exception))
        self.assertIn("3072", str(invalid.exception))

        def short_response(url, payload, timeout, api_key):
            if "dimensions" in payload:
                return 400, {}, b'{"error":{"message":"dimensions is not supported for this model"}}'
            return response(payload["input"], dimensions=4, model=ADA_EMBEDDING_MODEL)

        with tempfile.TemporaryDirectory() as short_dir:
            with self.assertRaises(SystemExit) as short:
                embed_openai(
                    [{"id": "a", "text": "ada input"}],
                    model_name=ADA_EMBEDDING_MODEL,
                    dimensions=None,
                    cache_dir=Path(short_dir),
                    preprocessing="title@1",
                    api_key="sk-test",
                    api_base="http://127.0.0.1/v1",
                    transport=short_response,
                    sleeper=lambda _delay: None,
                )
        self.assertIn("1536", str(short.exception))

        with self.assertRaises(SystemExit) as unknown:
            embed_openai(
                [{"id": "a", "text": "hello"}],
                model_name="text-embedding-unknown",
                dimensions=1536,
                cache_dir=Path("/tmp"),
                preprocessing="title@1",
                api_key="sk-test",
                api_base="http://127.0.0.1/v1",
                transport=reject_transport,
                sleeper=lambda _delay: None,
            )
        self.assertIn("no supported tokenizer", str(unknown.exception))

    def test_ada_cli_accepts_the_fixed_dimension_and_rejects_others_before_transport(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp) / "corpus.json"
            output = Path(tmp) / "graph.json"
            corpus.write_text(json.dumps(DOCS[:1]), encoding="utf-8")
            output.write_text("KEEP\n", encoding="utf-8")
            env = os.environ.copy()
            env.pop("OPENAI_API_KEY", None)

            def run(*extra):
                return subprocess.run(
                    [
                        sys.executable,
                        str(ROOT / "build.py"),
                        "--input",
                        str(corpus),
                        "--output",
                        str(output),
                        "--method",
                        "embedding",
                        "--embedding-provider",
                        "openai",
                        "--model",
                        ADA_EMBEDDING_MODEL,
                        "--cache-dir",
                        str(Path(tmp) / "cache"),
                        *extra,
                    ],
                    cwd=tmp,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )

            omitted = run()
            explicit = run("--dimensions", "1536")
            invalid = run("--dimensions", "3072")
            self.assertNotEqual(omitted.returncode, 0)
            self.assertIn("OPENAI_API_KEY", omitted.stderr)
            self.assertNotIn("--dimensions is required", omitted.stderr)
            self.assertNotEqual(explicit.returncode, 0)
            self.assertIn("OPENAI_API_KEY", explicit.stderr)
            self.assertNotIn("fixed output dimension", explicit.stderr)
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn("1536", invalid.stderr)
            self.assertIn("3072", invalid.stderr)
            self.assertNotIn("OPENAI_API_KEY", invalid.stderr)
            self.assertEqual(output.read_text(encoding="utf-8"), "KEEP\n")

    def test_numpy_reads_the_cache_file(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy not installed")

        def transport(url, payload, timeout, api_key):
            return response(payload["input"])

        with tempfile.TemporaryDirectory() as tmp:
            embed_openai(
                [{"id": "a", "text": "alpha"}],
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp),
                preprocessing="title@1",
                api_key="sk-test",
                api_base="http://127.0.0.1/v1",
                transport=transport,
                sleeper=lambda _delay: None,
            )
            cached = list(Path(tmp).rglob("*.npy"))
            self.assertEqual(len(cached), 1)
            loaded = np.load(cached[0])
            self.assertEqual(loaded.shape, (4,))
            self.assertTrue(np.isfinite(loaded).all())
            self.assertNotIn(b"sk-test", cached[0].read_bytes())
            self.assertEqual(len(read_float32_npy(cached[0], 4)), 4)

    def test_failure_does_not_publish_a_partial_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp) / "corpus.json"
            output = Path(tmp) / "graph.json"
            corpus.write_text(json.dumps(DOCS[:2]), encoding="utf-8")
            output.write_text("KEEP\n", encoding="utf-8")
            env = os.environ.copy()
            env.pop("OPENAI_API_KEY", None)
            proc = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "build.py"),
                    "--input",
                    str(corpus),
                    "--output",
                    str(output),
                    "--method",
                    "embedding",
                    "--embedding-provider",
                    "openai",
                    "--model",
                    OPENAI_EMBEDDING_MODEL,
                    "--dimensions",
                    "4",
                    "--cache-dir",
                    str(Path(tmp) / "cache"),
                ],
                cwd=tmp,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("does not fall back", proc.stderr)
            self.assertNotIn("fastembed", proc.stderr.lower())
            self.assertEqual(output.read_text(encoding="utf-8"), "KEEP\n")
            self.assertFalse(output.with_suffix(".json.partial").exists())

    def test_lexical_artifact_is_independent_of_the_embedding_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp) / "corpus.json"
            corpus.write_text(json.dumps(DOCS), encoding="utf-8")
            base = dict(
                input=str(corpus),
                representation="title_lead",
                method="lexical",
                top_k=2,
                min_score=0.05,
                precision_gate=False,
                mutual=False,
                lexical_min_score=None,
                embedding_min_score=None,
                model=None,
                cache_dir=str(Path(tmp) / "cache"),
                dimensions=None,
                openai_api_base=None,
            )
            default_args = argparse.Namespace(**base, embedding_provider="fastembed")
            openai_args = argparse.Namespace(**base, embedding_provider="openai")
            env_key = os.environ.pop("OPENAI_API_KEY", None)
            try:
                default_artifact, _, _, _ = semantic_build.build(default_args)
                openai_artifact, openai_report, _, _ = semantic_build.build(openai_args)
            finally:
                if env_key is not None:
                    os.environ["OPENAI_API_KEY"] = env_key
            self.assertEqual(default_artifact, openai_artifact)
            self.assertEqual(openai_report["method"], "lexical")
            self.assertNotIn("embedding", openai_report)
            self.assertNotIn("vectors", default_artifact)
            self.assertIn("vpn", {edge["target"] for edge in default_artifact["relationships"]["tls"]})

    def test_openai_uses_the_same_neighbor_selection_as_fastembed_vectors(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy not installed")
        rows = np.array([[1, 0, 0], [0.9, 0.1, 0], [0, 1, 0]], dtype=np.float32)
        rows = rows / np.linalg.norm(rows, axis=1, keepdims=True)
        calls = {"fastembed": 0, "openai": 0}

        def fake(provider):
            def embed(*_args, **_kwargs):
                calls[provider] += 1
                return rows, {"provider": provider}

            return embed

        original = semantic_build.embed_prepared
        try:
            with tempfile.TemporaryDirectory() as tmp:
                corpus = Path(tmp) / "corpus.json"
                corpus.write_text(json.dumps(DOCS), encoding="utf-8")
                common = dict(
                    input=str(corpus),
                    representation="title",
                    method="embedding",
                    top_k=1,
                    min_score=0.5,
                    precision_gate=False,
                    mutual=False,
                    lexical_min_score=None,
                    embedding_min_score=None,
                    model="fixture",
                    cache_dir=str(Path(tmp) / "cache"),
                    dimensions=3,
                    openai_api_base=None,
                )
                semantic_build.embed_prepared = fake("fastembed")
                fast_artifact, _, _, _ = semantic_build.build(argparse.Namespace(**common, embedding_provider="fastembed"))
                semantic_build.embed_prepared = fake("openai")
                openai_artifact, _, _, _ = semantic_build.build(argparse.Namespace(**common, embedding_provider="openai"))
        finally:
            semantic_build.embed_prepared = original
        self.assertEqual(calls, {"fastembed": 1, "openai": 1})
        self.assertEqual(fast_artifact, openai_artifact)
        self.assertGreater(sum(len(edges) for edges in fast_artifact["relationships"].values()), 0)
        self.assertNotIn("vectors", fast_artifact)

    def test_cli_rejects_invalid_embedding_provider_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp) / "corpus.json"
            output = Path(tmp) / "graph.json"
            corpus.write_text(json.dumps(DOCS[:1]), encoding="utf-8")
            output.write_text("KEEP\n", encoding="utf-8")
            proc = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "build.py"),
                    "--input",
                    str(corpus),
                    "--output",
                    str(output),
                    "--embedding-provider",
                    "opneai",
                ],
                cwd=tmp,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("opneai", proc.stderr)
            self.assertIn("fastembed", proc.stderr)
            self.assertIn("openai", proc.stderr)
            self.assertEqual(output.read_text(encoding="utf-8"), "KEEP\n")

    def test_cli_rejects_a_missing_embedding_provider_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp) / "corpus.json"
            output = Path(tmp) / "graph.json"
            corpus.write_text(json.dumps(DOCS[:1]), encoding="utf-8")
            output.write_text("KEEP\n", encoding="utf-8")
            proc = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "build.py"),
                    "--input",
                    str(corpus),
                    "--output",
                    str(output),
                    "--method",
                    "lexical",
                    "--embedding-provider",
                ],
                cwd=tmp,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(output.read_text(encoding="utf-8"), "KEEP\n")

    def test_tokenizer_cache_miss_hit_corrupt_and_download_failure(self):
        payload = self.prepared_tokenizer
        calls = []

        def fake_open(request, timeout=None):
            calls.append((request, timeout))
            return _TokenizerResponse(payload)

        urllib_request.urlopen = fake_open
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["TIKTOKEN_CACHE_DIR"] = tmp
            os.environ["OPENAI_API_BASE"] = "https://embeddings.example/v1"
            os.environ["OPENAI_API_KEY"] = "sk-test-secret"
            openai_embeddings._ENCODINGS.clear()
            first = cl100k_tokenizer_bytes()
            self.assertEqual(hashlib.sha256(first).hexdigest(), CL100K_SHA256)
            self.assertEqual(len(calls), 1)
            request, timeout = calls[0]
            self.assertEqual(request.full_url, CL100K_URL)
            self.assertEqual(timeout, TOKENIZER_DOWNLOAD_TIMEOUT_SEC)
            self.assertNotIn("Authorization", {key.title(): value for key, value in request.header_items()})
            self.assertNotIn("sk-test-secret", str(request.header_items()))
            cached = tokenizer_cache_file()
            self.assertIsNotNone(cached)
            self.assertEqual(hashlib.sha256(cached.read_bytes()).hexdigest(), CL100K_SHA256)
            self.assertEqual(list(Path(tmp).glob("*.partial")), [])
            openai_embeddings._ENCODINGS.clear()
            urllib_request.urlopen = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("cache hit downloaded"))
            second = cl100k_tokenizer_bytes()
            self.assertEqual(second, first)

            cached.write_bytes(b"corrupt-tokenizer")
            openai_embeddings._ENCODINGS.clear()
            urllib_request.urlopen = fake_open
            replaced = cl100k_tokenizer_bytes()
            self.assertEqual(hashlib.sha256(replaced).hexdigest(), CL100K_SHA256)
            self.assertEqual(hashlib.sha256(cached.read_bytes()).hexdigest(), CL100K_SHA256)

            cached.write_bytes(b"still-corrupt")
            openai_embeddings._ENCODINGS.clear()

            def fail_open(*_args, **_kwargs):
                raise OSError("offline")

            urllib_request.urlopen = fail_open
            with self.assertRaises(SystemExit) as raised:
                cl100k_tokenizer_bytes()
            message = str(raised.exception)
            self.assertIn(CL100K_URL, message)
            self.assertIn("no embedding request", message)
            self.assertIn(str(cached), message)
            self.assertIn("offline", message)
            self.assertEqual(cached.read_bytes(), b"still-corrupt")

            def bad_open(*_args, **_kwargs):
                return _TokenizerResponse(b"not-the-tokenizer")

            urllib_request.urlopen = bad_open
            with self.assertRaises(SystemExit) as mismatch:
                cl100k_tokenizer_bytes()
            self.assertIn(CL100K_SHA256, str(mismatch.exception))
            self.assertNotEqual(cached.read_bytes(), b"not-the-tokenizer")

    def test_tokenizer_download_failure_preserves_the_output_artifact(self):
        name = tokenizer_cache_name()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package = root / "node_modules" / "pkg" / "tools" / "search-semantic"
            package.mkdir(parents=True)
            package_default = package / PROJECT_TOKENIZER_CACHE / name
            consumer_cache = root / "consumer" / "build" / "search-semantic" / "tokenizers"
            explicit_cache = root / "project" / "custom-tokens"
            gym = root / "ignored-gym"
            gym.mkdir()
            (gym / name).write_bytes(self.prepared_tokenizer)
            corpus = root / "corpus.json"
            output = root / "graph.json"
            corpus.write_text(json.dumps(DOCS[:1]), encoding="utf-8")
            output.write_text("KEEP\n", encoding="utf-8")

            def fail_open(request, timeout=None):
                raise OSError(f"offline blocked {getattr(request, 'full_url', request)} sk-test-secret")

            urllib_request.urlopen = fail_open
            previous_argv = sys.argv

            def run_failure(cwd: Path, tiktoken: str | None, data_gym: str | None):
                output.write_text("KEEP\n", encoding="utf-8")
                if tiktoken is None:
                    os.environ.pop("TIKTOKEN_CACHE_DIR", None)
                else:
                    os.environ["TIKTOKEN_CACHE_DIR"] = tiktoken
                if data_gym is None:
                    os.environ.pop("DATA_GYM_CACHE_DIR", None)
                else:
                    os.environ["DATA_GYM_CACHE_DIR"] = data_gym
                os.environ["OPENAI_API_KEY"] = "sk-test"
                openai_embeddings._ENCODINGS.clear()
                sys.argv = [
                    "build.py",
                    "--input",
                    str(corpus),
                    "--output",
                    str(output),
                    "--method",
                    "embedding",
                    "--embedding-provider",
                    "openai",
                    "--model",
                    OPENAI_EMBEDDING_MODEL,
                    "--dimensions",
                    "4",
                    "--cache-dir",
                    str(root / "vectors"),
                    "--openai-api-base",
                    "https://embeddings.example/v1",
                ]
                with pushd(cwd):
                    selected = tokenizer_cache_file()
                    with self.assertRaises(SystemExit) as raised:
                        semantic_build.main()
                message = str(raised.exception)
                self.assertIn("Could not download the cl100k_base tokenizer", message)
                self.assertIn(CL100K_URL, message)
                self.assertIn("no embedding request", message)
                self.assertIn("offline blocked", message)
                self.assertIn("[redacted]", message)
                self.assertNotIn("sk-test-secret", message)
                self.assertNotIn("embeddings.example", message)
                self.assertNotIn(str(package_default), message)
                self.assertNotIn("prepare_tokenizer.py", message)
                self.assertIn("rerun the original build command", message)
                if selected is not None:
                    self.assertIn(str(selected), message)
                    self.assertIn(f"Copy the verified tokenizer file to {selected}", message)
                self.assertEqual(output.read_text(encoding="utf-8"), "KEEP\n")
                self.assertFalse(output.with_suffix(".json.partial").exists())
                self.assertFalse(package_default.exists())
                return message, selected

            try:
                project = root / "project"
                project.mkdir()
                consumer_message, selected = run_failure(package, str(consumer_cache), str(gym))
                self.assertEqual(selected, consumer_cache / name)
                self.assertIn(str(selected), consumer_message)
                self.assertNotIn(str(gym / name), consumer_message)

                explicit_message, selected = run_failure(project, "custom-tokens", str(gym))
                self.assertEqual(selected, explicit_cache / name)
                self.assertTrue(selected.is_absolute())
                self.assertIn(str(selected), explicit_message)
                self.assertNotIn(str(gym / name), explicit_message)
                self.assertFalse((explicit_cache / name).exists())

                disabled, selected = run_failure(package, "", str(gym))
                self.assertIsNone(selected)
                self.assertIn("No persistent tokenizer cache is selected", disabled)
                self.assertIn("does not fall through", disabled)
                self.assertIn("restore download access or prewarm that selected cache", disabled)
                self.assertNotIn("prepare_tokenizer.py", disabled)
                self.assertNotIn(str(gym), disabled)
                self.assertNotIn(str(consumer_cache), disabled)
                self.assertNotIn(str(package / "build"), disabled)
                self.assertEqual((gym / name).read_bytes(), self.prepared_tokenizer)
            finally:
                sys.argv = previous_argv

    def test_concurrent_tokenizer_publication_keeps_verified_bytes(self):
        payload = self.prepared_tokenizer
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["TIKTOKEN_CACHE_DIR"] = tmp
            openai_embeddings._ENCODINGS.clear()
            started = threading.Event()
            release = threading.Event()

            def slow_open(request, timeout=None):
                self.assertEqual(getattr(request, "full_url", request), CL100K_URL)
                self.assertEqual(timeout, TOKENIZER_DOWNLOAD_TIMEOUT_SEC)
                started.set()
                self.assertTrue(release.wait(5))
                return _TokenizerResponse(payload)

            urllib_request.urlopen = slow_open
            errors = []
            results = []

            def acquire():
                try:
                    results.append(cl100k_tokenizer_bytes())
                except BaseException as exc:
                    errors.append(exc)

            waiter = threading.Thread(target=acquire)
            waiter.start()
            self.assertTrue(started.wait(5))
            cache_file = tokenizer_cache_file()
            self.assertIsNotNone(cache_file)
            publish_verified_tokenizer(cache_file, payload)
            self.assertEqual([name for name in os.listdir(tmp) if name.endswith(".partial")], [])
            release.set()
            other = threading.Thread(target=acquire)
            other.start()
            waiter.join(5)
            other.join(5)
            self.assertFalse(waiter.is_alive())
            self.assertFalse(other.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(len(results), 2)
            self.assertTrue(all(hashlib.sha256(item).hexdigest() == CL100K_SHA256 for item in results))
            self.assertEqual(hashlib.sha256(cache_file.read_bytes()).hexdigest(), CL100K_SHA256)
            self.assertEqual([name for name in os.listdir(tmp) if name.endswith(".partial")], [])

    def test_cached_embedding_vectors_do_not_need_the_tokenizer(self):
        with tempfile.TemporaryDirectory() as tmp:
            def transport(url, payload, timeout, api_key):
                return response(payload["input"])

            embed_openai(
                [{"id": "a", "text": "alpha"}],
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp) / "vectors",
                preprocessing="title@1",
                api_key="sk-test",
                api_base="http://127.0.0.1/v1",
                transport=transport,
                sleeper=lambda _delay: None,
            )
            os.environ["TIKTOKEN_CACHE_DIR"] = str(Path(tmp) / "missing-tokenizer")
            openai_embeddings._ENCODINGS.clear()

            def fail_open(*_args, **_kwargs):
                raise AssertionError("tokenizer download")

            urllib_request.urlopen = fail_open
            _matrix, meta = embed_openai(
                [{"id": "a", "text": "alpha"}],
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=4,
                cache_dir=Path(tmp) / "vectors",
                preprocessing="title@1",
                api_key="",
                api_base="http://127.0.0.1/v1",
                transport=lambda *_args: (_ for _ in ()).throw(AssertionError("embedding request")),
                sleeper=lambda _delay: None,
            )
            project = Path(tmp) / "fresh-project"
            project.mkdir()
            os.environ.pop("TIKTOKEN_CACHE_DIR", None)
            os.environ.pop("DATA_GYM_CACHE_DIR", None)
            with pushd(project):
                _again, again = embed_openai(
                    [{"id": "a", "text": "alpha"}],
                    model_name=OPENAI_EMBEDDING_MODEL,
                    dimensions=4,
                    cache_dir=Path(tmp) / "vectors",
                    preprocessing="title@1",
                    api_key="",
                    api_base="http://127.0.0.1/v1",
                    transport=lambda *_args: (_ for _ in ()).throw(AssertionError("embedding request")),
                    sleeper=lambda _delay: None,
                )
            self.assertFalse((project / "build").exists())
        self.assertEqual(meta["cacheHits"], 1)
        self.assertEqual(meta["apiCalls"], 0)
        self.assertEqual(again["cacheHits"], 1)
        self.assertEqual(again["apiCalls"], 0)

    def test_prepared_fixture_resolution_honors_cache_precedence(self):
        good = self.prepared_tokenizer
        urllib_request.urlopen = lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("fixture resolution downloaded")
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tik = root / "tik"
            gym = root / "gym"
            name = tokenizer_cache_name()
            tik.mkdir()
            gym.mkdir()
            default_cache = root / PROJECT_TOKENIZER_CACHE
            default_cache.mkdir(parents=True)
            (tik / name).write_bytes(good)
            (gym / name).write_bytes(b"gym-not-the-fixture")
            (default_cache / name).write_bytes(b"project-not-the-fixture")
            with pushd(root):
                os.environ["TIKTOKEN_CACHE_DIR"] = str(tik)
                os.environ["DATA_GYM_CACHE_DIR"] = str(gym)
                self.assertEqual(read_prepared_tokenizer(), good)

                os.environ.pop("TIKTOKEN_CACHE_DIR", None)
                (gym / name).write_bytes(good)
                self.assertEqual(read_prepared_tokenizer(), good)

                (tik / name).write_bytes(good)
                (gym / name).write_bytes(b"gym-not-the-fixture")
                os.environ["TIKTOKEN_CACHE_DIR"] = str(tik)
                self.assertEqual(read_prepared_tokenizer(), good)

                os.environ.pop("TIKTOKEN_CACHE_DIR", None)
                os.environ.pop("DATA_GYM_CACHE_DIR", None)
                (default_cache / name).write_bytes(good)
                self.assertEqual(openai_embeddings.tokenizer_cache_dir(), default_cache)
                self.assertEqual(read_prepared_tokenizer(), good)

                (tik / name).write_bytes(b"corrupt-fixture")
                os.environ["TIKTOKEN_CACHE_DIR"] = str(tik)
                with self.assertRaises(AssertionError) as invalid:
                    read_prepared_tokenizer()
                self.assertIn(CL100K_SHA256, str(invalid.exception))
                self.assertIn(str(tik / name), str(invalid.exception))

                os.environ["TIKTOKEN_CACHE_DIR"] = str(root / "missing")
                with self.assertRaises(AssertionError) as missing:
                    read_prepared_tokenizer()
                self.assertIn("not prepared", str(missing.exception))
                self.assertIn("prepare_tokenizer.py", str(missing.exception))

                os.environ["TIKTOKEN_CACHE_DIR"] = ""
                os.environ["DATA_GYM_CACHE_DIR"] = str(gym)
                (gym / name).write_bytes(good)
                with self.assertRaises(AssertionError) as empty:
                    read_prepared_tokenizer()
                self.assertIn("empty", str(empty.exception))
                self.assertIn("does not fall through", str(empty.exception))
                self.assertEqual(self.prepared_tokenizer, good)

    def test_reference_counts_keep_the_captured_fixture_when_the_cache_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["TIKTOKEN_CACHE_DIR"] = str(Path(tmp) / "missing-tokenizer")
            openai_embeddings._ENCODINGS.clear()
            urllib_request.urlopen = lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("reference count downloaded")
            )
            sample = "hello tokenizer"
            self.assertEqual(reference_token_count(sample), reference_token_count(sample))
            self.assertGreater(reference_token_count(sample), 1)
            self.assertEqual(self.prepared_tokenizer, OpenAIProviderTests.prepared_tokenizer)

    def test_prepare_command_verifies_a_seeded_cache_without_network_or_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "cache"
            gym = Path(tmp) / "gym"
            cache.mkdir()
            gym.mkdir()
            destination = cache / tokenizer_cache_name()
            destination.write_bytes(self.prepared_tokenizer)
            (gym / tokenizer_cache_name()).write_bytes(b"other-cache")
            block = Path(tmp) / "netblock"
            block.mkdir()
            (block / "sitecustomize.py").write_text(
                "import socket\n"
                "_connect = socket.socket.connect\n"
                "def connect(self, address):\n"
                "    raise OSError('public network blocked during prepare: %r' % (address,))\n"
                "socket.socket.connect = connect\n",
                encoding="utf-8",
            )
            env = os.environ.copy()
            env["TIKTOKEN_CACHE_DIR"] = str(cache)
            env["DATA_GYM_CACHE_DIR"] = str(gym)
            env.pop("OPENAI_API_KEY", None)
            env["PYTHONPATH"] = str(block) + os.pathsep + env.get("PYTHONPATH", "")
            proc = subprocess.run(
                [sys.executable, str(PREPARE_TOKENIZER)],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn(str(destination), proc.stdout)
            self.assertEqual(destination.read_bytes(), self.prepared_tokenizer)
            self.assertEqual((gym / tokenizer_cache_name()).read_bytes(), b"other-cache")
            self.assertNotIn("sk-", proc.stdout + proc.stderr)

    def test_prepare_command_rejects_an_empty_cache_without_falling_through(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            gym = root / "gym"
            gym.mkdir()
            default_cache = root / PROJECT_TOKENIZER_CACHE
            default_cache.mkdir(parents=True)
            name = tokenizer_cache_name()
            (gym / name).write_bytes(self.prepared_tokenizer)
            (default_cache / name).write_bytes(self.prepared_tokenizer)
            block = Path(tmp) / "netblock"
            block.mkdir()
            (block / "sitecustomize.py").write_text(
                "import socket\n"
                "_connect = socket.socket.connect\n"
                "def connect(self, address):\n"
                "    raise OSError('public network blocked during prepare: %r' % (address,))\n"
                "socket.socket.connect = connect\n",
                encoding="utf-8",
            )
            env = os.environ.copy()
            env["TIKTOKEN_CACHE_DIR"] = ""
            env["DATA_GYM_CACHE_DIR"] = str(gym)
            env.pop("OPENAI_API_KEY", None)
            env["PYTHONPATH"] = str(block) + os.pathsep + env.get("PYTHONPATH", "")
            proc = subprocess.run(
                [sys.executable, str(PREPARE_TOKENIZER)],
                cwd=root,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("empty", proc.stderr)
            self.assertIn("does not fall through", proc.stderr)
            self.assertIn("build/search-semantic/tokenizers", proc.stderr)
            self.assertEqual((gym / name).read_bytes(), self.prepared_tokenizer)
            self.assertEqual((default_cache / name).read_bytes(), self.prepared_tokenizer)

    def test_disabling_the_tokenizer_cache_still_checks_the_checksum(self):
        os.environ["TIKTOKEN_CACHE_DIR"] = ""
        openai_embeddings._ENCODINGS.clear()
        urllib_request.urlopen = lambda request, timeout=None: _TokenizerResponse(b"unchecked")
        with self.assertRaises(SystemExit) as raised:
            cl100k_tokenizer_bytes()
        self.assertIn(CL100K_SHA256, str(raised.exception))
        self.assertIsNone(tokenizer_cache_file())

    def test_invocation_directory_resolves_default_relative_and_absolute_caches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            other = root / "other"
            other.mkdir()
            absolute = root / "absolute-cache"
            absolute.mkdir()
            with pushd(root):
                os.environ.pop("TIKTOKEN_CACHE_DIR", None)
                os.environ.pop("DATA_GYM_CACHE_DIR", None)
                resolved = openai_embeddings.tokenizer_cache_dir()
                self.assertEqual(resolved, Path(os.getcwd()) / PROJECT_TOKENIZER_CACHE)
                self.assertNotEqual(resolved, ROOT / PROJECT_TOKENIZER_CACHE)
                self.assertFalse((root / "build").exists())

                os.environ["TIKTOKEN_CACHE_DIR"] = "rel/tokens"
                os.environ["DATA_GYM_CACHE_DIR"] = str(absolute)
                self.assertEqual(openai_embeddings.tokenizer_cache_dir(), Path(os.getcwd()) / "rel" / "tokens")

                os.environ["TIKTOKEN_CACHE_DIR"] = str(absolute)
                with pushd(other):
                    self.assertEqual(openai_embeddings.tokenizer_cache_dir(), absolute)

                os.environ.pop("TIKTOKEN_CACHE_DIR", None)
                os.environ["DATA_GYM_CACHE_DIR"] = "gym-rel"
                self.assertEqual(openai_embeddings.tokenizer_cache_dir(), Path(os.getcwd()) / "gym-rel")

                os.environ["DATA_GYM_CACHE_DIR"] = ""
                self.assertIsNone(openai_embeddings.tokenizer_cache_dir())

                os.environ["TIKTOKEN_CACHE_DIR"] = ""
                os.environ["DATA_GYM_CACHE_DIR"] = str(absolute)
                self.assertIsNone(openai_embeddings.tokenizer_cache_dir())
                self.assertFalse((root / PROJECT_TOKENIZER_CACHE).exists())

    def test_prepare_and_direct_build_follow_the_invocation_directory(self):
        name = tokenizer_cache_name()
        package_cache = ROOT / PROJECT_TOKENIZER_CACHE / name
        package_before = package_cache.read_bytes() if package_cache.is_file() else None
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            block = write_download_block(root)
            destination = root / PROJECT_TOKENIZER_CACHE / name
            destination.parent.mkdir(parents=True)
            destination.write_bytes(self.prepared_tokenizer)
            env = env_without_tokenizer_overrides(block)
            prepared = subprocess.run(
                [sys.executable, str(PREPARE_TOKENIZER)],
                cwd=root,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(prepared.returncode, 0, prepared.stderr)
            self.assertIn(str(destination), prepared.stdout)
            self.assertNotIn(str(ROOT / PROJECT_TOKENIZER_CACHE), prepared.stdout)

            rel = root / "rel" / "tokens"
            rel.mkdir(parents=True)
            (rel / name).write_bytes(self.prepared_tokenizer)
            rel_env = env_without_tokenizer_overrides(block)
            rel_env["TIKTOKEN_CACHE_DIR"] = "rel/tokens"
            rel_env["DATA_GYM_CACHE_DIR"] = str(root / "unused-gym")
            relative = subprocess.run(
                [sys.executable, str(PREPARE_TOKENIZER)],
                cwd=root,
                env=rel_env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(relative.returncode, 0, relative.stderr)
            self.assertIn(str(rel / name), relative.stdout)
            self.assertFalse((root / "unused-gym").exists())

            absolute = root / "abs-cache"
            absolute.mkdir()
            (absolute / name).write_bytes(self.prepared_tokenizer)
            other = root / "empty-cwd"
            other.mkdir()
            abs_env = env_without_tokenizer_overrides(block)
            abs_env["TIKTOKEN_CACHE_DIR"] = str(absolute)
            absolute_proc = subprocess.run(
                [sys.executable, str(PREPARE_TOKENIZER)],
                cwd=other,
                env=abs_env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(absolute_proc.returncode, 0, absolute_proc.stderr)
            self.assertIn(str(absolute / name), absolute_proc.stdout)
            self.assertFalse((other / "build").exists())

            corpus = root / "corpus.json"
            corpus.write_text(json.dumps(DOCS[:1]), encoding="utf-8")
            lexical_out = root / "lexical.json"
            lex_env = env_without_tokenizer_overrides(block)
            lex_env["PYTHONPATH"] = str(ROOT) + os.pathsep + lex_env.get("PYTHONPATH", "")
            imported = subprocess.run(
                [sys.executable, "-c", "import lib.embedding, lib.openai_embeddings"],
                cwd=other,
                env=lex_env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(imported.returncode, 0, imported.stderr)
            self.assertFalse((other / "build").exists())
            lexical = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "build.py"),
                    "--input",
                    str(corpus),
                    "--output",
                    str(lexical_out),
                    "--method",
                    "lexical",
                    "--cache-dir",
                    str(root / "vectors"),
                ],
                cwd=other,
                env=env_without_tokenizer_overrides(block),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(lexical.returncode, 0, lexical.stderr)
            self.assertFalse((other / "build").exists())
            self.assertTrue(lexical_out.is_file())

            graph = root / "graph.json"
            graph.write_text("KEEP\n", encoding="utf-8")
            build_cmd = [
                sys.executable,
                str(ROOT / "build.py"),
                "--input",
                str(corpus),
                "--output",
                str(graph),
                "--method",
                "embedding",
                "--embedding-provider",
                "openai",
                "--model",
                OPENAI_EMBEDDING_MODEL,
                "--dimensions",
                "4",
                "--cache-dir",
                str(root / "vectors"),
                "--openai-api-base",
                "http://127.0.0.1:9/v1",
            ]
            miss_cwd = root / "miss-project"
            miss_cwd.mkdir()
            miss_env = env_without_tokenizer_overrides(block)
            miss_env["OPENAI_API_KEY"] = "sk-test"
            missed = subprocess.run(
                build_cmd,
                cwd=miss_cwd,
                env=miss_env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(missed.returncode, 0)
            self.assertIn("Could not download the cl100k_base tokenizer", missed.stderr)
            self.assertIn(str(miss_cwd / PROJECT_TOKENIZER_CACHE / name), missed.stderr)
            self.assertNotIn(str(ROOT / PROJECT_TOKENIZER_CACHE), missed.stderr)
            self.assertEqual(graph.read_text(encoding="utf-8"), "KEEP\n")
            self.assertFalse((miss_cwd / "build").exists())

            hit_cwd = root / "hit-project"
            hit_cache = hit_cwd / PROJECT_TOKENIZER_CACHE
            hit_cache.mkdir(parents=True)
            (hit_cache / name).write_bytes(self.prepared_tokenizer)
            hit_env = env_without_tokenizer_overrides(block)
            hit_env["OPENAI_API_KEY"] = "sk-test"
            hit = subprocess.run(
                build_cmd,
                cwd=hit_cwd,
                env=hit_env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(hit.returncode, 0)
            self.assertIn("HTTP 400", hit.stderr)
            self.assertNotIn("Could not download the cl100k_base tokenizer", hit.stderr)
            self.assertEqual((hit_cache / name).read_bytes(), self.prepared_tokenizer)
            self.assertEqual(graph.read_text(encoding="utf-8"), "KEEP\n")
            self.assertFalse(any(path.name == name for path in (root / "vectors").rglob("*") if path.is_file()))
        package_after = package_cache.read_bytes() if package_cache.is_file() else None
        self.assertEqual(package_after, package_before)

    @unittest.skipUnless(os.environ.get("SEARCH_SEMANTIC_OPENAI_LIVE") == "1", "set SEARCH_SEMANTIC_OPENAI_LIVE=1 to call OpenAI")
    def test_live_openai_embedding(self):
        if not os.environ.get("OPENAI_API_KEY"):
            self.skipTest("OPENAI_API_KEY is not set")
        with tempfile.TemporaryDirectory() as tmp:
            matrix, meta = embed_openai(
                [{"id": "a", "text": "tls certificates"}],
                model_name=OPENAI_EMBEDDING_MODEL,
                dimensions=OPENAI_EMBEDDING_DIMENSIONS,
                cache_dir=Path(tmp),
                preprocessing="live@1",
                api_key=os.environ["OPENAI_API_KEY"],
                api_base=os.environ.get("OPENAI_API_BASE"),
                sleeper=lambda _delay: None,
            )
        self.assertEqual(matrix.shape, (1, OPENAI_EMBEDDING_DIMENSIONS))
        self.assertEqual(meta["apiCalls"], 1)
        self.assertGreater(meta["promptTokens"], 0)


if __name__ == "__main__":
    unittest.main()
