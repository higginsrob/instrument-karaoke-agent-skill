"""URL-safe slugs for artist / album / song paths."""

from __future__ import annotations

import re
import unicodedata


def slugify(value: str, fallback: str = "unknown") -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = text.encode("ascii", "ignore").decode("ascii")
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[-\s]+", "-", text).strip("-")
    return text or fallback
