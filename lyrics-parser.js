/**
 * lyrics-parser.js — turns raw +LYRICS track clips into a render-ready payload.
 *
 * Pure functions (no Ableton access) so they can be unit tested.
 * All times are in beats; the browser converts using Live's current beat
 * position, so tempo changes never desync the lyrics.
 *
 * Supported track-name flags:
 *   Vocals +LYRICS [blue] [small] [left] [mono] [nofade] [nozoom]
 *                  [nosections] [linemarker] [progress] [top] [top+2]
 *                  [+150ms] [-200ms] [+1n] [-2n] +CLIPCOLORS / +CC
 * Supported line attributes (start of a clip name):
 *   [blue] [large] [small] [tiny] [left] [center] [mono] [<] [>]
 * Supported inline syntax (rendered by the browser):
 *   **bold**  *italic*  and "\" for line breaks inside one clip
 */

export const COLOR_NAMES = [
  "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];
const SIZES = ["large", "small", "tiny"];
const ALIGNS = ["left", "center"];

/** Parses "Vocals +LYRICS [blue] [small]" into a display name and options. */
export function parseTrackName(rawName) {
  let rest = String(rawName || "");
  const opts = {
    color: null, size: null, align: null, mono: false,
    nofade: false, nozoom: false, nosections: false, linemarker: false,
    progress: false, top: null, clipColors: false, delayMs: 0, delayBeats: 0,
  };
  rest = rest.replace(/\+(CLIPCOLORS|CC)\b/gi, () => { opts.clipColors = true; return ""; });
  rest = rest.replace(/\+LYRICS\b/gi, "");
  rest = rest.replace(/\[([^\]]*)\]/g, (whole, inner) => {
    const flag = inner.trim().toLowerCase();
    let m;
    if (COLOR_NAMES.includes(flag)) opts.color = flag;
    else if (SIZES.includes(flag)) opts.size = flag;
    else if (ALIGNS.includes(flag)) opts.align = flag;
    else if (flag === "mono") opts.mono = true;
    else if (flag === "nofade") opts.nofade = true;
    else if (flag === "nozoom") opts.nozoom = true;
    else if (flag === "nosections") opts.nosections = true;
    else if (flag === "linemarker") opts.linemarker = true;
    else if (flag === "progress") opts.progress = true;
    else if (flag === "top") opts.top = 0;
    else if ((m = flag.match(/^top\+(\d+)$/))) opts.top = Number(m[1]);
    else if ((m = flag.match(/^([+-]\d+(?:\.\d+)?)ms$/))) opts.delayMs = Number(m[1]);
    else if ((m = flag.match(/^([+-]\d+(?:\.\d+)?)n$/))) opts.delayBeats = Number(m[1]);
    else return whole; // not ours (e.g. transpose) — keep in the name
    return "";
  });
  return { name: rest.replace(/\s+/g, " ").trim(), opts };
}

/** Parses leading [attributes] off one clip name. */
export function parseLine(rawText) {
  let text = String(rawText || "").trim();
  const line = { text: "", color: null, size: null, align: null, mono: false, side: null };
  for (;;) {
    const m = text.match(/^\[([^\]]*)\]\s*/);
    if (!m) break;
    const flag = m[1].trim().toLowerCase();
    if (COLOR_NAMES.includes(flag)) line.color = flag;
    else if (SIZES.includes(flag)) line.size = flag;
    else if (ALIGNS.includes(flag)) line.align = flag;
    else if (flag === "mono") line.mono = true;
    else if (flag === "<") line.side = "before";
    else if (flag === ">") line.side = "after";
    else break; // unknown bracket (e.g. a chord) stays as text
    text = text.slice(m[0].length);
  }
  line.text = text;
  return line;
}

function clipColorHex(color) {
  const n = Number(color);
  if (!Number.isFinite(n) || n < 0) return null;
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}

/** Does a line that crosses a section start belong after that header? */
function lineAfterSection(line, section) {
  if (line.side === "before") return false;
  if (line.side === "after") return true;
  if (line.start >= section.start) return true;
  if (line.end > section.start) {
    return line.end - section.start > section.start - line.start; // more than half after
  }
  return false;
}

/**
 * @param lyricTracks [{ name, clips: [{ start, end, name, color }] }]  (beats)
 * @param songs       chronological [{ id, name, time, endTime, sections: [{ id, name, time }] }]
 * @returns { tracks: [{ id, name, opts, songs: [{ songId, name, start, end, items }] }] }
 *   items: { type: "section", id, name, start } | { type: "line", start, end, ... }
 */
export function buildLyricsPayload(lyricTracks, songs) {
  const ordered = [...songs].sort((a, b) => a.time - b.time);
  const tracks = lyricTracks.map((track, index) => {
    const { name, opts } = parseTrackName(track.name);
    const lines = (track.clips || [])
      .filter((c) => Number.isFinite(Number(c.start)) && String(c.name || "").trim())
      .map((c) => {
        const start = Number(c.start);
        const end = Number.isFinite(Number(c.end)) && Number(c.end) > start ? Number(c.end) : start + 1;
        const parsed = parseLine(c.name);
        return {
          type: "line", start, end, ...parsed,
          clipColor: opts.clipColors ? clipColorHex(c.color) : null,
        };
      })
      .filter((l) => l.text !== "")
      .sort((a, b) => a.start - b.start);

    const songEntries = ordered.map((song, i) => ({
      songId: song.id,
      name: song.name,
      start: song.time,
      end: ordered[i + 1]?.time ?? null,
      items: [],
    }));

    for (const line of lines) {
      let idx = -1;
      for (let i = 0; i < songEntries.length; i++) if (songEntries[i].start <= line.start) idx = i;
      if (idx < 0) idx = 0;
      songEntries[idx]?.items.push(line);
    }

    // Interleave section headers.
    for (const entry of songEntries) {
      const song = ordered.find((s) => s.id === entry.songId);
      const sections = [...(song.sections || [])]
        .filter((s) => Number.isFinite(s.time))
        .sort((a, b) => a.time - b.time);
      if (!sections.length) continue;
      const out = [];
      let si = 0;
      for (const item of entry.items) {
        while (si < sections.length && lineAfterSection(item, { start: sections[si].time })) {
          out.push({ type: "section", id: sections[si].id, name: sections[si].name, start: sections[si].time });
          si++;
        }
        out.push(item);
      }
      // Sections with no lines after them are still useful as markers.
      while (si < sections.length) {
        const s = sections[si++];
        out.push({ type: "section", id: s.id, name: s.name, start: s.time });
      }
      entry.items = out;
    }

    return { id: `${index}:${name}`, name, opts, songs: songEntries.filter((s) => s.items.length) };
  });
  return { tracks };
}
