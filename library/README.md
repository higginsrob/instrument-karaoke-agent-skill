# Song library

Imported chord charts and media live here (gitignored on `main`).

## Layout

```
library/
├── index.json
└── artists/<artist-slug>/albums/<album-slug>/
    ├── <song-slug>.md
    └── <song-slug>/          # optional media artifacts (local / admin only)
        ├── media.json
        ├── mixes/            # playable MP3s
        ├── youtube/          # poster.jpg + video.mp4
        ├── stems/            # demucs WAVs
        └── …
```

Songs without a known album go under `albums/singles/`.

## Publishing

- **`make github-pages`** — charts only (`*.md` + `index.json`) on the `gh-pages` branch. No mixes, video, or other media cache. Deployed site is Scroll view only.
- **Optional submodule** — for a separate always-public collection:

```bash
# from repo root (after removing the empty library/ placeholder if needed)
git submodule add https://github.com/<you>/instrument-karaoke-library.git library
```

Then import with `/ug-import`, commit inside `library/`, and push that submodule repo separately.
