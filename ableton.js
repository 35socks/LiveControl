/**
 * ableton.js — Manages the ableton-js connection and exposes a live state object.
 */

import { Ableton } from "ableton-js";
import { parseCuePoints, mergeMetadata, findActiveSong, findActiveSection } from "./setlist.js";
import { loadMeta, clearCache } from "./storage.js";

const BROADCAST_INTERVAL_MS = 100;

export class AbletonBridge {
  constructor(onStateChange) {
    this.onStateChange = onStateChange;
    this.ableton = new Ableton({
      clientPortFile: "ableton-js-client.port",
      serverPortFile: "ableton-js-server.port",
      logger: {
        debug: () => {},
        info:  () => {},
        warn:  () => {},
        error: console.error,
      },
    });

    this.setlist = [];
    this.rawCuePoints = [];
    this.connected = false;

    this.state = {
      connected: false,
      isPlaying: false,
      tempo: 120,
      currentTime: 0,
      activeSongIndex: -1,
      activeSectionIndex: -1,
      setlist: [],
      projectName: "",
    };

    this._lastBroadcast = 0;
    this._pendingBroadcast = null;
    this._lastStopCheck = 0;
    this._firedStops = new Set();
    this._lastSeenTime = 0;
    this._listenersAttached = false;
  }

  async start() {
    await this.ableton.start();
    console.log("[ableton] Started, waiting for connection…");

    this.ableton.on("connect", async () => {
      console.log("[ableton] Connected");
      this.connected = true;
      this._firedStops.clear();
      this._lastSeenTime = 0;
      await this._onConnect();
    });

    this.ableton.on("disconnect", () => {
      console.log("[ableton] Disconnected");
      this.connected = false;
      this.state.connected = false;
      this.state.isPlaying = false;
      this._broadcastNow();
    });

    this.ableton.on("error", (e) => {
      console.error("[ableton] Error:", e?.message || e);
    });
  }

  async _onConnect() {
    try {
      const [tempo, isPlaying, projectName] = await Promise.all([
        this.ableton.song.get("tempo"),
        this.ableton.song.get("is_playing"),
        this.ableton.song.get("name").catch(() => "Untitled"),
      ]);

      await this._loadSetlist();

      this.state.connected    = true;
      this.state.tempo        = tempo;
      this.state.isPlaying    = isPlaying;
      this.state.projectName  = projectName;

      // Ableton fires "connect" on every reconnect (e.g. if the Live set is
      // reopened). Without this guard, addListener would stack a new
      // listener each time, causing broadcasts/auto-stops to fire multiple
      // times per tick and leaking memory over a long session.
      if (!this._listenersAttached) {
        this._listenersAttached = true;

        this.ableton.song.addListener("is_playing", (val) => {
          this.state.isPlaying = val;
          this._broadcastNow();
        });

        this.ableton.song.addListener("tempo", (val) => {
          this.state.tempo = val;
          this._broadcastNow();
        });

        this.ableton.song.addListener("current_song_time", (val) => {
          this.state.currentTime = val;
          this._updateActivePosition(val);
          this._checkAutoStop(val);
          this._throttledBroadcast();
        });
      }

      this._broadcastNow();
    } catch (err) {
      console.error("[ableton] Error on connect:", err.message);
    }
  }

  async _loadSetlist() {
    try {
      await clearCache();
      const cueObjects = await this.ableton.song.get("cue_points");
      this.rawCuePoints = cueObjects;
      const parsed = parseCuePoints(cueObjects);
      const meta   = await loadMeta();
      this.setlist = mergeMetadata(parsed, meta);
      this.state.setlist = this._serializeSetlist();
      console.log(`[ableton] Loaded ${this.setlist.length} songs`);
    } catch (err) {
      console.error("[ableton] Failed to load setlist:", err.message);
      this.setlist = [];
      this.state.setlist = [];
    }
  }

  _serializeSetlist() {
    return this.setlist.map((song) => ({
      id:              song.id,
      name:            song.name,
      time:            song.time,
      duration:        song.duration,
      notes:           song.notes,
      color:           song.color,
      excluded:        song.excluded,
      sections:        song.sections.map((s) => ({ id: s.id, name: s.name, time: s.time })),
      stopMarkerCount: song.stopMarkers.length,
      // Present only when a [NEXTMARKER] cue moved the real start point
      // later than the song's own cue (i.e. skips lead-in silence).
      introSkip:       song.startCue.time > song.time ? song.startCue.time : null,
    }));
  }

  _updateActivePosition(currentTime) {
    this.state.activeSongIndex    = findActiveSong(this.setlist, currentTime);
    this.state.activeSectionIndex = findActiveSection(
      this.setlist[this.state.activeSongIndex], currentTime
    );
  }

  _checkAutoStop(currentTime) {
    // If the playhead has jumped backwards (rewind, loop, manual seek),
    // "un-fire" any stop markers ahead of the new position so they can
    // trigger again on the next pass instead of being silently skipped
    // for the rest of the session.
    if (currentTime < this._lastSeenTime - 0.5) {
      for (const key of [...this._firedStops]) {
        if (parseFloat(key) >= currentTime) this._firedStops.delete(key);
      }
    }
    this._lastSeenTime = currentTime;

    if (!this.state.isPlaying) return;
    const now = Date.now();
    if (now - this._lastStopCheck < 50) return;
    this._lastStopCheck = now;
    for (const song of this.setlist) {
      for (const stop of song.stopMarkers) {
        const key = stop.time.toFixed(4);
        if (!this._firedStops.has(key) && currentTime >= stop.time) {
          this._firedStops.add(key);
          console.log(`[ableton] Auto-stop at ${stop.time.toFixed(2)}s`);
          this.ableton.song.stopPlaying().catch(() => {});
        }
      }
    }
  }

  _throttledBroadcast() {
    const now = Date.now();
    if (now - this._lastBroadcast >= BROADCAST_INTERVAL_MS) {
      this._lastBroadcast = now;
      this.onStateChange({ ...this.state });
    } else if (!this._pendingBroadcast) {
      const delay = BROADCAST_INTERVAL_MS - (now - this._lastBroadcast);
      this._pendingBroadcast = setTimeout(() => {
        this._pendingBroadcast = null;
        this._lastBroadcast = Date.now();
        this.onStateChange({ ...this.state });
      }, delay);
    }
  }

  _broadcastNow() {
    this.state.setlist = this._serializeSetlist();
    this.onStateChange({ ...this.state });
  }

  /* ── Transport ───────────────────────────────────────────────────────────── */
  async play()            { await this.ableton.song.startPlaying(); }
  async stop()            { await this.ableton.song.stopPlaying();  }
  async continuePlaying() { await this.ableton.song.continuePlaying(); }
  async jumpToNextCue()   { await this.ableton.song.jumpToNextCue(); }
  async jumpToPrevCue()   { await this.ableton.song.jumpToPrevCue(); }
  async setTempo(bpm) {
    const val = parseFloat(bpm);
    if (!Number.isFinite(val)) throw new Error("Invalid tempo value");
    const clamped = Math.min(999, Math.max(20, val));
    await this.ableton.song.set("tempo", clamped);
  }

  async jumpToSong(songId) {
    const song = this.setlist.find((s) => s.id === songId);
    if (!song?.cueObject) throw new Error("Song not found: " + songId);
    // If a [NEXTMARKER] cue was found inside this song, jump there instead
    // of the song's own start — skips any lead-in silence before the music
    // actually begins.
    const target = song.startCue?.cueObject || song.cueObject;
    await target.jump();
  }

  async jumpToSection(songId, sectionId) {
    const song    = this.setlist.find((s) => s.id === songId);
    if (!song) throw new Error("Song not found: " + songId);
    const section = song.sections.find((s) => s.id === sectionId);
    if (!section?.cueObject) throw new Error("Section not found: " + sectionId);
    await section.cueObject.jump();
  }

  /* ── Setlist meta ────────────────────────────────────────────────────────── */
  async reloadSetlist() {
    await this._loadSetlist();
    this._broadcastNow();
  }

  updateSongMeta(songId, updates) {
    const song = this.setlist.find((s) => s.id === songId);
    if (!song) return;
    Object.assign(song, updates);
    this._broadcastNow();
  }

  reorderSetlist(orderedIds) {
    const map      = new Map(this.setlist.map((s) => [s.id, s]));
    const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
    for (const song of this.setlist) {
      if (!orderedIds.includes(song.id)) reordered.push(song);
    }
    this.setlist = reordered;
    this._broadcastNow();
  }
}
