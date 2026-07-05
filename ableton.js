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
    await song.cueObject.jump();
  }

  async jumpToSection(songId, sectionId) {
    const song    = this.setlist.find((s) => s.id === songId);
    if (!song) throw new Error("Song not found: " + songId);
    const section = song.sections.find((s) => s.id === sectionId);
    if (!section?.cueObject) throw new Error("Section not found: " + sectionId);
    await section.cueObject.jump();
  }

  /* ── Tracks ──────────────────────────────────────────────────────────────── */
  /**
   * Returns tracks using their array INDEX as `id` — avoids the t.raw.id NaN bug.
   */
  async getTracks() {
    const tracks = await this.ableton.song.get("tracks");
    // Fetch all tracks concurrently instead of one-by-one — with a large
    // set and many tracks, sequential round-trips over the ableton-js
    // socket could take several seconds; Promise.all keeps result order
    // aligned with the original index while running requests in parallel.
    const results = await Promise.all(
      tracks.map(async (t, i) => {
        try {
          const name  = await t.get("name");
          const muted = await t.get("mute").catch(() => false);
          const solo  = await t.get("solo").catch(() => false);
          // Volume: try track-level first, then mixer_device
          let volume = null, pan = 0;
          try { volume = await t.get("volume"); } catch {}
          if (volume == null) {
            try {
              const md = await t.get("mixer_device");
              volume   = await md.get("volume").catch(() => null);
            } catch {}
          }
          try { pan = await t.get("panning"); } catch {}
          if (pan == null || pan === 0) {
            try {
              const md = await t.get("mixer_device");
              pan      = await md.get("panning").catch(() => 0);
            } catch {}
          }
          return { id: i, name, muted: !!muted, solo: !!solo,
                    volume: volume ?? 0.85, pan: pan ?? 0 };
        } catch {
          // Safe placeholder so indices stay aligned
          return { id: i, name: `Track ${i + 1}`,
                    muted: false, solo: false, volume: 0.85, pan: 0 };
        }
      })
    );
    return results;
  }

  async _getTrack(index) {
    const tracks = await this.ableton.song.get("tracks");
    const track  = tracks[index];
    if (!track) throw new Error(`Track index ${index} not found`);
    return track;
  }

  async setTrackMute(index, muted) {
    const t = await this._getTrack(index);
    await t.set("mute", !!muted);
  }

  async setTrackSolo(index, solo) {
    const t = await this._getTrack(index);
    await t.set("solo", !!solo);
  }

  async setTrackVolume(index, volume) {
    const val = parseFloat(volume);
    if (!Number.isFinite(val)) throw new Error("Invalid volume value");
    const clamped = Math.min(1, Math.max(0, val));
    const t = await this._getTrack(index);
    // Try direct first, then via mixer_device
    try {
      await t.set("volume", clamped);
    } catch {
      const md = await t.get("mixer_device");
      await md.set("volume", clamped);
    }
  }

  async setTrackPan(index, pan) {
    const val = parseFloat(pan);
    if (!Number.isFinite(val)) throw new Error("Invalid pan value");
    const clamped = Math.min(1, Math.max(-1, val));
    const t = await this._getTrack(index);
    try {
      await t.set("panning", clamped);
    } catch {
      const md = await t.get("mixer_device");
      await md.set("panning", clamped);
    }
  }

  /* ── Devices / plugin parameters ─────────────────────────────────────────── */
  async getTrackDevices(index) {
    const t = await this._getTrack(index);
    let devices;
    try { devices = await t.get("devices"); }
    catch { return []; }

    const result = await Promise.all(
      devices.map(async (device, di) => {
        try {
          const name   = await device.get("name").catch(() => `Device ${di + 1}`);
          const params = await device.get("parameters").catch(() => []);
          const paramList = (await Promise.all(
            params.map(async (p, pi) => {
              try {
                const pname = await p.get("name").catch(() => '');
                const value = await p.get("value").catch(() => 0);
                const min   = await p.get("min").catch(() => 0);
                const max   = await p.get("max").catch(() => 1);
                return (pname && max > min) ? { id: pi, name: pname, value, min, max } : null;
              } catch { return null; }
            })
          )).filter(Boolean);
          return { id: di, name, params: paramList };
        } catch {
          return null;
        }
      })
    );
    return result.filter(Boolean);
  }

  async setDeviceParam(trackIndex, deviceIndex, paramIndex, value) {
    const val = parseFloat(value);
    if (!Number.isFinite(val)) throw new Error("Invalid parameter value");
    const t = await this._getTrack(trackIndex);
    const devices = await t.get("devices");
    const device  = devices[deviceIndex];
    if (!device) throw new Error(`Device ${deviceIndex} not found`);
    const params = await device.get("parameters");
    const param  = params[paramIndex];
    if (!param)  throw new Error(`Param ${paramIndex} not found`);
    await param.set("value", val);
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