---
name: ug-import
description: >-
  Import Ultimate-Guitar chord tabs by URL into the local library as
  YAML-frontmatter monospace markdown, then rebuild library/index.json.
  Use when the user runs /ug-import, pastes a tabs.ultimate-guitar.com URL,
  or asks to download/import a UG chord chart.
disable-model-invocation: true
---

# UG Import

Fetch a chords tab from Ultimate-Guitar, convert it to the project song format, and save it under `library/`.

## Usage

```
/ug-import https://tabs.ultimate-guitar.com/tab/beck/country-down-chords-1466425
```

Also accept a bare UG chords tab URL without the `/ug-import` prefix.

## Prerequisites

- Working directory is this repo root.
- Network access for the fetch (personal use; respect UG ToS — do not scrape at scale).
- Prefer **Chords** tabs (`…-chords-…` URLs). If the user pastes a non-chords tab, warn and ask before continuing.

## Workflow

Copy and track:

```
UG import progress:
- [ ] 1. Validate URL
- [ ] 2. Fetch + parse + write markdown
- [ ] 3. Confirm album / path (rename if needed)
- [ ] 4. Rebuild index (script already does this)
- [ ] 5. Report path + viewer hash
```

### 1. Validate URL

- Must be `https://tabs.ultimate-guitar.com/tab/...`
- Prefer URLs containing `-chords-`

### 2. Import

Run from repo root:

```bash
python3 scripts/ug_import.py "URL"
```

Offline / fixture mode:

```bash
python3 scripts/ug_import.py "URL" --html fixtures/beck-country-down.html
```

This writes:

`library/artists/<artist>/albums/<album|singles>/<song>.md`

and updates `library/index.json`. New chord shapes from UG are merged into `assets/chord-shapes.json` when missing.

### 3. Album metadata

UG often omits album name (defaults to `singles`). If the user knows the album:

1. Edit frontmatter `album:`
2. Move the file to `library/artists/<artist>/albums/<album-slug>/`
3. Run `python3 scripts/rebuild_index.py`

Or use [/library-organize](../library-organize/SKILL.md).

### 4. Cleanup

If spacing or chord list looks messy:

```bash
python3 scripts/chord_cleanup.py path/to/song.md
python3 scripts/rebuild_index.py
```

See [/chord-cleanup](../chord-cleanup/SKILL.md).

### 5. Report

Tell the user:

- Absolute or repo-relative path written
- `make server` → open `#/song/<artist>/<album>/<song>`
- Remind them `library/` is gitignored unless they use a submodule

## Song format contract

```markdown
---
title: ...
artist: ...
album: ...
tuning: E A D G B E
capo: 0
key: null
difficulty: intermediate
source: https://...
source_id: "123"
imported_at: YYYY-MM-DD
chords: [G, C, Am]
---

```
[Intro]
G         C
...
```
```

Body is a fenced monospace chord chart (chord rows above lyric rows).

## Legal

Personal practice copies only. Ultimate-Guitar terms apply to fetching. Do not redistribute copyrighted tabs without rights. See repo README.
