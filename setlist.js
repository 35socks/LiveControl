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

export function parseCuePoints(cuePoints, sectionClips = []) {
  const setlist = [];
  let currentSong = null;
  let currentSongHasExplicitStart = false;
  let currentSongEndMarker = null;

  const sortedCues = [...cuePoints].sort((a, b) => a.raw.time - b.raw.time);

  for (let i = 0; i < sortedCues.length; i++) {
    const cue = sortedCues[i];
    const name = (cue.raw.name || "").trim();
    const time = cue.raw.time;

    // Skip comments
    if (name.startsWith("//") || name.startsWith("*") || name.startsWith("[STOP] SETSTOP;")) continue;

    // AbleSet uses a song-end locator to end the current song without
    // stopping the transport. This is distinct from an AUTOSTOP marker.
    if (/^(?:>{3}\s*)?SONG\s+END\b/i.test(name)) {
      if (currentSong) {
        currentSong.songEndMarkers.push({ time, cueObject: cue });
        currentSongEndMarker = time;
      }
      continue;
    }

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
        const rawSectionName = name.slice(1).trim();
        const loopFlag = rawSectionName.match(/\s+\+(LOOPFULL|LOOP)\s*$/i);
        const startsEnd = /\+END\b/i.test(rawSectionName);
        const sectionName = rawSectionName
          .replace(/\s+\+(?:LOOPFULL|LOOP|SKIP|END)\b/gi, "")
          .trim();
        currentSong.sections.push({
          id: randomUUID(),
          name: sectionName,
          loopMode: loopFlag ? loopFlag[1].toUpperCase() : null,
          skipped: /\+SKIP\b/i.test(rawSectionName),
          startsEnd,
          time,
          cueObject: cue,
        });
      }
      continue;
    }

    // New song
    // A leading dot on a song cue marks the end of the song before it.
    // The cue itself still starts the next song and is not displayed with
    // the dot in AbleSet's setlist.
    const songEndBeforeNext = /^\.\s*/.test(name);
    if (songEndBeforeNext && currentSong) {
      currentSong.songEndMarkers.push({ time, cueObject: cue });
      currentSongEndMarker = time;
    }
    const songName = cleanName(name.replace(/^\.\s*/, ""));
    currentSong = {
      id: randomUUID(),
      name: songName,
      time,
      // Stable across reloads, including when two songs share a title.
      orderKey: `${songName}@${Number(time).toFixed(3)}`,
      cueObject: cue,
      // Defaults to the song's own cue; overwritten if a [NEXTMARKER]
      // cue is found before the next song entry.
      startCue: { time, cueObject: cue },
      sections: [],
      stopMarkers: [],
      songEndMarkers: [],
      // These get merged from storage (notes, color, excluded)
      notes: "",
      color: "",
      excluded: false,
    };
    currentSongHasExplicitStart = false;
    currentSongEndMarker = null;
    setlist.push(currentSong);
  }

  // Section clips are AbleSet's alternative to section locators. The
  // locator at the same beat always wins, matching AbleSet's documented
  // precedence. Clip length is intentionally ignored: its start defines
  // the section and the next section defines its end.
  for (const clip of sectionClips) {
    const time = Number(clip.time);
    if (!Number.isFinite(time)) continue;
    const song = [...setlist].reverse().find((item) => item.time <= time);
    if (!song || song.sections.some((section) => Math.abs(section.time - time) < 0.001)) continue;
    const rawName = String(clip.name || "").trim();
    if (!rawName) continue;
    const loopFlag = rawName.match(/\s+\+(LOOPFULL|LOOP)\s*$/i);
    song.sections.push({
      id: clip.id || randomUUID(),
      name: rawName.replace(/\s+\+(?:LOOPFULL|LOOP|SKIP|END)\b/gi, "").trim(),
      loopMode: loopFlag ? loopFlag[1].toUpperCase() : null,
      skipped: /\+SKIP\b/i.test(rawName),
      startsEnd: /\+END\b/i.test(rawName),
      time,
      cueObject: null,
    });
  }

  for (const song of setlist) {
    song.sections.sort((a, b) => a.time - b.time);
    let afterEnd = false;
    for (const section of song.sections) {
      section.skipped = section.skipped || section.startsEnd || afterEnd;
      if (section.startsEnd) afterEnd = true;
    }
  }

  // Calculate durations
  for (let i = 0; i < setlist.length; i++) {
    const song = setlist[i];
    const nextSongTime = i + 1 < setlist.length ? setlist[i + 1].time : null;
    const stopTime = song.stopMarkers
      .map((stop) => stop.time)
      .filter((time) => time > song.time)
      .sort((a, b) => a - b)[0] ?? null;
    const songEndTime = song.songEndMarkers
      .map((marker) => marker.time)
      .filter((time) => time > song.time)
      .sort((a, b) => a - b)[0] ?? null;
    const endTime = stopTime ?? songEndTime ?? nextSongTime;
    song.songEndTime = songEndTime;
    song.endTime = endTime;
    song.duration = endTime !== null ? endTime - song.time : null;

    // +END keeps optional sections available for direct jumps but removes
    // their time from the normal song duration and progress display.
    const endFlagSection = song.sections.find((section) => section.startsEnd);
    if (endFlagSection) {
      song.displayEndTime = Math.min(song.endTime ?? endFlagSection.time, endFlagSection.time);
      song.durationWithoutEnd = song.displayEndTime - song.time;
    } else {
      song.displayEndTime = song.endTime;
      song.durationWithoutEnd = song.duration;
    }
  }

  return setlist;
}

function isStopMarker(name) {
  const lower = name.toLowerCase();
  return (
    lower === "[stop]" ||
    lower === "stop" ||
    lower.includes("autostop") ||
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
  return name.replace(/^\.(\s*)/, "").replace(/^\[(.+)\]$/, "$1").trim();
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
    const orderMap = new Map(meta.order.map((item, i) => [
      typeof item === "string" ? item : item?.key,
      i,
    ]).filter(([key]) => key));
    setlist.sort((a, b) => {
      // Read old name-only order files while preferring occurrence-safe keys.
      const ai = orderMap.get(a.orderKey) ?? orderMap.get(a.name) ?? 9999;
      const bi = orderMap.get(b.orderKey) ?? orderMap.get(b.name) ?? 9999;
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
