---
name: chord-cleanup
description: >-
  Normalize an existing chord markdown song file: clean UG tags,
  spacing, and refresh the chords list in YAML frontmatter. Use when the
  user asks to clean up, normalize, or fix a song chart in library/.
disable-model-invocation: true
---

# Chord Cleanup

Normalize a song markdown file already in the library (or elsewhere).

## Usage

```
/chord-cleanup library/artists/beck/albums/singles/country-down.md
```

## Workflow

1. Confirm the path exists and has YAML frontmatter.
2. Run:

```bash
python3 scripts/chord_cleanup.py path/to/song.md
python3 scripts/rebuild_index.py
```

3. Summarize what changed (chord list, stripped tags, path).

## What the script does

- Strips leftover `[ch]` / `[tab]` tags and NBSP
- Removes lone trailing `X` lines
- Re-wraps body in a monospace fence
- Rebuilds `chords:` from chord-only lines if missing

Do not invent lyrics or chords. Only normalize formatting.
