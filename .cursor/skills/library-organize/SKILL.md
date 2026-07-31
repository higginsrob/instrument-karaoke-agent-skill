---
name: library-organize
description: >-
  Reorganize the instrument-karaoke library by artist/album slugs, fix song paths
  from frontmatter, and rebuild library/index.json. Use when the user asks
  to organize the library, fix album folders, or regenerate the catalog index.
disable-model-invocation: true
---

# Library Organize

Keep `library/` paths aligned with song frontmatter and refresh the catalog.

## Usage

```
/library-organize
/library-organize library/artists/beck/albums/singles/country-down.md
```

## Layout

```
library/
├── index.json
└── artists/<artist-slug>/albums/<album-slug>/<song-slug>.md
```

Unknown albums use `albums/singles/`.

## Workflow

Copy and track:

```
Library organize:
- [ ] 1. Scan library/artists/**/*.md
- [ ] 2. For each song, compare path vs frontmatter artist/album/title
- [ ] 3. Move/rename with slugify rules if mismatched
- [ ] 4. Rebuild index
- [ ] 5. Report moves
```

### Slug rules

Use the same slugify as import (`python3 -c` or move via script):

```bash
python3 - <<'PY'
from scripts.slugify import slugify
print(slugify("Sea Change"))
PY
```

Target path:

`library/artists/{slugify(artist)}/albums/{slugify(album or 'singles')}/{slugify(title)}.md`

Update frontmatter `album:` when moving out of `singles` if the user provides an album name.

### Rebuild index

Always finish with:

```bash
python3 scripts/rebuild_index.py
```

### Empty library

If `library/artists/` is missing, say so and point to `/ug-import` or copying `fixtures/demo-library/` for a local demo:

```bash
cp -R fixtures/demo-library/. library/
python3 scripts/rebuild_index.py
```

## Submodule note

If `library/` is a git submodule, commit/push inside that repo — do not force-add ignored files into the parent repo.
