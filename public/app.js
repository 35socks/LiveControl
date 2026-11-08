/**
 * app.js — LiveControl frontend
 */

/* ── State ───────────────────────────────────────────────────────────────── */
let state = {
  connected: false,
  isPlaying: false,
  tempo: 120,
  currentTime: 0,
  activeSongIndex: -1,
  activeSectionIndex: -1,
  setlist: [],
  projectName: '',
  setlistName: '',
  loop: null,
};

let expandedSongId = null;

// Songs whose sections are collapsed. Keyed by orderKey (stable across
// reloads, unlike song.id) and remembered in this browser.
const collapsedSongs = new Set((() => {
  try { return JSON.parse(localStorage.getItem('lc-collapsed') || '[]'); } catch { return []; }
})());
function saveCollapsed() {
  try { localStorage.setItem('lc-collapsed', JSON.stringify([...collapsedSongs])); } catch {}
}
const songKey = (song) => song.orderKey || song.name;

function updateSetlistName() {
  const proj = state.projectName && !/^untitled$/i.test(state.projectName) ? state.projectName : '';
  const name = state.setlistName || proj || 'Setlist';
  const el = document.getElementById('setlist-name');
  if (el.textContent !== name) el.textContent = name;
  document.title = `${name} · LiveControl`;
}

function updateCollapseAllLabel() {
  const btn = document.getElementById('collapse-all');
  if (!btn) return;
  const withSections = state.setlist.filter((s) => !s.excluded && s.sections.length > 0);
  btn.classList.toggle('hidden', withSections.length === 0);
  const anyOpen = withSections.some((s) => !collapsedSongs.has(songKey(s)));
  btn.textContent = anyOpen ? 'Collapse all' : 'Expand all';
}

// Modal state
let pendingJump = null;
let pendingNotesSong = null;
let pendingColorSong = null;

// Drag state
let dragSongId = null;

// Countdown
let _countdownBeat = 0;

// Played-section tracking
let playedSections = new Set();
let _lastActiveSong = -1;

// Auto-scroll tracking
let _lastScrollSong = -1;
let _lastScrollSection = -1;

/* ── WebSocket ───────────────────────────────────────────────────────────── */
let ws = null;
let reconnectDelay = 1000;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen  = () => { reconnectDelay = 1000; };
  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'state') applyState(msg.payload);
    } catch (e) { console.error('[ws] Parse error', e); }
  };
  ws.onclose = () => {
    updateConnDot(false);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
  ws.onerror = () => ws.close();
}

/* ── State application ───────────────────────────────────────────────────── */
function updateJumpControls() {
  const mode = document.getElementById('jump-mode');
  if (mode && state.jumpMode) mode.value = state.jumpMode;
  const stopAfterSong = document.getElementById('stop-after-song');
  if (stopAfterSong) stopAfterSong.checked = !!state.stopAfterSong;
  const pending = state.pendingJump;
  const bar = document.getElementById('jump-queue-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', !pending);
  if (pending) {
    const target = pending.sectionName ? `${pending.songName} · ${pending.sectionName}` : pending.songName;
    document.getElementById('jump-queue-name').textContent = target || 'Selected cue';
  }
}

function applyState(newState) {
  const wasConnected = state.connected;
  const previousSetlist = JSON.stringify(state.setlist);
  state = { ...state, ...newState };
  _stateRx = performance.now();
  updateJumpControls();
  updateSetlistName();

  if (state.connected) {
    document.getElementById('connection-overlay').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
  } else {
    document.getElementById('connection-overlay').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    return;
  }

  // Clear played sections on song change
  if (state.activeSongIndex !== _lastActiveSong) {
    playedSections.clear();
    _lastActiveSong = state.activeSongIndex;
  }
  if (state.activeSongIndex >= 0 && state.activeSectionIndex >= 0) {
    const sec = state.setlist[state.activeSongIndex]?.sections?.[state.activeSectionIndex];
    if (sec) playedSections.add(sec.id);
  }

  updateConnDot(state.connected);
  updateTransport();
  updatePerformanceView();
  updateProgress();
  updateSectionProgress();
  updateCountdown();
  updateLoopUI();
  autoScroll();

  if (!wasConnected || JSON.stringify(state.setlist) !== previousSetlist) {
    renderSetlist();
  } else {
    updateSetlistActive();
  }
}

/* ── DOM updaters ─────────────────────────────────────────────────────────── */
function updateConnDot(connected) {
  const dot = document.getElementById('conn-dot');
  dot.className = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
  const label = document.getElementById('conn-label');
  if (label) label.textContent = connected ? 'Connected' : 'Disconnected';
}

let _stateRx = performance.now();
let _vmKey = '';

// Beat position now, extrapolated from the last broadcast so the bar counter
// and metronome stay smooth between the server's 100ms updates.
function livePosition() {
  const tempo = Number(state.tempo) > 0 ? Number(state.tempo) : 120;
  const elapsed = state.isPlaying ? Math.min((performance.now() - _stateRx) / 1000, 0.5) : 0;
  const beat = Number.isFinite(state.currentBeat) ? state.currentBeat : (state.currentTime * tempo) / 60;
  return { beat: Math.max(0, beat + elapsed * tempo / 60), seconds: Math.max(0, (state.currentTime || 0) + elapsed) };
}

function updatePosition() {
  const num = Math.min(16, Math.max(1, Math.round(state.signatureNumerator) || 4));
  const den = Math.max(1, Math.round(state.signatureDenominator) || 4);
  const beatLen = 4 / den;               // quarter-note beats per metronome beat
  const barLen  = num * beatLen;
  const { beat, seconds } = livePosition();
  const bar = Math.floor(beat / barLen) + 1;
  const beatInBar = Math.min(num, Math.floor((beat % barLen) / beatLen) + 1);

  const barsEl = document.getElementById('transport-bars');
  const barsText = `${bar}.${beatInBar}`;
  if (barsEl.textContent !== barsText) barsEl.textContent = barsText;
  const timeEl = document.getElementById('transport-time');
  const timeText = formatTimecode(seconds);
  if (timeEl.textContent !== timeText) timeEl.textContent = timeText;

  const vm = document.getElementById('visual-metronome');
  if (vm.children.length !== num) {
    vm.innerHTML = Array.from({ length: num }, (_, i) => `<span class="vm-pip">${i + 1}</span>`).join('');
    _vmKey = '';
  }
  const key = state.isPlaying ? String(beatInBar) : '';
  if (key !== _vmKey) {
    _vmKey = key;
    [...vm.children].forEach((pip, i) => {
      pip.classList.toggle('on', state.isPlaying && i + 1 === beatInBar);
      pip.classList.toggle('downbeat', state.isPlaying && i === 0 && beatInBar === 1);
    });
  }
}

function positionLoop() {
  updatePosition();
  requestAnimationFrame(positionLoop);
}

function updateTransport() {
  document.getElementById('tempo-value').textContent = Math.round(state.tempo * 10) / 10;
  document.getElementById('transport-sig').textContent =
    `${state.signatureNumerator || 4}/${state.signatureDenominator || 4}`;

  const btn = document.getElementById('btn-play');
  btn.classList.toggle('playing', state.isPlaying);
  btn.querySelector('.icon-play').classList.toggle('hidden', state.isPlaying);
  btn.querySelector('.icon-stop').classList.toggle('hidden', !state.isPlaying);
  updatePosition();
}

function updateProgress() {
  const fill = document.getElementById('progress-fill');
  const song  = state.setlist[state.activeSongIndex];
  const duration = songDuration(song);
  // Whole-song sweep shown on a collapsed song's row (same look as sections).
  document.querySelectorAll('.song-progress-fill').forEach((el) => { el.style.width = '0%'; });
  if (!duration) { fill.style.width = '0%'; return; }
  const pct = Math.min(100, Math.max(0, ((state.currentTime - song.time) / duration) * 100));
  fill.style.width = pct + '%';
  const rowFill = document.querySelector(`.song-item[data-song-id="${CSS.escape(song.id)}"] .song-progress-fill`);
  if (rowFill) rowFill.style.width = pct + '%';
}

function updatePerformanceView() {
  const song = state.setlist[state.activeSongIndex];
  const section = song?.sections?.[state.activeSectionIndex];
  document.getElementById('performance-song').textContent = song?.name || 'Ready';
  document.getElementById('performance-section').textContent = section?.name || 'Waiting for section';
  const lyrics = document.getElementById('performance-lyrics');
  lyrics.replaceChildren();
  for (const track of state.lyrics || []) {
    const line = track.lines.filter(item => item.time <= state.currentTime).at(-1);
    if (!line) continue;
    const row = document.createElement('div');
    row.className = 'performance-lyric-line';
    if (track.name) {
      const label = document.createElement('span');
      label.className = 'performance-lyric-track';
      label.textContent = track.name;
      row.appendChild(label);
    }
    const text = document.createElement('span');
    text.textContent = line.text;
    row.appendChild(text);
    lyrics.appendChild(row);
  }
  lyrics.classList.toggle('hidden', !lyrics.childElementCount);
  document.getElementById('performance-tempo').textContent = `${Math.round(state.tempo * 10) / 10} BPM`;
  const loop = state.loop?.active ? state.loop : null;
  const loopingHere = loop && song?.id === loop.songId && (!loop.sectionId || loop.sectionId === section?.id);
  const badge = document.getElementById('performance-loop');
  badge.classList.toggle('hidden', !loopingHere);
  badge.textContent = loopingHere ? `LOOPING · ${section?.name || song?.name}` : '';
  const progress = document.getElementById('performance-progress-fill');
  const duration = songDuration(song);
  const end = section && (song.sections[state.activeSectionIndex + 1]?.time ?? (duration == null ? null : song.time + duration));
  progress.style.width = end && end > section.time
    ? `${Math.min(100, Math.max(0, ((state.currentTime - section.time) / (end - section.time)) * 100))}%`
    : '0%';
  const next = section && song?.sections?.[state.activeSectionIndex + 1];
  document.getElementById('performance-next').textContent = next?.name || 'Next song';
  document.getElementById('performance-remaining').textContent = next
    ? formatTime(Math.max(0, next.time - state.currentTime))
    : (end ? formatTime(Math.max(0, end - state.currentTime)) : '');
}

function updateSectionProgress() {
  document.querySelectorAll('.section-progress-fill').forEach(el => el.style.width = '0%');
  const song = state.setlist[state.activeSongIndex];
  if (!song?.sections?.length) return;
  const si = state.activeSectionIndex;
  if (si < 0) return;
  const sec = song.sections[si];
  const nextTime = si + 1 < song.sections.length
    ? song.sections[si + 1].time
    : (songDuration(song) == null ? null : song.time + songDuration(song));
  if (nextTime === null) return;
  const pct = Math.min(100, Math.max(0, ((state.currentTime - sec.time) / (nextTime - sec.time)) * 100));
  const el = document.querySelector(`.section-item[data-section-id="${sec.id}"] .section-progress-fill`);
  if (el) el.style.width = pct + '%';
}

/* ── Auto-scroll ─────────────────────────────────────────────────────────── */
function autoScroll() {
  if (state.activeSongIndex === _lastScrollSong && state.activeSectionIndex === _lastScrollSection) return;
  _lastScrollSong    = state.activeSongIndex;
  _lastScrollSection = state.activeSectionIndex;
  requestAnimationFrame(() => {
    let target = document.querySelector('.section-item.active-section');
    // A collapsed song hides its sections; scroll to the song row instead.
    if (!target || target.offsetParent === null) target = document.querySelector('.song-item.active');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

/* ── Countdown (last bar before next marker) ──────────────────────────────── */
function getNextMarkerTime() {
  const song = state.setlist[state.activeSongIndex];
  if (!song) return null;
  const sections = song.sections || [];
  const si = state.activeSectionIndex;
  if (si >= 0 && si + 1 < sections.length) return sections[si + 1].time;
  if (si < 0 && sections.length > 0)        return sections[0].time;
  return songDuration(song) == null ? null : song.time + songDuration(song);
}

function updateCountdown() {
  const overlay = document.getElementById('countdown-overlay');
  if (!state.isPlaying) { overlay.classList.add('hidden'); _countdownBeat = 0; return; }
  const next = getNextMarkerTime();
  if (next === null) { overlay.classList.add('hidden'); return; }
  const bps = state.tempo / 60;
  const twoBars = 8 / bps;
  const timeUntil = next - state.currentTime;
  if (timeUntil <= 0 || timeUntil > twoBars) { overlay.classList.add('hidden'); _countdownBeat = 0; return; }
  const beat = Math.min(8, Math.floor((1 - timeUntil / twoBars) * 8) + 1);
  const display = beat <= 4 ? null : beat - 4;
  if (display === null) { overlay.classList.add('hidden'); _countdownBeat = 0; return; }
  overlay.classList.remove('hidden');
  if (display !== _countdownBeat) {
    _countdownBeat = display;
    const num = document.getElementById('countdown-number');
    num.textContent = display;
    num.classList.remove('countdown-pulse');
    void num.offsetWidth;
    num.classList.add('countdown-pulse');
  }
}

/* ── Shared loop indicator ────────────────────────────────────────────────── */
function updateLoopUI() {
  const loop = state.loop?.active ? state.loop : null;
  const button = document.getElementById('btn-loop');
  if (button) {
    button.classList.toggle('active', !!loop);
    button.title = loop ? 'Turn off loop' : 'Loop current section';
  }
  document.querySelectorAll('.looping-section, .looping-song').forEach((el) => {
    el.classList.remove('looping-section', 'looping-song');
    el.querySelector('.loop-indicator')?.remove();
  });
  if (!loop) return;
  const songItem = document.querySelector(`.song-item[data-song-id="${CSS.escape(loop.songId)}"]`);
  if (loop.sectionId) {
    const section = songItem?.querySelector(`.section-item[data-section-id="${CSS.escape(loop.sectionId)}"]`);
    if (section) {
      section.classList.add('looping-section');
      const badge = document.createElement('span');
      badge.className = 'loop-indicator';
      badge.textContent = 'LOOP';
      section.querySelector('.section-name')?.after(badge);
    }
  } else if (songItem) {
    songItem.classList.add('looping-song');
    const badge = document.createElement('span');
    badge.className = 'loop-indicator';
    badge.textContent = 'LOOP';
    songItem.querySelector('.song-name')?.after(badge);
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const COLORS = {
  '':     { bg: '#333' },
  red:    { bg: '#ef4444' }, orange: { bg: '#f97316' },
  yellow: { bg: '#eab308' }, green:  { bg: '#22c55e' },
  teal:   { bg: '#14b8a6' }, blue:   { bg: '#3b82f6' },
  purple: { bg: '#a855f7' }, pink:   { bg: '#ec4899' },
};

function formatTime(secs) {
  if (secs == null || isNaN(secs)) return '--:--';
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTimecode(secs) {
  if (secs == null || isNaN(secs)) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function totalDuration(setlist) {
  return setlist.filter(s => !s.excluded && songDuration(s)).reduce((sum, s) => sum + songDuration(s), 0);
}

function songDuration(song) {
  return song?.displayDuration ?? song?.duration ?? null;
}

function showToast(message, kind = 'error') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast${kind === 'info' ? ' toast--info' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast--out');
    setTimeout(() => el.remove(), 200);
  }, 3200);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(path, opts);
    let data;
    try { data = await res.json(); }
    catch { data = { ok: res.ok }; }
    if (!res.ok || data.ok === false) {
      showToast(data.error || `Request failed (${res.status})`);
    }
    return data;
  } catch (e) {
    // Network failure — connection banner already communicates the
    // disconnected state, but a toast helps for one-off request drops
    // while otherwise connected.
    showToast('Could not reach LiveControl server');
    return { ok: false, error: e.message };
  }
}

/* ── Setlist rendering ───────────────────────────────────────────────────── */
function renderSetlist() {
  const container  = document.getElementById('setlist');
  const durationEl = document.getElementById('setlist-duration');
  const visible    = state.setlist.filter(s => !s.excluded);

  durationEl.textContent = totalDuration(state.setlist) > 0 ? formatTime(totalDuration(state.setlist)) : '';

  if (!visible.length) {
    container.innerHTML = `
      <div class="setlist-empty">
        <div class="setlist-empty-title">No songs found</div>
        <div class="setlist-empty-sub">Add cue points in Ableton's Arrangement view,<br>then click reload ↺</div>
      </div>`;
    return;
  }

  container.innerHTML = '';
  visible.forEach((song, visibleIdx) => {
    const realIdx  = state.setlist.indexOf(song);
    const isActive = realIdx === state.activeSongIndex;
    const isExpanded = expandedSongId === song.id;
    const colorBg = COLORS[song.color]?.bg || COLORS[''].bg;

    const item = document.createElement('div');
    const isQueuedSong = state.pendingJump?.songId === song.id;
    const hasSections = song.sections.length > 0;
    const isCollapsed = hasSections && collapsedSongs.has(songKey(song));
    item.className = `song-item${isActive ? ' active' : ''}${isExpanded ? ' expanded' : ''}${isCollapsed ? ' collapsed' : ''}${song.excluded ? ' excluded' : ''}${isQueuedSong ? ' queued-song' : ''}`;
    item.dataset.songId  = song.id;
    item.dataset.realIdx = realIdx;

    // Sections — always visible
    let sectionsHtml = '';
    if (song.sections.length > 0) {
      sectionsHtml = song.sections.map((sec, si) => {
        const isActiveSection = isActive && si === state.activeSectionIndex;
        const wasPlayed       = isActive && playedSections.has(sec.id) && !isActiveSection;
        const duration = songDuration(song);
        const sectionEnd = song.sections[si + 1]?.time ?? (duration == null ? null : song.time + duration);
        const sectionDuration = sectionEnd == null ? null : Math.max(0, sectionEnd - sec.time);
        return `
          <div class="section-item${isActiveSection ? ' active-section' : ''}${wasPlayed ? ' played-section' : ''}${sec.skipped ? ' skipped-section' : ''}${state.pendingJump?.sectionId === sec.id ? ' queued-section' : ''}"
               data-section-id="${sec.id}" data-song-id="${song.id}"${sec.skipped ? ' title="Skipped in the normal set flow; click to jump here"' : ''}>
            <div class="section-progress-bar"><div class="section-progress-fill"></div></div>
            <div class="section-dot"></div>
            <div class="section-name">${esc(sec.name)}</div>
            <div class="section-time">${formatTime(sectionDuration)}</div>
          </div>`;
      }).join('');
    }

    const notesPreview = song.notes
      ? `<div class="song-notes-preview">${esc(song.notes)}</div>` : '';

    const actionsHtml = isExpanded ? `
      <div class="song-actions">
        <button class="action-btn btn-notes" data-song-id="${song.id}">
          <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          Notes
        </button>
        <button class="action-btn btn-color" data-song-id="${song.id}">
          <svg viewBox="0 0 24 24"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
          Color
        </button>
        <button class="action-btn btn-exclude action-btn--danger" data-song-id="${song.id}">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z"/></svg>
          ${song.excluded ? 'Include' : 'Skip'}
        </button>
      </div>` : '';

    const introSkipHtml = song.introSkip != null
      ? `<div class="song-intro-skip" title="Jumping skips intro silence to ${formatTime(song.introSkip)}">
           <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.9V8.1z"/><path d="M16 6h2v12h-2z"/></svg>
         </div>` : '';

    item.innerHTML = `
      <div class="song-row">
        <div class="song-progress-bar"><div class="song-progress-fill"></div></div>
        <svg class="drag-handle" viewBox="0 0 24 24"><path d="M20 9H4v2h16V9zM4 15h16v-2H4v2z"/></svg>
        <button class="song-toggle${hasSections ? '' : ' song-toggle--empty'}" type="button" aria-label="${isCollapsed ? 'Expand' : 'Collapse'} sections of ${esc(song.name)}" aria-expanded="${!isCollapsed}"${hasSections ? '' : ' tabindex="-1"'}>
          <svg viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        </button>
        <div class="song-color-dot" style="background:${colorBg}"></div>
        <div class="song-number">${visibleIdx + 1}</div>
        <div class="song-name">${esc(song.name)}</div>
        <div class="song-collapsed-hint">${isActive && state.activeSectionIndex >= 0 ? '› ' + esc(song.sections[state.activeSectionIndex]?.name || '') : ''}</div>
        ${introSkipHtml}
        <div class="song-duration">${formatTime(songDuration(song))}</div>
        <svg class="song-chevron" viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
      </div>
      ${notesPreview}
      ${sectionsHtml || actionsHtml ? `<div class="song-expanded">${sectionsHtml}${actionsHtml}</div>` : ''}
    `;

    // Collapse / expand this song's sections
    item.querySelector('.song-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hasSections) return;
      const key = songKey(song);
      const nowCollapsed = !collapsedSongs.has(key);
      if (nowCollapsed) collapsedSongs.add(key); else collapsedSongs.delete(key);
      saveCollapsed();
      item.classList.toggle('collapsed', nowCollapsed);
      const toggle = e.currentTarget;
      toggle.setAttribute('aria-expanded', String(!nowCollapsed));
      toggle.setAttribute('aria-label', `${nowCollapsed ? 'Expand' : 'Collapse'} sections of ${song.name}`);
      updateCollapseAllLabel();
      if (!nowCollapsed && isActive) requestAnimationFrame(() => {
        item.querySelector('.section-item.active-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

    // Row tap
    item.querySelector('.song-row').addEventListener('click', (e) => {
      if (e.target.closest('.drag-handle')) return;
      if (isExpanded) {
        expandedSongId = null;
        renderSetlist();
      } else if (isActive) {
        expandedSongId = song.id;
        renderSetlist();
      } else {
        pendingJump = song;
        document.getElementById('modal-song-name').textContent = song.name;
        document.getElementById('jump-modal').classList.remove('hidden');
      }
    });

    // Section jumps
    item.querySelectorAll('.section-item').forEach(el => {
      el.addEventListener('click', () => {
        api('POST', `/api/jump/section/${song.id}/${el.dataset.sectionId}`);
      });
    });

    item.querySelector('.btn-notes')?.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingNotesSong = song;
      document.getElementById('notes-modal-name').textContent = song.name;
      document.getElementById('notes-textarea').value = song.notes || '';
      document.getElementById('notes-modal').classList.remove('hidden');
    });

    item.querySelector('.btn-color')?.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingColorSong = song;
      renderColorSwatches(song.color);
      document.getElementById('color-modal').classList.remove('hidden');
    });

    item.querySelector('.btn-exclude')?.addEventListener('click', (e) => {
      e.stopPropagation();
      api('POST', `/api/song/${song.id}/exclude`, { excluded: !song.excluded })
        .then(() => { expandedSongId = null; });
    });

    // Pointer-based drag works with mouse, touch and trackpad. Move by stable
    // song IDs so hidden/excluded rows and changed indices cannot corrupt order.
    const handle = item.querySelector('.drag-handle');
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      dragSongId = song.id;
      handle.setPointerCapture(e.pointerId);
      item.classList.add('dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragSongId) return;
      document.querySelectorAll('.song-item.drag-over').forEach(el => el.classList.remove('drag-over'));
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.song-item');
      if (target && target.dataset.songId !== dragSongId) target.classList.add('drag-over');
    });
    const finishDrag = (e) => {
      if (!dragSongId) return;
      const sourceId = dragSongId;
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.song-item');
      document.querySelectorAll('.song-item.drag-over, .song-item.dragging').forEach(el => el.classList.remove('drag-over', 'dragging'));
      dragSongId = null;
      if (!target || target.dataset.songId === sourceId) return;
      const order = state.setlist.map(s => s.id);
      const [moved] = order.splice(order.indexOf(sourceId), 1);
      let index = order.indexOf(target.dataset.songId);
      if (e.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2) index++;
      order.splice(index, 0, moved);
      api('POST', '/api/setlist/reorder', { order });
    };
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);

    container.appendChild(item);
  });

  updateCollapseAllLabel();
  updateSectionProgress();
  updateLoopUI();
  autoScroll();
}

function updateSetlistActive() {
  document.querySelectorAll('.song-item').forEach((el) => {
    const realIdx  = parseInt(el.dataset.realIdx);
    const isActive = realIdx === state.activeSongIndex;
    el.classList.toggle('active', isActive);

    const hint = el.querySelector('.song-collapsed-hint');
    if (hint) {
      const secName = isActive ? state.setlist[realIdx]?.sections?.[state.activeSectionIndex]?.name : '';
      const text = secName ? `› ${secName}` : '';
      if (hint.textContent !== text) hint.textContent = text;
    }

    el.querySelectorAll('.section-item').forEach((sec, si) => {
      const isActiveSec = isActive && si === state.activeSectionIndex;
      const wasPlayed   = isActive && playedSections.has(sec.dataset.sectionId) && !isActiveSec;
      sec.classList.toggle('active-section',  isActiveSec);
      sec.classList.toggle('played-section',  wasPlayed);
    });
  });

  updateTransport();
  updatePerformanceView();
  updateProgress();
  updateSectionProgress();
  updateCountdown();
  updateLoopUI();
  autoScroll();
}

/* ── Color swatches ──────────────────────────────────────────────────────── */
function renderColorSwatches(currentColor) {
  const container = document.getElementById('color-swatches');
  container.innerHTML = '';
  ['', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'].forEach(key => {
    const swatch = document.createElement('div');
    swatch.className = `color-swatch${key === currentColor ? ' selected' : ''}`;
    swatch.dataset.color = key;
    if (key) swatch.style.background = COLORS[key].bg;
    swatch.addEventListener('click', () => {
      if (!pendingColorSong) return;
      api('POST', `/api/song/${pendingColorSong.id}/color`, { color: key });
      document.getElementById('color-modal').classList.add('hidden');
      pendingColorSong = null;
    });
    container.appendChild(swatch);
  });
}

/* ── Event bindings ──────────────────────────────────────────────────────── */
document.getElementById('btn-play').addEventListener('click', () => {
  state.isPlaying ? api('POST', '/api/stop') : api('POST', '/api/play');
});
document.getElementById('btn-prev').addEventListener('click',   () => api('POST', '/api/prev-cue'));
document.getElementById('btn-next').addEventListener('click',   () => api('POST', '/api/next-cue'));
document.getElementById('btn-reload').addEventListener('click', () => api('POST', '/api/reload'));
document.getElementById('jump-mode').addEventListener('change', (event) => {
  api('POST', '/api/jump-mode', { mode: event.target.value });
});
document.getElementById('stop-after-song').addEventListener('change', (event) => {
  api('POST', '/api/settings/stop-after-song', { enabled: event.target.checked });
});
document.getElementById('jump-queue-quantized').addEventListener('click', () => api('POST', '/api/jump/commit', { quantized: true }));
document.getElementById('jump-queue-now').addEventListener('click', () => api('POST', '/api/jump/commit', { quantized: false }));
document.getElementById('jump-queue-cancel').addEventListener('click', () => api('POST', '/api/jump/cancel'));

let performanceMode = false;
document.getElementById('view-toggle').addEventListener('click', () => {
  performanceMode = !performanceMode;
  document.getElementById('app').classList.toggle('performance-mode', performanceMode);
  document.getElementById('view-toggle').textContent = performanceMode ? 'Setlist' : 'Performance';
  document.getElementById('view-toggle').setAttribute('aria-pressed', String(performanceMode));
  updatePerformanceView();
});

// Loop — capture the current section position at moment of toggle
document.getElementById('btn-loop').addEventListener('click', () => {
  if (state.loop?.active) {
    api('POST', '/api/loop', { active: false });
    return;
  }
  const song = state.setlist[state.activeSongIndex];
  if (!song) { showToast('Start a song before enabling a loop', 'info'); return; }
  const section = song.sections?.[state.activeSectionIndex];
  api('POST', '/api/loop', { songId: song.id, sectionId: section?.id || null });
});

// Tempo
document.getElementById('tempo-value').addEventListener('click', () => {
  const cur   = Math.round(state.tempo * 10) / 10;
  const input = prompt('Set tempo (BPM):', cur);
  if (input === null) return;
  const bpm = parseFloat(input);
  if (!isNaN(bpm) && bpm >= 20 && bpm <= 999) api('POST', '/api/tempo', { bpm });
});

// Jump modal
document.getElementById('modal-confirm').addEventListener('click', () => {
  if (pendingJump) { api('POST', `/api/jump/song/${pendingJump.id}`); expandedSongId = pendingJump.id; }
  document.getElementById('jump-modal').classList.add('hidden');
  pendingJump = null;
});
document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('jump-modal').classList.add('hidden'); pendingJump = null;
});
document.querySelector('#jump-modal .modal-backdrop').addEventListener('click', () => {
  document.getElementById('jump-modal').classList.add('hidden'); pendingJump = null;
});

// Notes modal
document.getElementById('notes-save').addEventListener('click', () => {
  if (pendingNotesSong)
    api('POST', `/api/song/${pendingNotesSong.id}/notes`,
        { notes: document.getElementById('notes-textarea').value });
  document.getElementById('notes-modal').classList.add('hidden');
  pendingNotesSong = null;
});
document.getElementById('notes-cancel').addEventListener('click', () => {
  document.getElementById('notes-modal').classList.add('hidden'); pendingNotesSong = null;
});
document.querySelector('#notes-modal .modal-backdrop').addEventListener('click', () => {
  document.getElementById('notes-modal').classList.add('hidden'); pendingNotesSong = null;
});

// Color modal
document.getElementById('color-cancel').addEventListener('click', () => {
  document.getElementById('color-modal').classList.add('hidden'); pendingColorSong = null;
});
document.querySelector('#color-modal .modal-backdrop').addEventListener('click', () => {
  document.getElementById('color-modal').classList.add('hidden'); pendingColorSong = null;
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space')      { e.preventDefault(); document.getElementById('btn-play').click(); }
  if (e.code === 'ArrowRight') api('POST', '/api/next-cue');
  if (e.code === 'ArrowLeft')  api('POST', '/api/prev-cue');
});

/* ── Theme switcher ──────────────────────────────────────────────────────── */
const THEMES = ['midnight', 'crimson', 'tape', 'mono'];
function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'midnight';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('lc-theme', theme); } catch {}
  document.querySelectorAll('.theme-option').forEach(btn =>
    btn.classList.toggle('theme-option--active', btn.dataset.theme === theme));
}
(function initTheme() {
  let saved = 'midnight';
  try { saved = localStorage.getItem('lc-theme') || 'midnight'; } catch {}
  applyTheme(saved);
})();

const themeBtn  = document.getElementById('theme-btn');
const themeMenu = document.getElementById('theme-menu');
themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  themeMenu.classList.toggle('hidden');
});
document.querySelectorAll('.theme-option').forEach(btn => {
  btn.addEventListener('click', () => {
    applyTheme(btn.dataset.theme);
    themeMenu.classList.add('hidden');
  });
});
document.addEventListener('click', (e) => {
  if (!themeMenu.classList.contains('hidden') && !themeMenu.contains(e.target) && e.target !== themeBtn) {
    themeMenu.classList.add('hidden');
  }
});

/* ── Init ────────────────────────────────────────────────────────────────── */
connect();

requestAnimationFrame(positionLoop);

// Collapse / expand every song
document.getElementById('collapse-all').addEventListener('click', () => {
  const withSections = state.setlist.filter((s) => s.sections.length > 0);
  const anyOpen = withSections.some((s) => !collapsedSongs.has(songKey(s)));
  withSections.forEach((s) => { if (anyOpen) collapsedSongs.add(songKey(s)); else collapsedSongs.delete(songKey(s)); });
  saveCollapsed();
  renderSetlist();
});

// Rename the setlist (stored by the server, shared across devices)
document.getElementById('setlist-name').addEventListener('click', () => {
  const current = document.getElementById('setlist-name').textContent;
  const input = prompt('Setlist name:', current === 'Setlist' ? '' : current);
  if (input === null) return;
  api('POST', '/api/settings/setlist-name', { name: input });
});

/* ── Connect a device (QR) ───────────────────────────────────────────────── */
let _qrUrls = [];

function showQrAddress(index) {
  const target = _qrUrls[index];
  if (!target) return;
  document.getElementById('qr-image').src = `/api/connect/qr.svg?i=${index}&t=${Date.now()}`;
  document.getElementById('qr-url').textContent = target.url;
}

async function openQrModal() {
  const modal = document.getElementById('qr-modal');
  const select = document.getElementById('qr-address');
  const res = await api('GET', '/api/connect');
  _qrUrls = res?.urls || [];
  if (!_qrUrls.length) {
    showToast('No network address found. Connect this computer to Wi-Fi.', 'info');
    return;
  }
  select.innerHTML = _qrUrls.map((u, i) => `<option value="${i}">${esc(u.url)} (${esc(u.label)})</option>`).join('');
  select.classList.toggle('hidden', _qrUrls.length < 2);
  showQrAddress(0);
  modal.classList.remove('hidden');
}

document.getElementById('qr-btn').addEventListener('click', openQrModal);
document.getElementById('qr-address').addEventListener('change', (e) => showQrAddress(Number(e.target.value)));
document.getElementById('qr-close').addEventListener('click', () => document.getElementById('qr-modal').classList.add('hidden'));
document.querySelector('#qr-modal .modal-backdrop').addEventListener('click', () => document.getElementById('qr-modal').classList.add('hidden'));
document.getElementById('qr-copy').addEventListener('click', async () => {
  const url = document.getElementById('qr-url').textContent;
  try { await navigator.clipboard.writeText(url); showToast('Address copied', 'info'); }
  catch { showToast('Select the address and copy it manually', 'info'); }
});
