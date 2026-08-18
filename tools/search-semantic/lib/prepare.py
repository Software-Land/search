"""Document text preparation for relationship analysis."""

from __future__ import annotations

import re
from typing import Iterable

TOKEN_RE = re.compile(r"[a-z0-9]+")

STOP = {
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
    "as", "at", "by", "from", "that", "this", "it", "be", "was", "were", "vs", "what",
}


def tokenize(text: str) -> list[str]:
    return [t for t in TOKEN_RE.findall(str(text or "").lower()) if t not in STOP and len(t) > 1]


def lead_tokens(text: str, n: int) -> list[str]:
    raw = TOKEN_RE.findall(str(text or "").lower())
    return raw[: max(0, n)]


def heading_text(doc: dict) -> str:
    headings = doc.get("headings")
    if isinstance(headings, list) and headings:
        return " ".join(str(h) for h in headings if h)
    return ""


def prepare_text(doc: dict, representation: str) -> str:
    title = str(doc.get("title") or "")
    body = str(doc.get("body") or "")
    if representation == "title":
        return title
    if representation == "title_lead":
        lead = " ".join(lead_tokens(body, 80))
        return f"{title}\n{title}\n{lead}"
    if representation == "title_struct":
        lead = " ".join(lead_tokens(body, 80))
        return f"Title: {title}\nTitle: {title}\nBody: {lead}"
    if representation == "title_once_lead":
        lead = " ".join(lead_tokens(body, 80))
        return f"Title: {title}\nBody: {lead}"
    if representation == "title_headings":
        heads = heading_text(doc) or " ".join(lead_tokens(body, 40))
        return f"Title: {title}\nTitle: {title}\nHeadings: {heads}"
    if representation == "title_body":
        body_part = " ".join(lead_tokens(body, 400))
        return f"{title}\n{title}\n{body_part}"
    if representation == "title_full":
        body_part = " ".join(lead_tokens(body, 1200))
        return f"{title}\n{body_part}"
    raise ValueError(f"unknown representation {representation}")


def prepared_documents(docs: Iterable[dict], representation: str) -> list[dict]:
    out = []
    for doc in docs:
        text = prepare_text(doc, representation)
        out.append(
            {
                "id": str(doc["id"]),
                "title": str(doc.get("title") or ""),
                "text": text,
                "tokens": tokenize(text),
            }
        )
    return out
