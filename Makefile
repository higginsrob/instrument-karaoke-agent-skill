.PHONY: help server build prod index test import batch-import github-pages \
	media-up media-up-gpu media-build media-build-cpu media-build-gpu media-down youtube-cookies

.DEFAULT_GOAL := help

BROWSER ?= chrome
PORT ?= 8080
YOUTUBE_COOKIES := services/media-pipeline/secrets/youtube.cookies.txt

# Static demo publish (GitHub Pages) — charts only (no cached audio/video).
GH_PAGES_BRANCH ?= gh-pages
GH_PAGES_REMOTE ?= origin
GH_PAGES_URL ?= https://higginsrob.github.io/instrument-karaoke-agent-skill/

# Chord tabs + index only. Media stays local for admin / media-pipeline.
GH_PAGES_RSYNC_FILTER := \
	--include '*/' \
	--include 'README.md' \
	--include 'index.json' \
	--include '*.md' \
	--exclude '*'

help:
	@echo ""
	@echo "  Instrument Karaoke — make targets"
	@echo "  ──────────────────────────────────────────────────"
	@echo "  make help          Show this help"
	@echo "  make server        Serve site (admin) at http://127.0.0.1:8765"
	@echo "  make build         Build static site into _site/"
	@echo "  make prod          Build + serve static site (no admin) at http://127.0.0.1:$(PORT)"
	@echo "  make index         Rebuild library/index.json from song markdown"
	@echo "  make test          Run unit + smoke tests"
	@echo "  make import        Usage: make import URL=<ug-tab-url>"
	@echo "  make batch-import  Usage: make batch-import FILE=tmp/mytabs-urls.txt"
	@echo "  make github-pages  Publish charts-only static demo to $(GH_PAGES_BRANCH)"
	@echo "                     (no audio/video; Scroll view only)."
	@echo "                     Live example: $(GH_PAGES_URL)"
	@echo "  make media-up      Start media-pipeline API (CPU Docker) on :8093"
	@echo "  make media-up-gpu  Start media-pipeline API (GPU Docker) on :8093"
	@echo "  make media-build-cpu  Build CPU media-pipeline image"
	@echo "  make media-build-gpu  Build GPU media-pipeline image"
	@echo "  make media-build   Build CPU + GPU media-pipeline images"
	@echo "  make media-down    Stop media-pipeline containers"
	@echo "  make youtube-cookies  Export YouTube cookies (BROWSER=chrome|safari|firefox)"
	@echo ""

server:
	MEDIA_API_URL=$${MEDIA_API_URL:-http://127.0.0.1:8093} python3 scripts/serve.py

build:
	python3 scripts/build_static.py

prod: build
	python3 scripts/serve_static.py --port $(PORT)

index:
	python3 scripts/rebuild_index.py

test:
	python3 -m unittest discover -s tests -v

import:
	@test -n "$(URL)" || (echo "Usage: make import URL=https://tabs.ultimate-guitar.com/tab/..."; exit 1)
	python3 scripts/ug_import.py "$(URL)"

batch-import:
	@test -n "$(FILE)" || (echo "Usage: make batch-import FILE=tmp/mytabs-urls.txt"; exit 1)
	python3 scripts/ug_batch_import.py "$(FILE)" $(if $(DELAY),--delay $(DELAY),) $(if $(LIMIT),--limit $(LIMIT),)

# Start only — use media-build-cpu / media-build-gpu / media-build when the image needs rebuilding.
media-up:
	cd services/media-pipeline && docker compose up

media-up-gpu:
	cd services/media-pipeline && docker compose --profile gpu up media-pipeline-gpu

media-build-cpu:
	cd services/media-pipeline && docker compose build media-pipeline

media-build-gpu:
	cd services/media-pipeline && docker compose --profile gpu build media-pipeline-gpu

media-build: media-build-cpu media-build-gpu

media-down:
	cd services/media-pipeline && docker compose --profile gpu down
	cd services/media-pipeline && docker compose down

youtube-cookies:
	@command -v yt-dlp >/dev/null || { echo "yt-dlp not found. Install: brew install yt-dlp"; exit 1; }
	@mkdir -p services/media-pipeline/secrets
	# Single watch URL (not youtube.com/) so yt-dlp does not crawl the home feed.
	yt-dlp --cookies-from-browser $(BROWSER) --cookies "$(YOUTUBE_COOKIES)" \
		--skip-download --no-playlist "https://www.youtube.com/watch?v=jNQXAC9IVRw"
	@echo "Wrote $(YOUTUBE_COOKIES) (from $(BROWSER)). Restart media-pipeline if it is already running."

# Publish chord charts only to gh-pages (no mixes / video / stems).
# Uses a temporary worktree so switching branches cannot wipe gitignored local data.
github-pages:
	@set -eu; \
	export GIT_SSH_COMMAND="$${GIT_SSH_COMMAND:-ssh -o Compression=no}"; \
	if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then \
		echo "Not a git repository."; exit 1; \
	fi; \
	if ! git diff --quiet || ! git diff --cached --quiet; then \
		echo "Working tree has uncommitted changes. Commit or stash first."; exit 1; \
	fi; \
	if [ ! -f library/index.json ]; then \
		echo "Missing library/index.json — import songs or seed fixtures/demo-library first."; exit 1; \
	fi; \
	if [ ! -d library/artists ] || [ -z "$$(find library/artists -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)" ]; then \
		echo "library/artists/ looks empty — import at least one song for a useful demo."; exit 1; \
	fi; \
	command -v rsync >/dev/null || { echo "rsync is required for make github-pages."; exit 1; }; \
	ROOT=$$(git rev-parse --show-toplevel); \
	BASE="main"; \
	if git show-ref --verify --quiet refs/heads/main; then \
		if git fetch $(GH_PAGES_REMOTE) main 2>/dev/null; then \
			BASE="$(GH_PAGES_REMOTE)/main"; \
			if git merge-base --is-ancestor $(GH_PAGES_REMOTE)/main main; then \
				BASE="main"; \
			fi; \
		else \
			echo "No $(GH_PAGES_REMOTE)/main yet — publishing from local main."; \
		fi; \
	else \
		echo "Missing local main branch."; exit 1; \
	fi; \
	WT=$$(mktemp -d "$${TMPDIR:-/tmp}/instrument-karaoke-gh-pages.XXXXXX"); \
	cleanup() { git worktree remove --force "$$WT" 2>/dev/null || rm -rf "$$WT"; }; \
	trap cleanup EXIT; \
	echo "Building $(GH_PAGES_BRANCH) from $${BASE} in worktree (charts only)..."; \
	git worktree add --detach "$$WT" "$$BASE"; \
	rm -rf "$$WT/library"; \
	mkdir -p "$$WT/library"; \
	rsync -a $(GH_PAGES_RSYNC_FILTER) "$$ROOT/library/" "$$WT/library/"; \
	touch "$$WT/.nojekyll"; \
	find "$$WT/library" -name .DS_Store -delete 2>/dev/null || true; \
	python3 "$$ROOT/scripts/rebuild_index.py" --library "$$WT/library"; \
	python3 "$$ROOT/scripts/strip_pages_media_flags.py" "$$WT/library/index.json"; \
	PUB_BYTES=$$(find "$$WT/library" -type f -exec stat -f%z {} + 2>/dev/null | awk '{s+=$$1} END {print s+0}'); \
	echo "Pages library payload: $$((PUB_BYTES / 1024 / 1024)) MiB (charts only)"; \
	git -C "$$WT" checkout -B $(GH_PAGES_BRANCH); \
	echo "Staging charts (force-add; gitignored on main)..."; \
	git -C "$$WT" add -f .nojekyll \
		':(exclude)*.DS_Store' ':(exclude)**/.DS_Store' \
		library; \
	if git -C "$$WT" diff --cached --quiet; then \
		echo "Nothing new to publish (tree already matches)."; \
	else \
		git -C "$$WT" commit -m "$$(printf '%s\n\n%s\n' \
			'Publish static example library for GitHub Pages' \
			'Charts only — no cached audio/video on the demo site.')"; \
	fi; \
	echo "Pushing $(GH_PAGES_BRANCH) -> $(GH_PAGES_REMOTE)..."; \
	if ! git -C "$$WT" push --force-with-lease -u $(GH_PAGES_REMOTE) $(GH_PAGES_BRANCH); then \
		echo "force-with-lease failed; retrying with --force for publish branch..."; \
		git -C "$$WT" push --force -u $(GH_PAGES_REMOTE) $(GH_PAGES_BRANCH); \
	fi; \
	trap - EXIT; \
	cleanup; \
	echo ""; \
	echo "Published charts-only demo (local library/ untouched)."; \
	echo "  Branch: $(GH_PAGES_BRANCH)"; \
	echo "  URL:    $(GH_PAGES_URL)"; \
	echo "If the site 404s, set Pages source to branch $(GH_PAGES_BRANCH) / (root) in repo Settings."
