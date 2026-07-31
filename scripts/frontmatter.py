"""Minimal YAML helpers for song frontmatter (stdlib only)."""

from __future__ import annotations

import re
from typing import Any


def dump_frontmatter(data: dict[str, Any]) -> str:
    lines: list[str] = []
    for key, value in data.items():
        lines.append(f"{key}: {_dump_value(value)}")
    return "\n".join(lines) + "\n"


def _dump_value(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return str(value)
    if isinstance(value, list):
        if not value:
            return "[]"
        # Prefer flow style for short chord lists
        inner = ", ".join(_dump_scalar(v) for v in value)
        return f"[{inner}]"
    return _dump_scalar(value)


def _dump_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    text = str(value)
    if text == "":
        return '""'
    needs_quote = (
        re.search(r'[:#\[\]{},&*!|>\'"%@`]', text)
        or text.strip() != text
        or text.lower() in {"null", "true", "false", "yes", "no"}
        or re.fullmatch(r"-?\d+(\.\d+)?", text) is not None
    )
    if needs_quote:
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return text


def load_frontmatter(text: str) -> dict[str, Any]:
    """Parse a simple YAML mapping (our song frontmatter subset)."""
    result: dict[str, Any] = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.strip().startswith("#"):
            i += 1
            continue
        if ":" not in line:
            i += 1
            continue
        key, _, rest = line.partition(":")
        key = key.strip()
        rest = rest.strip()
        if rest == "" or rest == "|":
            # block list
            items: list[Any] = []
            i += 1
            while i < len(lines):
                nxt = lines[i]
                if re.match(r"^-\s+", nxt):
                    items.append(_parse_scalar(nxt[1:].strip()))
                    i += 1
                elif nxt.strip() == "":
                    i += 1
                else:
                    break
            result[key] = items
            continue
        result[key] = _parse_scalar(rest)
        i += 1
    return result


def _parse_scalar(text: str) -> Any:
    if text == "null" or text == "~" or text == "":
        return None
    if text == "true":
        return True
    if text == "false":
        return False
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d+\.\d+", text):
        return float(text)
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        parts = _split_flow_list(inner)
        return [_parse_scalar(p.strip()) for p in parts]
    if (text.startswith('"') and text.endswith('"')) or (
        text.startswith("'") and text.endswith("'")
    ):
        return text[1:-1]
    return text


def _split_flow_list(inner: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    in_quote: str | None = None
    for ch in inner:
        if in_quote:
            buf.append(ch)
            if ch == in_quote:
                in_quote = None
            continue
        if ch in "\"'":
            in_quote = ch
            buf.append(ch)
            continue
        if ch == ",":
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    if buf or parts:
        parts.append("".join(buf))
    return parts
