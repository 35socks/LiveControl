/**
 * setlist.js — Parses Ableton cue points into a structured setlist
 *
 * Naming conventions supported:
 *   Song Title          → song entry (plain name)
 *   [Song Title]        → song entry (bracket notation)
 *   > Section Name      → section within current song
 *   --- STOP ---        → auto-stop marker
 *   [STOP]              → auto-stop marker
 *   [NEXTMARKER]         → the song's real starting point (skips lead-in
 *                          silence) — jumping to the song jumps here instead
 *   // anything         → comment, ignored
 */

import { randomUUID } from "crypto";

export function parseCuePoints(cuePoints) {
  const setlist = [];
  let currentSong = null;
  let currentSongHasExplicitStart = false;

  const sortedCues = [...cuePoints].sort((a, b) => a.raw.time - b.raw.time);

  for (let i = 0; i < sortedCues.length; i++) {
    const cue = sortedCues[i];
    const name = (cue.raw.name || "").trim();
    const time = cue.raw.time;

    // Skip comments
    if (name.startsWith("//")) continue;

    // Stop marker
    if (isStopMarker(name)) {
      if (currentSong) {
        currentSong.stopMarkers.push({ time, cueObject: cue });
      }
      continue;
    }

    // Real starting point of the current song (skips lead-in silence).
    // Only the first one found after a song's own cue point is used.
    if (isNextMarker(name)) {
      if (currentSong && !currentSongHasExplicitStart) {
        currentSong.startCue = { time, cueObject: cue };
        currentSongHasExplicitStart = true;
      }
      continue;
    }

    // Section within current song
    if (name.startsWith(">")) {
      if (currentSong) {
        const sectionName = name.slice(1).trim();
        currentSong.sections.push({
          id: randomUUID(),
          name: sectionName,
          time,
          cueObject: cue,
        });
      }
      continue;
    }

    // New song
    const songName = cleanName(name);
    currentSong = {
      id: randomUUID(),
      name: songName,
      time,
      cueObject: cue,
      // Defaults to the song's own cue; overwritten if a [NEXTMARKER]
      // cue is found before the next song entry.
      startCue: { time, cueObject: cue },
      sections: [],
      stopMarkers: [],
      // These get merged from storage (notes, color, excluded)
      notes: "",
      color: "",
      excluded: false,
    };
    currentSongHasExplicitStart = false;
    setlist.push(currentSong);
  }

  // Calculate durations
  for (let i = 0; i < setlist.length; i++) {
    const song = setlist[i];
    const nextSongTime =
      i + 1 < setlist.length ? setlist[i + 1].time : null;
    song.duration = nextSongTime !== null ? nextSongTime - song.time : null;
  }

  return setlist;
}

function isStopMarker(name) {
  const lower = name.toLowerCase();
  return (
    lower === "[stop]" ||
    lower === "stop" ||
    lower.includes("--- stop ---") ||
    lower.startsWith("[stop]")
  );
}

function isNextMarker(name) {
  const lower = name.toLowerCase().replace(/\s+/g, "");
  return lower === "[nextmarker]" || lower === "nextmarker";
}

function cleanName(name) {
  // Remove surrounding brackets: [Song Title] → Song Title
  return name.replace(/^\[(.+)\]$/, "$1").trim();
}

/**
 * Merge saved metadata (notes, colors, order, excluded) onto a parsed setlist.
 * meta = { songs: { [originalName]: { notes, color, excluded } }, order: [name, ...] }
 */
export function mergeMetadata(setlist, meta) {
  if (!meta) return setlist;

  // Apply per-song metadata
  for (const song of setlist) {
    const saved = meta.songs?.[song.name];
    if (saved) {
      song.notes = saved.notes ?? "";
      song.color = saved.color ?? "";
      song.excluded = saved.excluded ?? false;
    }
  }

  // Apply custom order if saved
  if (meta.order && meta.order.length > 0) {
    const orderMap = new Map(meta.order.map((name, i) => [name, i]));
    setlist.sort((a, b) => {
      const ai = orderMap.has(a.name) ? orderMap.get(a.name) : 9999;
      const bi = orderMap.has(b.name) ? orderMap.get(b.name) : 9999;
      return ai - bi;
    });
  }

  return setlist;
}

/**
 * Format seconds as MM:SS
 */
export function formatTime(seconds) {
  if (seconds == null || isNaN(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Given a setlist and current playhead time, find which song is active.
 * Returns the song index or -1.
 */
export function findActiveSong(setlist, currentTime) {
  if (!setlist.length) return -1;
  let activeIdx = -1;
  for (let i = 0; i < setlist.length; i++) {
    if (currentTime >= setlist[i].time) {
      activeIdx = i;
    } else {
      break;
    }
  }
  return activeIdx;
}

/**
 * Given a song and current playhead time, find active section index.
 */
export function findActiveSection(song, currentTime) {
  if (!song?.sections?.length) return -1;
  let activeIdx = -1;
  for (let i = 0; i < song.sections.length; i++) {
    if (currentTime >= song.sections[i].time) {
      activeIdx = i;
    } else {
      break;
    }
  }
  return activeIdx;
}
