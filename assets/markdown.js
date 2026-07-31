/** Parse song markdown (YAML frontmatter + fenced/plain body). */
(function (global) {
  function parseFrontmatter(text) {
    if (!text.startsWith("---")) {
      return { meta: {}, body: text };
    }
    const end = text.indexOf("\n---", 3);
    if (end === -1) {
      return { meta: {}, body: text };
    }
    const raw = text.slice(3, end).trim();
    const body = text.slice(end + 4).trim();
    const meta = {};
    raw.split("\n").forEach((line) => {
      const idx = line.indexOf(":");
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (value === "null" || value === "~" || value === "") {
        meta[key] = null;
        return;
      }
      if (value === "true") {
        meta[key] = true;
        return;
      }
      if (value === "false") {
        meta[key] = false;
        return;
      }
      if (/^-?\d+(\.\d+)?$/.test(value)) {
        meta[key] = Number(value);
        return;
      }
      if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        meta[key] = inner
          ? inner.split(",").map((p) => p.trim().replace(/^["']|["']$/g, ""))
          : [];
        return;
      }
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        meta[key] = value.slice(1, -1);
        return;
      }
      meta[key] = value;
    });
    let chart = body;
    const fence = chart.match(/^```(?:text|chord|chords)?\n([\s\S]*?)\n```\s*$/);
    if (fence) chart = fence[1];
    return { meta, body: chart };
  }

  global.SongMarkdown = { parseFrontmatter };
})(window);
