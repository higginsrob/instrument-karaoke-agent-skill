(function () {
  /** Pre-rendered stereo mixes used by export + single-file playback. */
  const MIX_MODES = [
    { id: "original", label: "Original" },
    { id: "karaoke-vocals", label: "No vocals" },
    { id: "karaoke-bass", label: "No bass" },
    { id: "karaoke-other", label: "No guitar/other" },
    { id: "karaoke-drums", label: "No drums" },
  ];
  const STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"];
  /** HT Demucs four-stem set used by the live mixer. */
  const MIXER_STEMS = ["vocals", "drums", "bass", "other"];
  const STEM_LABELS = {
    vocals: "Vocals",
    drums: "Drums",
    bass: "Bass",
    guitar: "Guitar",
    piano: "Piano",
    other: "Other",
  };
  const AUDIO_STORAGE_KEY = "instrument-karaoke.audio-mix";

  function defaultMixerMaps() {
    return {
      muted: Object.fromEntries(MIXER_STEMS.map((n) => [n, false])),
      soloed: Object.fromEntries(MIXER_STEMS.map((n) => [n, false])),
      volumes: Object.fromEntries(MIXER_STEMS.map((n) => [n, 1])),
      pans: Object.fromEntries(MIXER_STEMS.map((n) => [n, 0])),
    };
  }

  function readAudioPrefs() {
    const defaults = { mixId: "original", ...defaultMixerMaps() };
    try {
      const raw = localStorage.getItem(AUDIO_STORAGE_KEY);
      if (!raw) return defaults;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return defaults;
      const mixId = typeof data.mixId === "string" && data.mixId ? data.mixId : defaults.mixId;
      const muted = { ...defaults.muted };
      const soloed = { ...defaults.soloed };
      const volumes = { ...defaults.volumes };
      const pans = { ...defaults.pans };
      MIXER_STEMS.forEach((name) => {
        if (data.muted && typeof data.muted[name] === "boolean") muted[name] = data.muted[name];
        if (data.soloed && typeof data.soloed[name] === "boolean") soloed[name] = data.soloed[name];
        if (data.volumes && Number.isFinite(Number(data.volumes[name]))) {
          volumes[name] = Math.min(1, Math.max(0, Number(data.volumes[name])));
        }
        if (data.pans && Number.isFinite(Number(data.pans[name]))) {
          pans[name] = Math.min(1, Math.max(-1, Number(data.pans[name])));
        }
      });
      return { mixId, muted, soloed, volumes, pans };
    } catch {
      return defaults;
    }
  }

  function writeAudioPrefs(prefs) {
    try {
      localStorage.setItem(
        AUDIO_STORAGE_KEY,
        JSON.stringify({
          mixId: prefs.mixId,
          muted: prefs.muted,
          soloed: prefs.soloed,
          volumes: prefs.volumes,
          pans: prefs.pans,
        })
      );
    } catch {
      /* ignore quota / private mode */
    }
  }
  /** @type {Set<{ destroy: () => void }>} */
  const liveSessions = new Set();

  /** Admin API when available; otherwise direct library paths for static / Pages. */
  function mediaFileUrl(songPath, file, { useApi = false } = {}) {
    if (useApi) {
      const q = new URLSearchParams({ path: songPath, file });
      return `/api/media/file?${q.toString()}`;
    }
    const base = String(songPath || "")
      .replace(/\.md$/i, "")
      .replace(/^\/+/, "")
      .replace(/^library\//, "");
    const segments = [
      "library",
      ...base.split("/").filter(Boolean),
      ...String(file || "")
        .replace(/^\/+/, "")
        .split("/")
        .filter(Boolean),
    ];
    return segments.map(encodeURIComponent).join("/");
  }

  /** Drop src so the browser aborts in-flight range downloads immediately. */
  function releaseMediaElement(el) {
    if (!el) return;
    try {
      el.pause();
    } catch {
      /* ignore */
    }
    try {
      el.removeAttribute("src");
      el.removeAttribute("srcset");
      while (el.firstChild) el.removeChild(el.firstChild);
      el.load();
    } catch {
      /* ignore */
    }
  }

  window.MediaPlayer = {
    /** Hard refresh / tab close — tear down every mounted player (incl. detached mix Audio). */
    abortAll() {
      for (const session of [...liveSessions]) {
        try {
          session.destroy();
        } catch {
          /* ignore */
        }
      }
    },

    async mount(container, { songPath, isAdmin, canExport, mediaStatus, chartBody, title, artist, onSyncState, onLyricEdit, onVerified }) {
      if (!container || !window.MediaAnalysis) return { destroy() {} };

      const canShow =
        mediaStatus === "ready" || (mediaStatus === "needs_review" && isAdmin);
      if (!canShow) {
        container.hidden = true;
        container.innerHTML = "";
        return { destroy() {} };
      }

      const exportEnabled = Boolean(canExport ?? isAdmin);
      const showToolbar = exportEnabled || isAdmin;

      container.hidden = false;
      container.innerHTML = `
        <div class="media-stage" id="media-stage">
          <video class="media-video" playsinline preload="metadata"></video>
          <canvas class="media-canvas" aria-label="Media visualization"></canvas>
          <div class="media-chart-overlay" id="media-chart-overlay" hidden>
            <pre class="media-chart" id="media-chart" aria-label="Chords and lyrics"></pre>
          </div>
          <div
            class="media-progress-hit"
            id="media-progress-hit"
            role="slider"
            tabindex="0"
            aria-label="Seek timeline"
            aria-valuemin="0"
            aria-valuemax="0"
            aria-valuenow="0"
          ></div>
        </div>
        <div class="media-audio" id="media-audio">
          <div class="media-audio-row">
            <label class="media-audio-preset" id="media-audio-preset" for="media-audio-select" hidden>
              <span>Audio</span>
              <select id="media-audio-select" aria-label="Audio track preset"></select>
            </label>
            <button type="button" id="media-play">Play</button>
            <span class="media-time" id="media-time">0:00 / 0:00</span>
          </div>
          <div class="media-mixer" id="media-mixer" hidden></div>
        </div>
        <div class="media-toolbar"${showToolbar ? "" : " hidden"}>
          <span class="media-export-status" id="media-export-status" hidden></span>
          ${
            exportEnabled
              ? `<button type="button" class="secondary" id="media-export">Export video</button>`
              : ""
          }
          ${
            isAdmin
              ? `<button type="button" class="secondary" id="media-align">Align timing</button>
                 <button type="button" id="media-marker" hidden title="Stamp Align start on the selected line (or next unstamped)">Align start</button>
                 <button type="button" id="media-marker-end" hidden title="Stamp Align end on the selected line">Align end</button>
                 <button type="button" id="media-save-vtt" hidden>Save timing</button>
                 <button type="button" class="secondary" id="media-cancel-edit" hidden>Cancel</button>
                 ${
                   mediaStatus === "needs_review"
                     ? `<button type="button" id="media-verify">Verify media</button>`
                     : ""
                 }`
              : ""
          }
        </div>
        <div class="media-vtt-issues" id="media-vtt-issues" hidden></div>
        <div class="media-vtt-editor" id="media-vtt-editor" hidden>
          <p class="media-vtt-hint" id="media-align-hint">
            The stage keeps the chords-and-lyrics chart while you align.
            <strong>Align start</strong> when the lyric begins; <strong>Align end</strong> when singing stops.
            Chords past the lyric text play in the gap until the next line starts.
            Click a row to seek. Double-click a lyric to edit it inline (chart + VTT).
          </p>
          <ol class="media-align-list" id="media-align-list"></ol>
        </div>
      `;

      const mediaStage = container.querySelector("#media-stage");
      const video = container.querySelector(".media-video");
      const canvas = container.querySelector(".media-canvas");
      const chartOverlay = container.querySelector("#media-chart-overlay");
      const mediaChart = container.querySelector("#media-chart");
      const progressHit = container.querySelector("#media-progress-hit");
      const audioPreset = container.querySelector("#media-audio-preset");
      const audioSelect = container.querySelector("#media-audio-select");
      const mixerEl = container.querySelector("#media-mixer");
      const playBtn = container.querySelector("#media-play");
      const timeEl = container.querySelector("#media-time");
      const editor = container.querySelector("#media-vtt-editor");
      const alignList = container.querySelector("#media-align-list");
      const vttIssuesEl = container.querySelector("#media-vtt-issues");
      const alignBtn = container.querySelector("#media-align");
      const markerBtn = container.querySelector("#media-marker");
      const markerEndBtn = container.querySelector("#media-marker-end");
      const saveBtn = container.querySelector("#media-save-vtt");
      const cancelEditBtn = container.querySelector("#media-cancel-edit");
      const verifyBtn = container.querySelector("#media-verify");

      let destroyed = false;
      let raf = null;
      let alignMode = false;
      let lyricEditIndex = -1;
      let lyricEditOriginal = "";
      let lyricEditDraft = "";
      let selectedLineIndex = -1;
      let scrubbing = false;
      let progressDragging = false;
      /** Authoritative playhead intent — survives async mix/stem loads that finish later. */
      let wantedTime = 0;
      let wantPinnedUntil = 0;
      let lyricsCues = [];
      let chordsCues = [];
      let savedLyricsCues = [];
      let savedChordsCues = [];
      let syncLines = [];
      let drumsBeats = null;
      let duration = 0;
      /** @type {HTMLAudioElement | null} */
      let mixPlayer = null;
      const savedAudio = readAudioPrefs();
      /** One pre-rendered mix/solo file, or "mixer" for live multi-stem (bandwidth). */
      let mixId = savedAudio.mixId;
      /** Last explicitly chosen preset — kept even when a song lacks that option. */
      let preferredMixId = savedAudio.mixId;
      /** @type {Record<string, HTMLAudioElement>} */
      let stemPlayers = {};
      /** @type {Record<string, { source: MediaElementAudioSourceNode, gain: GainNode, panner: StereoPannerNode, analyser: AnalyserNode }>} */
      let stemNodes = {};
      /** @type {AudioContext | null} */
      let audioCtx = null;
      /** @type {Record<string, boolean>} */
      let muted = savedAudio.muted;
      /** @type {Record<string, boolean>} */
      let soloed = savedAudio.soloed;
      /** @type {Record<string, number>} volume 0..1 */
      let volumes = savedAudio.volumes;
      /** @type {Record<string, number>} pan -1..1 */
      let pans = savedAudio.pans;
      /** When set, next overlay scroll snaps instead of easing (seek). */
      let overlayScrollSnap = false;
      /** @type {string[]} */
      let availableStems = [];
      let audioAvailable = false;
      /** True when youtube/video.mp4 is present; otherwise the poster still shows. */
      let videoAvailable = false;
      let mixesChecked = false;
      /** @type {Record<string, boolean> | null} */
      let mediaFiles = null;
      let userPaused = true;
      let lastVideoDriftCheck = 0;
      let lastPlayingLine = -2;
      let chartBodyText = String(chartBody || "");
      /** @type {Promise<boolean> | null} */
      let mixesProbePromise = null;
      /** @type {Promise<void> | null} */
      let mixLoadPromise = null;
      /** @type {ReturnType<typeof setInterval> | null} */
      let exportPollTimer = null;
      /** @type {string | null} */
      let panDragStem = null;

      const api = {
        destroy() {
          if (destroyed) return;
          destroyed = true;
          liveSessions.delete(api);
          if (raf) {
            cancelAnimationFrame(raf);
            raf = null;
          }
          if (exportPollTimer) {
            clearInterval(exportPollTimer);
            exportPollTimer = null;
          }
          userPaused = true;
          pauseAll();
          teardownMixer();
          releaseMediaElement(mixPlayer);
          mixPlayer = null;
          releaseMediaElement(video);
          if (typeof onSyncState === "function") {
            onSyncState({
              alignMode: false,
              playingLineIndex: -1,
              selectedLineIndex: -1,
              stampedIndices: [],
            });
          }
          container.innerHTML = "";
          container.hidden = true;
        },
        getMixState() {
          return { mix: exportMixId(mixId) };
        },
      };
      liveSessions.add(api);

      const fileUrl = (file) => mediaFileUrl(songPath, file, { useApi: Boolean(isAdmin) });

      // Poster first; video.src is set only after probe confirms video.mp4 exists
      // (Pages publishes poster + MP3s without the large video files).
      video.poster = fileUrl("youtube/poster.jpg");
      video.preload = "metadata";
      video.playsInline = true;
      video.muted = true;
      video.removeAttribute("src");

      if (destroyed) return api;

      function hasFile(rel) {
        return Boolean(mediaFiles && mediaFiles[rel]);
      }

      function configureVideoElement() {
        if (hasFile("youtube/poster.jpg") || mediaFiles === null) {
          video.poster = fileUrl("youtube/poster.jpg");
        } else {
          video.removeAttribute("poster");
        }
        if (hasFile("youtube/video.mp4")) {
          videoAvailable = true;
          const next = fileUrl("youtube/video.mp4");
          if (video.getAttribute("src") !== next) {
            video.src = next;
          }
          return;
        }
        videoAvailable = false;
        if (video.getAttribute("src")) {
          video.removeAttribute("src");
          try {
            video.load();
          } catch {
            /* ignore */
          }
        }
      }

      function originalAudioUrl() {
        if (hasFile("mixes/original.mp3") || mediaFiles === null) {
          return fileUrl("mixes/original.mp3");
        }
        if (hasFile("source.mp3")) return fileUrl("source.mp3");
        return fileUrl("mixes/original.mp3");
      }

      function fileMixUrl(id) {
        if (id === "original") return originalAudioUrl();
        if (id.startsWith("stem-")) {
          const stemId = id.slice("stem-".length);
          if (hasFile(`mixes/${id}.mp3`)) return fileUrl(`mixes/${id}.mp3`);
          if (hasFile(`stems/${stemId}.wav`)) return fileUrl(`stems/${stemId}.wav`);
          return fileUrl(`mixes/${id}.mp3`);
        }
        return fileUrl(`mixes/${id}.mp3`);
      }

      function fileMixAvailable(id) {
        if (id === "original") {
          return hasFile("mixes/original.mp3") || hasFile("source.mp3") || mediaFiles === null;
        }
        if (id.startsWith("stem-")) {
          const stemId = id.slice("stem-".length);
          return hasFile(`mixes/${id}.mp3`) || hasFile(`stems/${stemId}.wav`);
        }
        return hasFile(`mixes/${id}.mp3`) || mediaFiles === null;
      }

      function persistAudioPrefs() {
        writeAudioPrefs({
          mixId: preferredMixId,
          muted,
          soloed,
          volumes,
          pans,
        });
      }

      function drumsAudible() {
        if (mixId === "mixer") return stemAudible("drums");
        if (mixId === "karaoke-drums") return false;
        if (mixId.startsWith("stem-")) return mixId === "stem-drums";
        return true;
      }

      /** Export only supports original + karaoke mixes (not solo stems or live mixer). */
      function exportMixId(id) {
        return MIX_MODES.some((m) => m.id === id) ? id : "original";
      }

      function isMixerMode() {
        return mixId === "mixer";
      }

      function mixerStemNames() {
        return MIXER_STEMS.filter((name) => stemPlayers[name]);
      }

      function mixerAvailable() {
        return MIXER_STEMS.every((id) => fileMixAvailable(`stem-${id}`));
      }

      function anySolo() {
        return MIXER_STEMS.some((name) => soloed[name]);
      }

      function stemAudible(name) {
        if (muted[name]) return false;
        if (anySolo() && !soloed[name]) return false;
        if (Object.keys(stemPlayers).length && !stemPlayers[name]) return false;
        return true;
      }

      function applyStemGains() {
        for (const name of mixerStemNames()) {
          const nodes = stemNodes[name];
          if (!nodes) continue;
          const vol = Number.isFinite(volumes[name]) ? volumes[name] : 1;
          nodes.gain.gain.value = stemAudible(name) ? vol : 0;
          nodes.panner.pan.value = Number.isFinite(pans[name]) ? pans[name] : 0;
        }
      }

      function masterStem() {
        if (!isMixerMode()) return null;
        return (
          stemPlayers.vocals ||
          stemPlayers.drums ||
          stemPlayers.bass ||
          stemPlayers.other ||
          null
        );
      }

      function presetOptions() {
        const opts = [];
        if (mixerAvailable()) {
          opts.push({ value: "mixer", label: "Mixer" });
        }
        if (fileMixAvailable("original") || mediaFiles === null) {
          opts.push({ value: "original", label: "Original" });
        }
        MIX_MODES.filter((m) => m.id !== "original").forEach((mode) => {
          if (fileMixAvailable(mode.id)) {
            opts.push({ value: mode.id, label: mode.label });
          }
        });
        availableStems.forEach((id) => {
          const value = `stem-${id}`;
          if (fileMixAvailable(value)) {
            opts.push({ value, label: `Solo — ${STEM_LABELS[id] || id}` });
          }
        });
        return opts;
      }

      function panKnobDegrees(pan) {
        return (Number.isFinite(pan) ? pan : 0) * 135;
      }

      function renderMixerControls() {
        if (!mixerEl) return;
        if (!isMixerMode() || !audioAvailable) {
          mixerEl.hidden = true;
          mixerEl.innerHTML = "";
          return;
        }
        const names = MIXER_STEMS.filter((id) => fileMixAvailable(`stem-${id}`));
        if (!names.length) {
          mixerEl.hidden = true;
          mixerEl.innerHTML = "";
          return;
        }
        mixerEl.hidden = false;
        const soloActive = anySolo();
        mixerEl.innerHTML = names
          .map((name) => {
            const isMuted = Boolean(muted[name]);
            const isSolo = Boolean(soloed[name]);
            const audible = stemAudible(name);
            const vol = Number.isFinite(volumes[name]) ? volumes[name] : 1;
            const pan = Number.isFinite(pans[name]) ? pans[name] : 0;
            const label = STEM_LABELS[name] || name;
            return `
              <div class="media-stem${audible ? "" : " is-silent"}" data-stem="${escapeHtml(name)}">
                <span class="media-stem-name">${escapeHtml(label)}</span>
                <div class="media-stem-btns">
                  <button type="button" class="media-stem-btn media-stem-mute${isMuted ? " is-active" : ""}"
                    data-stem="${escapeHtml(name)}" data-action="mute"
                    aria-pressed="${isMuted ? "true" : "false"}" title="Mute ${escapeHtml(label)}">M</button>
                  <button type="button" class="media-stem-btn media-stem-solo${isSolo ? " is-active" : ""}${soloActive && !isSolo ? " is-dim" : ""}"
                    data-stem="${escapeHtml(name)}" data-action="solo"
                    aria-pressed="${isSolo ? "true" : "false"}" title="Solo ${escapeHtml(label)}">S</button>
                </div>
                <div class="media-stem-fader-wrap">
                  <canvas class="media-stem-meter" data-meter="${escapeHtml(name)}" width="10" height="72" aria-hidden="true"></canvas>
                  <input type="range" class="media-stem-volume" data-stem="${escapeHtml(name)}"
                    min="0" max="1" step="0.01" value="${vol}"
                    aria-label="${escapeHtml(label)} volume" orient="vertical" />
                </div>
                <div class="media-stem-pan" data-stem="${escapeHtml(name)}" data-action="pan"
                  role="slider" tabindex="0" aria-valuemin="-100" aria-valuemax="100"
                  aria-valuenow="${Math.round(pan * 100)}" aria-label="${escapeHtml(label)} pan"
                  title="Pan ${escapeHtml(label)}">
                  <span class="media-stem-pan-knob" style="transform: rotate(${panKnobDegrees(pan)}deg)"></span>
                  <span class="media-stem-pan-label">Pan</span>
                </div>
              </div>`;
          })
          .join("");
      }

      function renderMixControls() {
        if (!audioSelect) return;
        const opts = presetOptions();
        if (!audioAvailable || !opts.length) {
          if (audioPreset) audioPreset.hidden = true;
          renderMixerControls();
          return;
        }
        if (audioPreset) audioPreset.hidden = false;
        if (opts.some((o) => o.value === preferredMixId)) {
          mixId = preferredMixId;
        } else if (!opts.some((o) => o.value === mixId)) {
          mixId = opts[0].value;
        }
        audioSelect.innerHTML = opts
          .map(
            (o) =>
              `<option value="${escapeHtml(o.value)}"${o.value === mixId ? " selected" : ""}>${escapeHtml(o.label)}</option>`
          )
          .join("");
        renderMixerControls();
      }

      function pinWantedTime(t) {
        const next = Math.max(0, Number(t) || 0);
        wantedTime = next;
        wantPinnedUntil = performance.now() + 750;
      }

      function clockTime() {
        if (scrubbing || progressDragging || performance.now() < wantPinnedUntil) {
          return wantedTime;
        }
        let live = 0;
        const master = masterStem();
        if (master && Number.isFinite(master.currentTime)) {
          live = master.currentTime;
        } else if (audioAvailable && mixPlayer && Number.isFinite(mixPlayer.currentTime)) {
          live = mixPlayer.currentTime;
        } else {
          live = video.currentTime || 0;
        }
        wantedTime = live;
        return live;
      }

      function mediaDuration() {
        const master = masterStem();
        if (master) {
          const md = Number(master.duration);
          if (Number.isFinite(md) && md > 0) return md;
        }
        if (audioAvailable && mixPlayer) {
          const md = Number(mixPlayer.duration);
          if (Number.isFinite(md) && md > 0) return md;
        }
        const vd = Number(video.duration);
        if (Number.isFinite(vd) && vd > 0) return vd;
        return Number.isFinite(duration) && duration > 0 ? duration : 0;
      }

      function snapMediaTo(el, t) {
        if (!el) return;
        try {
          const d = Number(el.duration);
          const target = Number.isFinite(d) && d > 0 ? Math.min(Math.max(0, t), Math.max(0, d - 0.05)) : Math.max(0, t);
          if (Math.abs((el.currentTime || 0) - target) > 0.04) {
            el.currentTime = target;
          }
        } catch {
          /* ignore seek race while loading */
        }
      }

      function syncAllTo(t) {
        if (videoAvailable) snapMediaTo(video, t);
        if (isMixerMode()) {
          for (const audio of Object.values(stemPlayers)) snapMediaTo(audio, t);
          return;
        }
        if (mixPlayer) snapMediaTo(mixPlayer, t);
      }

      async function playAll() {
        if (isMixerMode()) {
          await ensureAudioContext();
          applyStemGains();
        }
        const t = wantedTime;
        syncAllTo(t);
        if (isMixerMode() && mixerStemNames().length) {
          const tasks = Object.values(stemPlayers).map((audio) => audio.play().catch(() => {}));
          if (videoAvailable) {
            video.muted = true;
            tasks.push(video.play().catch(() => {}));
          }
          await Promise.all(tasks);
          return;
        }
        if (audioAvailable && mixPlayer) {
          // External audio owns the clock; muted video free-runs when present.
          const tasks = [mixPlayer.play().catch(() => {})];
          if (videoAvailable) {
            video.muted = true;
            tasks.push(video.play().catch(() => {}));
          }
          await Promise.all(tasks);
          return;
        }
        if (videoAvailable) {
          video.muted = false;
          await video.play();
        }
      }

      function pauseAll() {
        if (videoAvailable) video.pause();
        if (mixPlayer) mixPlayer.pause();
        for (const audio of Object.values(stemPlayers)) {
          audio.pause();
        }
      }

      function seekAll(t) {
        const d = mediaDuration();
        const target = d ? Math.min(Math.max(0, t), d) : Math.max(0, t);
        pinWantedTime(target);
        syncAllTo(target);
      }

      /** Occasional drift correction only — never scrub every animation frame. */
      function maybeResyncVideo(t) {
        if (!videoAvailable || !audioAvailable || userPaused || video.seeking || video.paused) return;
        if (scrubbing || progressDragging || performance.now() < wantPinnedUntil) return;
        if (!mixPlayer && !isMixerMode()) return;
        const now = performance.now();
        if (now - lastVideoDriftCheck < 1000) return;
        lastVideoDriftCheck = now;
        if (Math.abs((video.currentTime || 0) - t) > 0.35) {
          snapMediaTo(video, t);
        }
      }

      function rebuildSyncLines() {
        const groups = MediaAnalysis.extractChartGroups(chartBodyText);
        syncLines = MediaAnalysis.hydrateSyncLines(groups, lyricsCues, chordsCues);
      }

      function applyCuesFromSyncLines() {
        const { lyricsCues: nextLyrics, chordsCues: nextChords } = MediaAnalysis.syncLinesToCues(syncLines);
        lyricsCues = nextLyrics;
        chordsCues = nextChords;
        refreshVttValidation();
      }

      function currentVttValidation() {
        return MediaAnalysis.validateMediaVtt(lyricsCues, chordsCues);
      }

      function refreshVttValidation() {
        const result = currentVttValidation();
        if (vttIssuesEl) {
          if (!result.issues.length) {
            vttIssuesEl.hidden = true;
            vttIssuesEl.innerHTML = "";
            vttIssuesEl.classList.remove("is-error", "is-warn");
          } else {
            const isError = result.errors.length > 0;
            vttIssuesEl.hidden = false;
            vttIssuesEl.classList.toggle("is-error", isError);
            vttIssuesEl.classList.toggle("is-warn", !isError);
            const title = isError
              ? "VTT needs fixing before save / go-live"
              : "VTT warnings — fix before Verify media";
            vttIssuesEl.innerHTML = `<strong>${title}</strong><ul>${result.issues
              .slice(0, 8)
              .map((msg) => `<li>${escapeHtml(msg)}</li>`)
              .join("")}${
              result.issues.length > 8
                ? `<li>…and ${result.issues.length - 8} more</li>`
                : ""
            }</ul>`;
          }
        }
        if (verifyBtn) {
          const blockVerify = result.errors.length > 0 || result.warnings.length > 0;
          verifyBtn.disabled = blockVerify;
          verifyBtn.title = blockVerify
            ? result.issues[0] || "Fix VTT issues before verifying"
            : "Mark media as export-ready";
        }
        return result;
      }

      function formatVttValidationAlert(result, { forVerify = false } = {}) {
        const parts = [];
        if (result.errors.length) {
          parts.push(`Errors:\n- ${result.errors.join("\n- ")}`);
        }
        if (forVerify && result.warnings.length) {
          parts.push(`Warnings:\n- ${result.warnings.join("\n- ")}`);
        } else if (!forVerify && result.warnings.length) {
          parts.push(`Warnings (must fix before Verify):\n- ${result.warnings.join("\n- ")}`);
        }
        return parts.join("\n\n");
      }

      function chartOverlayActive() {
        // Chart scroll is drawn on the canvas; DOM overlay is no longer used for playback.
        return false;
      }

      function formatOverlayChartLine(line) {
        const text = String(line ?? "");
        const trimmed = text.trim();
        if (/^\[.+\]$/.test(trimmed) || /^(intro|verse|chorus|bridge|outro|solo|instrumental|interlude|pre-?chorus|break|coda|ending)(\s+\d+)?(\s*[:.\-]?\s*\d*x?)?$/i.test(trimmed)) {
          return `<span class="media-chart-section">${escapeHtml(text)}</span>`;
        }
        const chordRe =
          /\b([A-G](?:#|b)?(?:(?:maj|min|dim|aug|sus|add|M|m)?[0-9]*(?:[#b][0-9]+)?){0,3}(?:\([#b0-9]+\))?(?:\/[A-G](?:#|b)?)?)(?!\w)/g;
        return escapeHtml(text).replace(chordRe, (match) => `<span class="media-chart-chord">${match}</span>`);
      }

      function renderChartOverlay() {
        if (!mediaChart) return;
        const units = MediaAnalysis.chartDisplayUnits(chartBodyText);
        const parts = [];
        units.forEach((unit) => {
          if (unit.type === "blank") {
            parts.push("");
            return;
          }
          if (unit.type === "section" || unit.type === "raw") {
            parts.push(formatOverlayChartLine(unit.text));
            return;
          }
          if (unit.type === "group") {
            const inner = [];
            if (unit.chordLine != null) {
              inner.push(
                `<span class="media-chart-chord-line">${formatOverlayChartLine(unit.chordLine)}\n</span>`
              );
            }
            if (unit.lyricLine != null) inner.push(formatOverlayChartLine(unit.lyricLine));
            parts.push(
              `<span class="media-chart-line" data-line-index="${unit.index}">${inner.join("")}</span>`
            );
          }
        });
        mediaChart.innerHTML = parts.join("\n");
        overlayScrollSnap = true;
        updateChartOverlayHighlight();
      }

      function updateChartOverlayVisibility() {
        if (chartOverlay) chartOverlay.hidden = true;
        // Dim the video so the chords-and-lyrics chart stays readable (incl. align).
        mediaStage?.classList.add("is-chart-display");
      }

      /** ScrollTop that parks a sync line near the upper-middle of the overlay. */
      function overlayScrollTopForLine(lineIndex) {
        if (!chartOverlay || !mediaChart) return null;
        if (!Number.isFinite(lineIndex) || lineIndex < 0) return null;
        const el = mediaChart.querySelector(`.media-chart-line[data-line-index="${lineIndex}"]`);
        if (!el) return null;
        const maxScroll = Math.max(0, chartOverlay.scrollHeight - chartOverlay.clientHeight);
        const target = el.offsetTop + mediaChart.offsetTop - chartOverlay.clientHeight * 0.28;
        return Math.max(0, Math.min(maxScroll, target));
      }

      function lineWindowEnd(lineIndex) {
        const line = syncLines[lineIndex];
        if (!line || !Number.isFinite(line.start)) return null;
        for (let j = lineIndex + 1; j < syncLines.length; j += 1) {
          if (Number.isFinite(syncLines[j].start)) return syncLines[j].start;
        }
        return Number.isFinite(line.end) ? line.end : line.start + 3;
      }

      /**
       * Continuously ease the overlay toward the playing line, drifting into the next
       * line over the current line's duration so motion stays gradual.
       */
      function syncChartOverlayScroll() {
        if (!chartOverlayActive() || !chartOverlay) return;
        const t = clockTime();
        const playing = MediaAnalysis.playingSyncLineIndex(syncLines, t);
        if (playing < 0) return;

        const y0 = overlayScrollTopForLine(playing);
        if (y0 == null) return;
        const y1 = overlayScrollTopForLine(playing + 1);
        const line = syncLines[playing];
        const start = Number(line?.start);
        const end = lineWindowEnd(playing);
        let progress = 0;
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          progress = Math.min(1, Math.max(0, (t - start) / (end - start)));
        }
        // Smoothstep — slow start/end so the crawl never feels jumpy.
        const eased = progress * progress * (3 - 2 * progress);
        const target = y1 == null ? y0 : y0 + (y1 - y0) * eased * 0.9;

        const cur = chartOverlay.scrollTop;
        if (overlayScrollSnap || Math.abs(target - cur) < 0.4) {
          chartOverlay.scrollTop = target;
          overlayScrollSnap = false;
          return;
        }
        // Low lerp: a typical line-step settles over ~0.8–1.2s instead of snapping.
        const alpha = 0.05;
        chartOverlay.scrollTop = cur + (target - cur) * alpha;
      }

      function updateChartOverlayHighlight() {
        if (!mediaChart) return;
        const playing = MediaAnalysis.playingSyncLineIndex(syncLines, clockTime());
        mediaChart.querySelectorAll(".media-chart-line").forEach((el) => {
          const idx = Number(el.dataset.lineIndex);
          el.classList.toggle("is-playing", idx === playing);
          el.classList.toggle("is-selected", idx === selectedLineIndex);
        });
      }

      function emitSyncState() {
        if (typeof onSyncState !== "function") return;
        const playingLineIndex = MediaAnalysis.playingSyncLineIndex(syncLines, clockTime());
        const stampedIndices = syncLines
          .map((line, i) => (Number.isFinite(line.start) ? i : -1))
          .filter((i) => i >= 0);
        onSyncState({
          alignMode,
          playingLineIndex,
          selectedLineIndex,
          stampedIndices,
          lyricDisplay: "chart",
        });
      }

      function formatAlignTime(line) {
        if (!Number.isFinite(line.start)) return "—";
        if (Number.isFinite(line.end)) return `${fmt(line.start)}–${fmt(line.end)}`;
        return `${fmt(line.start)}–`;
      }

      function captureLyricEditDraft() {
        if (lyricEditIndex < 0 || !alignList) return;
        const input = alignList.querySelector(".media-align-lyric-input");
        if (input) lyricEditDraft = input.value;
      }

      function clearLyricEdit() {
        lyricEditIndex = -1;
        lyricEditOriginal = "";
        lyricEditDraft = "";
      }

      function beginLyricEdit(index) {
        if (!Number.isInteger(index) || index < 0 || index >= syncLines.length) return false;
        captureLyricEditDraft();
        const line = syncLines[index];
        lyricEditIndex = index;
        lyricEditOriginal = line.lyric || "";
        lyricEditDraft = lyricEditOriginal;
        selectedLineIndex = index;
        renderAlignList();
        const input = alignList?.querySelector(".media-align-lyric-input");
        if (input) {
          input.focus();
          input.select();
        }
        return true;
      }

      function revertLyricEdit() {
        if (lyricEditIndex < 0) return;
        clearLyricEdit();
        renderAlignList();
      }

      function renderAlignList() {
        if (!alignList) return;
        captureLyricEditDraft();
        if (!syncLines.length) {
          alignList.innerHTML = `<li class="media-align-empty">No chord/lyric lines found in the chart.</li>`;
          return;
        }
        const playing = MediaAnalysis.playingSyncLineIndex(syncLines, clockTime());
        alignList.innerHTML = syncLines
          .map((line, i) => {
            const label = line.lyric || "(instrumental)";
            const chords = (line.chords || []).map((c) => c.name).join(" ") || "—";
            const time = formatAlignTime(line);
            const editing = i === lyricEditIndex;
            const classes = [
              "media-align-item",
              Number.isFinite(line.start) ? "is-stamped" : "",
              Number.isFinite(line.end) ? "is-ended" : "",
              i === playing ? "is-playing" : "",
              i === selectedLineIndex ? "is-selected" : "",
              editing ? "is-editing" : "",
            ]
              .filter(Boolean)
              .join(" ");
            if (editing) {
              return `<li class="${classes}" data-line-index="${i}">
              <div class="media-align-line is-editing" data-line-index="${i}">
                <span class="media-align-time">${time}</span>
                <div class="media-align-chart">
                  <span class="media-align-chords">${escapeHtml(chords)}</span>
                  <input type="text" class="media-align-lyric-input" data-line-index="${i}" value="${escapeHtml(lyricEditDraft)}" aria-label="Edit lyric" />
                </div>
              </div>
              <span class="media-align-actions is-visible">
                <button type="button" class="media-align-revert" data-line-index="${i}">Revert</button>
                <button type="button" class="media-align-save-lyric" data-line-index="${i}">Save</button>
              </span>
            </li>`;
            }
            return `<li class="${classes}" data-line-index="${i}">
              <button type="button" class="media-align-line" data-line-index="${i}" title="Click to seek · double-click to edit lyric">
                <span class="media-align-time">${time}</span>
                <div class="media-align-chart">
                  <span class="media-align-chords">${escapeHtml(chords)}</span>
                  <span class="media-align-lyric">${escapeHtml(label)}</span>
                </div>
              </button>
              <span class="media-align-actions">
                <button type="button" class="media-align-assign media-align-start" data-line-index="${i}" title="Align start — when this lyric begins">Start</button>
                <button type="button" class="media-align-assign media-align-end" data-line-index="${i}" title="Align end — when singing stops (trailing chords use the gap)">End</button>
              </span>
            </li>`;
          })
          .join("");
        const focusIdx = selectedLineIndex >= 0 ? selectedLineIndex : playing;
        const focusEl = focusIdx >= 0 ? alignList.querySelector(`.media-align-item[data-line-index="${focusIdx}"]`) : null;
        focusEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }

      function setAlignMode(on) {
        alignMode = Boolean(on);
        if (!alignMode) clearLyricEdit();
        if (alignBtn) {
          alignBtn.classList.toggle("is-active", alignMode);
          alignBtn.textContent = alignMode ? "Aligning…" : "Align timing";
        }
        if (markerBtn) markerBtn.hidden = !alignMode;
        if (markerEndBtn) markerEndBtn.hidden = !alignMode;
        updateChartOverlayVisibility();
        if (!editor) {
          paint();
          emitSyncState();
          return;
        }
        if (!alignMode) {
          editor.hidden = true;
          if (saveBtn) saveBtn.hidden = true;
          if (cancelEditBtn) cancelEditBtn.hidden = true;
          if (chartOverlayActive()) {
            renderChartOverlay();
            overlayScrollSnap = true;
            updateChartOverlayHighlight();
          }
          paint();
          emitSyncState();
          return;
        }
        editor.hidden = false;
        if (saveBtn) saveBtn.hidden = false;
        if (cancelEditBtn) cancelEditBtn.hidden = false;
        rebuildSyncLines();
        if (selectedLineIndex < 0 && syncLines.length) selectedLineIndex = 0;
        renderAlignList();
        paint();
        emitSyncState();
      }

      function resolveMarkerTargetIndex() {
        if (
          Number.isInteger(selectedLineIndex) &&
          selectedLineIndex >= 0 &&
          selectedLineIndex < syncLines.length
        ) {
          return selectedLineIndex;
        }
        let lastStamped = -1;
        syncLines.forEach((line, i) => {
          if (Number.isFinite(line.start)) lastStamped = i;
        });
        const next = lastStamped + 1;
        if (next < syncLines.length) return next;
        return lastStamped >= 0 ? lastStamped : syncLines.length ? 0 : -1;
      }

      function stampChartLineStart(index, { advance = false } = {}) {
        if (!Number.isInteger(index) || index < 0 || index >= syncLines.length) return false;
        if (!alignMode) setAlignMode(true);
        syncLines = MediaAnalysis.applySyncLineStamp(syncLines, index, clockTime());
        applyCuesFromSyncLines();
        // Per-row Start stays put so Align end can follow; toolbar start advances.
        selectedLineIndex = advance
          ? Math.min(index + 1, syncLines.length - 1)
          : index;
        renderAlignList();
        paint();
        emitSyncState();
        return true;
      }

      function stampChartLineEnd(index) {
        if (!Number.isInteger(index) || index < 0 || index >= syncLines.length) return false;
        if (!alignMode) setAlignMode(true);
        syncLines = MediaAnalysis.applySyncLineStampEnd(syncLines, index, clockTime());
        applyCuesFromSyncLines();
        selectedLineIndex = Math.min(index + 1, syncLines.length - 1);
        renderAlignList();
        paint();
        emitSyncState();
        return true;
      }

      function placeMarker() {
        const index = resolveMarkerTargetIndex();
        if (index < 0) return false;
        return stampChartLineStart(index, { advance: true });
      }

      function placeMarkerEnd() {
        const index =
          Number.isInteger(selectedLineIndex) &&
          selectedLineIndex >= 0 &&
          selectedLineIndex < syncLines.length
            ? selectedLineIndex
            : resolveMarkerTargetIndex();
        if (index < 0) return false;
        return stampChartLineEnd(index);
      }

      function selectAndSeekLine(index) {
        if (!Number.isInteger(index) || index < 0 || index >= syncLines.length) return false;
        selectedLineIndex = index;
        const line = syncLines[index];
        if (Number.isFinite(line.start)) {
          const wasPaused = userPaused;
          seekAll(line.start);
          overlayScrollSnap = true;
          if (!wasPaused) {
            playAll().catch(() => {});
          }
        }
        renderAlignList();
        paint();
        emitSyncState();
        return true;
      }

      async function saveLyricEdit() {
        if (lyricEditIndex < 0) return false;
        captureLyricEditDraft();
        const index = lyricEditIndex;
        const current = lyricEditOriginal;
        const trimmed = String(lyricEditDraft).trim();
        if (!trimmed) {
          alert("Lyric cannot be empty.");
          return false;
        }
        if (trimmed === current) {
          clearLyricEdit();
          renderAlignList();
          return false;
        }

        selectedLineIndex = index;
        const priorLines = syncLines.map((l) => ({
          ...l,
          chords: (l.chords || []).map((c) => ({ ...c })),
        }));
        const priorLyrics = lyricsCues.map((c) => ({ ...c }));
        const priorChords = chordsCues.map((c) => ({ ...c }));

        syncLines[index] = { ...syncLines[index], lyric: trimmed };
        applyCuesFromSyncLines();
        const validation = currentVttValidation();
        if (!validation.ok) {
          syncLines = priorLines;
          lyricsCues = priorLyrics;
          chordsCues = priorChords;
          refreshVttValidation();
          alert(`Cannot save lyric edit — fix VTT errors first.\n\n${formatVttValidationAlert(validation)}`);
          renderAlignList();
          paint();
          return false;
        }

        try {
          const vttRes = await fetch("/api/media/vtt", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              path: songPath,
              kind: "lyrics",
              content: MediaAnalysis.cuesToVtt(lyricsCues),
            }),
          });
          if (!vttRes.ok) {
            const data = await vttRes.json().catch(() => ({}));
            throw new Error(data.error || "Failed to save lyrics VTT");
          }
        } catch (err) {
          syncLines = priorLines;
          lyricsCues = priorLyrics;
          chordsCues = priorChords;
          refreshVttValidation();
          alert(err.message || "Could not save lyrics VTT");
          renderAlignList();
          paint();
          return false;
        }

        if (typeof onLyricEdit === "function") {
          const ok = await onLyricEdit({
            lineIndex: index,
            oldLyric: current,
            newLyric: trimmed,
            chartBody: chartBodyText,
          });
          if (ok === false) {
            syncLines = priorLines;
            lyricsCues = priorLyrics;
            chordsCues = priorChords;
            applyCuesFromSyncLines();
            try {
              await fetch("/api/media/vtt", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  path: songPath,
                  kind: "lyrics",
                  content: MediaAnalysis.cuesToVtt(lyricsCues),
                }),
              });
            } catch {
              /* ignore rollback failure */
            }
            renderAlignList();
            paint();
            emitSyncState();
            return false;
          }
        }

        savedLyricsCues = lyricsCues.map((c) => ({ ...c }));
        clearLyricEdit();
        renderAlignList();
        paint();
        emitSyncState();
        return true;
      }

      /** @deprecated kept as alias for chart/overlay callers */
      async function editLyricLine(index) {
        return beginLyricEdit(index);
      }

      function discoverAvailableStems(files) {
        const ids = [];
        STEM_ORDER.forEach((id) => {
          if (files[`mixes/stem-${id}.mp3`] || files[`stems/${id}.wav`]) ids.push(id);
        });
        Object.keys(files).forEach((key) => {
          let id = null;
          if (key.startsWith("mixes/stem-") && key.endsWith(".mp3")) {
            id = key.slice("mixes/stem-".length, -".mp3".length);
          } else if (key.startsWith("stems/") && key.endsWith(".wav")) {
            id = key.slice("stems/".length, -".wav".length);
          }
          if (id && !ids.includes(id)) ids.push(id);
        });
        return ids;
      }

      async function probeMixesAvailable() {
        if (mixesChecked) return audioAvailable;
        mixesChecked = true;
        try {
          if (isAdmin) {
            const res = await fetch(`/api/media?${new URLSearchParams({ path: songPath })}`, {
              cache: "no-store",
            });
            const data = await res.json().catch(() => ({}));
            mediaFiles = res.ok && data.files && typeof data.files === "object" ? data.files : null;
          } else {
            const res = await fetch(fileUrl("mixes/original.mp3"), {
              method: "GET",
              headers: { Range: "bytes=0-0" },
              cache: "no-store",
            });
            const ok = res.ok || res.status === 206;
            mediaFiles = ok ? { "mixes/original.mp3": true } : {};
            try {
              await res.body?.cancel();
            } catch {
              /* ignore */
            }
            // Probe common stem MP3s in static mode.
            await Promise.all(
              STEM_ORDER.map(async (id) => {
                try {
                  const stemRes = await fetch(fileUrl(`mixes/stem-${id}.mp3`), {
                    method: "GET",
                    headers: { Range: "bytes=0-0" },
                    cache: "no-store",
                  });
                  if (stemRes.ok || stemRes.status === 206) {
                    mediaFiles[`mixes/stem-${id}.mp3`] = true;
                  }
                  try {
                    await stemRes.body?.cancel();
                  } catch {
                    /* ignore */
                  }
                } catch {
                  /* ignore */
                }
              })
            );
            await Promise.all(
              MIX_MODES.filter((m) => m.id !== "original").map(async (mode) => {
                try {
                  const mixRes = await fetch(fileUrl(`mixes/${mode.id}.mp3`), {
                    method: "GET",
                    headers: { Range: "bytes=0-0" },
                    cache: "no-store",
                  });
                  if (mixRes.ok || mixRes.status === 206) {
                    mediaFiles[`mixes/${mode.id}.mp3`] = true;
                  }
                  try {
                    await mixRes.body?.cancel();
                  } catch {
                    /* ignore */
                  }
                } catch {
                  /* ignore */
                }
              })
            );
            await Promise.all(
              ["youtube/poster.jpg", "youtube/video.mp4"].map(async (rel) => {
                try {
                  const mediaRes = await fetch(fileUrl(rel), {
                    method: "GET",
                    headers: { Range: "bytes=0-0" },
                    cache: "no-store",
                  });
                  if (mediaRes.ok || mediaRes.status === 206) {
                    mediaFiles[rel] = true;
                  }
                  try {
                    await mediaRes.body?.cancel();
                  } catch {
                    /* ignore */
                  }
                } catch {
                  /* ignore */
                }
              })
            );
          }
        } catch {
          mediaFiles = mediaFiles || {};
        }

        availableStems = mediaFiles ? discoverAvailableStems(mediaFiles) : [];
        audioAvailable = Boolean(
          (mediaFiles &&
            (mediaFiles["mixes/original.mp3"] ||
              mediaFiles["source.mp3"] ||
              MIX_MODES.some((m) => mediaFiles[`mixes/${m.id}.mp3`]) ||
              availableStems.length)) ||
            mediaFiles === null
        );
        configureVideoElement();
        renderMixControls();
        return audioAvailable;
      }

      function ensureMixesProbed() {
        if (mixesProbePromise) return mixesProbePromise;
        mixesProbePromise = probeMixesAvailable();
        return mixesProbePromise;
      }

      function loadAudioElement(audio, src, seekTo) {
        return new Promise((resolve, reject) => {
          if (destroyed) {
            resolve();
            return;
          }
          const finish = (ok) => {
            audio.onloadedmetadata = null;
            audio.oncanplay = null;
            audio.onerror = null;
            if (destroyed) {
              resolve();
              return;
            }
            if (!ok) {
              reject(new Error(`Failed to load ${src}`));
              return;
            }
            if (Number.isFinite(audio.duration) && audio.duration > duration) {
              duration = audio.duration;
            }
            // Always honor the latest scrub/seek, not the stale seekTo from load start.
            snapMediaTo(audio, wantedTime);
            resolve();
          };
          // Same URL already loaded — just seek.
          if (audio.dataset.loadedSrc === src && audio.readyState >= 1) {
            finish(true);
            return;
          }
          audio.onerror = () => finish(false);
          audio.onloadedmetadata = () => finish(true);
          audio.dataset.loadedSrc = src;
          audio.src = src;
          audio.load();
        });
      }

      async function ensureAudioContext() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!audioCtx || audioCtx.state === "closed") {
          audioCtx = new Ctx();
        }
        if (audioCtx.state === "suspended") {
          try {
            await audioCtx.resume();
          } catch {
            /* ignore */
          }
        }
        return audioCtx;
      }

      function wireStemNode(name, audio) {
        if (!audioCtx || stemNodes[name]) return;
        try {
          const source = audioCtx.createMediaElementSource(audio);
          const gain = audioCtx.createGain();
          const panner = audioCtx.createStereoPanner();
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.75;
          source.connect(gain);
          gain.connect(panner);
          panner.connect(analyser);
          analyser.connect(audioCtx.destination);
          stemNodes[name] = { source, gain, panner, analyser };
        } catch (err) {
          console.warn(`Failed to wire stem ${name}`, err);
        }
      }

      function teardownMixer() {
        for (const audio of Object.values(stemPlayers)) {
          releaseMediaElement(audio);
        }
        stemPlayers = {};
        stemNodes = {};
        if (audioCtx) {
          const ctx = audioCtx;
          audioCtx = null;
          try {
            ctx.close();
          } catch {
            /* ignore */
          }
        }
        if (mixerEl) {
          mixerEl.hidden = true;
          mixerEl.innerHTML = "";
        }
      }

      function loadMixAudio(targetMixId, seekTo) {
        if (!audioAvailable) return Promise.resolve();
        const id = targetMixId || mixId;
        if (Number.isFinite(seekTo)) pinWantedTime(seekTo);
        mixLoadPromise = (async () => {
          if (destroyed) return;
          if (!mixPlayer) {
            mixPlayer = new Audio();
            mixPlayer.preload = "metadata";
            mixPlayer.loop = false;
          }
          await loadAudioElement(mixPlayer, fileMixUrl(id), seekTo);
          snapMediaTo(video, wantedTime);
        })();
        return mixLoadPromise;
      }

      function loadMixerStems(seekTo) {
        if (!audioAvailable) return Promise.resolve();
        if (Number.isFinite(seekTo)) pinWantedTime(seekTo);
        mixLoadPromise = (async () => {
          if (destroyed) return;
          await ensureAudioContext();
          const names = MIXER_STEMS.filter((id) => fileMixAvailable(`stem-${id}`));
          await Promise.all(
            names.map(async (name) => {
              if (destroyed) return;
              if (!stemPlayers[name]) {
                const audio = new Audio();
                audio.preload = "metadata";
                audio.loop = false;
                stemPlayers[name] = audio;
                wireStemNode(name, audio);
              }
              await loadAudioElement(stemPlayers[name], fileMixUrl(`stem-${name}`), seekTo);
            })
          );
          if (destroyed) return;
          snapMediaTo(video, wantedTime);
          applyStemGains();
          renderMixerControls();
        })();
        return mixLoadPromise;
      }

      async function ensureMixReady() {
        await ensureMixesProbed();
        if (destroyed || !audioAvailable) return;
        const t = clockTime();
        if (isMixerMode()) {
          await loadMixerStems(t);
        } else {
          await loadMixAudio(mixId, t);
        }
      }

      async function switchPreset(nextMixId) {
        const opts = presetOptions();
        if (!opts.some((o) => o.value === nextMixId) || nextMixId === mixId) {
          renderMixControls();
          return;
        }
        const wasPlaying = !userPaused;
        const t = clockTime();
        const leavingMixer = isMixerMode();
        const enteringMixer = nextMixId === "mixer";
        preferredMixId = nextMixId;
        mixId = nextMixId;
        persistAudioPrefs();
        renderMixControls();
        paint();
        if (!audioAvailable) return;
        pauseAll();
        try {
          if (leavingMixer && !enteringMixer) {
            teardownMixer();
          }
          if (enteringMixer) {
            releaseMediaElement(mixPlayer);
            mixPlayer = null;
            await loadMixerStems(t);
          } else {
            await loadMixAudio(mixId, t);
          }
          if (destroyed) return;
          if (wasPlaying) {
            userPaused = false;
            await playAll();
            if (playBtn) playBtn.textContent = "Pause";
          } else {
            syncAllTo(t);
          }
        } catch (err) {
          console.warn(err);
        }
        paint();
      }

      async function loadAssets() {
        const [lyricsRes, chordsRes, beatsRes] = await Promise.all([
          fetch(fileUrl("lyrics.vtt"), { cache: "no-store" }),
          fetch(fileUrl("chords.vtt"), { cache: "no-store" }),
          fetch(fileUrl("drums_beats.json"), { cache: "no-store" }),
        ]);
        if (lyricsRes.ok) lyricsCues = MediaAnalysis.parseVtt(await lyricsRes.text());
        if (chordsRes.ok) chordsCues = MediaAnalysis.parseVtt(await chordsRes.text());
        lyricsCues = MediaAnalysis.sortCuesByStart(lyricsCues);
        chordsCues = MediaAnalysis.sortCuesByStart(chordsCues);
        savedLyricsCues = lyricsCues.slice();
        savedChordsCues = chordsCues.slice();
        if (beatsRes.ok) drumsBeats = await beatsRes.json();
        rebuildSyncLines();
        refreshVttValidation();
        await ensureMixesProbed();
      }

      function state() {
        const t = clockTime();
        const d = mediaDuration();
        return {
          currentTime: t,
          duration: d,
          lyricsCues,
          chordsCues,
          drumsBeats,
          syncLines,
          stemSilent: { drums: audioAvailable && !drumsAudible() },
          lyricDisplay: "chart",
          editMode: alignMode,
          editKind: alignMode ? "lyrics" : null,
          selectedLineIndex,
          selectedCueIndex: MediaAnalysis.playingSyncLineIndex(syncLines, t),
        };
      }

      function paintMixerMeters() {
        if (!isMixerMode() || !mixerEl) return;
        for (const name of mixerStemNames()) {
          const canvas = mixerEl.querySelector(`canvas[data-meter="${name}"]`);
          const analyser = stemNodes[name]?.analyser;
          if (!canvas || !analyser) continue;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          const w = canvas.width;
          const h = canvas.height;
          const buf = new Uint8Array(analyser.fftSize);
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          const level = Math.min(1, rms * 2.8);
          ctx.clearRect(0, 0, w, h);
          ctx.fillStyle = "rgba(30, 30, 30, 0.08)";
          ctx.fillRect(0, 0, w, h);
          const barH = Math.max(0, Math.round(level * h));
          const grad = ctx.createLinearGradient(0, h, 0, 0);
          grad.addColorStop(0, "rgba(42, 154, 106, 0.85)");
          grad.addColorStop(0.7, "rgba(180, 140, 40, 0.9)");
          grad.addColorStop(1, "rgba(180, 60, 40, 0.95)");
          ctx.fillStyle = grad;
          ctx.fillRect(1, h - barH, w - 2, barH);
        }
      }

      function paint() {
        if (destroyed) return;
        const t = clockTime();
        maybeResyncVideo(t);
        MediaAnalysis.drawFrame(canvas, state());
        paintMixerMeters();
        const d = mediaDuration();
        if (timeEl) timeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
        if (progressHit) {
          progressHit.setAttribute("aria-valuemax", String(Math.max(0, Math.round(d))));
          progressHit.setAttribute("aria-valuenow", String(Math.max(0, Math.round(t))));
          progressHit.classList.toggle("is-dragging", progressDragging);
        }
        const playing = MediaAnalysis.playingSyncLineIndex(syncLines, t);
        if (playing !== lastPlayingLine) {
          lastPlayingLine = playing;
          emitSyncState();
          if (alignMode && alignList) {
            alignList.querySelectorAll(".media-align-item").forEach((el) => {
              const idx = Number(el.dataset.lineIndex);
              el.classList.toggle("is-playing", idx === playing);
            });
            const focusIdx = playing >= 0 ? playing : selectedLineIndex;
            const focusEl =
              focusIdx >= 0
                ? alignList.querySelector(`.media-align-item[data-line-index="${focusIdx}"]`)
                : null;
            focusEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
        }
      }

      function loop() {
        paint();
        raf = requestAnimationFrame(loop);
      }

      audioSelect?.addEventListener("change", () => {
        const next = audioSelect.value;
        if (next) switchPreset(next);
      });

      /** Mute/solo re-render the mixer DOM, so detect double-click via timing instead of dblclick. */
      let lastMixerToggle = { key: "", at: 0 };

      mixerEl?.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-action='mute'], [data-action='solo']");
        if (!btn || !mixerEl.contains(btn)) return;
        const name = btn.getAttribute("data-stem");
        const action = btn.getAttribute("data-action");
        if (!name || !MIXER_STEMS.includes(name)) return;
        const key = `${action}:${name}`;
        const now = performance.now();
        const isDouble = lastMixerToggle.key === key && now - lastMixerToggle.at < 400;
        lastMixerToggle = { key, at: now };
        if (isDouble) {
          if (action === "mute") muted[name] = false;
          else if (action === "solo") soloed[name] = false;
        } else if (action === "mute") {
          muted[name] = !muted[name];
        } else if (action === "solo") {
          soloed[name] = !soloed[name];
        }
        persistAudioPrefs();
        applyStemGains();
        renderMixerControls();
        paint();
      });

      mixerEl?.addEventListener("dblclick", (event) => {
        const volumeEl = event.target.closest(".media-stem-volume");
        if (volumeEl && mixerEl.contains(volumeEl) && volumeEl instanceof HTMLInputElement) {
          const name = volumeEl.getAttribute("data-stem");
          if (!name || !MIXER_STEMS.includes(name)) return;
          event.preventDefault();
          volumes[name] = 1;
          volumeEl.value = "1";
          persistAudioPrefs();
          applyStemGains();
          return;
        }

        const panEl = event.target.closest(".media-stem-pan");
        if (panEl && mixerEl.contains(panEl)) {
          const name = panEl.getAttribute("data-stem");
          if (!name || !MIXER_STEMS.includes(name)) return;
          event.preventDefault();
          panDragStem = null;
          pans[name] = 0;
          const knob = panEl.querySelector(".media-stem-pan-knob");
          if (knob) knob.style.transform = `rotate(${panKnobDegrees(0)}deg)`;
          panEl.setAttribute("aria-valuenow", "0");
          persistAudioPrefs();
          applyStemGains();
        }
      });

      mixerEl?.addEventListener("input", (event) => {
        const el = event.target;
        if (!(el instanceof HTMLInputElement) || !el.classList.contains("media-stem-volume")) return;
        const name = el.getAttribute("data-stem");
        if (!name || !MIXER_STEMS.includes(name)) return;
        volumes[name] = Math.min(1, Math.max(0, Number(el.value) || 0));
        persistAudioPrefs();
        applyStemGains();
      });

      function setPanFromClientX(stem, clientX, panEl) {
        const rect = panEl.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const frac = (clientX - mid) / Math.max(1, rect.width / 2);
        pans[stem] = Math.min(1, Math.max(-1, frac));
        const knob = panEl.querySelector(".media-stem-pan-knob");
        if (knob) knob.style.transform = `rotate(${panKnobDegrees(pans[stem])}deg)`;
        panEl.setAttribute("aria-valuenow", String(Math.round(pans[stem] * 100)));
        applyStemGains();
      }

      mixerEl?.addEventListener("pointerdown", (event) => {
        const panEl = event.target.closest(".media-stem-pan");
        if (!panEl || !mixerEl.contains(panEl)) return;
        const name = panEl.getAttribute("data-stem");
        if (!name || !MIXER_STEMS.includes(name)) return;
        panDragStem = name;
        panEl.setPointerCapture?.(event.pointerId);
        setPanFromClientX(name, event.clientX, panEl);
        event.preventDefault();
      });

      mixerEl?.addEventListener("pointermove", (event) => {
        if (!panDragStem) return;
        const panEl = mixerEl.querySelector(`.media-stem-pan[data-stem="${panDragStem}"]`);
        if (!panEl) return;
        setPanFromClientX(panDragStem, event.clientX, panEl);
      });

      const endPanDrag = () => {
        if (panDragStem) persistAudioPrefs();
        panDragStem = null;
      };
      mixerEl?.addEventListener("pointerup", endPanDrag);
      mixerEl?.addEventListener("pointercancel", endPanDrag);

      mixerEl?.addEventListener("keydown", (event) => {
        const panEl = event.target.closest?.(".media-stem-pan");
        if (!panEl || !mixerEl.contains(panEl)) return;
        const name = panEl.getAttribute("data-stem");
        if (!name || !MIXER_STEMS.includes(name)) return;
        let next = pans[name] || 0;
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") next -= 0.1;
        else if (event.key === "ArrowRight" || event.key === "ArrowUp") next += 0.1;
        else if (event.key === "Home") next = -1;
        else if (event.key === "End") next = 1;
        else if (event.key === "0" || event.key === "Delete") next = 0;
        else return;
        event.preventDefault();
        pans[name] = Math.min(1, Math.max(-1, Math.round(next * 100) / 100));
        const knob = panEl.querySelector(".media-stem-pan-knob");
        if (knob) knob.style.transform = `rotate(${panKnobDegrees(pans[name])}deg)`;
        panEl.setAttribute("aria-valuenow", String(Math.round(pans[name] * 100)));
        persistAudioPrefs();
        applyStemGains();
      });

      chartOverlay?.addEventListener("click", (event) => {
        const lineEl = event.target.closest(".media-chart-line[data-line-index]");
        if (!lineEl || !chartOverlay.contains(lineEl)) return;
        const index = Number(lineEl.dataset.lineIndex);
        if (!Number.isInteger(index)) return;
        selectAndSeekLine(index);
        overlayScrollSnap = true;
        updateChartOverlayHighlight();
      });

      function canvasCssPoint(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.clientWidth / Math.max(1, rect.width);
        const scaleY = canvas.clientHeight / Math.max(1, rect.height);
        return {
          x: (clientX - rect.left) * scaleX,
          y: (clientY - rect.top) * scaleY,
        };
      }

      canvas?.addEventListener("click", (event) => {
        if (event.button != null && event.button !== 0) return;
        const { x, y } = canvasCssPoint(event.clientX, event.clientY);
        const index = MediaAnalysis.hitTestChartAt(x, y);
        if (index < 0) return;
        event.preventDefault();
        selectAndSeekLine(index);
        overlayScrollSnap = true;
      });

      canvas?.addEventListener("mousemove", (event) => {
        const { x, y } = canvasCssPoint(event.clientX, event.clientY);
        const index = MediaAnalysis.hitTestChartAt(x, y);
        canvas.style.cursor = index >= 0 ? "pointer" : "default";
      });

      canvas?.addEventListener("mouseleave", () => {
        canvas.style.cursor = "default";
      });

      playBtn?.addEventListener("click", async () => {
        if (userPaused) {
          try {
            playBtn.disabled = true;
            playBtn.textContent = "Loading…";
            await ensureMixReady();
            if (destroyed) return;
            userPaused = false;
            await playAll();
            playBtn.textContent = "Pause";
          } catch (err) {
            userPaused = true;
            playBtn.textContent = "Play";
            console.warn(err);
          } finally {
            if (!destroyed) playBtn.disabled = false;
          }
        } else {
          userPaused = true;
          pauseAll();
          playBtn.textContent = "Play";
        }
      });

      const endScrub = () => {
        scrubbing = false;
        if (!userPaused) {
          if (isMixerMode() && mixerStemNames().length) {
            if (videoAvailable) video.play().catch(() => {});
            for (const audio of Object.values(stemPlayers)) {
              if (audio.paused) audio.play().catch(() => {});
            }
          } else if (audioAvailable && mixPlayer) {
            if (videoAvailable) video.play().catch(() => {});
            if (mixPlayer.paused) mixPlayer.play().catch(() => {});
          } else if (videoAvailable && video.paused) {
            video.play().catch(() => {});
          }
        }
      };

      function seekFromProgressClientX(clientX) {
        if (!progressHit) return;
        const d = mediaDuration();
        if (!d) return;
        const rect = progressHit.getBoundingClientRect();
        const w = Math.max(1, rect.width);
        const frac = Math.min(1, Math.max(0, (clientX - rect.left) / w));
        const t = frac * d;
        scrubbing = true;
        seekAll(t);
        overlayScrollSnap = true;
        paint();
      }

      function endProgressDrag() {
        if (!progressDragging) return;
        progressDragging = false;
        progressHit?.classList.remove("is-dragging");
        endScrub();
      }

      progressHit?.addEventListener("pointerdown", (event) => {
        if (event.button != null && event.button !== 0) return;
        event.preventDefault();
        progressDragging = true;
        progressHit.classList.add("is-dragging");
        progressHit.setPointerCapture?.(event.pointerId);
        seekFromProgressClientX(event.clientX);
      });
      progressHit?.addEventListener("pointermove", (event) => {
        if (!progressDragging) return;
        seekFromProgressClientX(event.clientX);
      });
      progressHit?.addEventListener("pointerup", endProgressDrag);
      progressHit?.addEventListener("pointercancel", endProgressDrag);
      progressHit?.addEventListener("keydown", (event) => {
        const d = mediaDuration();
        if (!d) return;
        const step = Math.max(1, d * 0.02);
        let next = null;
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = clockTime() - step;
        if (event.key === "ArrowRight" || event.key === "ArrowUp") next = clockTime() + step;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = d;
        if (next == null) return;
        event.preventDefault();
        seekAll(Math.min(d, Math.max(0, next)));
        overlayScrollSnap = true;
        paint();
      });

      alignBtn?.addEventListener("click", () => setAlignMode(!alignMode));
      markerBtn?.addEventListener("click", () => placeMarker());
      markerEndBtn?.addEventListener("click", () => placeMarkerEnd());
      cancelEditBtn?.addEventListener("click", () => {
        lyricsCues = savedLyricsCues.slice();
        chordsCues = savedChordsCues.slice();
        rebuildSyncLines();
        refreshVttValidation();
        setAlignMode(false);
        paint();
      });
      saveBtn?.addEventListener("click", async () => {
        applyCuesFromSyncLines();
        const validation = currentVttValidation();
        if (!validation.ok) {
          alert(`Cannot save timing — fix VTT errors first.\n\n${formatVttValidationAlert(validation)}`);
          return;
        }
        if (validation.warnings.length) {
          const proceed = window.confirm(
            `VTT has warnings. You can save, but Verify media will stay blocked until they are fixed.\n\n${formatVttValidationAlert(validation)}\n\nSave anyway?`
          );
          if (!proceed) return;
        }
        const lyricsContent = MediaAnalysis.cuesToVtt(lyricsCues);
        const chordsContent = MediaAnalysis.cuesToVtt(chordsCues);
        const [lyricsRes, chordsRes] = await Promise.all([
          fetch("/api/media/vtt", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: songPath, kind: "lyrics", content: lyricsContent }),
          }),
          fetch("/api/media/vtt", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: songPath, kind: "chords", content: chordsContent }),
          }),
        ]);
        const lyricsData = await lyricsRes.json().catch(() => ({}));
        const chordsData = await chordsRes.json().catch(() => ({}));
        if (!lyricsRes.ok || !chordsRes.ok) {
          alert(lyricsData.error || chordsData.error || "Save failed");
          return;
        }
        savedLyricsCues = lyricsCues.slice();
        savedChordsCues = chordsCues.slice();
        refreshVttValidation();
        setAlignMode(false);
        paint();
      });

      alignList?.addEventListener("click", (event) => {
        const revertBtn = event.target.closest(".media-align-revert[data-line-index]");
        if (revertBtn) {
          event.preventDefault();
          revertLyricEdit();
          return;
        }
        const saveLyricBtn = event.target.closest(".media-align-save-lyric[data-line-index]");
        if (saveLyricBtn) {
          event.preventDefault();
          saveLyricEdit();
          return;
        }
        if (event.target.closest(".media-align-lyric-input") || event.target.closest(".media-align-line.is-editing")) {
          return;
        }
        const endBtn = event.target.closest(".media-align-end[data-line-index]");
        if (endBtn) {
          event.preventDefault();
          stampChartLineEnd(Number(endBtn.dataset.lineIndex));
          return;
        }
        const startBtn = event.target.closest(".media-align-start[data-line-index]");
        if (startBtn) {
          event.preventDefault();
          stampChartLineStart(Number(startBtn.dataset.lineIndex));
          return;
        }
        const btn = event.target.closest(".media-align-line[data-line-index]");
        if (!btn || btn.classList.contains("is-editing")) return;
        selectAndSeekLine(Number(btn.dataset.lineIndex));
      });
      alignList?.addEventListener("dblclick", (event) => {
        if (event.target.closest(".media-align-assign")) return;
        if (event.target.closest(".media-align-lyric-input")) return;
        const btn = event.target.closest(".media-align-line[data-line-index]");
        if (!btn || btn.classList.contains("is-editing")) return;
        event.preventDefault();
        beginLyricEdit(Number(btn.dataset.lineIndex));
      });
      alignList?.addEventListener("keydown", (event) => {
        if (!event.target.classList?.contains("media-align-lyric-input")) return;
        if (event.key === "Enter") {
          event.preventDefault();
          saveLyricEdit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          revertLyricEdit();
        }
      });

      verifyBtn?.addEventListener("click", async () => {
        const validation = currentVttValidation();
        if (!validation.ok || validation.warnings.length) {
          alert(
            `Cannot verify media until VTT issues are fixed.\n\n${formatVttValidationAlert(validation, {
              forVerify: true,
            })}`
          );
          refreshVttValidation();
          return;
        }
        if (verifyBtn) verifyBtn.disabled = true;
        try {
          const res = await fetch("/api/media/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: songPath }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            alert(data.error || "Verify failed");
            refreshVttValidation();
            return;
          }
          if (typeof onVerified === "function") {
            await onVerified();
          } else {
            location.reload();
          }
        } finally {
          if (verifyBtn && !destroyed) refreshVttValidation();
        }
      });

      const exportStatusEl = container.querySelector("#media-export-status");

      function setToolbarExportStatus(job) {
        if (!exportStatusEl) return;
        if (!job || !job.status) {
          exportStatusEl.hidden = true;
          exportStatusEl.textContent = "";
          exportStatusEl.classList.remove("is-active", "is-done", "is-error");
          return;
        }
        const progress = Number(job.progress || 0);
        const msg = job.message || job.stage || job.status;
        exportStatusEl.hidden = false;
        exportStatusEl.classList.toggle("is-active", job.status === "queued" || job.status === "processing");
        exportStatusEl.classList.toggle("is-done", job.status === "completed");
        exportStatusEl.classList.toggle("is-error", job.status === "failed" || job.status === "cancelled");
        if (job.status === "completed") {
          exportStatusEl.textContent = "Export ready";
        } else if (job.status === "failed" || job.status === "cancelled") {
          exportStatusEl.textContent = job.error_message || msg || `Export ${job.status}`;
        } else {
          exportStatusEl.textContent = `Export ${progress}% — ${msg}`;
        }
      }

      async function refreshExportStatus({ preferQueue = false } = {}) {
        if (destroyed) return null;
        try {
          // Prefer exports/status.json via /api/media (works without pipeline).
          // Only hit /api/queue when actively tracking a live export — avoids
          // console 502 noise whenever media-pipeline is down.
          if (preferQueue) {
            const queueRes = await fetch("/api/queue?limit=50", { cache: "no-store" });
            const queueData = await queueRes.json().catch(() => ({}));
            if (queueRes.ok && Array.isArray(queueData.jobs)) {
              const active = queueData.jobs.find(
                (j) =>
                  j.job_type === "export_video" &&
                  j.song_path === songPath &&
                  (j.status === "queued" || j.status === "processing")
              );
              if (active) {
                setToolbarExportStatus(active);
                return active;
              }
              const recent = queueData.jobs.find(
                (j) => j.job_type === "export_video" && j.song_path === songPath
              );
              if (recent && (recent.status === "completed" || recent.status === "failed")) {
                setToolbarExportStatus(recent);
                return recent;
              }
            }
          }
          const res = await fetch(`/api/media?${new URLSearchParams({ path: songPath })}`, {
            cache: "no-store",
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) return null;
          const job = data.export
            ? {
                id: data.export.job_id,
                status: data.export.status,
                progress: data.export.progress,
                stage: data.export.stage,
                message: data.export.message,
                error_message: data.export.error_message,
                output_file: data.export.output_file,
              }
            : null;
          setToolbarExportStatus(job);
          return job;
        } catch {
          return null;
        }
      }

      function startExportStatusPolling() {
        if (exportPollTimer) return;
        exportPollTimer = setInterval(() => {
          refreshExportStatus({ preferQueue: true }).then((job) => {
            if (!job || (job.status !== "queued" && job.status !== "processing")) {
              if (exportPollTimer) {
                clearInterval(exportPollTimer);
                exportPollTimer = null;
              }
            }
          });
        }, 1000);
      }

      container.querySelector("#media-export")?.addEventListener("click", () => {
        openExportModal({
          songPath,
          title: title || "",
          artist: artist || "",
          chartBody: chartBodyText,
          getMixState: () => api.getMixState(),
          onJobUpdate(job) {
            setToolbarExportStatus(job);
            if (job && (job.status === "queued" || job.status === "processing")) {
              startExportStatusPolling();
            }
          },
        });
      });

      // Resume toolbar status if an export is already running.
      if (exportEnabled) {
        refreshExportStatus().then((job) => {
          if (job && (job.status === "queued" || job.status === "processing")) {
            startExportStatusPolling();
          }
        });
      }

      video.addEventListener("loadedmetadata", () => {
        if (video.duration && video.duration > duration) duration = video.duration;
        paint();
      });

      try {
        await loadAssets();
      } catch (err) {
        console.warn("Media assets incomplete", err);
      }
      if (destroyed) return api;
      ensureMixesProbed().catch(() => {});
      renderChartOverlay();
      updateChartOverlayVisibility();
      paint();
      emitSyncState();
      loop();

      api.isAlignMode = () => alignMode;
      api.placeMarker = placeMarker;
      api.placeMarkerEnd = placeMarkerEnd;
      api.selectAndSeekLine = selectAndSeekLine;
      api.editLyricLine = editLyricLine;
      api.setChartBody = (nextBody) => {
        const prev = syncLines.map((line) => ({
          start: line.start,
          end: line.end,
          lyric: line.lyric,
        }));
        chartBodyText = String(nextBody || "");
        rebuildSyncLines();
        // Keep existing markers when chart text is refreshed (e.g. lyric edit).
        syncLines = syncLines.map((line, i) => {
          const old = prev[i];
          if (!old) return line;
          if (Number.isFinite(old.start)) {
            return { ...line, start: old.start, end: old.end };
          }
          return line;
        });
        if (selectedLineIndex >= syncLines.length) {
          selectedLineIndex = syncLines.length ? syncLines.length - 1 : -1;
        }
        if (alignMode) renderAlignList();
        renderChartOverlay();
        updateChartOverlayVisibility();
        emitSyncState();
        paint();
      };
      return api;
    },
  };

  function fmt(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const RESOLUTIONS = {
    "1080p": { width: 1920, height: 1080, label: "1080p (1920×1080)" },
    "720p": { width: 1280, height: 720, label: "720p (1280×720)" },
    "480p": { width: 854, height: 480, label: "480p (854×480)" },
  };

  function apiErrorMessage(data, fallback) {
    if (!data || typeof data !== "object") return fallback;
    if (typeof data.error === "string") return data.error;
    if (data.error && typeof data.error.message === "string") return data.error.message;
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail) && data.detail.length) {
      return data.detail
        .map((item) => (typeof item === "string" ? item : item.msg || JSON.stringify(item)))
        .join("; ");
    }
    return fallback;
  }

  function openExportModal({ songPath, title, artist, chartBody, getMixState, onJobUpdate }) {
    document.getElementById("export-video-modal")?.remove();
    const state = typeof getMixState === "function" ? getMixState() : { mix: "original" };
    let selectedMix =
      state && typeof state.mix === "string" && MIX_MODES.some((m) => m.id === state.mix)
        ? state.mix
        : "original";

    const overlay = document.createElement("div");
    overlay.id = "export-video-modal";
    overlay.className = "modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "export-video-title");

    const mixButtons = MIX_MODES.map((mode) => {
      const active = mode.id === selectedMix;
      return `<button type="button" class="media-mix-btn${active ? " is-active" : ""}" data-mix="${escapeHtml(mode.id)}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(mode.label)}</button>`;
    }).join("");

    overlay.innerHTML = `
      <div class="modal-dialog export-modal-dialog">
        <h2 id="export-video-title" class="modal-title">Export video</h2>
        <p class="modal-message">Burn chord/lyric/drums overlays onto the source video and attach a stereo karaoke mix.</p>
        <div class="export-section">
          <div class="export-section-label">Karaoke mix</div>
          <div class="export-mix-list" role="group" aria-label="Karaoke mix">${mixButtons}</div>
        </div>
        <div class="export-options">
          <label class="export-field">
            <span>Resolution</span>
            <select id="export-resolution">
              ${Object.entries(RESOLUTIONS)
                .map(([key, val], i) => `<option value="${key}"${i === 0 ? " selected" : ""}>${escapeHtml(val.label)}</option>`)
                .join("")}
            </select>
          </label>
          <label class="export-field">
            <span>FPS</span>
            <select id="export-fps">
              <option value="source" selected>Source</option>
              <option value="24">24</option>
              <option value="30">30</option>
            </select>
          </label>
        </div>
        <div class="export-progress" id="export-progress" hidden>
          <div class="export-progress-meta">
            <span id="export-progress-label">Queued…</span>
            <span id="export-progress-pct">0%</span>
          </div>
          <div class="export-progress-track" aria-hidden="true">
            <div class="export-progress-fill" id="export-progress-fill" style="width:0%"></div>
          </div>
          <p class="export-progress-stage" id="export-progress-stage"></p>
        </div>
        <p class="export-error" id="export-error" hidden></p>
        <div class="modal-actions">
          <button type="button" class="modal-btn secondary" data-action="close">Close</button>
          <a class="modal-btn" id="export-download" hidden download>Download</a>
          <button type="button" class="modal-btn" data-action="start" id="export-start">Start export</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    let closed = false;
    let pollTimer = null;
    let polling = false;
    let jobId = null;

    function close() {
      if (closed) return;
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      overlay.remove();
    }

    function setError(msg) {
      const el = overlay.querySelector("#export-error");
      if (!el) return;
      if (!msg) {
        el.hidden = true;
        el.textContent = "";
        return;
      }
      el.hidden = false;
      el.textContent = msg;
    }

    function applyJobToUi(job) {
      if (!job) return;
      const progressEl = overlay.querySelector("#export-progress");
      if (progressEl) progressEl.hidden = false;
      const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
      const fill = overlay.querySelector("#export-progress-fill");
      const pct = overlay.querySelector("#export-progress-pct");
      const label = overlay.querySelector("#export-progress-label");
      const stage = overlay.querySelector("#export-progress-stage");
      if (fill) fill.style.width = `${progress}%`;
      if (pct) pct.textContent = `${progress}%`;
      if (label) {
        if (job.status === "queued") label.textContent = "Queued — waiting for worker…";
        else if (job.status === "processing") label.textContent = "Exporting…";
        else if (job.status === "completed") label.textContent = "Export ready";
        else label.textContent = job.status || "Working…";
      }
      if (stage) stage.textContent = job.message || job.stage || "";
      if (typeof onJobUpdate === "function") onJobUpdate(job);

      if (job.status === "completed" && job.output_file) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        const dl = overlay.querySelector("#export-download");
        const startBtn = overlay.querySelector("#export-start");
        if (dl) {
          const q = new URLSearchParams({ path: songPath, file: job.output_file });
          dl.href = `/api/media/file?${q.toString()}`;
          const base = (title || "export").replace(/[^\w\-]+/g, "_");
          dl.download = `${base}.mp4`;
          dl.hidden = false;
          dl.textContent = "Download";
        }
        if (startBtn) startBtn.hidden = true;
        return;
      }
      if (job.status === "failed" || job.status === "cancelled") {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        setError(job.error_message || job.message || `Export ${job.status}`);
        const startBtn = overlay.querySelector("#export-start");
        if (startBtn) {
          startBtn.disabled = false;
          startBtn.hidden = false;
          startBtn.textContent = "Retry";
        }
      }
    }

    function syncMixButtons() {
      overlay.querySelectorAll("[data-mix]").forEach((btn) => {
        const id = btn.getAttribute("data-mix");
        const active = id === selectedMix;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }

    overlay.querySelector(".export-mix-list")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-mix]");
      if (!btn || jobId) return;
      const id = btn.getAttribute("data-mix");
      if (!id || !MIX_MODES.some((m) => m.id === id)) return;
      selectedMix = id;
      syncMixButtons();
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.querySelector('[data-action="close"]')?.addEventListener("click", close);
    function onKey(event) {
      if (event.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        close();
      }
    }
    document.addEventListener("keydown", onKey);

    async function pollJob() {
      if (!jobId || closed || polling) return;
      polling = true;
      try {
        // Prefer queue job record; fall back to exports/status.json via /api/media.
        const res = await fetch(`/api/queue/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        let job = await res.json().catch(() => null);
        if (!res.ok || !job || !job.id) {
          const mediaRes = await fetch(`/api/media?${new URLSearchParams({ path: songPath })}`, {
            cache: "no-store",
          });
          const mediaData = await mediaRes.json().catch(() => ({}));
          if (mediaRes.ok && mediaData.export && mediaData.export.job_id === jobId) {
            job = {
              id: mediaData.export.job_id,
              status: mediaData.export.status,
              progress: mediaData.export.progress,
              stage: mediaData.export.stage,
              message: mediaData.export.message,
              error_message: mediaData.export.error_message,
              output_file: mediaData.export.output_file,
            };
          } else if (!res.ok) {
            setError(apiErrorMessage(job, `Poll failed (${res.status})`));
            return;
          }
        }
        applyJobToUi(job);
      } catch (err) {
        setError(err.message || String(err));
      } finally {
        polling = false;
      }
    }

    overlay.querySelector("#export-start")?.addEventListener("click", async () => {
      setError("");
      const startBtn = overlay.querySelector("#export-start");
      const progressEl = overlay.querySelector("#export-progress");
      const dl = overlay.querySelector("#export-download");
      if (dl) dl.hidden = true;
      const resKey = overlay.querySelector("#export-resolution")?.value || "1080p";
      const fpsKey = overlay.querySelector("#export-fps")?.value || "source";
      const res = RESOLUTIONS[resKey] || RESOLUTIONS["1080p"];
      const fps = fpsKey === "source" ? null : Number(fpsKey);
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.textContent = "Starting…";
      }
      if (progressEl) progressEl.hidden = false;
      applyJobToUi({ status: "queued", progress: 0, message: "Submitting export job…" });
      try {
        const resFetch = await fetch("/api/media/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            song_path: songPath,
            mix: selectedMix,
            width: res.width,
            height: res.height,
            fps,
            title: title || undefined,
            artist: artist || undefined,
            chart_body: chartBody || "",
          }),
        });
        const data = await resFetch.json().catch(() => ({}));
        if (!resFetch.ok) {
          throw new Error(apiErrorMessage(data, `Export failed (${resFetch.status})`));
        }
        jobId = data.id;
        if (startBtn) startBtn.textContent = "Exporting…";
        applyJobToUi(data);
        await pollJob();
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollJob, 750);
      } catch (err) {
        setError(err.message || String(err));
        if (startBtn) {
          startBtn.disabled = false;
          startBtn.textContent = "Start export";
        }
      }
    });

    syncMixButtons();
    overlay.querySelector("#export-start")?.focus();
  }
})();
