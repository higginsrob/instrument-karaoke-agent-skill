/** Chord diagram renderer: guitar, ukulele, and piano modes. */
(function (global) {
  const GUITAR_STRINGS = 6;
  const UKE_STRINGS = 4;
  const FRET_COUNT = 5;
  const INSTRUMENTS = ["guitar", "ukulele", "piano"];

  const NOTE_INDEX = {
    C: 0,
    "C#": 1,
    Db: 1,
    D: 2,
    "D#": 3,
    Eb: 3,
    E: 4,
    F: 5,
    "F#": 6,
    Gb: 6,
    G: 7,
    "G#": 8,
    Ab: 8,
    A: 9,
    "A#": 10,
    Bb: 10,
    B: 11,
  };

  const PC_NAME = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  const QUALITY_INTERVALS = {
    "": [0, 4, 7],
    maj: [0, 4, 7],
    M: [0, 4, 7],
    m: [0, 3, 7],
    min: [0, 3, 7],
    "5": [0, 7],
    "7": [0, 4, 7, 10],
    m7: [0, 3, 7, 10],
    maj7: [0, 4, 7, 11],
    M7: [0, 4, 7, 11],
    dim: [0, 3, 6],
    aug: [0, 4, 8],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
    sus: [0, 5, 7],
    add9: [0, 4, 7, 14],
    madd9: [0, 3, 7, 14],
    "9": [0, 4, 7, 10, 14],
    m9: [0, 3, 7, 10, 14],
    "6": [0, 4, 7, 9],
    m6: [0, 3, 7, 9],
  };

  // Guitar movable forms. Offsets from form root fret.
  const GUITAR_FORMS = {
    "": {
      E: { frets: [0, 2, 2, 1, 0, 0], fingers: [1, 3, 4, 2, 1, 1], barre: true },
      A: { frets: [-1, 0, 2, 2, 2, 0], fingers: [0, 1, 2, 3, 4, 1], barre: true },
    },
    m: {
      E: { frets: [0, 2, 2, 0, 0, 0], fingers: [1, 3, 4, 1, 1, 1], barre: true },
      A: { frets: [-1, 0, 2, 2, 1, 0], fingers: [0, 1, 3, 4, 2, 1], barre: true },
    },
    "7": {
      E: { frets: [0, 2, 0, 1, 0, 0], fingers: [1, 3, 1, 2, 1, 1], barre: true },
      A: { frets: [-1, 0, 2, 0, 2, 0], fingers: [0, 1, 3, 1, 4, 1], barre: true },
    },
    m7: {
      E: { frets: [0, 2, 0, 0, 0, 0], fingers: [1, 3, 1, 1, 1, 1], barre: true },
      A: { frets: [-1, 0, 2, 0, 1, 0], fingers: [0, 1, 3, 1, 2, 1], barre: true },
    },
    "5": {
      E: { frets: [0, 2, 2, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0], barre: false },
      A: { frets: [-1, 0, 2, 2, -1, -1], fingers: [0, 1, 3, 4, 0, 0], barre: false },
    },
    sus2: {
      A: { frets: [-1, 0, 2, 2, 0, 0], fingers: [0, 1, 3, 4, 1, 1], barre: true },
    },
    sus4: {
      E: { frets: [0, 2, 2, 2, 0, 0], fingers: [1, 2, 3, 4, 1, 1], barre: true },
      A: { frets: [-1, 0, 2, 2, 3, 0], fingers: [0, 1, 2, 3, 4, 1], barre: true },
    },
    maj7: {
      E: { frets: [0, 2, 1, 1, 0, 0], fingers: [1, 4, 2, 3, 1, 1], barre: true },
      A: { frets: [-1, 0, 2, 1, 2, 0], fingers: [0, 1, 3, 2, 4, 1], barre: true },
    },
  };

  // Ukulele GCEA shapes: frets are [G, C, E, A] for the listed root.
  const UKE_SHAPES = {
    "": [
      { root: "C", frets: [0, 0, 0, 3], fingers: [0, 0, 0, 3] },
      { root: "G", frets: [0, 2, 3, 2], fingers: [0, 1, 3, 2] },
      { root: "F", frets: [2, 0, 1, 0], fingers: [2, 0, 1, 0] },
      { root: "A", frets: [2, 1, 0, 0], fingers: [2, 1, 0, 0] },
      { root: "D", frets: [2, 2, 2, 0], fingers: [1, 2, 3, 0] },
      { root: "E", frets: [1, 4, 0, 2], fingers: [1, 4, 0, 2] },
      { root: "C", frets: [5, 4, 3, 3], fingers: [3, 2, 1, 1], barre: 3 },
    ],
    m: [
      { root: "A", frets: [2, 0, 0, 0], fingers: [2, 0, 0, 0] },
      { root: "D", frets: [2, 2, 1, 0], fingers: [2, 3, 1, 0] },
      { root: "E", frets: [0, 4, 3, 2], fingers: [0, 3, 2, 1] },
      { root: "C", frets: [0, 3, 3, 3], fingers: [0, 1, 1, 1], barre: 3 },
      { root: "G", frets: [0, 2, 3, 1], fingers: [0, 2, 3, 1] },
      { root: "F", frets: [1, 0, 1, 3], fingers: [1, 0, 2, 4] },
    ],
    "7": [
      { root: "C", frets: [0, 0, 0, 1], fingers: [0, 0, 0, 1] },
      { root: "G", frets: [0, 2, 1, 2], fingers: [0, 2, 1, 3] },
      { root: "A", frets: [0, 1, 0, 0], fingers: [0, 1, 0, 0] },
      { root: "D", frets: [2, 2, 2, 3], fingers: [1, 1, 1, 2], barre: 2 },
      { root: "E", frets: [1, 2, 0, 2], fingers: [1, 2, 0, 3] },
      { root: "F", frets: [2, 3, 1, 0], fingers: [2, 3, 1, 0] },
    ],
    m7: [
      { root: "A", frets: [0, 0, 0, 0], fingers: [0, 0, 0, 0] },
      { root: "D", frets: [2, 2, 1, 3], fingers: [2, 3, 1, 4] },
      { root: "E", frets: [0, 2, 0, 2], fingers: [0, 1, 0, 2] },
      { root: "C", frets: [3, 3, 3, 3], fingers: [1, 1, 1, 1], barre: 3 },
    ],
    "5": [
      { root: "C", frets: [0, 0, 3, 3], fingers: [0, 0, 1, 2] },
      { root: "G", frets: [0, 2, 3, 0], fingers: [0, 1, 2, 0] },
      { root: "D", frets: [2, 2, 0, 0], fingers: [1, 2, 0, 0] },
      { root: "A", frets: [2, 4, 0, 0], fingers: [1, 3, 0, 0] },
    ],
    sus2: [
      { root: "C", frets: [0, 0, 3, 3], fingers: [0, 0, 1, 2] },
      { root: "G", frets: [0, 2, 3, 0], fingers: [0, 1, 2, 0] },
      { root: "D", frets: [2, 2, 0, 0], fingers: [2, 3, 0, 0] },
    ],
    sus4: [
      { root: "C", frets: [0, 0, 1, 3], fingers: [0, 0, 1, 3] },
      { root: "G", frets: [0, 2, 3, 3], fingers: [0, 1, 2, 3] },
      { root: "D", frets: [0, 2, 3, 0], fingers: [0, 1, 2, 0] },
      { root: "A", frets: [2, 2, 0, 0], fingers: [1, 2, 0, 0] },
    ],
    maj7: [
      { root: "C", frets: [0, 0, 0, 2], fingers: [0, 0, 0, 2] },
      { root: "F", frets: [2, 4, 1, 0], fingers: [2, 4, 1, 0] },
      { root: "G", frets: [0, 2, 2, 2], fingers: [0, 1, 1, 1], barre: 2 },
      { root: "A", frets: [1, 1, 0, 0], fingers: [1, 2, 0, 0] },
    ],
    add9: [
      { root: "C", frets: [0, 0, 0, 3], fingers: [0, 0, 0, 3] },
      { root: "G", frets: [0, 2, 3, 0], fingers: [0, 1, 3, 0] },
      { root: "D", frets: [2, 2, 0, 0], fingers: [2, 3, 0, 0] },
    ],
    madd9: [
      { root: "A", frets: [2, 0, 0, 2], fingers: [2, 0, 0, 3] },
      { root: "E", frets: [0, 4, 3, 0], fingers: [0, 2, 1, 0] },
    ],
  };

  const GUITAR_TUNINGS = [
    { id: "standard", label: "Standard (E A D G B E)", open: ["E", "A", "D", "G", "B", "E"] },
    { id: "half-down", label: "½ step down (Eb…)", open: ["Eb", "Ab", "Db", "Gb", "Bb", "Eb"] },
    { id: "whole-down", label: "Whole step down (D…)", open: ["D", "G", "C", "F", "A", "D"] },
    { id: "drop-d", label: "Drop D (D A D G B E)", open: ["D", "A", "D", "G", "B", "E"] },
    { id: "drop-c", label: "Drop C (C G C F A D)", open: ["C", "G", "C", "F", "A", "D"] },
    { id: "open-g", label: "Open G (D G D G B D)", open: ["D", "G", "D", "G", "B", "D"] },
    { id: "open-d", label: "Open D (D A D F# A D)", open: ["D", "A", "D", "F#", "A", "D"] },
    { id: "dadgad", label: "DADGAD", open: ["D", "A", "D", "G", "A", "D"] },
  ];

  const UKE_TUNINGS = [
    { id: "standard", label: "Standard high G (G C E A)", open: ["G", "C", "E", "A"] },
    { id: "low-g", label: "Low G (G C E A)", open: ["G", "C", "E", "A"] },
    { id: "baritone", label: "Baritone (D G B E)", open: ["D", "G", "B", "E"] },
    { id: "d-tuning", label: "D tuning (A D F# B)", open: ["A", "D", "F#", "B"] },
  ];

  const STANDARD_GUITAR_OPEN = GUITAR_TUNINGS[0].open;
  const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
  const IS_BLACK_PC = { 1: true, 3: true, 6: true, 8: true, 10: true };

  /** CSS custom properties for chord-tone fills (root from accent color). */
  const TONE_COLOR_FALLBACKS = {
    root: "#1e1e1e",
    other: "#5c5c5c",
  };

  /** Resolve palette colors to concrete hex (SVG presentation attrs don't always handle var()). */
  function resolveToneColors() {
    let root = TONE_COLOR_FALLBACKS.root;
    let other = TONE_COLOR_FALLBACKS.other;
    try {
      if (typeof getComputedStyle === "function" && document?.documentElement) {
        const cs = getComputedStyle(document.documentElement);
        const r = cs.getPropertyValue("--chord-tone-root").trim();
        const o = cs.getPropertyValue("--chord-tone-other").trim() || cs.getPropertyValue("--chord-tone-third").trim();
        if (r) root = r;
        if (o) other = o;
      }
    } catch {
      /* ignore */
    }
    return { root, other };
  }

  /** Root pitch class of the written chord name (ignores slash bass). */
  function chordRootPc(chordName) {
    const parsed = parseChordName(chordName);
    if (!parsed) return null;
    const pc = NOTE_INDEX[parsed.root];
    return pc == null ? null : pc;
  }

  function toneFillForPc(pc, rootPc, colors) {
    const c = colors || resolveToneColors();
    if (rootPc != null && pc === rootPc) return c.root;
    return c.other;
  }

  function parseChordName(name) {
    const raw = String(name || "").trim();
    const m = raw.match(/^([A-G](?:#|b)?)(.*?)(?:\/([A-G](?:#|b)?))?$/);
    if (!m) return null;
    let quality = m[2] || "";
    quality = quality.replace(/^min$/, "m").replace(/^maj$/, "maj7");
    if (quality === "M") quality = "maj7";
    if (quality === "sus") quality = "sus4";
    if (quality === "add9" || quality === "add2") quality = "add9";
    return { root: m[1], quality, bass: m[3] || null, raw };
  }

  function normalizeQuality(q) {
    if (QUALITY_INTERVALS[q]) return q;
    if (q.endsWith("add9") && q.startsWith("m")) return "madd9";
    if (GUITAR_FORMS[q] || UKE_SHAPES[q]) return q;
    return q;
  }

  function chordTonePcs(parsed) {
    if (!parsed) return [];
    const rootPc = NOTE_INDEX[parsed.root];
    if (rootPc == null) return [];
    const quality = normalizeQuality(parsed.quality);
    const intervals = QUALITY_INTERVALS[quality] || QUALITY_INTERVALS[""];
    const tones = intervals.map((i) => (rootPc + i) % 12);
    if (parsed.bass != null && NOTE_INDEX[parsed.bass] != null) {
      const bass = NOTE_INDEX[parsed.bass];
      if (!tones.includes(bass)) tones.unshift(bass);
    }
    return tones;
  }

  function rootFretOnString(root, openNote) {
    const rootPc = NOTE_INDEX[root];
    const openPc = NOTE_INDEX[openNote];
    if (rootPc == null || openPc == null) return null;
    return (rootPc - openPc + 12) % 12;
  }

  function shapeKey(shape) {
    if (!shape || !Array.isArray(shape.frets)) return "";
    return shape.frets.join(",");
  }

  function getTuningList(instrument) {
    if (instrument === "ukulele") return UKE_TUNINGS;
    if (instrument === "guitar") return GUITAR_TUNINGS;
    return [];
  }

  function findTuning(instrument, tuningId) {
    const list = getTuningList(instrument);
    return list.find((t) => t.id === tuningId) || list[0] || null;
  }

  function openPcsFromNotes(notes) {
    return notes.map((n) => NOTE_INDEX[n]).map((pc) => (pc == null ? 0 : pc));
  }

  function uniformTransposeFrom(referenceOpen, openNotes) {
    if (!openNotes || !referenceOpen || openNotes.length !== referenceOpen.length) return null;
    const deltas = openNotes.map((n, i) => {
      const a = NOTE_INDEX[referenceOpen[i]];
      const b = NOTE_INDEX[n];
      if (a == null || b == null) return null;
      let d = a - b;
      while (d > 6) d -= 12;
      while (d < -6) d += 12;
      return d;
    });
    if (deltas.some((d) => d == null)) return null;
    if (!deltas.every((d) => d === deltas[0])) return null;
    return deltas[0];
  }

  function uniformTransposeFromStandard(openNotes) {
    return uniformTransposeFrom(STANDARD_GUITAR_OPEN, openNotes);
  }

  function shiftShapeFrets(shape, semitones) {
    if (!semitones) return shape;
    const frets = shape.frets.map((f) => {
      if (f < 0) return -1;
      const next = f + semitones;
      return next < 0 ? -1 : next;
    });
    if (frets.every((f) => f < 0)) return null;
    const fretted = frets.filter((f) => f > 0);
    const minFret = fretted.length ? Math.min(...fretted) : 0;
    const maxFret = fretted.length ? Math.max(...fretted) : 0;
    let base = 1;
    if (minFret > 1) {
      base = minFret;
      if (maxFret - base + 1 > FRET_COUNT) base = Math.max(1, maxFret - FRET_COUNT + 1);
    }
    let barre = shape.barre == null ? null : Number(shape.barre) + semitones;
    if (barre != null && barre < 1) barre = null;
    return {
      frets,
      fingers: (shape.fingers || []).map((finger, i) => (frets[i] <= 0 ? 0 : finger)),
      base_fret: base,
      barre,
    };
  }

  function finalizeShape(frets) {
    const fretted = frets.filter((f) => f > 0);
    const minFret = fretted.length ? Math.min(...fretted) : 0;
    const maxFret = fretted.length ? Math.max(...fretted) : 0;
    let base = 1;
    if (minFret > 1) {
      base = minFret;
      if (maxFret - base + 1 > FRET_COUNT) base = Math.max(1, maxFret - FRET_COUNT + 1);
    }
    const fingers = frets.map((f) => (f > 0 ? 1 : 0));
    return { frets: frets.slice(), fingers, base_fret: base, barre: null };
  }

  function searchVoicingsForTuning(openNotes, chordName, limit) {
    const parsed = parseChordName(chordName);
    if (!parsed) return [];
    const tones = chordTonePcs(parsed);
    if (!tones.length) return [];
    const toneSet = new Set(tones);
    const rootPc = NOTE_INDEX[parsed.root];
    const openPcs = openPcsFromNotes(openNotes);
    const stringCount = openPcs.length;
    const maxFret = 8;
    const maxSpan = 4;
    const maxMutes = stringCount <= 4 ? 1 : 2;
    const results = [];

    function spanOk(frets) {
      const fretted = frets.filter((f) => f > 0);
      if (!fretted.length) return true;
      return Math.max(...fretted) - Math.min(...fretted) <= maxSpan;
    }

    function score(frets) {
      const sounding = [];
      const used = new Set();
      let mutes = 0;
      for (let i = 0; i < frets.length; i++) {
        const f = frets[i];
        if (f < 0) {
          mutes += 1;
          continue;
        }
        const pc = (openPcs[i] + f) % 12;
        sounding.push({ i, f, pc });
        used.add(pc);
      }
      let missing = 0;
      for (const t of toneSet) if (!used.has(t)) missing += 1;
      const bass = sounding.find(Boolean);
      const rootInBass = bass && bass.pc === rootPc ? 0 : 1;
      const fretted = sounding.filter((s) => s.f > 0).map((s) => s.f);
      const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
      return missing * 100 + mutes * 8 + rootInBass * 5 + span;
    }

    function dfs(idx, current, mutes) {
      if (results.length >= (limit || 10) * 3) return;
      if (idx === stringCount) {
        if (!spanOk(current)) return;
        const used = new Set();
        let sounded = 0;
        for (let i = 0; i < current.length; i++) {
          if (current[i] < 0) continue;
          sounded += 1;
          used.add((openPcs[i] + current[i]) % 12);
        }
        if (sounded < 2) return;
        let missing = 0;
        for (const t of toneSet) if (!used.has(t)) missing += 1;
        // Allow incomplete only for sparse chords; prefer full coverage
        if (missing > (tones.length > 3 ? 1 : 0)) return;
        results.push(current.slice());
        return;
      }

      // Prefer chord tones; mute last
      const opts = [];
      for (let f = 0; f <= maxFret; f++) {
        if (toneSet.has((openPcs[idx] + f) % 12)) opts.push(f);
      }
      if (mutes < maxMutes) opts.push(-1);

      for (const f of opts) {
        current.push(f);
        if (spanOk(current)) dfs(idx + 1, current, mutes + (f < 0 ? 1 : 0));
        current.pop();
        if (results.length >= (limit || 10) * 3) return;
      }
    }

    dfs(0, [], 0);
    results.sort((a, b) => score(a) - score(b));
    const out = [];
    const seen = new Set();
    for (const frets of results) {
      const shape = finalizeShape(frets);
      const key = shapeKey(shape);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(shape);
      if (out.length >= (limit || 6)) break;
    }
    return out;
  }

  function applyGuitarForm(form, rootFret) {
    const frets = form.frets.map((f) => (f < 0 ? -1 : f + rootFret));
    const fingers = (form.fingers || []).map((finger, i) => (frets[i] <= 0 ? 0 : finger));
    const fretted = frets.filter((f) => f > 0);
    const minFret = fretted.length ? Math.min(...fretted) : 1;
    const maxFret = fretted.length ? Math.max(...fretted) : 1;
    let base = rootFret > 0 ? rootFret : 1;
    if (maxFret - base + 1 > FRET_COUNT) base = Math.max(1, maxFret - FRET_COUNT + 1);
    if (minFret < base && minFret > 0) base = minFret;
    const barre = form.barre && rootFret > 0 ? rootFret : null;
    return { frets, fingers, base_fret: base, barre };
  }

  function generatedGuitarVoicings(chordName) {
    const parsed = parseChordName(chordName);
    if (!parsed || parsed.bass) return [];
    const forms = GUITAR_FORMS[normalizeQuality(parsed.quality)];
    if (!forms) return [];
    const out = [];
    if (forms.E) {
      const r = rootFretOnString(parsed.root, "E");
      if (r != null && r <= 10) out.push(applyGuitarForm(forms.E, r));
    }
    if (forms.A) {
      const r = rootFretOnString(parsed.root, "A");
      if (r != null && r <= 10) out.push(applyGuitarForm(forms.A, r));
    }
    return out;
  }

  function transposeUkeShape(shape, fromRoot, toRoot) {
    const fromPc = NOTE_INDEX[fromRoot];
    const toPc = NOTE_INDEX[toRoot];
    if (fromPc == null || toPc == null) return null;
    const shift = (toPc - fromPc + 12) % 12;
    const frets = shape.frets.map((f) => (f < 0 ? -1 : f + shift));
    const maxFret = Math.max(0, ...frets.filter((f) => f >= 0));
    if (maxFret > 12) return null;
    const fretted = frets.filter((f) => f > 0);
    const minFret = fretted.length ? Math.min(...fretted) : 0;
    let base = 1;
    if (minFret > 1) {
      base = minFret;
      if (maxFret - base + 1 > FRET_COUNT) base = Math.max(1, maxFret - FRET_COUNT + 1);
    }
    let barre = null;
    if (shape.barre != null) {
      barre = Number(shape.barre) + shift;
      if (barre < 1) barre = null;
    }
    const fingers = (shape.fingers || []).map((finger, i) => (frets[i] <= 0 ? 0 : finger));
    return { frets, fingers, base_fret: base, barre };
  }

  function generatedUkeVoicings(chordName) {
    const parsed = parseChordName(chordName);
    if (!parsed) return [];
    const quality = normalizeQuality(parsed.quality);
    const forms = UKE_SHAPES[quality];
    if (!forms) return [];
    const out = [];
    const seen = new Set();
    for (const form of forms) {
      const shape = transposeUkeShape(form, form.root, parsed.root);
      if (!shape) continue;
      const key = shapeKey(shape);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(shape);
    }
    return out;
  }

  function ukeQualityFallbacks(quality) {
    const q = normalizeQuality(quality || "");
    const out = [];
    const add = (x) => {
      if (!out.includes(x)) out.push(x);
    };
    add(q);
    if (/add\d+/i.test(q)) {
      add(q.replace(/add\d+/gi, ""));
    }
    if (/^m7/.test(q) || q === "min7") {
      add("m7");
      add("m");
    } else if (/^m/.test(q) && q !== "m") {
      add("m");
    }
    if (/^maj(9|11|13)$/.test(q)) {
      add("maj7");
      add("");
    } else if (q === "maj7" || q === "M7") {
      add("");
    }
    if (q === "9" || q === "11" || q === "13") {
      add("7");
      add("");
    }
    if (q === "6" || q === "69") add("");
    if (q === "m6" || q === "m9" || q === "m11") {
      add("m7");
      add("m");
    }
    if (/^sus/.test(q)) add("");
    if (q === "7") add("");
    if (q.startsWith("m")) add("m");
    add("");
    return out;
  }

  function simplifiedUkeCandidates(chordName) {
    const parsed = parseChordName(chordName);
    if (!parsed) return [];
    const names = [];
    const add = (name) => {
      if (name && name !== chordName && !names.includes(name)) names.push(name);
    };
    // Drop slash bass and simplify quality until a known uke shape exists
    for (const q of ukeQualityFallbacks(parsed.quality)) {
      add(`${parsed.root}${q}`);
    }
    return names;
  }

  function resolveUkeVoicings(chordName, shapesDb, tuningId) {
    const tuning = findTuning("ukulele", tuningId || "standard");
    if (!tuning || tuning.id === "standard" || tuning.id === "low-g") {
      let voicings = generatedUkeVoicings(chordName);
      if (voicings.length) return voicings;
      for (const alt of simplifiedUkeCandidates(chordName)) {
        voicings = generatedUkeVoicings(alt);
        if (voicings.length) return voicings;
      }
      return searchVoicingsForTuning(tuning.open, chordName, 6);
    }
    if (tuning.id === "baritone") {
      const fromGuitar = baritoneFromGuitar(chordName, shapesDb);
      if (fromGuitar.length) return fromGuitar;
      for (const alt of simplifiedUkeCandidates(chordName)) {
        const simplified = baritoneFromGuitar(alt, shapesDb);
        if (simplified.length) return simplified;
      }
    }
    let found = searchVoicingsForTuning(tuning.open, chordName, 6);
    if (found.length) return found;
    for (const alt of simplifiedUkeCandidates(chordName)) {
      found = searchVoicingsForTuning(tuning.open, alt, 6);
      if (found.length) return found;
    }
    return [];
  }

  function baritoneFromGuitar(chordName, shapesDb) {
    // Baritone DGBE == guitar strings 3–6 (0-based 2–5)
    const guitar = resolveGuitarVoicingsStandard(chordName, shapesDb);
    const out = [];
    const seen = new Set();
    for (const shape of guitar) {
      const frets = shape.frets.slice(2, 6);
      while (frets.length < 4) frets.push(-1);
      const fingers = (shape.fingers || []).slice(2, 6);
      const next = {
        frets,
        fingers,
        base_fret: shape.base_fret || 1,
        barre: shape.barre,
      };
      const key = shapeKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(next);
    }
    return out;
  }

  function normalizeStored(entry) {
    if (!entry) return [];
    if (Array.isArray(entry)) return entry.filter((s) => s && Array.isArray(s.frets));
    if (Array.isArray(entry.frets)) return [entry];
    if (Array.isArray(entry.shapes)) return entry.shapes.filter((s) => s && Array.isArray(s.frets));
    return [];
  }

  function guitarShapeToneScore(shape, chordName) {
    const tones = chordTonePcs(parseChordName(chordName));
    if (!tones.length || !shape || !Array.isArray(shape.frets)) return 0;
    const open = openPcsFromNotes(STANDARD_GUITAR_OPEN);
    const used = new Set();
    let sounding = 0;
    const n = Math.min(shape.frets.length, open.length);
    for (let i = 0; i < n; i++) {
      const f = Number(shape.frets[i]);
      if (!Number.isFinite(f) || f < 0) continue;
      sounding += 1;
      used.add((open[i] + f) % 12);
    }
    if (!sounding) return 0;
    let hit = 0;
    for (const t of tones) if (used.has(t)) hit += 1;
    return hit * 10 - (tones.length - hit) * 5;
  }

  function orientGuitarShape(shape, chordName) {
    if (!shape || !Array.isArray(shape.frets) || shape.frets.length !== GUITAR_STRINGS) {
      return shape;
    }
    const fwd = guitarShapeToneScore(shape, chordName);
    const rev = {
      frets: shape.frets.slice().reverse(),
      fingers: Array.isArray(shape.fingers) ? shape.fingers.slice().reverse() : [],
      base_fret: shape.base_fret,
      barre: shape.barre,
    };
    const bwd = guitarShapeToneScore(rev, chordName);
    return bwd > fwd ? rev : shape;
  }

  function resolveGuitarVoicingsStandard(chordName, shapesDb) {
    const seen = new Set();
    const out = [];
    function add(shape) {
      if (!shape || !Array.isArray(shape.frets)) return;
      const oriented = orientGuitarShape(shape, chordName);
      const key = shapeKey(oriented);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(oriented);
    }
    normalizeStored(shapesDb && shapesDb[chordName]).forEach(add);
    generatedGuitarVoicings(chordName).forEach(add);
    return out;
  }

  function resolveGuitarVoicings(chordName, shapesDb, tuningId) {
    const tuning = findTuning("guitar", tuningId || "standard");
    if (!tuning || tuning.id === "standard") {
      return resolveGuitarVoicingsStandard(chordName, shapesDb);
    }
    const uniform = uniformTransposeFromStandard(tuning.open);
    if (uniform != null && uniform !== 0) {
      return resolveGuitarVoicingsStandard(chordName, shapesDb)
        .map((s) => shiftShapeFrets(s, uniform))
        .filter(Boolean)
        .filter((s) => Math.max(...s.frets.filter((f) => f >= 0), 0) <= 15);
    }
    return searchVoicingsForTuning(tuning.open, chordName, 6);
  }

  function resolvePianoVoicings(chordName) {
    const parsed = parseChordName(chordName);
    if (!parsed) return [];
    const rootPc = NOTE_INDEX[parsed.root];
    if (rootPc == null) return [];
    const quality = normalizeQuality(parsed.quality);
    const intervals = (QUALITY_INTERVALS[quality] || QUALITY_INTERVALS[""]).map((i) => i % 12);
    const unique = [];
    for (const iv of intervals) {
      if (!unique.includes(iv)) unique.push(iv);
    }
    const bassPc = parsed.bass != null ? NOTE_INDEX[parsed.bass] : null;
    const voicings = [];
    for (let i = 0; i < unique.length; i++) {
      const stacked = unique.slice(i).concat(unique.slice(0, i));
      voicings.push({
        kind: "piano",
        rootPc,
        bassPc: bassPc != null ? bassPc : (rootPc + unique[i]) % 12,
        tones: stacked.map((iv) => (rootPc + iv) % 12),
        inversion: i,
      });
    }
    return voicings;
  }

  function resolveVoicings(chordName, shapesDb, instrument, tuningId) {
    const mode = INSTRUMENTS.includes(instrument) ? instrument : "guitar";
    if (mode === "ukulele") return resolveUkeVoicings(chordName, shapesDb, tuningId);
    if (mode === "piano") return resolvePianoVoicings(chordName);
    return resolveGuitarVoicings(chordName, shapesDb, tuningId);
  }

  function renderFretboard(shape, chordName, stringCount, openPcs) {
    if (!shape || !Array.isArray(shape.frets)) {
      return `<p class="diagram-missing">No diagram for ${escapeHtml(chordName)}</p>`;
    }

    const frets = shape.frets.slice(0, stringCount);
    while (frets.length < stringCount) frets.push(-1);
    const fingers = (shape.fingers || []).slice(0, stringCount);
    const base = Math.max(1, shape.base_fret || 1);
    const barre = shape.barre;
    const rootPc = chordRootPc(chordName);
    const colors = resolveToneColors();
    const opens =
      Array.isArray(shape.openPcs) && shape.openPcs.length >= stringCount
        ? shape.openPcs
        : Array.isArray(openPcs) && openPcs.length >= stringCount
          ? openPcs
          : null;

    const w = stringCount <= 4 ? 120 : 140;
    const h = 170;
    const left = 28;
    const top = 36;
    const right = w - 28;
    const bottom = 140;
    const stringGap = stringCount > 1 ? (right - left) / (stringCount - 1) : 0;
    const fretGap = (bottom - top) / FRET_COUNT;

    const stringFill = (s, fretNum) => {
      if (!opens || rootPc == null) return colors.other;
      const pc = (opens[s] + fretNum) % 12;
      return toneFillForPc(pc, rootPc, colors);
    };

    let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(chordName)} chord">`;
    svg += `<text x="${w / 2}" y="16" text-anchor="middle" font-size="14" font-family="DM Sans,sans-serif" fill="#1e1e1e" font-weight="600">${escapeHtml(chordName)}</text>`;

    if (base > 1) {
      svg += `<text x="8" y="${top + fretGap * 0.7}" font-size="11" font-family="IBM Plex Mono,monospace" fill="#626262">${base}</text>`;
    }

    if (base === 1) {
      svg += `<rect x="${left - 1}" y="${top - 3}" width="${right - left + 2}" height="5" fill="#1e1e1e" rx="1"/>`;
    } else {
      svg += `<line x1="${left}" y1="${top}" x2="${right}" y2="${top}" stroke="#1e1e1e" stroke-width="1.5"/>`;
    }

    for (let f = 1; f <= FRET_COUNT; f++) {
      const y = top + f * fretGap;
      svg += `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#1e1e1e" stroke-width="1.2" opacity="0.55"/>`;
    }
    for (let s = 0; s < stringCount; s++) {
      const x = left + s * stringGap;
      svg += `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="#1e1e1e" stroke-width="1.3"/>`;
    }

    if (barre != null) {
      const barreFret = Number(barre);
      const y = top + (barreFret - base + 0.5) * fretGap;
      if (y >= top && y <= bottom) {
        svg += `<rect x="${left - 4}" y="${y - 6}" width="${right - left + 8}" height="12" rx="6" fill="#5c5c5c" opacity="0.9"/>`;
      }
    }

    for (let s = 0; s < stringCount; s++) {
      const x = left + s * stringGap;
      const fret = frets[s];
      if (fret === -1 || fret === "x" || fret === "X") {
        svg += `<text x="${x}" y="${top - 10}" text-anchor="middle" font-size="12" fill="#626262">×</text>`;
        continue;
      }
      const n = Number(fret);
      if (n === 0) {
        const stroke = stringFill(s, 0);
        svg += `<circle cx="${x}" cy="${top - 12}" r="5" fill="none" stroke="${stroke}" stroke-width="1.6"/>`;
        continue;
      }
      const relative = n - base + 1;
      if (relative < 1 || relative > FRET_COUNT) continue;
      const y = top + (relative - 0.5) * fretGap;
      const fill = stringFill(s, n);
      svg += `<circle cx="${x}" cy="${y}" r="7.5" fill="${fill}"/>`;
      const finger = fingers[s];
      if (finger && Number(finger) > 0) {
        svg += `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="10" fill="#efefef" font-family="DM Sans,sans-serif">${finger}</text>`;
      }
    }

    svg += "</svg>";
    return svg;
  }

  function renderDiagram(shape, chordName, openPcs) {
    return renderFretboard(shape, chordName, GUITAR_STRINGS, openPcs);
  }

  function renderUkeDiagram(shape, chordName, openPcs) {
    return renderFretboard(shape, chordName, UKE_STRINGS, openPcs);
  }

  function renderPianoDiagram(voicing, chordName) {
    if (!voicing || !Array.isArray(voicing.tones) || !voicing.tones.length) {
      return `<p class="diagram-missing">No diagram for ${escapeHtml(chordName)}</p>`;
    }

    // Closed-position absolute pitches for this inversion
    const abs = [];
    let prev = voicing.tones[0];
    abs.push(prev);
    for (let i = 1; i < voicing.tones.length; i++) {
      let n = voicing.tones[i];
      while (n <= prev) n += 12;
      abs.push(n);
      prev = n;
    }

    const isWhite = (n) => WHITE_PCS.includes(((n % 12) + 12) % 12);
    let lo = Math.min(...abs);
    let hi = Math.max(...abs);
    while (!isWhite(lo)) lo -= 1;
    while (!isWhite(hi)) hi += 1;
    // One white key of padding on each side
    lo -= 1;
    while (!isWhite(lo)) lo -= 1;
    hi += 1;
    while (!isWhite(hi)) hi += 1;

    const whiteKeys = [];
    for (let n = lo; n <= hi; n++) {
      if (isWhite(n)) whiteKeys.push(n);
    }

    const active = new Set(abs);
    const rootPc = voicing.rootPc != null ? voicing.rootPc : chordRootPc(chordName);
    const colors = resolveToneColors();
    const whiteW = 32;
    const whiteH = 110;
    const blackW = 20;
    const blackH = 68;
    const keyboardTop = 34;
    const w = Math.max(160, whiteKeys.length * whiteW + 16);
    const h = 168;
    const left = (w - whiteKeys.length * whiteW) / 2;

    let svg = `<svg class="piano-diagram" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(chordName)} piano chord">`;
    svg += `<text x="${w / 2}" y="18" text-anchor="middle" font-size="15" font-family="DM Sans,sans-serif" fill="#1e1e1e" font-weight="600">${escapeHtml(chordName)}</text>`;

    whiteKeys.forEach((n, i) => {
      const x = left + i * whiteW;
      const pc = ((n % 12) + 12) % 12;
      const on = active.has(n);
      let fill = "#f7f7f7";
      if (on) fill = toneFillForPc(pc, rootPc, colors);
      svg += `<rect x="${x}" y="${keyboardTop}" width="${whiteW - 1.5}" height="${whiteH}" rx="2" fill="${fill}" stroke="#1e1e1e" stroke-width="1.2"/>`;
      if (on) {
        svg += `<text x="${x + (whiteW - 1.5) / 2}" y="${keyboardTop + whiteH - 12}" text-anchor="middle" font-size="11" font-family="DM Sans,sans-serif" fill="#f3f3f3">${PC_NAME[pc]}</text>`;
      }
    });

    whiteKeys.forEach((n, i) => {
      const next = n + 1;
      if (next > hi) return;
      const pc = ((next % 12) + 12) % 12;
      if (!IS_BLACK_PC[pc]) return;
      const x = left + i * whiteW + whiteW - blackW / 2;
      const on = active.has(next);
      let fill = "#1e1e1e";
      if (on) fill = toneFillForPc(pc, rootPc, colors);
      svg += `<rect x="${x}" y="${keyboardTop}" width="${blackW}" height="${blackH}" rx="1.5" fill="${fill}" stroke="#111" stroke-width="0.7"/>`;
      if (on) {
        svg += `<text x="${x + blackW / 2}" y="${keyboardTop + blackH - 10}" text-anchor="middle" font-size="9" font-family="DM Sans,sans-serif" fill="#f3f3f3">${PC_NAME[pc]}</text>`;
      }
    });

    const invLabel =
      voicing.inversion === 0
        ? "root position"
        : `${voicing.inversion === 1 ? "1st" : voicing.inversion === 2 ? "2nd" : voicing.inversion === 3 ? "3rd" : voicing.inversion + "th"} inversion`;
    svg += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" font-size="11" font-family="DM Sans,sans-serif" fill="#626262">${invLabel}</text>`;
    svg += "</svg>";
    return svg;
  }

  function openPcsForInstrument(instrument, tuningId) {
    if (instrument === "piano") return null;
    const mode = instrument === "ukulele" ? "ukulele" : "guitar";
    const tuning = findTuning(mode, tuningId);
    if (!tuning) return null;
    return openPcsFromNotes(tuning.open);
  }

  function renderInstrumentDiagram(voicing, chordName, instrument, tuningId) {
    if (instrument === "piano") return renderPianoDiagram(voicing, chordName);
    const openPcs = openPcsForInstrument(instrument, tuningId);
    if (instrument === "ukulele") return renderUkeDiagram(voicing, chordName, openPcs);
    return renderDiagram(voicing, chordName, openPcs);
  }

  function renderDiagramNav(chordName, shapesDb, index, instrument, tuningId) {
    const mode = INSTRUMENTS.includes(instrument) ? instrument : "guitar";
    const voicings = resolveVoicings(chordName, shapesDb, mode, tuningId);
    const count = voicings.length;
    const i = count ? ((index % count) + count) % count : 0;
    const voicing = count ? voicings[i] : null;
    const canCycle = count > 1;
    return {
      html: `
        <div class="diagram-nav">
          <button type="button" class="diagram-arrow" data-dir="-1" aria-label="Previous voicing"${canCycle ? "" : " disabled"}>‹</button>
          <div class="diagram-stage">${renderInstrumentDiagram(voicing, chordName || "", mode, tuningId)}</div>
          <button type="button" class="diagram-arrow" data-dir="1" aria-label="Next voicing"${canCycle ? "" : " disabled"}>›</button>
        </div>
        <p class="diagram-index"${canCycle ? "" : " hidden"}>${count ? i + 1 : 0} / ${count}</p>
      `,
      index: i,
      count,
      instrument: mode,
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  global.ChordDiagrams = {
    INSTRUMENTS,
    GUITAR_TUNINGS,
    UKE_TUNINGS,
    getTuningList,
    renderDiagram,
    renderInstrumentDiagram,
    resolveVoicings,
    renderDiagramNav,
  };
})(window);
