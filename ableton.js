/**
 * ableton.js — Manages the ableton-js connection and exposes a live state object.
 */

import { Ableton } from "ableton-js";
import { parseCuePoints, mergeMetadata, findActiveSong, findActiveSection } from "./setlist.js";
import { loadMeta, clearCache, setSetting } from "./storage.js";
import { buildLyricsPayload } from "./lyrics-parser.js";

const BROADCAST_INTERVAL_MS = 100;

export class AbletonBridge {
  constructor(onStateChange, onLyricsChange = () => {}) {
    this.onStateChange = onStateChange;
    this.onLyricsChange = onLyricsChange;
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
    this.lyricTracks = [];
    this.lyrics = { tracks: [] };
    this.guideTracks = [];
    this._jumpGuideCueId = null;
    this.connected = false;
    this.jumpMode = "quantized";

    this.state = {
      connected: false,
      isPlaying: false,
      tempo: 120,
      currentTime: 0,
      currentBeat: 0,
      signatureNumerator: 4,
      signatureDenominator: 4,
      activeSongIndex: -1,
      activeSectionIndex: -1,
      setlist: [],
      jumpMode: this.jumpMode,
      pendingJump: null,
      stopAfterSong: this.stopAfterSong,
      projectName: "",
      setlistName: "",
      loop: null,
    };

    this._lastBroadcast = 0;
    this._pendingBroadcast = null;
    this._lastStopCheck = 0;
    this._firedStops = new Set();
    this._firedSongEnds = new Set();
    this._lastSeenTime = 0;
    this._currentBeatTime = 0;
    this._loopBeatRange = null;
    this._loopAwaitingReturn = false;
    this._suppressedLoopCueId = null;
    this._listenersAttached = false;
    this._parkedBeat = null;
    this._stopHandling = false;
    this._liveLoopKey = null;   // last loop range pushed to Live ("off" when disabled)
    this._liveLoopOk = false;   // true once Live's own loop brackets are confirmed
    this._liveLoopChain = Promise.resolve();
  }

  async start() {
    // Attach listeners before start(): Ableton.start() waits for (and emits)
    // the initial connection before its promise resolves. Registering after
    // the await misses that first event and leaves the UI disconnected.
    this.ableton.on("connect", async () => {
      console.log("[ableton] Connected");
      this.connected = true;
      this._firedStops.clear();
      this._firedSongEnds.clear();
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

    await this.ableton.start();
    console.log("[ableton] Started and connected");
  }

  async _onConnect() {
    try {
      const [tempo, isPlaying, projectName, currentTime, sigNum, sigDen] = await Promise.all([
        this.ableton.song.get("tempo"),
        this.ableton.song.get("is_playing"),
        this.ableton.song.get("name").catch(() => "Untitled"),
        this.ableton.song.get("current_song_time").catch(() => 0),
        this.ableton.song.get("signature_numerator").catch(() => 4),
        this.ableton.song.get("signature_denominator").catch(() => 4),
      ]);

      await this._loadSetlist();

      this.state.connected    = true;
      this.state.tempo        = tempo;
      this.state.isPlaying    = isPlaying;
      this.state.projectName  = projectName;
      this.state.setlist      = this._serializeSetlist();
      this._currentBeatTime   = currentTime;
      this.state.currentBeat  = currentTime;
      this.state.signatureNumerator   = sigNum;
      this.state.signatureDenominator = sigDen;
      this.state.currentTime  = currentTime * this._secondsPerBeat();
      this._lastSeenTime      = currentTime;
      this._updateActivePosition(currentTime);

      // Ableton fires "connect" on every reconnect (e.g. if the Live set is
      // reopened). Without this guard, addListener would stack a new
      // listener each time, causing broadcasts/auto-stops to fire multiple
      // times per tick and leaking memory over a long session.
      if (!this._listenersAttached) {
        this._listenersAttached = true;

        this.ableton.song.addListener("is_playing", (val) => {
          this.state.isPlaying = val;
          if (val) this._parkedBeat = null;
          if (!val) this._loopAwaitingReturn = false;
          if (!val && this.pendingJump?.mode === "manual") {
            this._performPendingJump(true).catch((err) => console.error("[ableton] Manual queued jump failed:", err.message));
          }
          this._broadcastNow();
        });

        this.ableton.song.addListener("tempo", (val) => {
          this.state.tempo = val;
          this.state.setlist = this._serializeSetlist();
          this.state.currentTime = this._currentBeatTime * this._secondsPerBeat();
          this._updateActivePosition(this._currentBeatTime);
          this._broadcastNow();
        });

        this.ableton.song.addListener("signature_numerator", (val) => {
          this.state.signatureNumerator = val;
          this._broadcastNow();
        });

        this.ableton.song.addListener("signature_denominator", (val) => {
          this.state.signatureDenominator = val;
          this._broadcastNow();
        });

        this.ableton.song.addListener("current_song_time", (val) => {
          this._currentBeatTime = val;
          this.state.currentBeat = val;
          this.state.currentTime = val * this._secondsPerBeat();
          this._updateActivePosition(val);
          this._checkAutoStop(val);
          this._throttledBroadcast();
        });
      }

      // Live may have been reopened: forget what we pushed and re-apply.
      this._liveLoopKey = null;
      this._liveLoopOk = false;
      this._applyLiveLoop(this._loopBeatRange);

      this._broadcastNow();
    } catch (err) {
      console.error("[ableton] Error on connect:", err.message);
    }
  }

  async _loadSetlist() {
    try {
      await clearCache();
      const [cueObjects, tracks] = await Promise.all([
        this.ableton.song.get("cue_points"),
        this.ableton.song.get("tracks").catch(() => []),
      ]);
      this.rawCuePoints = cueObjects;
      const sectionClips = [];
      this.lyricTracks = [];
      this.guideTracks = [];
      for (const track of tracks) {
        const trackName = String(track.raw?.name || "");
        const isSections = /^sections$/i.test(trackName.trim()) || /\+SECTIONS\b/i.test(trackName);
        const isLyrics = /\+LYRICS\b/i.test(trackName);
        const isLoopGuide = /\+LOOPGUIDE\b/i.test(trackName);
        const isJumpGuide = /\+JUMPGUIDE\b/i.test(trackName);
        if (isLoopGuide) this.guideTracks.push({ track, mode: "loop", lastMute: null });
        if (isJumpGuide) this.guideTracks.push({ track, mode: "jump", lastMute: null });
        if (!isSections && !isLyrics) continue;
        const clips = await track.get("arrangement_clips").catch(() => []);
        if (isLyrics) {
          this.lyricTracks.push({
            // Keep the full track name; lyrics-parser reads its [flags].
            name: trackName,
            clips: clips.map((clip) => clip.raw || {}).map((raw) => ({
              start: Number(raw.start_time), end: Number(raw.end_time),
              name: raw.name, color: raw.color,
            })),
          });
        }
        if (!isSections) continue;
        for (const clip of clips) {
          const raw = clip.raw || {};
          if (Number.isFinite(Number(raw.start_time))) {
            sectionClips.push({ id: raw.id, name: raw.name, time: Number(raw.start_time) });
          }
        }
      }
      const parsed = parseCuePoints(cueObjects, sectionClips);
      const meta   = await loadMeta();
      this.jumpMode = ["quantized", "end-of-section", "end-of-song", "dynamic", "manual"].includes(meta.settings?.jumpMode)
        ? meta.settings.jumpMode
        : this.jumpMode;
      this.stopAfterSong = !!meta.settings?.stopAfterSong;
      this.state.jumpMode = this.jumpMode;
      this.state.stopAfterSong = this.stopAfterSong;
      this.state.setlistName = typeof meta.settings?.setlistName === "string" ? meta.settings.setlistName : "";
      this.setlist = mergeMetadata(parsed, meta);
      this.state.setlist = this._serializeSetlist();
      this._buildLyrics();
      console.log(`[ableton] Loaded ${this.setlist.length} songs`);
    } catch (err) {
      console.error("[ableton] Failed to load setlist:", err.message);
      this.setlist = [];
      this.state.setlist = [];
      this._buildLyrics();
    }
  }

  _secondsPerBeat() {
    const tempo = Number(this.state.tempo);
    return Number.isFinite(tempo) && tempo > 0 ? 60 / tempo : 0.5;
  }

  // Lyrics stay in beats and travel separately from the 10 Hz state tick;
  // browsers sync them against state.currentBeat.
  _buildLyrics() {
    try {
      this.lyrics = buildLyricsPayload(this.lyricTracks, this.setlist.map((song) => ({
        id: song.id, name: song.name, time: song.time, endTime: song.endTime,
        sections: song.sections.map((s) => ({ id: s.id, name: s.name, time: s.time })),
      })));
    } catch (err) {
      console.error("[ableton] Failed to build lyrics:", err.message);
      this.lyrics = { tracks: [] };
    }
    this.onLyricsChange(this.lyrics);
  }

  _serializeSetlist() {
    const scale = this._secondsPerBeat();
    return this.setlist.map((song) => ({
      id:              song.id,
      name:            song.name,
      orderKey:        song.orderKey,
      time:            song.time * scale,
      duration:        song.duration == null ? null : song.duration * scale,
      notes:           song.notes,
      color:           song.color,
      excluded:        song.excluded,
      sections:        song.sections.map((s) => ({ id: s.id, name: s.name, time: s.time * scale, loopMode: s.loopMode, skipped: !!s.skipped })),
      stopMarkerCount: song.stopMarkers.length,
      songEndTime:     song.songEndTime == null ? null : song.songEndTime * scale,
      displayDuration: song.durationWithoutEnd == null ? null : song.durationWithoutEnd * scale,
      // Present only when a [NEXTMARKER] cue moved the real start point
      // later than the song's own cue (i.e. skips lead-in silence).
      introSkip:       song.startCue.time > song.time ? song.startCue.time * scale : null,
    }));
  }

  _updateActivePosition(currentTime) {
    // The setlist can be reordered for a performance. Resolve playback
    // position in Ableton cue chronology, then map it to display order.
    const chronological = [...this.setlist].sort((a, b) => a.time - b.time);
    const chronologicalIndex = findActiveSong(chronological, currentTime);
    const activeSong = chronological[chronologicalIndex];
    this.state.activeSongIndex = activeSong ? this.setlist.indexOf(activeSong) : -1;
    this.state.activeSectionIndex = findActiveSection(
      activeSong, currentTime
    );
    const activeSection = activeSong?.sections?.[this.state.activeSectionIndex];
    if (this._jumpGuideCueId && activeSection?.id === this._jumpGuideCueId) this._jumpGuideCueId = null;
    this._syncCueLoop(activeSong, this.state.activeSectionIndex);
    this._syncGuideTracks(activeSong, activeSection);
  }

  _syncGuideTracks(song, section) {
    const loopGuideActive = !!(this.state.loop?.active && this.state.loop.sectionId &&
      this.state.loop.songId === song?.id && this.state.loop.sectionId === section?.id);
    for (const guide of this.guideTracks) {
      const shouldMute = guide.mode === "loop" ? !loopGuideActive : !this._jumpGuideCueId;
      if (guide.lastMute === shouldMute) continue;
      guide.lastMute = shouldMute;
      guide.track.set("mute", shouldMute).catch((err) => console.error("[ableton] Guide-track mute failed:", err.message));
    }
  }

  _syncCueLoop(song, sectionIndex) {
    const section = song?.sections?.[sectionIndex];
    if (this._suppressedLoopCueId && this._suppressedLoopCueId !== section?.id) this._suppressedLoopCueId = null;
    if (this.state.loop?.source === "manual") return;
    if (!section?.loopMode || section.id === this._suppressedLoopCueId) {
      if (this.state.loop?.source === "cue") {
        this.state.loop = null;
        this._loopBeatRange = null;
        this._applyLiveLoop(null);
      }
      return;
    }
    const end = song.sections[sectionIndex + 1]?.time ?? song.endTime;
    if (!Number.isFinite(end) || end <= section.time) return;
    const scale = this._secondsPerBeat();
    this._loopBeatRange = { start: section.time, end };
    this._applyLiveLoop(this._loopBeatRange);
    this.state.loop = {
      active: true, source: "cue", mode: section.loopMode,
      songId: song.id, sectionId: section.id,
      startTime: section.time * scale, endTime: end * scale,
    };
  }

  _checkAutoStop(currentTime) {
    const previousTime = this._lastSeenTime;
    // If the playhead has jumped backwards (rewind, loop, manual seek),
    // "un-fire" any stop markers ahead of the new position so they can
    // trigger again on the next pass instead of being silently skipped
    // for the rest of the session.
    if (currentTime < this._lastSeenTime - 0.5) {
      for (const key of [...this._firedStops]) {
        if (parseFloat(key) >= currentTime) this._firedStops.delete(key);
      }
      for (const key of [...this._firedSongEnds]) {
        if (parseFloat(key) >= currentTime) this._firedSongEnds.delete(key);
      }
    }
    this._lastSeenTime = currentTime;

    // The loop belongs to the LiveControl session, so every connected
    // performance device sees the same target and the host performs the jump.
    const loop = this.state.loop;
    if (loop?.active && this._loopBeatRange && currentTime < this._loopBeatRange.start + 0.5) {
      this._loopAwaitingReturn = false;
    }
    if (loop?.active && this._loopBeatRange && !this._liveLoopOk && this.state.isPlaying && !this._loopJumpPending && !this._loopAwaitingReturn &&
        previousTime < this._loopBeatRange.end && currentTime >= this._loopBeatRange.end) {
      this._loopJumpPending = true;
      this._loopAwaitingReturn = true;
      const jump = loop.sectionId
        ? this.jumpToSection(loop.songId, loop.sectionId)
        : this.jumpToSong(loop.songId);
      jump.catch((err) => {
        console.error("[ableton] Loop jump failed:", err.message);
        this._loopAwaitingReturn = false;
      }).finally(() => { this._loopJumpPending = false; });
      return;
    }

    if (!this.state.isPlaying) return;
    const now = Date.now();
    if (now - this._lastStopCheck < 50) {
      // Skipped tick: keep the old reference time so a marker crossed during
      // this tick is still detected on the next one instead of being missed.
      this._lastSeenTime = previousTime;
      return;
    }
    this._lastStopCheck = now;
    if (this.pendingJump && this._pendingJumpBoundaryCrossed(previousTime, currentTime)) {
      this._performPendingJump(false).catch((err) => console.error("[ableton] Queued jump failed:", err.message));
      return;
    }
    const stops = this.setlist
      .flatMap((song) => song.stopMarkers.map((stop) => ({ ...stop, song })))
      .sort((a, b) => a.time - b.time);
    for (const stop of stops) {
        const key = stop.time.toFixed(4);
        if (!this._firedStops.has(key) && previousTime < stop.time && currentTime >= stop.time) {
          this._firedStops.add(key);
          console.log(`[ableton] Stop marker at beat ${stop.time.toFixed(2)}`);
          this._handleStopMarker(stop.song).catch((err) => console.error("[ableton] Stop-marker handling failed:", err.message));
          return;
        }
    }

    const songsByTime = [...this.setlist].sort((a, b) => a.time - b.time);
    if (this.stopAfterSong) {
      for (const song of songsByTime) {
        const end = song.songEndTime ?? song.endTime;
        if (Number.isFinite(end) && previousTime < end && currentTime >= end) {
          this.ableton.song.stopPlaying().catch(() => {});
          return;
        }
      }
    }
    // SONG END advances to the next song while playback keeps running. A
    // plain AUTOSTOP marker or Stop After Song preference halts transport.
    for (let i = 0; i < songsByTime.length; i++) {
      const song = songsByTime[i];
      for (const marker of song.songEndMarkers) {
        const key = marker.time.toFixed(4);
        if (this._firedSongEnds.has(key) || previousTime >= marker.time || currentTime < marker.time) continue;
        this._firedSongEnds.add(key);
        if (this.stopAfterSong) {
          this.ableton.song.stopPlaying().catch(() => {});
          return;
        }
        const nextSong = songsByTime.slice(i + 1).find((candidate) => !candidate.excluded);
        if (nextSong) this.jumpToSong(nextSong.id).catch((err) => console.error("[ableton] Song-end jump failed:", err.message));
        else this.ableton.song.stopPlaying().catch(() => {});
        return;
      }
    }
  }

  // [STOP] marker reached: halt transport, then park the playhead on the next
  // song's start so pressing play starts that song instead of rewinding.
  async _handleStopMarker(song) {
    if (this._stopHandling) return;
    this._stopHandling = true;
    try {
      // Next song in setlist (display) order, skipping excluded songs.
      const index = this.setlist.indexOf(song);
      const nextSong = this.setlist.slice(index + 1).find((candidate) => !candidate.excluded);

      // Stop first: a jump while playing would be quantized and keep playing.
      await this.ableton.song.stopPlaying();
      if (!nextSong) return;

      await this.jumpToSong(nextSong.id, true);
      this._parkedBeat = nextSong.startCue?.time ?? nextSong.time;
      console.log(`[ableton] Parked at "${nextSong.name}"`);
    } finally {
      this._stopHandling = false;
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
    this.state.currentBeat = this._currentBeatTime;
    this.state.currentTime = this._currentBeatTime * this._secondsPerBeat();
    this.state.setlist = this._serializeSetlist();
    this.onStateChange({ ...this.state });
  }

  /* ── Transport ───────────────────────────────────────────────────────────── */
  async play() {
    // After a [STOP] marker the playhead is parked on the next song. Live's
    // Play button would go back to the arrangement start marker, so continue
    // from the playhead instead.
    if (this._parkedBeat != null) {
      this._parkedBeat = null;
      await this.ableton.song.continuePlaying();
    } else {
      await this.ableton.song.startPlaying();
    }
  }
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

  async jumpToSong(songId, immediate = false) {
    const song = this.setlist.find((s) => s.id === songId);
    if (!song?.cueObject) throw new Error("Song not found: " + songId);
    // If a [NEXTMARKER] cue was found inside this song, jump there instead
    // of the song's own start — skips any lead-in silence before the music
    // actually begins.
    const explicitStart = song.startCue?.time > song.time;
    const firstPlayableSection = song.sections.find((section) => !section.skipped);
    const skipIntroSections = song.sections.length > 0 && song.sections[0].skipped && firstPlayableSection;
    const target = explicitStart
      ? song.startCue.cueObject
      : skipIntroSections
        ? firstPlayableSection.cueObject
        : song.startCue?.cueObject || song.cueObject;
    const targetTime = skipIntroSections ? firstPlayableSection.time : song.startCue?.time ?? song.time;
    if (target?.jump && !immediate) await target.jump();
    else await this.ableton.song.set("current_song_time", targetTime);
  }

  async jumpToSection(songId, sectionId, immediate = false) {
    const song    = this.setlist.find((s) => s.id === songId);
    if (!song) throw new Error("Song not found: " + songId);
    const section = song.sections.find((s) => s.id === sectionId);
    const currentSong = this.setlist[this.state.activeSongIndex];
    const targetIndex = song.sections.findIndex((item) => item.id === sectionId);
    const isNextSection = currentSong?.id === songId && targetIndex === this.state.activeSectionIndex + 1;
    this._jumpGuideCueId = isNextSection ? null : sectionId;
    this._syncGuideTracks(currentSong, currentSong?.sections?.[this.state.activeSectionIndex]);
    if (section?.cueObject && !immediate) await section.cueObject.jump();
    else if (Number.isFinite(section?.time)) await this.ableton.song.set("current_song_time", section.time);
    else throw new Error("Section not found: " + sectionId);
  }

  // Tap-a-lyric-line: move the playhead straight to a beat position.
  async jumpToBeat(beat) {
    const value = Number(beat);
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid beat");
    await this.ableton.song.set("current_song_time", value);
  }

  async setStopAfterSong(enabled) {
    this.stopAfterSong = !!enabled;
    this.state.stopAfterSong = this.stopAfterSong;
    await setSetting("stopAfterSong", this.stopAfterSong);
    this._broadcastNow();
  }

  async setSetlistName(name) {
    const clean = String(name ?? "").trim().slice(0, 80);
    this.state.setlistName = clean;
    await setSetting("setlistName", clean);
    this._broadcastNow();
  }

  async setJumpMode(mode) {
    const modes = new Set(["quantized", "end-of-section", "end-of-song", "dynamic", "manual"]);
    if (!modes.has(mode)) throw new Error("Unsupported jump mode");
    this.jumpMode = mode;
    this.state.jumpMode = mode;
    await setSetting("jumpMode", mode);
    this._broadcastNow();
  }

  async requestJump(type, songId, sectionId = null) {
    const song = this.setlist.find((item) => item.id === songId);
    if (!song || song.excluded) throw new Error("Song not found or excluded");
    const section = sectionId ? song.sections.find((item) => item.id === sectionId) : null;
    if (sectionId && !section) throw new Error("Section not found");
    if (this.jumpMode === "quantized") {
      return type === "section" ? this.jumpToSection(songId, sectionId) : this.jumpToSong(songId);
    }
    if (this.jumpMode === "manual" && !this.state.isPlaying) {
      return type === "section" ? this.jumpToSection(songId, sectionId, true) : this.jumpToSong(songId, true);
    }
    this.pendingJump = { type, songId, sectionId, mode: this.jumpMode };
    if (type === "section") {
      const currentSong = this.setlist[this.state.activeSongIndex];
      const targetIndex = song.sections.findIndex((item) => item.id === sectionId);
      const isNextSection = currentSong?.id === songId && targetIndex === this.state.activeSectionIndex + 1;
      this._jumpGuideCueId = isNextSection ? null : sectionId;
      this._syncGuideTracks(currentSong, currentSong?.sections?.[this.state.activeSectionIndex]);
    }
    this.state.pendingJump = {
      ...this.pendingJump,
      songName: song.name,
      sectionName: section?.name || null,
    };
    this._broadcastNow();
    return this.state.pendingJump;
  }

  async commitPendingJump(quantized = true) {
    return this._performPendingJump(!quantized);
  }

  cancelPendingJump() {
    this.pendingJump = null;
    this.state.pendingJump = null;
    this._jumpGuideCueId = null;
    const song = this.setlist[this.state.activeSongIndex];
    this._syncGuideTracks(song, song?.sections?.[this.state.activeSectionIndex]);
    this._broadcastNow();
  }

  async _performPendingJump(immediate) {
    const pending = this.pendingJump;
    if (!pending) return;
    if (pending.type === "section") {
      const song = this.setlist.find((item) => item.id === pending.songId);
      const targetIndex = song?.sections?.findIndex((item) => item.id === pending.sectionId) ?? -1;
      const currentSong = this.setlist[this.state.activeSongIndex];
      const isNextSection = currentSong?.id === pending.songId && targetIndex === this.state.activeSectionIndex + 1;
      this._jumpGuideCueId = isNextSection ? null : pending.sectionId;
    }
    this.pendingJump = null;
    this.state.pendingJump = null;
    this._broadcastNow();
    if (pending.type === "section") return this.jumpToSection(pending.songId, pending.sectionId, immediate);
    return this.jumpToSong(pending.songId, immediate);
  }

  _pendingJumpBoundaryCrossed(previousTime, currentTime) {
    const pending = this.pendingJump;
    const activeSong = [...this.setlist].sort((a, b) => a.time - b.time)
      .filter((song) => !song.excluded && song.time <= previousTime).at(-1);
    if (!activeSong) return false;
    const mode = pending.mode === "dynamic"
      ? pending.type === "section" ? "end-of-section" : "end-of-song"
      : pending.mode;
    let boundary;
    if (mode === "end-of-section") {
      const index = findActiveSection(activeSong, previousTime);
      boundary = activeSong.sections[index + 1]?.time ?? activeSong.songEndTime ?? activeSong.endTime;
    } else if (mode === "end-of-song") {
      boundary = activeSong.songEndTime ?? activeSong.endTime;
    }
    return Number.isFinite(boundary) && previousTime < boundary && currentTime >= boundary;
  }

  async setLoop(songId, sectionId = null) {
    const song = this.setlist.find((item) => item.id === songId);
    if (!song || song.excluded) throw new Error("Choose an included song or section to loop");
    const sectionIndex = sectionId ? song.sections.findIndex((item) => item.id === sectionId) : -1;
    if (sectionId && sectionIndex < 0) throw new Error("Section not found");
    const startTime = sectionIndex >= 0 ? song.sections[sectionIndex].time : song.startCue.time;
    const endTime = sectionIndex >= 0
      ? (song.sections[sectionIndex + 1]?.time ?? song.endTime)
      : (song.sections[0]?.time ?? song.endTime);
    if (!Number.isFinite(endTime) || endTime <= startTime) {
      throw new Error("This section has no following cue to mark the loop end");
    }
    this._loopJumpPending = false;
    this._loopAwaitingReturn = false;
    this._loopBeatRange = { start: startTime, end: endTime };
    await this._applyLiveLoop(this._loopBeatRange);
    const scale = this._secondsPerBeat();
    this._suppressedLoopCueId = null;
    this.state.loop = { active: true, source: "manual", songId, sectionId, startTime: startTime * scale, endTime: endTime * scale };
    this._lastSeenTime = this._currentBeatTime;
    this._syncGuideTracks(this.setlist.find((item) => item.id === songId), sectionIndex >= 0 ? song.sections[sectionIndex] : null);
    this._broadcastNow();
    return this.state.loop;
  }

  async clearLoop() {
    this._loopJumpPending = false;
    this._loopAwaitingReturn = false;
    const currentSong = this.setlist[this.state.activeSongIndex];
    const currentSection = currentSong?.sections[this.state.activeSectionIndex];
    if (currentSection?.loopMode && this.state.loop?.sectionId === currentSection.id) {
      this._suppressedLoopCueId = currentSection.id;
    }
    if (this.state.loop?.source === "cue") this._suppressedLoopCueId = this.state.loop.sectionId;
    this.state.loop = null;
    this._loopBeatRange = null;
    this._lastSeenTime = this._currentBeatTime;
    await this._applyLiveLoop(null);
    this._syncGuideTracks(currentSong, currentSection);
    this._broadcastNow();
  }

  /**
   * Push a loop range (in beats) to Ableton's real loop brackets and switch
   * Live's loop on, or switch it off when range is null. Calls are serialised
   * so rapid toggles can't interleave, and every write is read back to
   * confirm Live accepted it. Resolves either way; _liveLoopOk says whether
   * the brackets are confirmed (otherwise the software loop-jump covers).
   */
  _applyLiveLoop(range) {
    const key = range ? `${range.start}:${range.end}` : "off";
    if (key === this._liveLoopKey) return this._liveLoopChain;
    this._liveLoopKey = key;
    this._liveLoopChain = this._liveLoopChain.then(async () => {
      const song = this.ableton.song;
      const close = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
      try {
        if (!range) {
          await song.set("loop", false);
          this._liveLoopOk = false;
          return;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          await song.set("loop_start", range.start);
          await song.set("loop_length", range.end - range.start);
          await song.set("loop", true);
          const [start, length, on] = await Promise.all([
            song.get("loop_start"), song.get("loop_length"), song.get("loop"),
          ]);
          if (close(start, range.start) && close(length, range.end - range.start) && on) {
            this._liveLoopOk = true;
            return;
          }
        }
        throw new Error("Live did not accept the loop brackets");
      } catch (err) {
        this._liveLoopOk = false;
        console.error("[ableton] Could not set Live loop brackets:", err.message);
      }
    });
    return this._liveLoopChain;
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
    if (!Array.isArray(orderedIds) || orderedIds.length !== this.setlist.length ||
        new Set(orderedIds).size !== this.setlist.length ||
        orderedIds.some((id) => !this.setlist.some((song) => song.id === id))) {
      throw new Error("Order must contain every song exactly once");
    }
    const map      = new Map(this.setlist.map((s) => [s.id, s]));
    const reordered = orderedIds.map((id) => map.get(id));
    this.setlist = reordered;
    this._broadcastNow();
  }
}
