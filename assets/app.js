(function () {
  const app = document.getElementById("app");
  const CHORD_RE =
    /\b([A-G](?:#|b)?(?:(?:maj|min|dim|aug|sus|add|M|m)?[0-9]*(?:[#b][0-9]+)?){0,3}(?:\([#b0-9]+\))?(?:\/[A-G](?:#|b)?)?)(?!\w)/g;
  const SECTION_RE = /^\[.+\]$/;
  const SECTION_LOOSE_RE =
    /^(intro|verse|chorus|bridge|outro|solo|instrumental|interlude|pre-?chorus|break|coda|ending)(\s+\d+)?(\s*[:.\-]?\s*\d*x?)?$/i;
  const VIEW_MODE_STORAGE_KEY = "instrument-karaoke.song-view-mode";
  const VIEW_AS_USER_STORAGE_KEY = "instrument-karaoke.view-as-user";
  const SHOW_CHORDS_STORAGE_KEY = "instrument-karaoke.show-chords";
  const ACCENT_STORAGE_KEY = "instrument-karaoke.chord-accent";
  const ACCENT_DEFAULT = "#1e1e1e";
  const ACCENT_COLORS = [
    { id: "black", label: "Black", value: "#1e1e1e" },
    { id: "red", label: "Red", value: "#e04545" },
    { id: "orange", label: "Orange", value: "#e88520" },
    { id: "teal", label: "Teal", value: "#2a9a9a" },
    { id: "blue", label: "Blue", value: "#3a7fd4" },
    { id: "purple", label: "Purple", value: "#8b5cc7" },
    { id: "rose", label: "Rose", value: "#d45a8a" },
  ];
  /** Non-root chord tones share one gray; root uses the selected accent. */
  const CHORD_OTHER_TONE = "#5c5c5c";
  const CHORD_TONE_CSS_VARS = [
    "--chord-tone-root",
    "--chord-tone-other",
    "--chord-tone-third",
    "--chord-tone-fifth",
    "--chord-tone-fifth-alt",
    "--chord-tone-sixth",
    "--chord-tone-seventh",
    "--chord-tone-ninth",
    "--chord-tone-eleventh",
    "--chord-tone-extension",
  ];

  let index = null;
  let shapes = {};
  let isAdmin = false;
  let viewAsUser = readViewAsUserPref();
  let chordAccent = readAccentPref();
  let showChords = readShowChordsPref();
  let songKeydownHandler = null;
  let songAccentHandler = null;
  let mediaPlayerHandle = null;
  let queueHandle = null;
  let chartSyncState = {
    alignMode: false,
    playingLineIndex: -1,
    selectedLineIndex: -1,
    stampedIndices: [],
    lyricDisplay: "chart",
  };
  let scrollState = {
    playing: false,
    countingDown: false,
    countdownTimer: null,
    raf: null,
    last: 0,
    carry: 0,
    speed: 1,
    startDelay: 0,
  };

  function hasPlayableMedia(status, song) {
    // Pages may keep media_status=ready in frontmatter without shipping mixes.
    if (song && typeof song === "object" && "media_playable" in song && !song.media_playable) {
      return false;
    }
    if (status === "ready") return true;
    // Needs-review media is admin-only until verified.
    return status === "needs_review" && adminUi();
  }

  /** Public-facing media status for non-admin UI (tables + song meta). */
  function publicMediaStatus(status) {
    const st = String(status || "none");
    if (adminUi()) return st;
    return st === "ready" ? "ready" : "none";
  }

  function readViewAsUserPref() {
    try {
      return localStorage.getItem(VIEW_AS_USER_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function writeViewAsUserPref(on) {
    try {
      localStorage.setItem(VIEW_AS_USER_STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* ignore quota / private mode */
    }
  }

  /** Admin UI features — false when viewing as a regular user. */
  function adminUi() {
    return isAdmin && !viewAsUser;
  }

  function readShowChordsPref() {
    try {
      const raw = localStorage.getItem(SHOW_CHORDS_STORAGE_KEY);
      if (raw == null) return true;
      return raw !== "0";
    } catch {
      return true;
    }
  }

  function writeShowChordsPref(on) {
    try {
      localStorage.setItem(SHOW_CHORDS_STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* ignore quota / private mode */
    }
  }

  function applyShowChords(on) {
    showChords = Boolean(on);
    document.documentElement.classList.toggle("chords-hidden", !showChords);
    const toggle = document.getElementById("settings-show-chords");
    if (toggle) toggle.checked = showChords;
  }

  function readViewModePref() {
    try {
      return localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "videoScroll" ? "videoScroll" : "scroll";
    } catch {
      return "scroll";
    }
  }

  function writeViewModePref(mode) {
    try {
      localStorage.setItem(
        VIEW_MODE_STORAGE_KEY,
        mode === "videoScroll" ? "videoScroll" : "scroll"
      );
    } catch {
      /* ignore quota / private mode */
    }
  }

  function readAccentPref() {
    try {
      const raw = localStorage.getItem(ACCENT_STORAGE_KEY);
      if (!raw) return ACCENT_DEFAULT;
      const allowed = new Set(ACCENT_COLORS.map((c) => c.value));
      return allowed.has(raw) ? raw : ACCENT_DEFAULT;
    } catch {
      return ACCENT_DEFAULT;
    }
  }

  function writeAccentPref(value) {
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, value);
    } catch {
      /* ignore quota / private mode */
    }
  }

  function applyChordAccent(value) {
    const allowed = new Set(ACCENT_COLORS.map((c) => c.value));
    chordAccent = allowed.has(value) ? value : ACCENT_DEFAULT;
    const root = document.documentElement;
    root.style.setProperty("--chord-accent", chordAccent);
    root.style.setProperty("--chord-tone-root", chordAccent);
    for (const cssVar of CHORD_TONE_CSS_VARS) {
      if (cssVar === "--chord-tone-root") continue;
      root.style.setProperty(cssVar, CHORD_OTHER_TONE);
    }
    document.querySelectorAll(".accent-swatch").forEach((el) => {
      const active = el.dataset.accent === chordAccent;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-checked", active ? "true" : "false");
    });
    window.dispatchEvent(new CustomEvent("chord-accent-change"));
  }

  function accentSwatchesHtml() {
    return `
      <div class="accent-field">
        <span class="tuning-label">Chord color</span>
        <div class="accent-swatches" id="accent-swatches" role="radiogroup" aria-label="Chord color">
          ${ACCENT_COLORS.map(
            (c) =>
              `<button type="button" class="accent-swatch${c.value === chordAccent ? " is-active" : ""}" data-accent="${c.value}" style="--swatch:${c.value}" role="radio" aria-checked="${c.value === chordAccent ? "true" : "false"}" aria-label="${escapeHtml(c.label)}" title="${escapeHtml(c.label)}"></button>`
          ).join("")}
        </div>
      </div>`;
  }

  function showChordsToggleHtml() {
    return `
      <label class="settings-toggle">
        <input type="checkbox" id="settings-show-chords"${showChords ? " checked" : ""} />
        <span>Show chords</span>
      </label>`;
  }

  function closeSettingsModal() {
    document.getElementById("settings-modal")?.remove();
    document.removeEventListener("keydown", onSettingsKeydown, true);
  }

  function onSettingsKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSettingsModal();
    }
  }

  function openSettingsModal() {
    closeSettingsModal();
    const overlay = document.createElement("div");
    overlay.id = "settings-modal";
    overlay.className = "modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "settings-modal-title");
    overlay.innerHTML = `
      <div class="modal-dialog settings-modal-dialog">
        <h2 id="settings-modal-title" class="modal-title">Settings</h2>
        <div class="settings-body">
          ${showChordsToggleHtml()}
          ${accentSwatchesHtml()}
        </div>
        <div class="modal-actions">
          <button type="button" class="modal-btn secondary" data-action="close">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSettingsModal();
      const swatch = e.target.closest("[data-accent]");
      if (swatch) {
        writeAccentPref(swatch.dataset.accent);
        applyChordAccent(swatch.dataset.accent);
      }
    });
    overlay.querySelector("#settings-show-chords")?.addEventListener("change", (e) => {
      const on = Boolean(e.target.checked);
      writeShowChordsPref(on);
      applyShowChords(on);
    });
    overlay.querySelector('[data-action="close"]')?.addEventListener("click", closeSettingsModal);
    document.addEventListener("keydown", onSettingsKeydown, true);
    overlay.querySelector('[data-action="close"]')?.focus();
  }

  function wireSettingsNav() {
    document.getElementById("nav-settings")?.addEventListener("click", openSettingsModal);
  }

  function clampSpeed(n) {
    if (!Number.isFinite(n)) return 1;
    return Math.min(4, Math.max(0.5, n));
  }

  function clampStartDelay(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.min(30, Math.max(0, n));
  }

  function isTabLine(line) {
    const t = line.trim();
    if (!t) return false;
    if (/^[eEBGDA]\s*[|:].*[-0-9xh]/i.test(t)) return true;
    if (/^[eEBGDA]\|/i.test(t)) return true;
    if (!t.includes("|") || !t.includes("-")) return false;
    const stripped = t.replace(/[-|0-9xhbrp~^\\/=*\s]/gi, "");
    return stripped.length <= 2 && t.length >= 8;
  }

  function isSectionMarker(line) {
    const t = line.trim();
    return SECTION_RE.test(t) || SECTION_LOOSE_RE.test(t);
  }

  function isMetaLine(line) {
    const t = line.trim();
    if (!t) return false;
    if (/^tabbed by\b/i.test(t)) return true;
    if (/^chords used\b/i.test(t)) return true;
    if (/^(capo|tuning|key)\s*:/i.test(t)) return true;
    if (/^\([^)]*\)$/.test(t)) return true;
    if (/\btab\b/i.test(t) && t.length < 60) {
      CHORD_RE.lastIndex = 0;
      const leftover = t.replace(CHORD_RE, "").replace(/[\s|/.\-#]+/g, "");
      CHORD_RE.lastIndex = 0;
      if (leftover.length > 0 && !isSectionMarker(t)) return true;
    }
    return false;
  }

  function isChordDiagramHeader(line, nextLine) {
    if (!nextLine || !isTabLine(nextLine)) return false;
    const t = line.trim();
    if (!t) return false;
    CHORD_RE.lastIndex = 0;
    const leftover = t
      .replace(CHORD_RE, " ")
      .replace(/[*,xX0-9()\s|/.\-]+/g, "");
    CHORD_RE.lastIndex = 0;
    return leftover.length === 0;
  }

  function isChordOnlyLine(line) {
    const t = line.trim();
    if (!t) return false;
    CHORD_RE.lastIndex = 0;
    const leftover = t
      .replace(CHORD_RE, " ")
      .replace(/[,\sxX0-9()|/.\-*×#]+/gi, "")
      .trim();
    CHORD_RE.lastIndex = 0;
    return leftover.length === 0;
  }

  function isFretDiagramLine(line) {
    const t = line.trim();
    if (!t) return false;
    CHORD_RE.lastIndex = 0;
    if (!CHORD_RE.test(t)) {
      // Bare fret dump like "x02220" / "xx0230"
      return /^[xX0-9\-]{4,8}$/.test(t);
    }
    CHORD_RE.lastIndex = 0;
    const withoutChords = t.replace(CHORD_RE, " ").replace(/\s+/g, "");
    CHORD_RE.lastIndex = 0;
    if (withoutChords.length < 4 || withoutChords.length > 12) return false;
    return /^[xX0-9\-]+$/.test(withoutChords);
  }

  function simplifyChartBody(body) {
    const lines = String(body || "").split("\n");
    const kept = [];
    let started = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) {
        if (started) kept.push("");
        continue;
      }
      if (isTabLine(line) || isMetaLine(line) || isFretDiagramLine(line)) continue;
      let nextNonEmpty = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) {
          nextNonEmpty = lines[j];
          break;
        }
      }
      if (isChordDiagramHeader(line, nextNonEmpty)) continue;

      if (!started) {
        if (isSectionMarker(trimmed) || isChordOnlyLine(trimmed)) {
          started = true;
        } else {
          continue;
        }
      }
      kept.push(line);
    }
    // Collapse runs of blank lines to a single blank
    const out = [];
    let blank = false;
    for (const line of kept) {
      if (!line.trim()) {
        if (blank) continue;
        blank = true;
        out.push("");
        continue;
      }
      blank = false;
      out.push(line);
    }
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join("\n");
  }

  function ensureSpaceAboveChordLines(body) {
    const lines = String(body || "").split("\n");
    const out = [];
    for (const line of lines) {
      if (isChordOnlyLine(line) && out.length && out[out.length - 1].trim()) {
        out.push("");
      }
      out.push(line);
    }
    return out.join("\n");
  }

  function chartBodyForView(body) {
    return simplifyChartBody(ensureSpaceAboveChordLines(body));
  }

  async function detectAdmin() {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data && data.admin);
    } catch {
      return false;
    }
  }

  async function boot() {
    try {
      applyChordAccent(chordAccent);
      applyShowChords(showChords);
      wireSettingsNav();
      isAdmin = await detectAdmin();
      updateAdminBadge();
      const [idxRes, shapesRes] = await Promise.all([
        fetch("library/index.json", { cache: "no-store" }),
        fetch("assets/chord-shapes.json", { cache: "no-store" }),
      ]);
      if (shapesRes.ok) shapes = await shapesRes.json();
      if (!idxRes.ok) {
        renderEmptyLibrary();
        return;
      }
      index = await idxRes.json();
      if (!index.song_count) {
        renderEmptyLibrary();
        return;
      }
      window.addEventListener("hashchange", route);
      route();
    } catch (err) {
      app.innerHTML = `<p class="error">Failed to load library: ${escapeHtml(err.message)}</p>`;
    }
  }

  function updateAdminBadge() {
    const nav = document.querySelector(".site-nav");
    if (!nav) return;
    let badge = document.getElementById("admin-badge");
    const queueNav = document.getElementById("nav-queue");
    if (queueNav) queueNav.hidden = !adminUi();
    if (isAdmin) {
      if (!badge) {
        badge = document.createElement("button");
        badge.type = "button";
        badge.id = "admin-badge";
        badge.className = "admin-badge";
        badge.addEventListener("click", toggleViewAsUser);
        nav.appendChild(badge);
      }
      badge.classList.toggle("is-viewing-as-user", viewAsUser);
      badge.setAttribute("aria-pressed", viewAsUser ? "true" : "false");
      if (viewAsUser) {
        badge.textContent = "View as user";
        badge.title = "Return to admin view";
      } else {
        badge.textContent = "Admin";
        badge.title = "Switch to user view";
      }
    } else if (badge) {
      badge.remove();
    }
  }

  function toggleViewAsUser() {
    if (!isAdmin) return;
    viewAsUser = !viewAsUser;
    writeViewAsUserPref(viewAsUser);
    updateAdminBadge();
    if (viewAsUser && parseHash().view === "queue") {
      location.hash = "#/";
      return;
    }
    route();
  }

  function renderEmptyLibrary() {
    app.innerHTML = `
      <h1 class="hero-line">Library</h1>
      <p class="lede">No songs yet. Import with <code>/ug-import &lt;url&gt;</code>, or seed a demo:</p>
      <pre class="chart" style="padding:1rem;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.7)">cp -R fixtures/demo-library/. library/
python3 scripts/rebuild_index.py
make server</pre>
    `;
  }

  function parseHash() {
    const raw = (location.hash || "#/").replace(/^#/, "");
    const parts = raw.split("/").filter(Boolean);
    if (parts.length === 0 || parts[0] === "artists") return { view: "artists" };
    if (parts[0] === "songs") return { view: "songs" };
    if (parts[0] === "admin" && parts[1] === "queue") return { view: "queue" };
    if (parts[0] === "artist" && parts[1]) {
      return { view: "artist", artist: parts[1] };
    }
    if (parts[0] === "song" && parts[1] && parts[2] && parts[3]) {
      return { view: "song", artist: parts[1], album: parts[2], song: parts[3] };
    }
    return { view: "artists" };
  }

  function destroyTransientViews() {
    unbindSongKeys();
    unbindSongAccentListener();
    if (mediaPlayerHandle) {
      mediaPlayerHandle.destroy();
      mediaPlayerHandle = null;
    }
    // Detached stem <Audio> elements won't be in the DOM — abortAll clears every session.
    if (window.MediaPlayer?.abortAll) {
      window.MediaPlayer.abortAll();
    }
    if (queueHandle) {
      queueHandle.destroy();
      queueHandle = null;
    }
  }

  // Hard refresh must abort stem/video downloads or the browser's 6-per-host
  // connection limit stays saturated for tens of seconds.
  window.addEventListener("pagehide", () => {
    destroyTransientViews();
  });
  window.addEventListener("beforeunload", () => {
    destroyTransientViews();
  });

  function route() {
    unbindSongKeys();
    stopScroll();
    destroyTransientViews();
    const r = parseHash();
    if (r.view === "queue") return renderQueue();
    if (!index || !index.song_count) {
      renderEmptyLibrary();
      return;
    }
    if (r.view === "artist") return renderArtist(r.artist);
    if (r.view === "song") return renderSong(r.artist, r.album, r.song);
    if (r.view === "songs") return renderSongs();
    return renderArtists();
  }

  function renderQueue() {
    if (!adminUi()) {
      app.innerHTML = `<p class="error">Admin only. Run <code>make server</code> locally.</p>`;
      return;
    }
    app.innerHTML = `<div id="queue-root"></div>`;
    const root = document.getElementById("queue-root");
    if (window.MediaQueue) {
      queueHandle = MediaQueue.render(root, { isAdmin: true });
    } else {
      app.innerHTML = `<p class="error">Queue UI failed to load.</p>`;
    }
  }

  function mediaStatusLabel(status) {
    const map = {
      none: "No media",
      queued: "Queued",
      processing: "Processing",
      needs_review: "Needs review",
      ready: "Ready",
      failed: "Failed",
    };
    return map[status] || status || "No media";
  }

  function mediaFlagMark(on, label) {
    const yes = Boolean(on);
    return `<span class="media-flag ${yes ? "is-yes" : "is-no"}" title="${escapeHtml(label)}: ${yes ? "Yes" : "No"}" aria-label="${escapeHtml(label)}: ${yes ? "Yes" : "No"}">${yes ? "Yes" : "—"}</span>`;
  }

  function songMediaFlags(song) {
    return {
      downloaded: Boolean(song && song.media_downloaded),
      processed: Boolean(song && song.media_processed),
      status: String((song && song.media_status) || "none"),
    };
  }

  function songMediaFlagsHtml({ artist, tuning, capo, difficulty, status, downloaded, processed, youtubeUrl }) {
    const st = publicMediaStatus(status);
    const yt = adminUi() ? String(youtubeUrl || "") : "";
    const adminFlags = adminUi()
      ? `<span>·</span><span class="media-flag-chip">Downloaded ${mediaFlagMark(downloaded, "Downloaded")}</span>
                <span>·</span><span class="media-flag-chip">Processed ${mediaFlagMark(processed, "Processed")}</span>`
      : "";
    return `
                <span>${escapeHtml(artist || "")}</span>
                ${tuning ? `<span>·</span><span>${escapeHtml(tuning)}</span>` : ""}
                ${capo ? `<span>·</span><span>Capo ${escapeHtml(capo)}</span>` : ""}
                ${difficulty ? `<span>·</span><span>${escapeHtml(difficulty)}</span>` : ""}
                ${adminFlags}
                ${
                  yt || st !== "none"
                    ? `<span>·</span><span class="media-status-pill media-status-${escapeHtml(st)}">${escapeHtml(mediaStatusLabel(st))}</span>`
                    : ""
                }`;
  }

  function libraryViewTabs(active) {
    return `
      <div class="view-tabs" role="tablist" aria-label="Library views">
        <a role="tab" class="view-tab${active === "artists" ? " is-active" : ""}" href="#/" aria-selected="${active === "artists"}">Artists</a>
        <a role="tab" class="view-tab${active === "songs" ? " is-active" : ""}" href="#/songs" aria-selected="${active === "songs"}">Songs</a>
      </div>`;
  }

  function libraryHeader(active) {
    const artists = index.artists || [];
    return `
      <h1 class="hero-line">Library</h1>
      <p class="lede">${index.song_count} song${index.song_count === 1 ? "" : "s"} across ${artists.length} artist${artists.length === 1 ? "" : "s"}.</p>
      ${libraryViewTabs(active)}`;
  }

  function renderArtists() {
    const artists = index.artists || [];
    app.innerHTML = `
      ${libraryHeader("artists")}
      <div class="artist-grid">
        ${artists
          .map((a) => {
            const songCount = (a.albums || []).reduce((n, al) => n + (al.songs || []).length, 0);
            return `
          <a class="artist-link" href="#/artist/${encodeURIComponent(a.slug)}">
            <strong>${escapeHtml(a.name)}</strong>
            <span class="meta-muted">${songCount} song${songCount === 1 ? "" : "s"}</span>
          </a>`;
          })
          .join("")}
      </div>
    `;
  }

  let songsSearchQuery = "";
  let artistSongsSearchQuery = "";

  function sortedSongsList() {
    return [...(index.songs || [])].sort((a, b) => {
      const artist = (a.artist || "").localeCompare(b.artist || "", undefined, { sensitivity: "base" });
      if (artist) return artist;
      return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
    });
  }

  function filterSongsByQuery(songs, query) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return songs;
    return songs.filter(
      (s) =>
        (s.artist || "").toLowerCase().includes(q) || (s.title || "").toLowerCase().includes(q)
    );
  }

  function songsSearchBarHtml(query) {
    return `
      <div class="songs-search">
        <label class="visually-hidden" for="songs-search-input">Search artist or song</label>
        <input
          id="songs-search-input"
          type="search"
          placeholder="Search artist or song…"
          value="${escapeHtml(query)}"
          autocomplete="off"
        />
      </div>`;
  }

  function songsTableHostHtml(songs, query) {
    const filtered = filterSongsByQuery(songs, query);
    if (!filtered.length) {
      const q = (query || "").trim();
      return q
        ? `<p class="empty">No songs match “${escapeHtml(q)}”.</p>`
        : `<p class="empty">No songs yet.</p>`;
    }
    return songTableHtml(filtered);
  }

  function wireSongsSearch(allSongs, { getQuery, setQuery, onDeleted }) {
    const input = document.getElementById("songs-search-input");
    const host = document.getElementById("songs-table-host");
    if (!input || !host) return;
    input.addEventListener("input", () => {
      setQuery(input.value);
      host.innerHTML = songsTableHostHtml(allSongs, getQuery());
      if (adminUi()) wireSongsTableDeletes({ onDeleted });
    });
  }

  function renderSongs() {
    const songs = sortedSongsList();
    app.innerHTML = `
      ${libraryHeader("songs")}
      ${songsSearchBarHtml(songsSearchQuery)}
      <div id="songs-table-host">
        ${songsTableHostHtml(songs, songsSearchQuery)}
      </div>
    `;
    wireSongsSearch(songs, {
      getQuery: () => songsSearchQuery,
      setQuery: (q) => {
        songsSearchQuery = q;
      },
      onDeleted: () => renderSongs(),
    });
    if (adminUi()) wireSongsTableDeletes({ onDeleted: () => renderSongs() });
  }

  function songTableHtml(songs) {
    const showAdminFlags = adminUi();
    return `
      <div class="song-table-wrap">
        <table class="song-table">
          <thead>
            <tr>
              <th scope="col">Artist</th>
              <th scope="col">Song</th>
              ${
                showAdminFlags
                  ? `<th scope="col" class="song-table-flag">Downloaded</th>
              <th scope="col" class="song-table-flag">Processed</th>`
                  : ""
              }
              <th scope="col" class="song-table-status">Media</th>
              ${showAdminFlags ? `<th scope="col" class="song-table-actions">Actions</th>` : ""}
            </tr>
          </thead>
          <tbody>
            ${songs
              .map((s) => {
                const flags = songMediaFlags(s);
                // Non-admin: only show Ready after verify; hide needs_review workflow.
                const status = publicMediaStatus(flags.status);
                const showStatus = showAdminFlags
                  ? flags.status !== "none" || Boolean(s.youtube_url)
                  : status === "ready";
                return `
              <tr>
                <td>
                  <a href="#/artist/${encodeURIComponent(s.artist_slug)}">${escapeHtml(s.artist)}</a>
                </td>
                <td class="song-title">
                  <a href="#/song/${encodeURIComponent(s.artist_slug)}/${encodeURIComponent(s.album_slug)}/${encodeURIComponent(s.song_slug)}">${escapeHtml(s.title)}</a>
                </td>
                ${
                  showAdminFlags
                    ? `<td class="song-table-flag">${mediaFlagMark(flags.downloaded, "Downloaded")}</td>
                <td class="song-table-flag">${mediaFlagMark(flags.processed, "Processed")}</td>`
                    : ""
                }
                <td class="song-table-status">
                  ${
                    showStatus
                      ? `<span class="media-status-pill media-status-${escapeHtml(status)}">${escapeHtml(mediaStatusLabel(status))}</span>`
                      : `<span class="meta-muted">—</span>`
                  }
                </td>
                ${
                  showAdminFlags
                    ? `<td class="song-table-actions">
                        <button type="button" class="table-delete" data-path="${escapeHtml(s.path)}" data-title="${escapeHtml(s.title)}" data-artist="${escapeHtml(s.artist)}">Delete</button>
                      </td>`
                    : ""
                }
              </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>`;
  }

  function wireSongsTableDeletes({ onDeleted } = {}) {
    app.querySelectorAll(".table-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.path;
        const title = btn.dataset.title || "this song";
        const artist = btn.dataset.artist || "Unknown";
        const ok = await confirmModal({
          title: "Delete song?",
          message: `Permanently delete “${title}” by ${artist}? This cannot be undone.`,
          confirmLabel: "Delete",
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          await deleteSongByPath(path);
          if (!index.song_count) {
            renderEmptyLibrary();
            return;
          }
          if (typeof onDeleted === "function") onDeleted();
          else renderSongs();
        } catch (err) {
          btn.disabled = false;
          await confirmModal({
            title: "Delete failed",
            message: err.message || "Could not delete song.",
            confirmLabel: "OK",
            cancelLabel: null,
          });
        }
      });
    });
  }

  function renderArtist(slug) {
    const artist = (index.artists || []).find((a) => a.slug === slug);
    if (!artist) {
      app.innerHTML = `<p class="error">Artist not found.</p>`;
      return;
    }
    const songs = (index.songs || [])
      .filter((s) => s.artist_slug === slug)
      .sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
    const onDeleted = () => {
      if (!(index.artists || []).some((a) => a.slug === slug)) {
        location.hash = "#/";
        return;
      }
      renderArtist(slug);
    };
    app.innerHTML = `
      <nav class="crumb"><a href="#/">Library</a><span>/</span><span>${escapeHtml(artist.name)}</span></nav>
      <h1 class="hero-line">${escapeHtml(artist.name)}</h1>
      <p class="lede">${songs.length} song${songs.length === 1 ? "" : "s"} in your library.</p>
      ${songsSearchBarHtml(artistSongsSearchQuery)}
      <div id="songs-table-host">
        ${songsTableHostHtml(songs, artistSongsSearchQuery)}
      </div>
    `;
    wireSongsSearch(songs, {
      getQuery: () => artistSongsSearchQuery,
      setQuery: (q) => {
        artistSongsSearchQuery = q;
      },
      onDeleted,
    });
    if (adminUi()) wireSongsTableDeletes({ onDeleted });
  }

  async function renderSong(artistSlug, albumSlug, songSlug) {
    const song = (index.songs || []).find(
      (s) =>
        s.artist_slug === artistSlug &&
        s.album_slug === albumSlug &&
        s.song_slug === songSlug
    );
    if (!song) {
      app.innerHTML = `<p class="error">Song not found.</p>`;
      return;
    }
    app.innerHTML = `<p class="loading">Loading ${escapeHtml(song.title)}…</p>`;
    try {
      const res = await fetch(`library/${song.path}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const { meta, body } = SongMarkdown.parseFrontmatter(text);
      const chords = meta.chords || song.chords || [];
      const speed = clampSpeed(Number(meta.scroll_speed ?? 1));
      const startDelay = clampStartDelay(Number(meta.start_delay ?? 0));
      const mediaStatus =
        song && "media_playable" in song && !song.media_playable
          ? String(song.media_status || "none")
          : String(meta.media_status || song.media_status || "none");
      const youtubeUrl =
        song && "media_playable" in song && !song.media_playable
          ? ""
          : String(meta.youtube_url || song.youtube_url || "");
      let mediaDownloaded =
        song && "media_playable" in song
          ? Boolean(song.media_downloaded) && Boolean(song.media_playable)
          : Boolean(song.media_downloaded) || mediaStatus === "needs_review" || mediaStatus === "ready";
      let mediaProcessed =
        song && "media_playable" in song
          ? Boolean(song.media_processed) && Boolean(song.media_playable)
          : Boolean(song.media_processed) || mediaStatus === "needs_review" || mediaStatus === "ready";
      const playableMedia = hasPlayableMedia(mediaStatus, song);
      const initialViewMode =
        playableMedia && readViewModePref() === "videoScroll" ? "videoScroll" : "scroll";
      scrollState.speed = speed;
      scrollState.startDelay = startDelay;

      app.innerHTML = `
        <nav class="crumb">
          <a href="#/">Library</a><span>/</span>
          <a href="#/artist/${encodeURIComponent(artistSlug)}">${escapeHtml(meta.artist || song.artist)}</a>
        </nav>
        <div class="song-layout">
          <div>
            <header class="song-header">
              <div class="song-title-row">
                <h1 id="song-title-display">${escapeHtml(meta.title || song.title)}</h1>
                <div class="view-modes" id="view-modes" role="tablist" aria-label="Song view"${playableMedia ? "" : " hidden"}>
                  <button type="button" class="view-mode${initialViewMode === "scroll" ? " is-active" : ""}" data-view-mode="scroll" role="tab" aria-selected="${initialViewMode === "scroll" ? "true" : "false"}">Scroll</button>
                  <button type="button" class="view-mode${initialViewMode === "videoScroll" ? " is-active" : ""}" data-view-mode="videoScroll" role="tab" aria-selected="${initialViewMode === "videoScroll" ? "true" : "false"}">Video</button>
                </div>
              </div>
              <div class="song-meta" id="song-meta-display">
                ${songMediaFlagsHtml({
                  artist: meta.artist || song.artist,
                  tuning: meta.tuning,
                  capo: meta.capo,
                  difficulty: meta.difficulty,
                  status: mediaStatus,
                  downloaded: mediaDownloaded,
                  processed: mediaProcessed,
                  youtubeUrl,
                })}
              </div>
            </header>
            <div id="media-root" class="media-root" hidden></div>
            <div class="toolbar" id="song-toolbar"${initialViewMode === "videoScroll" ? " hidden" : ""}>
              <button type="button" id="scroll-toggle">Play scroll</button>
              <label id="scroll-speed-wrap">Speed
                <input id="scroll-speed" type="range" min="0.5" max="4" step="0.25" value="${speed}" />
                <span id="speed-label">${speed.toFixed(2)}×</span>
              </label>
              ${
                adminUi()
                  ? `<button type="button" class="secondary" id="song-edit">Edit</button>
                     <button type="button" class="danger" id="song-delete">Delete</button>
                     <button type="button" id="song-save" hidden>Save</button>
                     <button type="button" class="secondary" id="song-cancel" hidden>Cancel</button>
                     <span id="save-status" class="save-status" hidden></span>`
                  : ""
              }
            </div>
            <div id="admin-editor" class="admin-editor" hidden>
              <div class="admin-meta-grid">
                <label>Title <input id="edit-title" type="text" /></label>
                <label>Artist <input id="edit-artist" type="text" /></label>
                <label>Album <input id="edit-album" type="text" /></label>
                <label>Tuning <input id="edit-tuning" type="text" /></label>
                <label>Capo <input id="edit-capo" type="number" min="0" step="1" /></label>
                <label>Key <input id="edit-key" type="text" /></label>
                <label>Difficulty <input id="edit-difficulty" type="text" /></label>
                <label>Scroll speed <input id="edit-scroll_speed" type="number" min="0.5" max="4" step="0.25" /></label>
                <label>Start delay (sec) <input id="edit-start_delay" type="number" min="0" max="30" step="1" /></label>
                <label class="span-2">Chords <input id="edit-chords" type="text" placeholder="Am, G, D" /></label>
                <label class="span-2">YouTube URL <input id="edit-youtube_url" type="url" placeholder="https://www.youtube.com/watch?v=…" /></label>
                <label>Media status
                  <input id="edit-media_status" type="text" readonly />
                </label>
                <div class="admin-reprocess">
                  <button type="button" class="secondary" id="song-reprocess">Reprocess media</button>
                  <span id="reprocess-status" class="save-status" hidden></span>
                </div>
              </div>
              <label class="admin-body-label">Chart
                <textarea id="edit-body" class="admin-body" spellcheck="false"></textarea>
              </label>
            </div>
            <div class="song-chords" id="song-chords" hidden aria-label="Song chords"></div>
            <div class="chart-panel" id="chart-panel"${initialViewMode === "videoScroll" ? " hidden" : ""}>
              <pre class="chart" id="chart">${renderChartHtml(chartBodyForView(body), chords)}</pre>
            </div>
            <div id="scroll-countdown" class="scroll-countdown" hidden aria-live="polite"></div>
          </div>
          <aside class="chord-panel">
            <h2>Chords</h2>
            <div class="instrument-modes" id="instrument-modes" role="tablist" aria-label="Chord instrument">
              <button type="button" class="instrument-mode is-active" data-instrument="guitar" role="tab" aria-selected="true">Guitar</button>
              <button type="button" class="instrument-mode" data-instrument="ukulele" role="tab" aria-selected="false">Ukulele</button>
              <button type="button" class="instrument-mode" data-instrument="piano" role="tab" aria-selected="false">Piano</button>
            </div>
            <label class="tuning-field" id="tuning-field">
              <span class="tuning-label">Tuning</span>
              <select id="tuning-select" aria-label="Instrument tuning"></select>
            </label>
            <div class="chord-list" id="chord-list">
              ${chords
                .map(
                  (c, i) =>
                    `<button type="button" class="chord-chip${i === 0 ? " is-active" : ""}" data-chord="${escapeHtml(c)}">${escapeHtml(c)}</button>`
                )
                .join("")}
            </div>
            <div class="diagram-wrap" id="diagram"></div>
          </aside>
        </div>
      `;
      wireSongUi({
        song,
        meta,
        body,
        initialChord: chords[0] || null,
        artistSlug,
        albumSlug,
        songSlug,
        mediaStatus,
        initialViewMode,
      });
    } catch (err) {
      app.innerHTML = `<p class="error">Could not load song: ${escapeHtml(err.message)}</p>`;
    }
  }

  function formatChartLineHtml(line, knownChords) {
    const known = new Set(knownChords || []);
    const trimmed = String(line || "").trim();
    if (isSectionMarker(trimmed)) {
      return `<span class="section">${escapeHtml(line)}</span>`;
    }
    CHORD_RE.lastIndex = 0;
    return escapeHtml(line).replace(CHORD_RE, (match, name) => {
      if (known.size && !known.has(name)) {
        CHORD_RE.lastIndex = 0;
        const remainder = line.replace(CHORD_RE, "").replace(/[\s|/.\-#]+/g, "");
        CHORD_RE.lastIndex = 0;
        if (remainder.length > 2) return match;
      }
      return `<span class="chord" data-chord="${name}">${name}</span>`;
    });
  }

  function renderChartHtml(body, knownChords) {
    if (!window.MediaAnalysis?.chartDisplayUnits) {
      return String(body || "")
        .split("\n")
        .map((line) => formatChartLineHtml(line, knownChords))
        .join("\n");
    }
    const units = MediaAnalysis.chartDisplayUnits(body);
    const parts = [];
    units.forEach((unit) => {
      if (unit.type === "blank") {
        parts.push("");
        return;
      }
      if (unit.type === "section" || unit.type === "raw") {
        parts.push(formatChartLineHtml(unit.text, knownChords));
        return;
      }
      if (unit.type === "group") {
        const inner = [];
        if (unit.chordLine != null) {
          inner.push(
            `<span class="chart-chord-line">${formatChartLineHtml(unit.chordLine, knownChords)}\n</span>`
          );
        }
        if (unit.lyricLine != null) inner.push(formatChartLineHtml(unit.lyricLine, knownChords));
        parts.push(
          `<span class="chart-sync-line" data-line-index="${unit.index}">${inner.join("")}</span>`
        );
      }
    });
    return parts.join("\n");
  }

  function applyChartSyncHighlight() {
    const chartEl = document.getElementById("chart");
    if (!chartEl) return;
    const playing = chartSyncState.playingLineIndex;
    const selected = chartSyncState.selectedLineIndex;
    const stamped = new Set(chartSyncState.stampedIndices || []);
    chartEl.querySelectorAll(".chart-sync-line").forEach((el) => {
      const idx = Number(el.dataset.lineIndex);
      el.classList.toggle("is-playing", idx === playing);
      el.classList.toggle("is-selected", idx === selected);
      el.classList.toggle("is-stamped", stamped.has(idx));
    });
  }

  function chordsToInput(chords) {
    return (chords || []).join(", ");
  }

  function parseChordsInput(value) {
    return String(value || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  function wireSongUi(ctx) {
    const {
      song,
      meta,
      body,
      initialChord,
      artistSlug,
      albumSlug,
      songSlug,
      mediaStatus,
      initialViewMode,
    } = ctx;
    const list = document.getElementById("chord-list");
    const diagram = document.getElementById("diagram");
    const songChords = document.getElementById("song-chords");
    const toggle = document.getElementById("scroll-toggle");
    const speedInput = document.getElementById("scroll-speed");
    const speedLabel = document.getElementById("speed-label");
    const speedWrap = document.getElementById("scroll-speed-wrap");
    const songToolbar = document.getElementById("song-toolbar");
    const viewModes = document.getElementById("view-modes");
    const chartPanel = document.getElementById("chart-panel");
    const chartEl = document.getElementById("chart");
    const countdownEl = document.getElementById("scroll-countdown");
    const editBtn = document.getElementById("song-edit");
    const deleteBtn = document.getElementById("song-delete");
    const saveBtn = document.getElementById("song-save");
    const cancelBtn = document.getElementById("song-cancel");
    const editor = document.getElementById("admin-editor");
    const saveStatus = document.getElementById("save-status");
    const mediaRoot = document.getElementById("media-root");
    let editing = false;
    let songBody = body;
    let songMeta = { ...meta };
    let currentMediaStatus = mediaStatus;
    let viewMode = initialViewMode === "videoScroll" ? "videoScroll" : "scroll";
    let activeChord = null;
    let voicingIndex = 0;
    let instrument = "guitar";
    let tunings = { guitar: "standard", ukulele: "standard" };
    const modes = document.getElementById("instrument-modes");
    const tuningField = document.getElementById("tuning-field");
    const tuningSelect = document.getElementById("tuning-select");
    const chords = songMeta.chords || song.chords || [];

    function activeChartBody() {
      return chartBodyForView(songBody);
    }

    function refreshChart() {
      if (!chartEl) return;
      const viewBody = chartBodyForView(songBody);
      chartEl.innerHTML = renderChartHtml(viewBody, chords);
      if (activeChord) {
        chartEl.querySelectorAll(".chord").forEach((el) => {
          el.classList.toggle("is-active", el.dataset.chord === activeChord);
        });
      }
      mediaPlayerHandle?.setChartBody?.(activeChartBody());
      applyChartSyncHighlight();
    }

    async function saveLyricEdit({ lineIndex, oldLyric, newLyric }) {
      const spaced = ensureSpaceAboveChordLines(songBody);
      let nextBody = null;
      // View always uses the simplified chart, so match by lyric text rather than raw line index.
      const groups = MediaAnalysis.extractChartGroups(spaced);
      let matchIdx = groups.findIndex((g) => g.lyric === oldLyric);
      if (matchIdx < 0) {
        const key = String(oldLyric || "")
          .toLowerCase()
          .replace(/[^\w\s']/g, "")
          .replace(/\s+/g, " ");
        matchIdx = groups.findIndex((g) => {
          const gk = String(g.lyric || "")
            .toLowerCase()
            .replace(/[^\w\s']/g, "")
            .replace(/\s+/g, " ");
          return gk === key;
        });
      }
      if (matchIdx < 0 && Number.isFinite(lineIndex)) {
        matchIdx = lineIndex;
      }
      if (matchIdx >= 0) {
        nextBody = MediaAnalysis.replaceChartGroupLyric(spaced, matchIdx, newLyric);
      }
      if (!nextBody) {
        alert("Could not update that lyric in the chart.");
        return false;
      }
      const nextMeta = {
        title: songMeta.title || song.title || "",
        artist: songMeta.artist || song.artist || "",
        album: songMeta.album || song.album || "singles",
        tuning: songMeta.tuning || "",
        capo: Number(songMeta.capo || 0),
        key: songMeta.key || null,
        difficulty: songMeta.difficulty || null,
        scroll_speed: clampSpeed(Number(songMeta.scroll_speed ?? 1)),
        start_delay: clampStartDelay(Number(songMeta.start_delay ?? 0)),
        chords: songMeta.chords || song.chords || [],
        youtube_url: songMeta.youtube_url || song.youtube_url || "",
        media_status: songMeta.media_status || "none",
        media_verified_at: songMeta.media_verified_at || null,
        source: songMeta.source || song.source || "",
        source_id: songMeta.source_id || song.source_id || "",
        imported_at: songMeta.imported_at || song.imported_at || null,
      };
      try {
        const res = await fetch("/api/song", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: song.path, meta: nextMeta, body: nextBody }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        songBody = nextBody;
        songMeta = { ...songMeta, ...nextMeta };
        const editBody = document.getElementById("edit-body");
        if (editBody) editBody.value = songBody;
        refreshChart();
        return true;
      } catch (err) {
        alert(err.message || "Could not save lyric to song chart");
        return false;
      }
    }

    function tearDownMediaPlayer() {
      if (mediaPlayerHandle) {
        mediaPlayerHandle.destroy();
        mediaPlayerHandle = null;
      }
      if (mediaRoot) {
        mediaRoot.hidden = true;
        mediaRoot.innerHTML = "";
      }
      chartPanel?.classList.remove("is-aligning");
      chartSyncState = {
        alignMode: false,
        playingLineIndex: -1,
        selectedLineIndex: -1,
        stampedIndices: [],
        lyricDisplay: "chart",
      };
      applyChartSyncHighlight();
    }

    function mountMediaPlayer() {
      if (!mediaRoot || !window.MediaPlayer) return;
      if (!hasPlayableMedia(currentMediaStatus, song)) return;
      tearDownMediaPlayer();
      let mountCancelled = false;
      mediaPlayerHandle = {
        destroy() {
          mountCancelled = true;
          window.MediaPlayer?.abortAll?.();
        },
      };
      MediaPlayer.mount(mediaRoot, {
        songPath: song.path,
        isAdmin: adminUi(),
        // Export uses the local API; available whenever the admin server is up,
        // including "view as user" / normal-user UI.
        canExport: isAdmin,
        mediaStatus: currentMediaStatus,
        chartBody: activeChartBody(),
        title: song.title,
        artist: song.artist,
        onSyncState(state) {
          chartSyncState = state || chartSyncState;
          chartPanel?.classList.toggle("is-aligning", Boolean(state?.alignMode));
          applyChartSyncHighlight();
        },
        onLyricEdit: saveLyricEdit,
        onVerified: async () => {
          const idxRes = await fetch("library/index.json", { cache: "no-store" });
          if (idxRes.ok) index = await idxRes.json();
          await renderSong(artistSlug, albumSlug, songSlug);
        },
      }).then((handle) => {
        if (mountCancelled || mediaPlayerHandle === null || viewMode !== "videoScroll") {
          handle.destroy();
          if (mediaPlayerHandle && mountCancelled) mediaPlayerHandle = null;
          return;
        }
        mediaPlayerHandle = handle;
      });
    }

    function syncViewModeButtons() {
      if (!viewModes) return;
      const playable = hasPlayableMedia(currentMediaStatus, song);
      viewModes.hidden = !playable;
      viewModes.querySelectorAll("[data-view-mode]").forEach((btn) => {
        const active = btn.getAttribute("data-view-mode") === viewMode;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
    }

    function applyViewMode() {
      const playable = hasPlayableMedia(currentMediaStatus, song);
      if (viewMode === "videoScroll" && !playable) {
        viewMode = "scroll";
      }
      const isVideo = viewMode === "videoScroll" && playable;
      syncViewModeButtons();
      if (isVideo && editing) {
        setEditing(false);
      }
      if (songToolbar) songToolbar.hidden = isVideo;
      if (toggle) toggle.hidden = false;
      if (speedWrap) speedWrap.hidden = false;
      if (isVideo) {
        stopScroll();
        if (toggle) toggle.textContent = "Play scroll";
        if (countdownEl) {
          countdownEl.hidden = true;
          countdownEl.textContent = "";
        }
        if (chartPanel) chartPanel.hidden = true;
        if (songChords) songChords.hidden = true;
        if (!mediaPlayerHandle || mediaRoot?.hidden) {
          mountMediaPlayer();
        } else {
          mediaPlayerHandle?.setChartBody?.(activeChartBody());
        }
      } else {
        tearDownMediaPlayer();
        if (!editing && chartPanel) chartPanel.hidden = false;
        renderSongChordStrip();
        refreshChart();
      }
    }

    function setViewMode(next) {
      const mode = next === "videoScroll" ? "videoScroll" : "scroll";
      if (mode === "videoScroll" && !hasPlayableMedia(currentMediaStatus, song)) return;
      if (mode === viewMode) return;
      viewMode = mode;
      writeViewModePref(viewMode);
      applyViewMode();
    }

    viewModes?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-view-mode]");
      if (!btn || viewModes.hidden) return;
      setViewMode(btn.getAttribute("data-view-mode"));
    });

    // Refresh downloaded/processed from live media sidecar when the admin API is available.
    (async () => {
      try {
        const q = new URLSearchParams({ path: song.path });
        const res = await fetch(`/api/media?${q}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const metaEl = document.getElementById("song-meta-display");
        if (!metaEl) return;
        const status = String(data.media_status || songMeta.media_status || mediaStatus || "none");
        currentMediaStatus = status;
        songMeta.media_status = status;
        if (data.youtube_url) songMeta.youtube_url = data.youtube_url;
        // Index can lag the pipeline; trust live /api/media for the Video switch.
        song.media_status = status;
        song.media_downloaded = Boolean(data.media_downloaded);
        song.media_processed = Boolean(data.media_processed);
        if ("media_playable" in data) {
          song.media_playable = Boolean(data.media_playable);
        } else {
          song.media_playable =
            Boolean(data.media_downloaded) &&
            (status === "needs_review" || status === "ready");
        }
        metaEl.innerHTML = songMediaFlagsHtml({
          artist: songMeta.artist || song.artist,
          tuning: songMeta.tuning,
          capo: songMeta.capo,
          difficulty: songMeta.difficulty,
          status,
          downloaded: Boolean(data.media_downloaded),
          processed: Boolean(data.media_processed),
          youtubeUrl: data.youtube_url || songMeta.youtube_url || "",
        });
        const ms = document.getElementById("edit-media_status");
        if (ms) ms.value = mediaStatusLabel(status);
        applyViewMode();
      } catch {
        /* static hosting / offline — keep index/frontmatter flags */
      }
    })();

    function currentTuningId() {
      return tunings[instrument] || "standard";
    }

    function populateTuningSelect() {
      if (!tuningSelect || !tuningField) return;
      const list = ChordDiagrams.getTuningList
        ? ChordDiagrams.getTuningList(instrument)
        : [];
      if (!list.length) {
        tuningField.hidden = true;
        return;
      }
      tuningField.hidden = false;
      const selected = currentTuningId();
      tuningSelect.innerHTML = list
        .map(
          (t) =>
            `<option value="${escapeHtml(t.id)}"${t.id === selected ? " selected" : ""}>${escapeHtml(t.label)}</option>`
        )
        .join("");
    }

    function renderSongChordStrip() {
      if (!songChords) return;
      if (!chords.length) {
        songChords.hidden = true;
        songChords.innerHTML = "";
        return;
      }
      songChords.hidden = editing || viewMode === "videoScroll";
      songChords.dataset.instrument = instrument;
      const tuningId = currentTuningId();
      songChords.innerHTML = chords
        .map((name) => {
          const voicings = ChordDiagrams.resolveVoicings(name, shapes, instrument, tuningId);
          const html = ChordDiagrams.renderInstrumentDiagram(
            voicings[0] || null,
            name,
            instrument,
            tuningId
          );
          const active = name === activeChord ? " is-active" : "";
          return `<button type="button" class="song-chord${active}" data-chord="${escapeHtml(name)}" aria-label="${escapeHtml(name)} chord">${html}</button>`;
        })
        .join("");
    }

    function renderActiveDiagram() {
      if (!diagram) return;
      if (!activeChord) {
        diagram.innerHTML = "";
        return;
      }
      const nav = ChordDiagrams.renderDiagramNav(
        activeChord,
        shapes,
        voicingIndex,
        instrument,
        currentTuningId()
      );
      voicingIndex = nav.index;
      diagram.innerHTML = nav.html;
      diagram.dataset.instrument = instrument;
    }

    function setInstrument(next) {
      const allowed = ChordDiagrams.INSTRUMENTS || ["guitar", "ukulele", "piano"];
      if (!allowed.includes(next) || next === instrument) return;
      instrument = next;
      voicingIndex = 0;
      modes?.querySelectorAll(".instrument-mode").forEach((el) => {
        const on = el.dataset.instrument === instrument;
        el.classList.toggle("is-active", on);
        el.setAttribute("aria-selected", on ? "true" : "false");
      });
      populateTuningSelect();
      renderActiveDiagram();
      renderSongChordStrip();
    }

    function selectChord(name, resetVoicing) {
      if (!name) return;
      if (name !== activeChord || resetVoicing) voicingIndex = 0;
      activeChord = name;
      list.querySelectorAll(".chord-chip").forEach((el) => {
        el.classList.toggle("is-active", el.dataset.chord === name);
      });
      songChords?.querySelectorAll(".song-chord").forEach((el) => {
        el.classList.toggle("is-active", el.dataset.chord === name);
      });
      document.querySelectorAll(".chart .chord").forEach((el) => {
        el.classList.toggle("is-active", el.dataset.chord === name);
      });
      renderActiveDiagram();
    }

    function stepVoicing(delta) {
      if (!activeChord) return;
      const count = ChordDiagrams.resolveVoicings(
        activeChord,
        shapes,
        instrument,
        currentTuningId()
      ).length;
      if (count < 2) return;
      voicingIndex = (voicingIndex + delta + count) % count;
      renderActiveDiagram();
    }

    modes?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-instrument]");
      if (btn) setInstrument(btn.dataset.instrument);
    });
    tuningSelect?.addEventListener("change", () => {
      if (instrument === "piano") return;
      tunings[instrument] = tuningSelect.value || "standard";
      voicingIndex = 0;
      renderActiveDiagram();
      renderSongChordStrip();
    });
    list?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-chord]");
      if (btn) selectChord(btn.dataset.chord, true);
    });
    songChords?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-chord]");
      if (btn) selectChord(btn.dataset.chord, true);
    });
    chartEl?.addEventListener("click", (e) => {
      const syncLine = e.target.closest(".chart-sync-line");
      const chordEl = e.target.closest(".chord");
      if (mediaPlayerHandle?.isAlignMode?.() && syncLine) {
        e.preventDefault();
        mediaPlayerHandle.selectAndSeekLine(Number(syncLine.dataset.lineIndex));
        return;
      }
      if (syncLine && !chordEl && mediaPlayerHandle?.selectAndSeekLine) {
        mediaPlayerHandle.selectAndSeekLine(Number(syncLine.dataset.lineIndex));
        return;
      }
      if (chordEl) selectChord(chordEl.dataset.chord, true);
    });
    chartEl?.addEventListener("dblclick", (e) => {
      const syncLine = e.target.closest(".chart-sync-line");
      if (!syncLine || !mediaPlayerHandle?.editLyricLine) return;
      e.preventDefault();
      mediaPlayerHandle.editLyricLine(Number(syncLine.dataset.lineIndex));
    });
    diagram?.addEventListener("click", (e) => {
      const btn = e.target.closest(".diagram-arrow");
      if (!btn || btn.disabled) return;
      stepVoicing(Number(btn.dataset.dir) || 0);
    });

    populateTuningSelect();
    renderSongChordStrip();
    if (initialChord) selectChord(initialChord, true);
    applyViewMode();
    bindSongAccentListener(() => {
      renderActiveDiagram();
      renderSongChordStrip();
    });

    function syncSpeedLabel(value) {
      scrollState.speed = clampSpeed(Number(value));
      if (speedLabel) speedLabel.textContent = `${scrollState.speed.toFixed(2)}×`;
      if (speedInput && Number(speedInput.value) !== scrollState.speed) {
        speedInput.value = String(scrollState.speed);
      }
    }

    function toggleScrollPlayback() {
      if (scrollState.playing || scrollState.countingDown) {
        stopScroll();
        if (toggle) toggle.textContent = "Play scroll";
        return;
      }
      const atTop = pageScrollTop() <= 1;
      const delay = clampStartDelay(scrollState.startDelay);
      if (atTop && delay > 0) {
        startScrollWithDelay(delay, toggle, countdownEl);
      } else {
        startScroll();
        if (toggle) toggle.textContent = "Pause";
      }
    }

    speedInput?.addEventListener("input", () => {
      syncSpeedLabel(speedInput.value);
      const editSpeed = document.getElementById("edit-scroll_speed");
      if (editing && editSpeed) editSpeed.value = String(scrollState.speed);
    });

    toggle?.addEventListener("click", () => toggleScrollPlayback());

    bindSongKeys((e) => {
      if (editing) return false;
      if (isTypingTarget(e.target)) return false;
      if (viewMode === "videoScroll") {
        if (e.code === "Space" || e.key === " ") {
          e.preventDefault();
          if (!e.repeat) document.getElementById("media-play")?.click();
          return true;
        }
        return false;
      }
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        if (!e.repeat) toggleScrollPlayback();
        return true;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        nudgePageScroll(scrollNudgeAmount());
        return true;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        nudgePageScroll(-scrollNudgeAmount());
        return true;
      }
      return false;
    });

    function fillEditor() {
      document.getElementById("edit-title").value = songMeta.title || song.title || "";
      document.getElementById("edit-artist").value = songMeta.artist || song.artist || "";
      document.getElementById("edit-album").value = songMeta.album || song.album || "";
      document.getElementById("edit-tuning").value = songMeta.tuning || "";
      document.getElementById("edit-capo").value = String(songMeta.capo ?? 0);
      document.getElementById("edit-key").value = songMeta.key == null ? "" : String(songMeta.key);
      document.getElementById("edit-difficulty").value = songMeta.difficulty || "";
      document.getElementById("edit-scroll_speed").value = String(
        clampSpeed(Number(songMeta.scroll_speed ?? scrollState.speed ?? 1))
      );
      document.getElementById("edit-start_delay").value = String(
        clampStartDelay(Number(songMeta.start_delay ?? scrollState.startDelay ?? 0))
      );
      document.getElementById("edit-chords").value = chordsToInput(songMeta.chords || song.chords || []);
      const yt = document.getElementById("edit-youtube_url");
      if (yt) yt.value = songMeta.youtube_url || "";
      const ms = document.getElementById("edit-media_status");
      if (ms) ms.value = mediaStatusLabel(songMeta.media_status || "none");
      document.getElementById("edit-body").value = songBody;
    }

    document.getElementById("edit-scroll_speed")?.addEventListener("input", (e) => {
      syncSpeedLabel(e.target.value);
    });

    document.getElementById("edit-start_delay")?.addEventListener("input", (e) => {
      scrollState.startDelay = clampStartDelay(Number(e.target.value));
    });

    function setEditing(on) {
      editing = on;
      if (editor) editor.hidden = !on;
      if (chartPanel) chartPanel.hidden = on || viewMode === "videoScroll";
      if (songChords) songChords.hidden = on || !chords.length || viewMode === "videoScroll";
      if (editBtn) editBtn.hidden = on;
      if (deleteBtn) deleteBtn.hidden = on;
      if (saveBtn) saveBtn.hidden = !on;
      if (cancelBtn) cancelBtn.hidden = !on;
      if (saveStatus) {
        saveStatus.hidden = true;
        saveStatus.textContent = "";
        saveStatus.classList.remove("is-error");
      }
      if (on) {
        stopScroll();
        if (toggle) toggle.textContent = "Play scroll";
        fillEditor();
      } else if (viewMode !== "videoScroll") {
        renderSongChordStrip();
      }
    }

    editBtn?.addEventListener("click", () => setEditing(true));

    document.getElementById("song-reprocess")?.addEventListener("click", async () => {
      const reprocessBtn = document.getElementById("song-reprocess");
      const reprocessStatus = document.getElementById("reprocess-status");
      const youtubeUrl = (document.getElementById("edit-youtube_url")?.value || "").trim();
      if (!youtubeUrl) {
        if (reprocessStatus) {
          reprocessStatus.hidden = false;
          reprocessStatus.classList.add("is-error");
          reprocessStatus.textContent = "Set a YouTube URL first";
        }
        return;
      }
      const ok = await confirmModal({
        title: "Reprocess media?",
        message:
          "Re-run the audio pipeline for this song (download, stem separation, karaoke mixes, lyrics align, drums). Existing media artifacts will be replaced.",
        confirmLabel: "Reprocess",
      });
      if (!ok) return;
      if (reprocessBtn) reprocessBtn.disabled = true;
      if (reprocessStatus) {
        reprocessStatus.hidden = false;
        reprocessStatus.classList.remove("is-error");
        reprocessStatus.textContent = "Queueing…";
      }
      try {
        const res = await fetch("/api/media/reprocess", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: song.path,
            youtube_url: youtubeUrl,
            chart_body: document.getElementById("edit-body")?.value || songBody,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const idxRes = await fetch("library/index.json", { cache: "no-store" });
        if (idxRes.ok) index = await idxRes.json();
        await renderSong(artistSlug, albumSlug, songSlug);
      } catch (err) {
        if (reprocessStatus) {
          reprocessStatus.hidden = false;
          reprocessStatus.classList.add("is-error");
          reprocessStatus.textContent = err.message || "Reprocess failed";
        }
        if (reprocessBtn) reprocessBtn.disabled = false;
      }
    });

    deleteBtn?.addEventListener("click", async () => {
      const title = songMeta.title || song.title || "this song";
      const artist = songMeta.artist || song.artist || "Unknown";
      const ok = await confirmModal({
        title: "Delete song?",
        message: `Permanently delete “${title}” by ${artist}? This cannot be undone.`,
        confirmLabel: "Delete",
      });
      if (!ok) return;
      deleteBtn.disabled = true;
      try {
        await deleteSongByPath(song.path);
        if (!index.song_count) {
          location.hash = "#/";
          return;
        }
        location.hash = "#/songs";
      } catch (err) {
        deleteBtn.disabled = false;
        await confirmModal({
          title: "Delete failed",
          message: err.message || "Could not delete song.",
          confirmLabel: "OK",
          cancelLabel: null,
        });
      }
    });
    cancelBtn?.addEventListener("click", () => {
      syncSpeedLabel(songMeta.scroll_speed ?? 1);
      scrollState.startDelay = clampStartDelay(Number(songMeta.start_delay ?? 0));
      setEditing(false);
    });

    saveBtn?.addEventListener("click", async () => {
      const nextMeta = {
        title: document.getElementById("edit-title").value.trim(),
        artist: document.getElementById("edit-artist").value.trim(),
        album: document.getElementById("edit-album").value.trim() || "singles",
        tuning: document.getElementById("edit-tuning").value.trim(),
        capo: Number(document.getElementById("edit-capo").value || 0),
        key: document.getElementById("edit-key").value.trim() || null,
        difficulty: document.getElementById("edit-difficulty").value.trim() || null,
        scroll_speed: clampSpeed(Number(document.getElementById("edit-scroll_speed").value)),
        start_delay: clampStartDelay(Number(document.getElementById("edit-start_delay").value)),
        chords: parseChordsInput(document.getElementById("edit-chords").value),
        youtube_url: (document.getElementById("edit-youtube_url")?.value || "").trim(),
        media_status: songMeta.media_status || "none",
        media_verified_at: songMeta.media_verified_at || null,
        source: songMeta.source || song.source || "",
        source_id: songMeta.source_id || song.source_id || "",
        imported_at: songMeta.imported_at || song.imported_at || null,
      };
      const nextBody = document.getElementById("edit-body").value;
      if (saveBtn) saveBtn.disabled = true;
      if (saveStatus) {
        saveStatus.hidden = false;
        saveStatus.classList.remove("is-error");
        saveStatus.textContent = "Saving…";
      }
      try {
        const res = await fetch("/api/song", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: song.path,
            meta: nextMeta,
            body: nextBody,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const idxRes = await fetch("library/index.json", { cache: "no-store" });
        if (idxRes.ok) index = await idxRes.json();
        await renderSong(artistSlug, albumSlug, songSlug);
      } catch (err) {
        if (saveStatus) {
          saveStatus.hidden = false;
          saveStatus.classList.add("is-error");
          saveStatus.textContent = err.message || "Save failed";
        }
        if (saveBtn) saveBtn.disabled = false;
      }
    });
  }

  function getPageScroller() {
    return document.scrollingElement || document.documentElement;
  }

  function pageScrollTop() {
    return getPageScroller().scrollTop || window.scrollY || 0;
  }

  function scrollNudgeAmount() {
    return Math.max(48, Math.round(window.innerHeight * 0.08));
  }

  function nudgePageScroll(delta) {
    const scroller = getPageScroller();
    const max = Math.max(0, scroller.scrollHeight - window.innerHeight);
    scroller.scrollTop = Math.min(max, Math.max(0, scroller.scrollTop + delta));
  }

  function isTypingTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return Boolean(el.closest("input, textarea, select, [contenteditable='true']"));
  }

  function unbindSongKeys() {
    if (!songKeydownHandler) return;
    window.removeEventListener("keydown", songKeydownHandler);
    songKeydownHandler = null;
  }

  function unbindSongAccentListener() {
    if (!songAccentHandler) return;
    window.removeEventListener("chord-accent-change", songAccentHandler);
    songAccentHandler = null;
  }

  function bindSongAccentListener(handler) {
    unbindSongAccentListener();
    songAccentHandler = handler;
    window.addEventListener("chord-accent-change", songAccentHandler);
  }

  function bindSongKeys(handler) {
    unbindSongKeys();
    songKeydownHandler = (e) => {
      handler(e);
    };
    window.addEventListener("keydown", songKeydownHandler);
  }

  function setCountdownDisplay(countdownEl, remaining) {
    if (!countdownEl) return;
    if (remaining == null) {
      countdownEl.hidden = true;
      countdownEl.textContent = "";
      return;
    }
    countdownEl.hidden = false;
    countdownEl.textContent = String(remaining);
  }

  function startScrollWithDelay(delaySec, toggle, countdownEl) {
    stopScroll();
    const total = Math.ceil(delaySec);
    if (total <= 0) {
      startScroll();
      if (toggle) toggle.textContent = "Pause";
      return;
    }

    scrollState.countingDown = true;
    if (toggle) toggle.textContent = "Cancel";
    let remaining = total;
    setCountdownDisplay(countdownEl, remaining);

    scrollState.countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(scrollState.countdownTimer);
        scrollState.countdownTimer = null;
        scrollState.countingDown = false;
        setCountdownDisplay(countdownEl, null);
        startScroll();
        if (toggle) toggle.textContent = "Pause";
        return;
      }
      setCountdownDisplay(countdownEl, remaining);
    }, 1000);
  }

  function startScroll() {
    stopScroll();
    const scroller = getPageScroller();
    scrollState.playing = true;
    scrollState.last = performance.now();
    scrollState.carry = 0;
    // Non-linear so 1.0 stays leisurely while 4.0 stays ~72px/s
    // 0.5→~4px/s, 1.0→10px/s, 2.0→~26px/s, 4.0→~70px/s

    function tick(now) {
      if (!scrollState.playing) return;
      const dt = Math.min(0.05, (now - scrollState.last) / 1000);
      scrollState.last = now;
      // Browsers truncate scrollTop to integers — accumulate subpixels
      // so speeds ≤1× still advance.
      const pxPerSec = 10 * Math.pow(scrollState.speed, 1.4);
      scrollState.carry += pxPerSec * dt;
      const pixels = Math.floor(scrollState.carry);
      if (pixels > 0) {
        scroller.scrollTop += pixels;
        scrollState.carry -= pixels;
      }
      if (scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 1) {
        stopScroll();
        const toggle = document.getElementById("scroll-toggle");
        if (toggle) toggle.textContent = "Play scroll";
        return;
      }
      scrollState.raf = requestAnimationFrame(tick);
    }
    scrollState.raf = requestAnimationFrame(tick);
  }

  function stopScroll() {
    scrollState.playing = false;
    scrollState.countingDown = false;
    scrollState.carry = 0;
    if (scrollState.countdownTimer) {
      clearInterval(scrollState.countdownTimer);
      scrollState.countdownTimer = null;
    }
    if (scrollState.raf) cancelAnimationFrame(scrollState.raf);
    scrollState.raf = null;
    setCountdownDisplay(document.getElementById("scroll-countdown"), null);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function confirmModal({ title, message, confirmLabel = "Delete", cancelLabel = "Cancel" }) {
    return new Promise((resolve) => {
      document.getElementById("confirm-modal")?.remove();
      const overlay = document.createElement("div");
      overlay.id = "confirm-modal";
      overlay.className = "modal-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-labelledby", "confirm-modal-title");
      const cancelHtml =
        cancelLabel == null
          ? ""
          : `<button type="button" class="modal-btn secondary" data-action="cancel">${escapeHtml(cancelLabel)}</button>`;
      overlay.innerHTML = `
        <div class="modal-dialog">
          <h2 id="confirm-modal-title" class="modal-title">${escapeHtml(title)}</h2>
          <p class="modal-message">${escapeHtml(message)}</p>
          <div class="modal-actions">
            ${cancelHtml}
            <button type="button" class="modal-btn${cancelLabel == null ? "" : " danger"}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const finish = (value) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      };
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) finish(false);
      });
      overlay.querySelector('[data-action="cancel"]')?.addEventListener("click", () => finish(false));
      overlay.querySelector('[data-action="confirm"]')?.addEventListener("click", () => finish(true));
      document.addEventListener("keydown", onKey, true);
      overlay.querySelector('[data-action="confirm"]')?.focus();
    });
  }

  async function deleteSongByPath(path) {
    const res = await fetch("/api/song", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const idxRes = await fetch("library/index.json", { cache: "no-store" });
    if (!idxRes.ok) throw new Error("Deleted, but failed to refresh library index");
    index = await idxRes.json();
    return data;
  }

  boot();
})();
