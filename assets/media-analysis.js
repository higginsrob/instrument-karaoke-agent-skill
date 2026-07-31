(function () {
  const PLAYHEAD_RATIO = 0.35;
  const WINDOW_SECONDS = 8;
  const STEM_ORDER = ["drums"];
  const DRUM_LANES = ["crash", "hihat", "snare", "tom", "kick"];
  const DRUM_COLORS = {
    kick: "#c45c5c",
    tom: "#d4894a",
    snare: "#c9a227",
    hihat: "#3a9a7a",
    crash: "#4a8fc8",
  };

  function parseVtt(text) {
    const cues = [];
    const blocks = String(text || "").replace(/^\uFEFF/, "").split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split(/\n/).filter((l) => l.trim() !== "" && l.trim() !== "WEBVTT");
      if (!lines.length) continue;
      let timeLine = lines[0];
      let textLines = lines.slice(1);
      if (!timeLine.includes("-->") && lines[1] && lines[1].includes("-->")) {
        timeLine = lines[1];
        textLines = lines.slice(2);
      }
      if (!timeLine.includes("-->")) continue;
      const [startRaw, endRaw] = timeLine.split("-->").map((s) => s.trim().split(/\s+/)[0]);
      const start = parseVttTime(startRaw);
      const end = parseVttTime(endRaw);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      cues.push({ start, end, text: textLines.join(" ").trim() });
    }
    return cues;
  }

  function sortCuesByStart(cues) {
    return (cues || [])
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function parseVttTime(value) {
    const parts = String(value || "").split(":");
    if (parts.length === 3) {
      return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    }
    if (parts.length === 2) {
      return Number(parts[0]) * 60 + Number(parts[1]);
    }
    return Number(value);
  }

  function formatVttTime(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
  }

  function cuesToVtt(cues) {
    const lines = ["WEBVTT", ""];
    cues.forEach((cue, i) => {
      lines.push(String(i + 1));
      lines.push(`${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}`);
      lines.push(cue.text || "");
      lines.push("");
    });
    return lines.join("\n");
  }

  function computeViewport(currentTime, duration) {
    const half = WINDOW_SECONDS * PLAYHEAD_RATIO;
    const t = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
    const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
    // Keep `t` under the fixed playhead from the first frame. Allow a negative
    // window start so early beats sit to the right of the playhead instead of
    // waiting ~half a window for the scroll to "catch up".
    let start = t - half;
    let end = start + WINDOW_SECONDS;
    if (dur && dur > WINDOW_SECONDS && end > dur) {
      end = dur;
      start = end - WINDOW_SECONDS;
    }
    return { start, end, playheadRatio: PLAYHEAD_RATIO };
  }

  function timeToX(time, viewport, width) {
    const span = Math.max(0.001, viewport.end - viewport.start);
    return ((time - viewport.start) / span) * width;
  }

  function parseChordCue(cue) {
    const raw = String(cue?.text || "").trim();
    const match = raw.match(/^(.*)\|(\d+)$/);
    if (match) {
      return { name: match[1].trim(), column: Number(match[2]), start: cue.start, end: cue.end };
    }
    return { name: raw, column: null, start: cue.start, end: cue.end };
  }

  function chordsForLyric(seg, chordsCues, nextCueStart) {
    const start = seg.cue.start;
    // Include chords through the gap until the next lyric starts so trailing
    // post-lyric chords stay attached to this line's sheet.
    const end = Number.isFinite(nextCueStart) ? nextCueStart : seg.cue.end;
    return (chordsCues || [])
      .map(parseChordCue)
      .filter((c) => c.name && Number.isFinite(c.start) && c.start >= start - 0.001 && c.start < end - 0.001)
      .sort((a, b) => a.start - b.start);
  }

  function buildLyricSegments(ctx, cues, font, chordsCues) {
    ctx.font = font;
    const gap = "   ";
    const gapW = ctx.measureText(gap).width;
    const spaceW = ctx.measureText(" ").width;
    const segments = [];
    let cursor = 0;
    // Chronological order is required: next lyric start bounds chord attachment.
    const ordered = sortCuesByStart(cues);
    ordered.forEach((cue, index) => {
      const text = String(cue.text || "").replace(/\n+/g, " ").trim();
      if (!text) return;
      if (segments.length) cursor += gapW;
      const nextCue = ordered[index + 1];
      const lineChords = chordsForLyric({ cue }, chordsCues, nextCue?.start);
      const maxCol = Math.max(
        text.length,
        ...lineChords.map((c) => (Number.isFinite(c.column) ? c.column + c.name.length : 0)),
        0
      );
      const textWidth = ctx.measureText(text).width;
      const sheetWidth = Math.max(textWidth, maxCol * spaceW);
      segments.push({
        cue,
        index,
        text,
        textStartPx: cursor,
        textWidth,
        sheetWidth,
        spaceW,
        gapW,
        lineChords,
        nextStart: Number.isFinite(nextCue?.start) ? nextCue.start : null,
      });
      cursor += sheetWidth;
    });
    return segments;
  }

  /** Calm scroll rate so upcoming lines ease toward the playhead before they start. */
  function karaokeApproachPps(seg) {
    const dur = Math.max(0.8, (seg.cue.end || 0) - (seg.cue.start || 0));
    // Approach uses lyric width — trailing chords scroll in the post-lyric gap.
    const width = Math.max(seg.textWidth || 0, 1);
    return Math.max(28, Math.min(90, width / dur));
  }

  function karaokeSingPx(segments, currentTime) {
    if (!segments.length) return 0;
    const first = segments[0];
    // Before the first lyric: keep it to the right of the playhead and let it
    // drift in, instead of parking on the needle for the whole intro.
    if (currentTime < first.cue.start) {
      const pps = karaokeApproachPps(first);
      return first.textStartPx - (first.cue.start - currentTime) * pps;
    }
    const last = segments[segments.length - 1];
    const lastSheet = Math.max(last.sheetWidth || 0, last.textWidth || 0);
    const lastHang = Number.isFinite(last.nextStart) ? last.nextStart : last.cue.end;
    if (currentTime >= lastHang) {
      return last.textStartPx + lastSheet;
    }
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const textW = Math.max(seg.textWidth || 0, 0);
      const sheetW = Math.max(seg.sheetWidth || 0, textW);
      const trailW = Math.max(0, sheetW - textW);
      const next = segments[i + 1];

      // Singing: with an explicit post-lyric gap, scroll lyric text only;
      // otherwise keep legacy full-sheet scroll (trailing chords in-window).
      if (currentTime >= seg.cue.start && currentTime < seg.cue.end) {
        const hasGap = next && next.cue.start > seg.cue.end + 0.001;
        const scrollW = hasGap ? textW : sheetW;
        const p = (currentTime - seg.cue.start) / Math.max(0.05, seg.cue.end - seg.cue.start);
        return seg.textStartPx + p * scrollW;
      }

      // After lyric end: scroll trailing chords in the gap, then ease into next.
      if (next && currentTime >= seg.cue.end && currentTime < next.cue.start) {
        const textEndPx = seg.textStartPx + textW;
        const sheetEndPx = seg.textStartPx + sheetW;
        const arrivePx = next.textStartPx;
        const gapDur = Math.max(0.05, next.cue.start - seg.cue.end);
        const pps = karaokeApproachPps(next);
        const approachPx = Math.max(0, arrivePx - sheetEndPx);
        const approachSec = approachPx / Math.max(1, pps);

        if (trailW > 0) {
          const trailSec = Math.max(0.05, gapDur - approachSec);
          const trailElapsed = currentTime - seg.cue.end;
          if (trailElapsed < trailSec) {
            return textEndPx + (trailElapsed / trailSec) * trailW;
          }
        }

        const timeToNext = next.cue.start - currentTime;
        if (timeToNext > approachSec) return sheetEndPx;
        return arrivePx - timeToNext * pps;
      }

      // Last line trailing / hang after its lyric end.
      if (!next && currentTime >= seg.cue.end) {
        if (trailW > 0) {
          const hang = 1.5;
          const trailElapsed = currentTime - seg.cue.end;
          const p = Math.min(1, trailElapsed / hang);
          return seg.textStartPx + textW + p * trailW;
        }
        return seg.textStartPx + sheetW;
      }
    }
    return 0;
  }

  function drawLyricChordBand(ctx, lyricsCues, chordsCues, currentTime, x, yChord, hChord, yLyric, hLyric, w) {
    // Same monospace face for chords + lyrics so columns match UG charts.
    const fontSize = Math.max(13, Math.floor(hLyric * 0.4));
    const bandFont = `600 ${fontSize}px "IBM Plex Mono", ui-monospace, monospace`;
    const segments = buildLyricSegments(ctx, lyricsCues, bandFont, chordsCues);
    if (!segments.length) return;

    const playheadX = x + w * PLAYHEAD_RATIO;
    const originX = playheadX - karaokeSingPx(segments, currentTime);
    // Index into sorted segments (not raw cue array order).
    const activeLyric = segments.findIndex(
      (seg) => currentTime >= seg.cue.start && currentTime < seg.cue.end
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, yChord, w, hChord + (yLyric - yChord) + hLyric);
    ctx.clip();
    ctx.font = bandFont;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    segments.forEach((seg) => {
      const baseX = originX + seg.textStartPx;
      const lyricActive = seg.index === activeLyric;
      const lineUntil = Number.isFinite(seg.nextStart) ? seg.nextStart : seg.cue.end;
      const lineActive = currentTime >= seg.cue.start && currentTime < lineUntil;

      seg.lineChords.forEach((chord) => {
        const col = Number.isFinite(chord.column) ? chord.column : 0;
        // Character-column offset in the same monospace metrics as the lyric.
        const px = baseX + col * seg.spaceW;
        if (px < x - 40 || px > x + w + 40) return;
        // Chords highlight on their own times (including post-lyric trailing).
        const isActive =
          lineActive && currentTime >= chord.start && currentTime < (chord.end || chord.start + 0.05);
        ctx.fillStyle = isActive ? "#ffffff" : "rgba(245, 240, 230, 0.7)";
        if (isActive) {
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.lineWidth = 1.4;
          ctx.strokeText(chord.name, px, yChord + hChord / 2);
        }
        ctx.fillText(chord.name, px, yChord + hChord / 2);
      });

      ctx.fillStyle = lyricActive ? "#ffffff" : "rgba(245, 240, 230, 0.55)";
      if (lyricActive) {
        ctx.lineWidth = Math.max(1, fontSize * 0.1);
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.strokeText(seg.text, baseX, yLyric + hLyric / 2);
      }
      ctx.fillText(seg.text, baseX, yLyric + hLyric / 2);
    });
    ctx.restore();
  }

  function drawDrums(ctx, beats, viewport, x, y, w, h) {
    const onsets = beats?.onsets || [];
    const laneH = h / DRUM_LANES.length;
    ctx.save();
    ctx.fillStyle = "rgba(20, 24, 28, 0.35)";
    ctx.fillRect(x, y, w, h);
    DRUM_LANES.forEach((lane, i) => {
      const ly = y + i * laneH;
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(x, ly, w, laneH - 1);
      ctx.fillStyle = "rgba(245,240,230,0.35)";
      ctx.font = `500 ${Math.max(9, Math.floor(laneH * 0.45))}px "DM Sans", sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(lane, x + 6, ly + laneH / 2);
    });
    onsets.forEach((onset) => {
      const t = Number(onset.time);
      if (t < viewport.start || t > viewport.end) return;
      const lane = onset.instrument;
      const idx = DRUM_LANES.indexOf(lane);
      if (idx < 0) return;
      const px = x + timeToX(t, viewport, w);
      const ly = y + idx * laneH;
      const strength = Math.max(0.25, Math.min(1, Number(onset.strength) || 0.6));
      ctx.fillStyle = DRUM_COLORS[lane] || "#888";
      ctx.globalAlpha = 0.55 + strength * 0.45;
      ctx.fillRect(px - 1.5, ly + 2, 3, laneH - 4);
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  }

  function drawPlayhead(ctx, x, y, w, h) {
    const px = x + w * PLAYHEAD_RATIO;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, y);
    ctx.lineTo(px, y + h);
    ctx.stroke();
  }

  /** Thin scrubbable progress strip flush to the canvas bottom edge. */
  const PROGRESS_BAR_H = 5;

  function drawProgressBar(ctx, currentTime, duration, cssW, cssH) {
    const h = PROGRESS_BAR_H;
    const y = cssH - h;
    const d = Math.max(0, Number(duration) || 0);
    const t = Math.max(0, Number(currentTime) || 0);
    const frac = d > 0 ? Math.min(1, t / d) : 0;

    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.fillRect(0, y, cssW, h);
    if (frac > 0) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.fillRect(0, y, cssW * frac, h);
    }
    // Soft top edge so it reads as a timeline, not a hard crop.
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.fillRect(0, y, cssW, 1);
  }

  function smoothstep01(t) {
    const x = Math.min(1, Math.max(0, Number(t) || 0));
    return x * x * (3 - 2 * x);
  }

  function syncLineWindowEnd(lines, index) {
    const line = lines[index];
    if (!line || !Number.isFinite(line.start)) return null;
    for (let j = index + 1; j < lines.length; j += 1) {
      if (Number.isFinite(lines[j].start)) return lines[j].start;
    }
    return Number.isFinite(line.end) ? line.end : line.start + 3;
  }

  function formatSyncChordLine(line) {
    const chords = (line?.chords || []).filter((c) => c?.name);
    if (!chords.length) return "";
    const lyricLen = String(line.lyric || "").length;
    const maxCol = Math.max(
      lyricLen,
      ...chords.map((c) => (Number.isFinite(c.column) ? c.column + String(c.name).length : String(c.name).length)),
      1
    );
    const chars = Array(maxCol).fill(" ");
    chords.forEach((chord) => {
      const col = Number.isFinite(chord.column) ? Math.max(0, chord.column) : 0;
      const name = String(chord.name);
      for (let i = 0; i < name.length && col + i < chars.length; i += 1) {
        chars[col + i] = name[i];
      }
    });
    const placed = chars.join("").replace(/\s+$/g, "");
    return placed || chords.map((c) => c.name).join(" ");
  }

  /** Hit targets for the last drawn chart scroll (CSS pixels). */
  let lastChartHitRegions = [];

  function pointInRect(rect, px, py) {
    return rect && px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
  }

  /**
   * Map a canvas CSS-space point to a sync-line index when it lands on
   * drawn chord or lyric text. Returns -1 when nothing is hit.
   */
  function hitTestChartAt(cssX, cssY) {
    const x = Number(cssX);
    const y = Number(cssY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    for (let i = lastChartHitRegions.length - 1; i >= 0; i -= 1) {
      const region = lastChartHitRegions[i];
      if (pointInRect(region.chord, x, y) || pointInRect(region.lyric, x, y)) {
        return region.index;
      }
    }
    return -1;
  }

  /**
   * Vertical chart scroll: playing line stays centered in the available band,
   * easing toward the next line over the current line's duration.
   * In align mode, focus follows the selected line and stamps are marked.
   */
  function drawChartScroll(ctx, lines, currentTime, x, y, w, h, opts = {}) {
    lastChartHitRegions = [];
    const list = lines || [];
    const editMode = Boolean(opts.editMode);
    const selectedIndex = Number.isInteger(opts.selectedIndex) ? opts.selectedIndex : -1;
    const showChords =
      opts.showChords != null
        ? Boolean(opts.showChords)
        : !document.documentElement.classList.contains("chords-hidden");
    const chordH = Math.max(16, Math.min(26, Math.floor(h * 0.045)));
    const lyricH = Math.max(18, Math.min(30, Math.floor(h * 0.055)));
    const pairGap = 2;
    const blockGap = Math.max(8, Math.floor(h * 0.018));
    const fontChord = `700 ${chordH * 0.72}px "IBM Plex Mono", ui-monospace, monospace`;
    const fontLyric = `500 ${lyricH * 0.7}px "IBM Plex Mono", ui-monospace, monospace`;

    const rows = [];
    list.forEach((line, i) => {
      const chordText = showChords ? formatSyncChordLine(line) : "";
      const lyricText = String(line.lyric || "");
      if (!chordText && !lyricText) return;
      const inner = (chordText ? chordH : 0) + (lyricText ? lyricH : 0) + (chordText && lyricText ? pairGap : 0);
      const blockH = inner + blockGap;
      rows.push({
        index: i,
        chordText,
        lyricText,
        blockH,
        innerH: inner,
        start: line.start,
        stamped: Number.isFinite(line.start),
        ended: Number.isFinite(line.end),
      });
    });
    if (!rows.length) return;

    let acc = 0;
    rows.forEach((row) => {
      row.top = acc;
      row.mid = acc + row.innerH / 2;
      acc += row.blockH;
    });

    const playing = playingSyncLineIndex(list, currentTime);
    let focusIndex = playing;
    // Align: keep the selected row in view when it isn't the playing line yet.
    if (editMode && selectedIndex >= 0 && (playing < 0 || selectedIndex !== playing)) {
      focusIndex = selectedIndex;
    }
    let rowIdx = rows.findIndex((r) => r.index === focusIndex);
    if (rowIdx < 0) {
      // Before first stamp / after end: park at first or last timed row.
      const t = Number(currentTime) || 0;
      let fallback = 0;
      for (let i = 0; i < rows.length; i += 1) {
        if (Number.isFinite(list[rows[i].index]?.start) && t >= list[rows[i].index].start) {
          fallback = i;
        }
      }
      rowIdx = fallback;
    }

    const row0 = rows[rowIdx];
    const row1 = rows[rowIdx + 1] || null;
    let frac = 0;
    // Only ease toward the next line while tracking the playing window.
    if (!editMode || focusIndex === playing) {
      if (row0 && row1 && Number.isFinite(row0.start)) {
        const end = syncLineWindowEnd(list, row0.index);
        if (Number.isFinite(end) && end > row0.start) {
          frac = smoothstep01((currentTime - row0.start) / (end - row0.start));
        }
      }
    }
    const focusMid = row1 && frac > 0 ? row0.mid + (row1.mid - row0.mid) * frac : row0.mid;
    const scroll = focusMid - h / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, "rgba(10, 12, 14, 0.72)");
    grad.addColorStop(0.7, "rgba(10, 12, 14, 0.55)");
    grad.addColorStop(1, "rgba(10, 12, 14, 0.22)");
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);

    const padX = 10;
    rows.forEach((row) => {
      const drawTop = y + row.top - scroll;
      if (drawTop + row.blockH < y - 4 || drawTop > y + h + 4) return;
      const isPlaying = row.index === playing;
      const isSelected = editMode && row.index === selectedIndex;
      if (isPlaying) {
        ctx.fillStyle = "rgba(201, 162, 39, 0.22)";
        ctx.fillRect(x + 2, drawTop - 2, w - 4, row.innerH + 4);
        ctx.fillStyle = "rgba(240, 211, 106, 0.95)";
        ctx.fillRect(x + 2, drawTop - 2, 3, row.innerH + 4);
      } else if (isSelected) {
        ctx.fillStyle = "rgba(74, 143, 200, 0.2)";
        ctx.fillRect(x + 2, drawTop - 2, w - 4, row.innerH + 4);
        ctx.fillStyle = "rgba(120, 180, 230, 0.95)";
        ctx.fillRect(x + 2, drawTop - 2, 3, row.innerH + 4);
      } else if (editMode && !row.stamped) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
        ctx.fillRect(x + 2, drawTop - 2, w - 4, row.innerH + 4);
      }
      let ty = drawTop;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      const dimUnstamped = editMode && !row.stamped && !isSelected;
      const hit = { index: row.index, chord: null, lyric: null };
      if (row.chordText) {
        ctx.font = fontChord;
        ctx.fillStyle = dimUnstamped ? "rgba(240, 211, 106, 0.45)" : "#f0d36a";
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = 2;
        ctx.fillText(row.chordText, x + padX, ty);
        ctx.shadowBlur = 0;
        const chordW = Math.ceil(ctx.measureText(row.chordText).width);
        hit.chord = { x: x + padX, y: ty, w: Math.max(chordW, 12), h: chordH };
        ty += chordH + (row.lyricText ? pairGap : 0);
      }
      if (row.lyricText) {
        ctx.font = fontLyric;
        ctx.fillStyle = isPlaying
          ? "rgba(255,255,255,0.95)"
          : isSelected
            ? "rgba(255,255,255,0.92)"
            : dimUnstamped
              ? "rgba(245,245,242,0.45)"
              : "rgba(245,245,242,0.82)";
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = 2;
        ctx.fillText(row.lyricText, x + padX, ty);
        ctx.shadowBlur = 0;
        const lyricW = Math.ceil(ctx.measureText(row.lyricText).width);
        hit.lyric = { x: x + padX, y: ty, w: Math.max(lyricW, 12), h: lyricH };
      }
      if (hit.chord || hit.lyric) lastChartHitRegions.push(hit);
      if (editMode) {
        ctx.font = `600 ${Math.max(10, Math.floor(lyricH * 0.45))}px "IBM Plex Mono", ui-monospace, monospace`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        const mark = row.ended ? "●" : row.stamped ? "◐" : "○";
        ctx.fillStyle = row.ended
          ? "rgba(42, 154, 106, 0.9)"
          : row.stamped
            ? "rgba(240, 211, 106, 0.85)"
            : "rgba(255,255,255,0.35)";
        ctx.fillText(mark, x + w - 10, drawTop + row.innerH / 2);
        ctx.textAlign = "left";
      }
    });
    ctx.restore();
  }

  function drawFrame(canvas, state) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const duration = state.duration || 0;
    const currentTime = state.currentTime || 0;
    const viewport = computeViewport(currentTime, duration);

    // Chords-and-lyrics chart scroll; drums band is optional (user toggle / no track).
    const pad = 8;
    const rowGap = 4;
    const progressH = PROGRESS_BAR_H;
    const usableH = cssH - progressH;
    const showDrums = state.showDrums !== false;
    const drumsH = showDrums ? 90 : 0;
    const x = pad;
    const w = cssW - pad * 2;

    const chartTop = pad;
    const chartH = Math.max(80, usableH - pad - (showDrums ? drumsH + rowGap : 0));
    drawChartScroll(ctx, state.syncLines || [], currentTime, x, chartTop, w, chartH, {
      editMode: Boolean(state.editMode),
      selectedIndex: state.selectedLineIndex,
    });

    if (showDrums) {
      const drumsY = chartTop + chartH + rowGap;
      // Keep drum MIDI at full opacity even when audio omits drums (visual guide).
      drawDrums(ctx, state.drumsBeats, viewport, x, drumsY, w, drumsH);
      drawPlayhead(ctx, pad, drumsY, w, drumsH);
    }

    drawProgressBar(ctx, currentTime, duration, cssW, cssH);
  }

  const CHART_CHORD_RE =
    /\b([A-G](?:#|b)?(?:(?:maj|min|dim|aug|sus|add|M|m)?[0-9]*(?:[#b][0-9]+)?){0,3}(?:\([#b0-9]+\))?(?:\/[A-G](?:#|b)?)?)(?!\w)/g;
  const CHART_SECTION_BRACKET_RE = /^\[([^\]]+)\](?:\s+.*)?$/;
  const CHART_SECTION_LOOSE_RE =
    /^(intro|verse|chorus|bridge|outro|solo|instrumental|interlude|pre-?chorus|break|coda|ending|hook|refrain)(\s+\d+)?(\s*[:.\-]?\s*\d*x?)?$/i;
  const CHART_SECTION_WORD_RE =
    /(intro|verse|chorus|bridge|outro|solo|instrumental|interlude|pre-?chorus|break|coda|ending|hook|refrain)/i;
  const CHART_URL_RE = /https?:\/\/\S+/i;
  const CHART_TAB_STRING_RE = /^(?:[eE]b?|[bB]b?|[gG]b?|[dD]b?|[aA]b?)\s*\|/;
  const CHART_REPEAT_RE = /\(?\s*x\d+\s*\)?/gi;
  const CHART_PERFORMANCE_PAREN_RE =
    /\((?:[^)]*\b(?:fade|repeat|barre|until|times?|continue|hold|palm\s*mute|n\.?c\.?|no\s*chord|x\d+)[^)]*)\)/gi;
  const CHART_TRAILING_REPEAT_X_RE = /\s+x\d+\s*$/i;
  const CHART_META_LINE_RE =
    /^(?:please\s+rate\b.*|tabbed\s+by\b.*|chords?\s+used\b.*|(?:capo|tuning|key)\s*[:].*|capo\s+[ivxlcd\d]+\b.*|play\s+over\b.*|then\s+repeat\b.*|repeat\s+(?:verse|chorus|bridge|outro|intro|and)\b.*|riff\s*x?\d*\b.*|n\.?c\.?\s*$|this\s+tab\b.*|i\s+tabbed\b.*)$/i;
  const CHART_ADLIB_PAREN_RE =
    /^\((?:(?:ooh+|oh+|ah+|hey+|yeah+|woo+|whoa+|mm+|uh[\s\-]?huh|ha+)(?:[\s,/]+(?:ooh+|oh+|ah+|hey+|yeah+|woo+|whoa+|mm+|uh[\s\-]?huh|ha+))*)\)$/i;
  const CHART_FRET_SHAPE_RE = /^[xX0-9]{4,8}$/;

  function isChartSectionMarker(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return false;
    const bracket = trimmed.match(CHART_SECTION_BRACKET_RE);
    if (bracket) {
      const inner = bracket[1].trim();
      if (CHART_SECTION_LOOSE_RE.test(inner) || CHART_SECTION_WORD_RE.test(inner)) return true;
      return inner.length > 0 && inner.length <= 40;
    }
    return CHART_SECTION_LOOSE_RE.test(trimmed);
  }

  function isChartUrlLine(line) {
    const stripped = String(line || "").trim();
    if (!stripped) return false;
    if (CHART_URL_RE.test(stripped) && stripped.replace(CHART_URL_RE, "").replace(/[ ()[\]]/g, "") === "") {
      return true;
    }
    return /^https?:\/\/\S+$/i.test(stripped);
  }

  function isChartTabLine(line) {
    const stripped = String(line || "").trim();
    if (!stripped) return false;
    if (CHART_TAB_STRING_RE.test(stripped)) return true;
    const pipeCount = (stripped.match(/\|/g) || []).length;
    if (pipeCount >= 2) {
      CHART_CHORD_RE.lastIndex = 0;
      const hasChord = CHART_CHORD_RE.test(stripped);
      CHART_CHORD_RE.lastIndex = 0;
      if (hasChord && !/[-]{3,}|\d[-|]|[|-]\d/.test(stripped)) return false;
      const tabish = (stripped.match(/[-|0-9hpxHPX/~]/g) || []).length;
      if (tabish >= Math.max(8, Math.floor(0.5 * stripped.length))) return true;
      let rest = stripped.replace(/[|\-\s0-9hpxHPX/~.=]+/gi, "");
      rest = rest.replace(CHART_REPEAT_RE, "").trim();
      if (rest.length <= 2) return true;
    }
    return false;
  }

  function isChartFretDiagramLine(line) {
    const stripped = String(line || "")
      .trim()
      .replace(/[,;]+$/, "");
    if (!stripped) return false;
    const tokens = stripped
      .split(/\s+/)
      .map((t) => t.replace(/[,;]+$/g, ""))
      .filter(Boolean);
    return tokens.length > 0 && tokens.every((t) => CHART_FRET_SHAPE_RE.test(t));
  }

  function isChartParentheticalNote(line) {
    const stripped = String(line || "").trim();
    if (!(stripped.startsWith("(") && stripped.endsWith(")") && stripped.length >= 3)) {
      return false;
    }
    if (CHART_ADLIB_PAREN_RE.test(stripped)) return false;
    return true;
  }

  function isChartMetaLine(line) {
    const stripped = String(line || "").trim();
    if (!stripped) return false;
    if (CHART_META_LINE_RE.test(stripped)) return true;
    if (isChartParentheticalNote(stripped)) return true;
    if (isChartFretDiagramLine(stripped)) return true;
    if (/\b(?:standard\s+tuning|re-?tuning|barre\s+chord|this\s+version)\b/i.test(stripped)) {
      return true;
    }
    if (/\bplease\s+rate\b/i.test(stripped)) return true;
    if (/\btab\b/i.test(stripped) && stripped.length < 80 && !/\b(?:table|tablet|taboo)\b/i.test(stripped)) {
      return true;
    }
    return false;
  }

  function isChartChordOnlyLine(line) {
    const stripped = String(line || "").trim();
    if (
      !stripped ||
      isChartSectionMarker(stripped) ||
      isChartUrlLine(stripped) ||
      isChartTabLine(line) ||
      isChartMetaLine(stripped)
    ) {
      return false;
    }
    CHART_CHORD_RE.lastIndex = 0;
    let remainder = stripped.replace(CHART_CHORD_RE, "");
    CHART_CHORD_RE.lastIndex = 0;
    remainder = remainder.replace(CHART_REPEAT_RE, "");
    remainder = remainder.replace(CHART_PERFORMANCE_PAREN_RE, "");
    remainder = remainder.replace(/[\s|/.\-#(),]+/g, "");
    if (remainder) return false;
    CHART_CHORD_RE.lastIndex = 0;
    return CHART_CHORD_RE.test(stripped);
  }

  function extractChartChordTokens(line) {
    const tokens = [];
    CHART_CHORD_RE.lastIndex = 0;
    let match;
    while ((match = CHART_CHORD_RE.exec(line)) !== null) {
      tokens.push({ name: match[1], column: match.index });
    }
    CHART_CHORD_RE.lastIndex = 0;
    return tokens;
  }

  function normalizeChartLyric(text) {
    let out = String(text || "").replace(CHART_URL_RE, "");
    out = out.replace(CHART_PERFORMANCE_PAREN_RE, "");
    out = out.replace(CHART_TRAILING_REPEAT_X_RE, "");
    out = out.replace(/\s+/g, " ").replace(/^[\s|\-]+|[\s|\-]+$/g, "");
    return out.trim();
  }

  function looksLikeChartLyricCore(lyric) {
    if (!lyric) return false;
    const words = lyric.match(/[A-Za-z']{2,}/g) || [];
    if (!words.length) return false;
    const letters = [...lyric].filter((ch) => /[A-Za-z]/.test(ch)).length;
    if (letters < 3) return false;
    const glyphs = [...lyric].filter((ch) => "|-_=+".includes(ch)).length;
    if (glyphs >= Math.max(3, letters)) return false;
    return true;
  }

  function looksLikeChartLyric(text) {
    const lyric = normalizeChartLyric(text);
    if (!lyric || isChartSectionMarker(lyric) || isChartUrlLine(lyric) || isChartTabLine(lyric)) {
      return false;
    }
    if (isChartMetaLine(lyric) || isChartFretDiagramLine(lyric) || isChartParentheticalNote(lyric)) {
      return false;
    }
    return looksLikeChartLyricCore(lyric);
  }

  function stripChartPreamble(lines) {
    for (let i = 0; i < lines.length; i += 1) {
      if (isChartSectionMarker(lines[i].trim())) return lines.slice(i);
    }
    return lines;
  }

  /**
   * Walk a UG-style chart into display units. Sync `group` units share indices with
   * extractChartGroups / karaoke line stamps.
   */
  function chartDisplayUnits(chartBody) {
    const raw = String(chartBody || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const preambleLen = raw.length - stripChartPreamble(raw).length;
    const units = [];
    // Emit preamble lines that were stripped so the chart still looks complete.
    for (let i = 0; i < preambleLen; i += 1) {
      const line = raw[i];
      if (!line.trim()) units.push({ type: "blank", sourceIndex: i });
      else units.push({ type: "raw", text: line, sourceIndex: i });
    }

    let pendingChords = null;
    let pendingChordLine = null;
    let pendingChordSourceIndex = null;
    let currentSection = null;
    let groupIndex = 0;

    function flushPending() {
      if (!pendingChords) return;
      units.push({
        type: "group",
        index: groupIndex,
        chordLine: pendingChordLine,
        lyricLine: null,
        chordSourceIndex: pendingChordSourceIndex,
        lyricSourceIndex: null,
        group: { lyric: "", chords: pendingChords, section: currentSection },
      });
      groupIndex += 1;
      pendingChords = null;
      pendingChordLine = null;
      pendingChordSourceIndex = null;
    }

    for (let li = preambleLen; li < raw.length; li += 1) {
      const line = raw[li];
      const stripped = line.trim();
      if (!stripped) {
        flushPending();
        units.push({ type: "blank", sourceIndex: li });
        continue;
      }
      if (isChartSectionMarker(stripped)) {
        flushPending();
        currentSection = stripped;
        units.push({ type: "section", text: line, sourceIndex: li });
        continue;
      }
      if (
        isChartUrlLine(stripped) ||
        isChartTabLine(line) ||
        isChartMetaLine(stripped) ||
        isChartFretDiagramLine(stripped)
      ) {
        flushPending();
        units.push({ type: "raw", text: line, sourceIndex: li });
        continue;
      }
      if (isChartChordOnlyLine(line)) {
        flushPending();
        pendingChords = extractChartChordTokens(line);
        pendingChordLine = line;
        pendingChordSourceIndex = li;
        continue;
      }
      const chords = pendingChords || extractChartChordTokens(line);
      let lyric;
      if (pendingChords) {
        lyric = normalizeChartLyric(stripped);
      } else {
        CHART_CHORD_RE.lastIndex = 0;
        lyric = normalizeChartLyric(line.replace(CHART_CHORD_RE, ""));
        CHART_CHORD_RE.lastIndex = 0;
      }
      if (!looksLikeChartLyric(lyric)) {
        if (chords.length && !pendingChords) {
          flushPending();
          units.push({
            type: "group",
            index: groupIndex,
            chordLine: line,
            lyricLine: null,
            chordSourceIndex: li,
            lyricSourceIndex: null,
            group: { lyric: "", chords, section: currentSection },
          });
          groupIndex += 1;
        } else if (pendingChords) {
          flushPending();
        } else {
          units.push({ type: "raw", text: line, sourceIndex: li });
        }
        continue;
      }
      units.push({
        type: "group",
        index: groupIndex,
        chordLine: pendingChordLine,
        lyricLine: line,
        chordSourceIndex: pendingChordSourceIndex,
        lyricSourceIndex: li,
        group: { lyric, chords, section: currentSection },
      });
      groupIndex += 1;
      pendingChords = null;
      pendingChordLine = null;
      pendingChordSourceIndex = null;
    }
    flushPending();
    return units;
  }

  /** Replace the lyric source line for a sync group. Returns new chart body or null. */
  function replaceChartGroupLyric(chartBody, groupIndex, newLyric) {
    const text = String(chartBody || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const raw = text.split("\n");
    const units = chartDisplayUnits(text);
    const unit = units.find((u) => u.type === "group" && u.index === groupIndex);
    if (!unit || unit.lyricSourceIndex == null || unit.lyricSourceIndex < 0) return null;
    const next = String(newLyric ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")[0];
    if (!looksLikeChartLyric(next)) return null;
    raw[unit.lyricSourceIndex] = next;
    return raw.join("\n");
  }

  function extractChartGroups(chartBody) {
    return chartDisplayUnits(chartBody)
      .filter((u) => u.type === "group")
      .map((u) => ({ ...u.group }));
  }

  function normalizeLyricKey(text) {
    return normalizeChartLyric(text).toLowerCase().replace(/[^\w\s']/g, "").replace(/\s+/g, " ");
  }

  /**
   * Validate lyrics + chords VTT cues before save / verify.
   * Errors block save and go-live; warnings block verify only.
   */
  function validateMediaVtt(lyricsCues, chordsCues) {
    const errors = [];
    const warnings = [];
    const lyrics = Array.isArray(lyricsCues) ? lyricsCues : [];
    const chords = Array.isArray(chordsCues) ? chordsCues : [];

    let prevStart = -Infinity;
    lyrics.forEach((cue, i) => {
      const n = i + 1;
      const text = String(cue?.text || "").trim();
      if (!Number.isFinite(cue?.start) || !Number.isFinite(cue?.end)) {
        errors.push(`Lyric cue ${n}: invalid timing`);
        return;
      }
      if (!(cue.end > cue.start)) {
        errors.push(`Lyric cue ${n}: end must be after start (${formatVttTime(cue.start)})`);
      }
      if (cue.start < prevStart - 0.001) {
        errors.push(
          `Lyric cue ${n}: out of chronological order (starts ${formatVttTime(cue.start)} after previous ${formatVttTime(prevStart)})`
        );
      } else {
        prevStart = cue.start;
      }
      const dur = cue.end - cue.start;
      if (text && text !== "·" && dur < 0.1) {
        warnings.push(`Lyric cue ${n} is very short (${Math.round(dur * 1000)}ms): "${text}"`);
      }
    });

    // Near-duplicate lyric starts (same text + same start) usually mean a junk insert.
    const seenStarts = new Map();
    lyrics.forEach((cue, i) => {
      const key = `${normalizeLyricKey(cue?.text || "")}|${Number(cue?.start).toFixed(3)}`;
      if (!key.startsWith("|") && seenStarts.has(key)) {
        warnings.push(
          `Lyric cue ${i + 1} duplicates cue ${seenStarts.get(key)} at ${formatVttTime(cue.start)}`
        );
      } else if (!key.startsWith("|")) {
        seenStarts.set(key, i + 1);
      }
    });

    chords.forEach((cue, i) => {
      const n = i + 1;
      if (!Number.isFinite(cue?.start) || !Number.isFinite(cue?.end)) {
        errors.push(`Chord cue ${n}: invalid timing`);
        return;
      }
      if (!(cue.end > cue.start)) {
        errors.push(`Chord cue ${n}: end must be after start (${formatVttTime(cue.start)})`);
      }
      const parsed = parseChordCue(cue);
      if (!parsed.name || !Number.isFinite(parsed.column) || parsed.column < 0) {
        errors.push(`Chord cue ${n}: expected Name|column, got "${cue.text || ""}"`);
      }
    });

    const ordered = sortCuesByStart(lyrics);
    ordered.forEach((cue, idx) => {
      const text = String(cue.text || "").trim();
      if (!text) return;
      const next = ordered[idx + 1];
      const until = next ? next.start : cue.end;
      const attached = chordsForLyric({ cue }, chords, until);
      const colHits = new Map();
      let collisions = 0;
      attached.forEach((c) => {
        const col = Number.isFinite(c.column) ? c.column : 0;
        const prev = colHits.get(col) || 0;
        if (prev) collisions += 1;
        colHits.set(col, prev + 1);
      });
      if (attached.length > 18 || collisions > 2) {
        warnings.push(
          `Lyric "${text}" at ${formatVttTime(cue.start)} attaches ${attached.length} chords` +
            (collisions ? ` with ${collisions} column collisions` : "") +
            " — fix lyric timing order before going live"
        );
      }
    });

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      issues: errors.concat(warnings),
    };
  }

  function hydrateSyncLines(groups, lyricsCues, chordsCues) {
    const cues = sortCuesByStart(lyricsCues);
    let cursor = 0;
    return (groups || []).map((g) => {
      const lyric = g.lyric || "";
      const line = {
        lyric,
        chords: (g.chords || []).map((c) => ({ name: c.name, column: c.column })),
        section: g.section || null,
        start: null,
        end: null,
      };
      if (!lyric && !(g.chords || []).length) return line;
      const key = normalizeLyricKey(lyric || "·");
      let found = -1;
      for (let i = cursor; i < cues.length; i += 1) {
        const cueKey = normalizeLyricKey(cues[i].text);
        if (!lyric) {
          // Instrumental: match empty / placeholder near cursor.
          if (!cueKey || cueKey === "·" || cueKey === "") {
            found = i;
            break;
          }
        } else if (cueKey === key || cueKey.includes(key) || key.includes(cueKey)) {
          found = i;
          break;
        }
      }
      if (found < 0 && lyric) {
        for (let i = 0; i < cues.length; i += 1) {
          if (normalizeLyricKey(cues[i].text) === key) {
            found = i;
            break;
          }
        }
      }
      if (found >= 0) {
        line.start = cues[found].start;
        line.end = cues[found].end;
        cursor = found + 1;
        // Prefer chord tokens from chart; if chart had none, recover from VTT.
        // Include trailing chords timed in the gap before the next lyric cue.
        if (!line.chords.length && Array.isArray(chordsCues)) {
          const until =
            found + 1 < cues.length && Number.isFinite(cues[found + 1].start)
              ? cues[found + 1].start
              : line.end;
          line.chords = chordsCues
            .map(parseChordCue)
            .filter((c) => c.name && c.start >= line.start - 0.001 && c.start < until - 0.001)
            .map((c) => ({ name: c.name, column: Number.isFinite(c.column) ? c.column : 0 }));
        }
      }
      return line;
    });
  }

  function placeChordsInWindow(chordsCues, chords, windowStart, windowEnd, colBase, colSpan) {
    const span = Math.max(0.05, windowEnd - windowStart);
    const list = chords || [];
    list.forEach((chord, ci) => {
      if (!chord?.name) return;
      const col = Number.isFinite(chord.column) ? chord.column : 0;
      let p0;
      let p1;
      if (colSpan > 0) {
        p0 = Math.max(0, Math.min(1, (col - colBase) / colSpan));
        const nextCol =
          ci + 1 < list.length && Number.isFinite(list[ci + 1].column)
            ? list[ci + 1].column
            : colBase + colSpan;
        p1 = Math.max(p0 + 0.01, Math.min(1, (nextCol - colBase) / colSpan));
      } else {
        p0 = ci / Math.max(1, list.length);
        p1 = (ci + 1) / Math.max(1, list.length);
      }
      const cStart = windowStart + span * p0;
      const cEnd = Math.max(cStart + 0.05, windowStart + span * p1);
      chordsCues.push({ start: cStart, end: Math.min(windowEnd, cEnd), text: `${chord.name}|${col}` });
    });
  }

  function syncLinesToCues(lines) {
    const lyricsCues = [];
    const chordsCues = [];
    const timed = (lines || [])
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => Number.isFinite(line.start));
    timed.forEach(({ line }, i) => {
      const next = timed[i + 1]?.line;
      const nextStart = next && Number.isFinite(next.start) ? next.start : null;
      // Explicit end = when singing stops. Without it, lyric window runs to next start.
      let lyricEnd = Number.isFinite(line.end)
        ? line.end
        : nextStart != null
          ? nextStart
          : line.start + 3;
      if (nextStart != null) lyricEnd = Math.min(lyricEnd, nextStart);
      if (lyricEnd <= line.start) lyricEnd = line.start + 0.05;
      const gapEnd = nextStart != null ? nextStart : lyricEnd;
      const lyricText = line.lyric && looksLikeChartLyric(line.lyric) ? line.lyric : line.chords?.length ? "·" : "";
      if (lyricText) {
        lyricsCues.push({ start: line.start, end: lyricEnd, text: lyricText });
      }
      const chords = (line.chords || []).filter((c) => c?.name);
      if (!chords.length) return;
      const lyricLen = (line.lyric || "").length;
      const maxCol = Math.max(
        lyricLen,
        ...chords.map((c) => (Number.isFinite(c.column) ? c.column + String(c.name).length : 0)),
        1
      );
      // Instrumental / no lyric text: spread chords across the full line window.
      if (!lyricLen || lyricText === "·") {
        placeChordsInWindow(chordsCues, chords, line.start, gapEnd, 0, maxCol);
        return;
      }
      const inLyric = [];
      const trailing = [];
      chords.forEach((chord) => {
        const col = Number.isFinite(chord.column) ? chord.column : 0;
        if (col >= lyricLen) trailing.push(chord);
        else inLyric.push(chord);
      });
      if (inLyric.length) {
        placeChordsInWindow(chordsCues, inLyric, line.start, lyricEnd, 0, Math.max(lyricLen, 1));
      }
      if (trailing.length) {
        if (gapEnd > lyricEnd + 0.001) {
          // Post-lyric chords live in the gap before the next line starts.
          placeChordsInWindow(
            chordsCues,
            trailing,
            lyricEnd,
            gapEnd,
            lyricLen,
            Math.max(1, maxCol - lyricLen)
          );
        } else {
          // No gap — keep trailing chords inside the lyric window (legacy).
          placeChordsInWindow(chordsCues, trailing, line.start, lyricEnd, 0, maxCol);
        }
      }
    });
    return { lyricsCues, chordsCues };
  }

  /** Stamp the start of a lyric line. Does not close the previous line's end. */
  function applySyncLineStamp(lines, index, time) {
    const next = (lines || []).map((line) => ({
      ...line,
      chords: (line.chords || []).map((c) => ({ ...c })),
    }));
    if (!next[index]) return next;
    const t = Math.max(0, Number(time) || 0);
    next[index].start = t;
    // If a later line starts before this stamp, clear its times (user went backwards).
    for (let i = index + 1; i < next.length; i += 1) {
      if (Number.isFinite(next[i].start) && next[i].start <= t) {
        next[i].start = null;
        next[i].end = null;
      }
    }
    // Clamp a previous line's end so it does not overlap this start.
    for (let i = index - 1; i >= 0; i -= 1) {
      if (!Number.isFinite(next[i].start)) continue;
      if (Number.isFinite(next[i].end) && next[i].end > t) {
        next[i].end = t;
      }
      break;
    }
    if (Number.isFinite(next[index].end) && next[index].end <= t) {
      next[index].end = null;
    }
    return next;
  }

  /** Stamp when singing ends on a line. Trailing chords use (end, nextStart). */
  function applySyncLineStampEnd(lines, index, time) {
    const next = (lines || []).map((line) => ({
      ...line,
      chords: (line.chords || []).map((c) => ({ ...c })),
    }));
    if (!next[index]) return next;
    const t = Math.max(0, Number(time) || 0);
    if (!Number.isFinite(next[index].start)) {
      // No start yet — treat as start so the line is usable.
      next[index].start = t;
      next[index].end = null;
      return next;
    }
    if (t <= next[index].start) {
      next[index].end = next[index].start + 0.05;
    } else {
      next[index].end = t;
    }
    // Clear later lines that start before this end.
    for (let i = index + 1; i < next.length; i += 1) {
      if (Number.isFinite(next[i].start) && next[i].start < next[index].end) {
        next[i].start = null;
        next[i].end = null;
      }
    }
    return next;
  }

  function playingSyncLineIndex(lines, currentTime) {
    const t = Number(currentTime) || 0;
    let active = -1;
    (lines || []).forEach((line, i) => {
      if (!Number.isFinite(line.start)) return;
      // Stay active through the post-lyric gap until the next line starts.
      let end = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (Number.isFinite(lines[j].start)) {
          end = lines[j].start;
          break;
        }
      }
      if (end == null) {
        end = Number.isFinite(line.end) ? line.end : line.start + 3;
      }
      if (t >= line.start && t < end) active = i;
    });
    return active;
  }

  window.MediaAnalysis = {
    STEM_ORDER,
    parseVtt,
    sortCuesByStart,
    cuesToVtt,
    drawFrame,
    formatVttTime,
    chartDisplayUnits,
    extractChartGroups,
    validateMediaVtt,
    hydrateSyncLines,
    syncLinesToCues,
    applySyncLineStamp,
    applySyncLineStampEnd,
    playingSyncLineIndex,
    replaceChartGroupLyric,
    hitTestChartAt,
    PROGRESS_BAR_H,
  };
})();

