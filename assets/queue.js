(function () {
  const POLL_MS = 2000;
  const FETCH_MS = 8000;
  const STATUS_LABELS = {
    queued: "Queued",
    processing: "Processing",
    needs_review: "Needs review",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };

  window.MediaQueue = {
    render(root, { isAdmin }) {
      if (!root) return { destroy() {} };
      if (!isAdmin) {
        root.innerHTML = `<p class="error">Admin only.</p>`;
        return { destroy() {} };
      }

      let pollTimer = null;
      let paused = false;
      let destroyed = false;
      /** @type {AbortController | null} */
      let inflight = null;
      let refreshing = false;

      root.innerHTML = `
        <h1 class="hero-line">Job queue</h1>
        <p class="lede">Media pipeline jobs (process songs or export videos).</p>
        <div class="queue-controls">
          <span id="queue-paused-label" class="queue-paused-label" hidden>Paused</span>
          <div class="queue-controls-actions">
            <button type="button" class="secondary" id="queue-refresh">Refresh</button>
            <button type="button" class="secondary" id="queue-pause">Pause</button>
            <button type="button" class="secondary" id="queue-resume" hidden>Resume</button>
            <button type="button" class="secondary" id="queue-clear-complete">Clear complete</button>
            <button type="button" class="secondary" id="queue-clear">Clear</button>
          </div>
        </div>
        <p id="queue-empty" class="queue-empty" hidden>No jobs yet.</p>
        <ul id="queue-list" class="queue-list"></ul>
      `;

      const listEl = root.querySelector("#queue-list");
      const emptyEl = root.querySelector("#queue-empty");
      const pausedLabel = root.querySelector("#queue-paused-label");
      const pauseBtn = root.querySelector("#queue-pause");
      const resumeBtn = root.querySelector("#queue-resume");
      const refreshBtn = root.querySelector("#queue-refresh");

      function songHash(songPath) {
        // artists/a/albums/b/c.md → #/song/a/b/c
        const parts = String(songPath || "").replace(/^library\//, "").split("/");
        if (parts.length >= 5 && parts[0] === "artists" && parts[2] === "albums") {
          const artist = parts[1];
          const album = parts[3];
          const song = parts[4].replace(/\.md$/, "");
          return `#/song/${encodeURIComponent(artist)}/${encodeURIComponent(album)}/${encodeURIComponent(song)}`;
        }
        return "#/";
      }

      function setRefreshing(on) {
        refreshing = on;
        if (!refreshBtn) return;
        refreshBtn.disabled = on;
        refreshBtn.textContent = on ? "Refreshing…" : "Refresh";
      }

      function renderJobs(jobs) {
        if (!jobs.length) {
          emptyEl.hidden = false;
          emptyEl.textContent = "No jobs yet.";
          listEl.innerHTML = "";
          return;
        }
        emptyEl.hidden = true;
        listEl.innerHTML = jobs
          .map((job) => {
            const label = job.title || job.song_path || job.id;
            const status = STATUS_LABELS[job.status] || job.status;
            const href = songHash(job.song_path);
            const progress = Number(job.progress || 0);
            const kind = job.job_type === "export_video" ? "Export" : "Process";
            const msg = job.message || job.stage || "";
            const err = job.error_message ? `<div class="queue-item-error">${escapeHtml(job.error_message)}</div>` : "";
            const canCancel = job.status === "queued" || job.status === "processing";
            const needsReview = job.status === "needs_review";
            const statusEl = needsReview
              ? `<a class="queue-status queue-status-needs_review queue-status-link" href="${href}">${escapeHtml(status)}</a>`
              : `<span class="queue-status queue-status-${escapeHtml(job.status)}">${escapeHtml(status)}</span>`;
            const download =
              job.job_type === "export_video" && job.status === "completed" && job.output_file
                ? `<a class="secondary queue-download" href="/api/media/file?${new URLSearchParams({
                    path: job.song_path,
                    file: job.output_file,
                  }).toString()}" download>Download</a>`
                : "";
            const review =
              needsReview
                ? `<a class="secondary queue-review" href="${href}">Review song</a>`
                : "";
            return `
              <li class="queue-item" data-id="${escapeHtml(job.id)}">
                <div class="queue-item-top">
                  <a class="queue-item-label" href="${href}">${escapeHtml(label)}</a>
                  ${statusEl}
                </div>
                <div class="queue-item-meta">
                  <span class="queue-kind">${escapeHtml(kind)}</span>
                  <span>${escapeHtml(job.artist || "")}</span>
                  <span>${escapeHtml(msg)}</span>
                  ${job.queue_position ? `<span>#${job.queue_position}</span>` : ""}
                </div>
                <progress max="100" value="${progress}"></progress>
                ${err}
                <div class="queue-item-actions">
                  ${review}
                  ${download}
                  ${canCancel ? `<button type="button" class="secondary queue-cancel" data-id="${escapeHtml(job.id)}">Cancel</button>` : ""}
                </div>
              </li>`;
          })
          .join("");

        listEl.querySelectorAll(".queue-cancel").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-id");
            try {
              await fetch(`/api/queue/${encodeURIComponent(id)}`, { method: "DELETE" });
              refresh({ force: true });
            } catch {
              /* ignore */
            }
          });
        });
      }

      async function refresh({ force = false } = {}) {
        if (destroyed) return;
        if (refreshing && !force) return;
        if (inflight) {
          inflight.abort();
          inflight = null;
        }
        const ac = new AbortController();
        inflight = ac;
        const timer = setTimeout(() => ac.abort(), FETCH_MS);
        setRefreshing(true);
        try {
          const res = await fetch("/api/queue?limit=50", {
            cache: "no-store",
            signal: ac.signal,
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          if (destroyed || inflight !== ac) return;
          paused = Boolean(data.paused);
          pausedLabel.hidden = !paused;
          pauseBtn.hidden = paused;
          resumeBtn.hidden = !paused;
          renderJobs(data.jobs || []);
        } catch (err) {
          if (destroyed || inflight !== ac) return;
          // Superseded by a newer refresh — ignore abort from our own replacement.
          if (err && err.name === "AbortError" && inflight && inflight !== ac) return;
          if (err && err.name === "AbortError") {
            emptyEl.hidden = false;
            emptyEl.textContent = "Queue unavailable: request timed out";
            listEl.innerHTML = "";
            return;
          }
          emptyEl.hidden = false;
          emptyEl.textContent = `Queue unavailable: ${err.message || err}`;
          listEl.innerHTML = "";
        } finally {
          clearTimeout(timer);
          if (inflight === ac) {
            inflight = null;
            if (!destroyed) setRefreshing(false);
          }
        }
      }

      refreshBtn?.addEventListener("click", () => refresh({ force: true }));
      pauseBtn?.addEventListener("click", async () => {
        await fetch("/api/queue/pause", { method: "POST" });
        refresh({ force: true });
      });
      resumeBtn?.addEventListener("click", async () => {
        await fetch("/api/queue/resume", { method: "POST" });
        refresh({ force: true });
      });
      root.querySelector("#queue-clear-complete")?.addEventListener("click", async () => {
        try {
          await fetch("/api/queue/clear-complete", { method: "POST" });
          refresh({ force: true });
        } catch {
          /* ignore */
        }
      });
      root.querySelector("#queue-clear")?.addEventListener("click", async () => {
        if (!window.confirm("Clear the entire job queue? Active jobs will be cancelled.")) return;
        try {
          await fetch("/api/queue/clear", { method: "POST" });
          refresh({ force: true });
        } catch {
          /* ignore */
        }
      });

      refresh({ force: true });
      pollTimer = setInterval(() => refresh(), POLL_MS);

      return {
        destroy() {
          destroyed = true;
          if (pollTimer) clearInterval(pollTimer);
          if (inflight) inflight.abort();
          inflight = null;
        },
      };
    },
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
