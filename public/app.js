/**
 * app.js — LiveControl frontend
 */

/* ── Protected track names (mixer + tracks panel) ─────────────────────────── */
const PROTECTED = ['song name', 'clicks', 'cues'];
const isProtected = (name) => PROTECTED.includes((name || '').toLowerCase().trim());

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
};

let expandedSongId = null;
let activeTab = 'setlist';

// Modal state
let pendingJump = null;
let pendingNotesSong = null;
let pendingColorSong = null;
let pluginTrackContext = null; // { id, name }

// Drag state
let dragSrcIndex = null;

// Loop — captures the section at the moment the button is pressed
let loopActive = false;
let loopTargetSong = -1;
let loopTargetSection = -1;
let _loopLastJump = 0; // timestamp debounce

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
function applyState(newState) {
  const wasConnected = state.connected;
  const wasLen = state.setlist.length;
  state = { ...state, ...newState };

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
  updateHeader();
  updateTransport();
  updateProgress();
  updateSectionProgress();
  updateCountdown();
  checkLoop();
  autoScroll();

  if (!wasConnected || state.setlist.length !== wasLen) {
    renderSetlist();
  } else {
    updateSetlistActive();
  }
}

/* ── DOM updaters ─────────────────────────────────────────────────────────── */
function updateConnDot(connected) {
  const dot = document.getElementById('conn-dot');
  dot.className = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
}

function updateHeader() {
  document.getElementById('project-name').textContent = state.projectName || 'LiveControl';
}

function updateTransport() {
  const song    = state.setlist[state.activeSongIndex];
  const section = song?.sections?.[state.activeSectionIndex];
  document.getElementById('transport-time').textContent = formatTimecode(state.currentTime);
  document.getElementById('transport-song-name').textContent =
    song ? (section ? `${song.name}  ›  ${section.name}` : song.name) : '—';
  document.getElementById('tempo-value').textContent = Math.round(state.tempo * 10) / 10;

  const btn = document.getElementById('btn-play');
  btn.classList.toggle('playing', state.isPlaying);
  btn.querySelector('.icon-play').classList.toggle('hidden', state.isPlaying);
  btn.querySelector('.icon-stop').classList.toggle('hidden', !state.isPlaying);
}

function updateProgress() {
  const fill = document.getElementById('progress-fill');
  const song  = state.setlist[state.activeSongIndex];
  if (!song?.duration) { fill.style.width = '0%'; return; }
  const pct = Math.min(100, Math.max(0, ((state.currentTime - song.time) / song.duration) * 100));
  fill.style.width = pct + '%';
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
    : (state.setlist[state.activeSongIndex + 1]?.time ?? null);
  if (nextTime === null) return;
  const pct = Math.min(100, Math.max(0, ((state.currentTime - sec.time) / (nextTime - sec.time)) * 100));
  const el = document.querySelector(`.section-item[data-section-id="${sec.id}"] .section-progress-fill`);
  if (el) el.style.width = pct + '%';
}

/* ── Auto-scroll ─────────────────────────────────────────────────────────── */
function autoScroll() {
  if (activeTab !== 'setlist') return;
  if (state.activeSongIndex === _lastScrollSong && state.activeSectionIndex === _lastScrollSection) return;
  _lastScrollSong    = state.activeSongIndex;
  _lastScrollSection = state.activeSectionIndex;
  requestAnimationFrame(() => {
    const target =
      document.querySelector('.section-item.active-section') ||
      document.querySelector('.song-item.active');
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
  return state.setlist[state.activeSongIndex + 1]?.time ?? null;
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

/* ── Loop — jump back to start of section when it ends ───────────────────── */
function checkLoop() {
  if (!loopActive || !state.isPlaying || loopTargetSong < 0) return;
  const now = Date.now();
  if (now - _loopLastJump < 2000) return; // 2 s cooldown after a loop-jump

  // Detect if playhead has moved PAST the captured section
  const pastTarget =
    state.activeSongIndex > loopTargetSong ||
    (state.activeSongIndex === loopTargetSong && state.activeSectionIndex > loopTargetSection);

  if (pastTarget) {
    _loopLastJump = now;
    const song    = state.setlist[loopTargetSong];
    if (!song) return;
    const section = song.sections?.[loopTargetSection];
    if (section) {
      api('POST', `/api/jump/section/${song.id}/${section.id}`);
    } else {
      api('POST', `/api/jump/song/${song.id}`);
    }
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
  return setlist.filter(s => !s.excluded && s.duration).reduce((sum, s) => sum + s.duration, 0);
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
    item.className = `song-item${isActive ? ' active' : ''}${isExpanded ? ' expanded' : ''}${song.excluded ? ' excluded' : ''}`;
    item.dataset.songId  = song.id;
    item.dataset.realIdx = realIdx;
    item.draggable = true;

    // Sections — always visible
    let sectionsHtml = '';
    if (song.sections.length > 0) {
      sectionsHtml = song.sections.map((sec, si) => {
        const isActiveSection = isActive && si === state.activeSectionIndex;
        const wasPlayed       = isActive && playedSections.has(sec.id) && !isActiveSection;
        return `
          <div class="section-item${isActiveSection ? ' active-section' : ''}${wasPlayed ? ' played-section' : ''}"
               data-section-id="${sec.id}" data-song-id="${song.id}">
            <div class="section-progress-bar"><div class="section-progress-fill"></div></div>
            <div class="section-dot"></div>
            <div class="section-name">${esc(sec.name)}</div>
            <div class="section-time">${formatTime(sec.time)}</div>
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

    item.innerHTML = `
      <div class="song-row">
        <svg class="drag-handle" viewBox="0 0 24 24"><path d="M20 9H4v2h16V9zM4 15h16v-2H4v2z"/></svg>
        <div class="song-color-dot" style="background:${colorBg}"></div>
        <div class="song-number">${visibleIdx + 1}</div>
        <div class="song-name">${esc(song.name)}</div>
        <div class="song-duration">${formatTime(song.duration)}</div>
        <svg class="song-chevron" viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
      </div>
      ${notesPreview}
      ${sectionsHtml || actionsHtml ? `<div class="song-expanded">${sectionsHtml}${actionsHtml}</div>` : ''}
    `;

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

    // Drag and drop
    item.addEventListener('dragstart', (e) => {
      dragSrcIndex = realIdx;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.style.opacity = '0.4', 0);
    });
    item.addEventListener('dragend',  () => { item.style.opacity = ''; });
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
    item.addEventListener('dragleave',() => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const targetIdx = parseInt(item.dataset.realIdx);
      if (dragSrcIndex !== null && dragSrcIndex !== targetIdx) {
        const newOrder = state.setlist.map(s => s.id);
        const [moved] = newOrder.splice(dragSrcIndex, 1);
        newOrder.splice(targetIdx, 0, moved);
        api('POST', '/api/setlist/reorder', { order: newOrder });
      }
      dragSrcIndex = null;
    });

    container.appendChild(item);
  });

  updateSectionProgress();
  autoScroll();
}

function updateSetlistActive() {
  document.querySelectorAll('.song-item').forEach((el) => {
    const realIdx  = parseInt(el.dataset.realIdx);
    const isActive = realIdx === state.activeSongIndex;
    el.classList.toggle('active', isActive);

    el.querySelectorAll('.section-item').forEach((sec, si) => {
      const isActiveSec = isActive && si === state.activeSectionIndex;
      const wasPlayed   = isActive && playedSections.has(sec.dataset.sectionId) && !isActiveSec;
      sec.classList.toggle('active-section',  isActiveSec);
      sec.classList.toggle('played-section',  wasPlayed);
    });
  });

  updateTransport();
  updateProgress();
  updateSectionProgress();
  updateCountdown();
  checkLoop();
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

/* ── Tracks panel ─────────────────────────────────────────────────────────── */
async function loadTracks() {
  const container = document.getElementById('tracks-list');
  container.innerHTML = '<div class="loading-tracks">Loading tracks…</div>';
  try {
    const data   = await api('GET', '/api/tracks');
    const tracks = (data.tracks || []).filter(t => !isProtected(t.name));
    if (!tracks.length) { container.innerHTML = '<div class="loading-tracks">No tracks found</div>'; return; }
    container.innerHTML = '';
    tracks.forEach(track => {
      const el = document.createElement('div');
      el.className = 'track-item';
      el.innerHTML = `
        <div class="track-name">${esc(track.name)}</div>
        <button class="track-toggle${track.muted ? ' muted' : ''}" data-action="mute">
          ${track.muted ? 'MUTED' : 'MUTE'}
        </button>
        <button class="track-toggle${track.solo ? ' active' : ''}" data-action="solo">SOLO</button>
      `;
      el.querySelector('[data-action="mute"]').addEventListener('click', () => {
        api('POST', `/api/track/${track.id}/mute`, { muted: !track.muted }).then(loadTracks);
      });
      el.querySelector('[data-action="solo"]').addEventListener('click', () => {
        api('POST', `/api/track/${track.id}/solo`, { solo: !track.solo }).then(loadTracks);
      });
      container.appendChild(el);
    });
  } catch {
    container.innerHTML = '<div class="loading-tracks">Error loading tracks.</div>';
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   EQ canvas — biquad filter maths
   ══════════════════════════════════════════════════════════════════════════ */

/** Magnitude of a peaking EQ biquad at frequency `f` Hz */
function peakingMag(f, fc, gainDB, Q, fs = 44100) {
  if (gainDB === 0) return 1;
  const A   = Math.pow(10, gainDB / 40);
  const w0  = 2 * Math.PI * fc / fs;
  const cos0= Math.cos(w0), sin0 = Math.sin(w0);
  const alp = sin0 / (2 * Math.max(Q, 0.01));
  const b0 = 1 + alp * A,  b1 = -2 * cos0, b2 = 1 - alp * A;
  const a0 = 1 + alp / A,  a1 = -2 * cos0, a2 = 1 - alp / A;
  const w  = 2 * Math.PI * f / fs;
  const cw = Math.cos(w), sw = Math.sin(w);
  const bR = b0 + b1*cw + b2*Math.cos(2*w);
  const bI = -(b1*sw + b2*Math.sin(2*w));
  const aR = a0 + a1*cw + a2*Math.cos(2*w);
  const aI = -(a1*sw + a2*Math.sin(2*w));
  const bM = Math.hypot(bR, bI), aM = Math.hypot(aR, aI);
  return aM > 0 ? bM / aM : 1;
}

/** Magnitude of a low/high-shelf biquad at frequency `f` Hz */
function shelfMag(f, fc, gainDB, isHigh, fs = 44100) {
  if (gainDB === 0) return 1;
  const A   = Math.pow(10, gainDB / 40);
  const w0  = 2 * Math.PI * fc / fs;
  const cos0= Math.cos(w0), sin0 = Math.sin(w0);
  const alp = sin0 / 2 * Math.sqrt((A + 1/A) * (1/1 - 1) + 2); // S=1
  let b0,b1,b2,a0,a1,a2;
  if (!isHigh) {
    b0 =         A*((A+1)-(A-1)*cos0+2*Math.sqrt(A)*alp);
    b1 =     2*A*((A-1)-(A+1)*cos0);
    b2 =         A*((A+1)-(A-1)*cos0-2*Math.sqrt(A)*alp);
    a0 =           (A+1)+(A-1)*cos0+2*Math.sqrt(A)*alp;
    a1 =    -2*   ((A-1)+(A+1)*cos0);
    a2 =           (A+1)+(A-1)*cos0-2*Math.sqrt(A)*alp;
  } else {
    b0 =         A*((A+1)+(A-1)*cos0+2*Math.sqrt(A)*alp);
    b1 =    -2*A*((A-1)+(A+1)*cos0);
    b2 =         A*((A+1)+(A-1)*cos0-2*Math.sqrt(A)*alp);
    a0 =           (A+1)-(A-1)*cos0+2*Math.sqrt(A)*alp;
    a1 =     2*   ((A-1)-(A+1)*cos0);
    a2 =           (A+1)-(A-1)*cos0-2*Math.sqrt(A)*alp;
  }
  const w  = 2 * Math.PI * f / fs;
  const cw = Math.cos(w), sw = Math.sin(w);
  const bR = b0+b1*cw+b2*Math.cos(2*w), bI = -(b1*sw+b2*Math.sin(2*w));
  const aR = a0+a1*cw+a2*Math.cos(2*w), aI = -(a1*sw+a2*Math.sin(2*w));
  const bM = Math.hypot(bR,bI), aM = Math.hypot(aR,aI);
  return aM > 0 ? bM/aM : 1;
}

/**
 * bands = [{ type:'peak'|'lowShelf'|'highShelf', freq, gain, q }]
 */
function drawEQCanvas(canvas, bands = []) {
  const dpr = window.devicePixelRatio || 1;
  // Resize to CSS size × DPR for sharpness
  const cssW = canvas.offsetWidth  || 92;
  const cssH = canvas.offsetHeight || 60;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);

  const FMIN = 20, FMAX = 20000, DB_MAX = 15, DB_MIN = -15;
  const freqToX = f  => (Math.log10(f / FMIN) / Math.log10(FMAX / FMIN)) * W;
  const dbToY   = db => H - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * H;

  // Grid
  ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = dpr;
  [100, 1000, 10000].forEach(f => {
    ctx.beginPath(); ctx.moveTo(freqToX(f), 0); ctx.lineTo(freqToX(f), H); ctx.stroke();
  });
  ctx.strokeStyle = '#252525';
  const y0 = dbToY(0);
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

  // Response curve
  const pts = W;
  const resp = new Float32Array(pts);
  for (let i = 0; i < pts; i++) {
    const f = FMIN * Math.pow(FMAX / FMIN, i / (pts - 1));
    let db = 0;
    for (const b of bands) {
      let mag = 1;
      if (b.type === 'peak')      mag = peakingMag(f, b.freq, b.gain, b.q || 1);
      else if (b.type === 'lowShelf')  mag = shelfMag(f, b.freq, b.gain, false);
      else if (b.type === 'highShelf') mag = shelfMag(f, b.freq, b.gain, true);
      db += 20 * Math.log10(Math.max(mag, 1e-10));
    }
    resp[i] = db;
  }

  // Fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0,   'rgba(34,197,94,0.40)');
  grad.addColorStop(0.5, 'rgba(34,197,94,0.10)');
  grad.addColorStop(1,   'rgba(34,197,94,0.02)');
  ctx.beginPath();
  ctx.moveTo(0, dbToY(resp[0]));
  for (let i = 1; i < pts; i++) ctx.lineTo(i, dbToY(resp[i]));
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(0, dbToY(resp[0]));
  for (let i = 1; i < pts; i++) ctx.lineTo(i, dbToY(resp[i]));
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
}

/** Extract band objects from an EQ Eight device's parameter list */
function parseEQEightBands(params) {
  const bands = [];
  for (let i = 1; i <= 8; i++) {
    const on   = params.find(p => p.name === `${i} Filter On`);
    const freq = params.find(p => p.name === `${i} Frequency A` || p.name === `${i} Frequency`);
    const gain = params.find(p => p.name === `${i} Gain`);
    const q    = params.find(p => p.name === `${i} Resonance`   || p.name === `${i} Q`);
    const type = params.find(p => p.name === `${i} Filter Type`);
    if (!freq) continue;
    if (on && on.value < 0.5) continue; // band is off
    const bandTypeCode = type ? Math.round(type.value) : 2;
    let bandType = 'peak';
    if (bandTypeCode === 4) bandType = 'highShelf';
    else if (bandTypeCode === 5) bandType = 'lowShelf';
    bands.push({
      type: bandType,
      freq: freq.value,
      gain: gain ? gain.value : 0,
      q:    q    ? Math.max(0.01, q.value) : 1,
    });
  }
  return bands;
}

/* ══════════════════════════════════════════════════════════════════════════
   MIXER
   ══════════════════════════════════════════════════════════════════════════ */
let _mixerTracks = [];

async function loadMixer() {
  const container = document.getElementById('mixer-channels');
  container.innerHTML = '<div class="loading-tracks">Loading mixer…</div>';
  try {
    const data   = await api('GET', '/api/tracks');
    _mixerTracks = (data.tracks || []).filter(t => !isProtected(t.name));
    if (!_mixerTracks.length) {
      container.innerHTML = '<div class="loading-tracks">No tracks found</div>'; return;
    }
    container.innerHTML = '';

    _mixerTracks.forEach(track => {
      const volPct = track.volume != null ? Math.round(track.volume * 100) : 85;
      const panRaw = track.pan    != null ? track.pan : 0; // -1..+1
      const panInt = Math.round(panRaw * 100);             // -100..+100
      const panLabel = panRaw > 0.01  ? `R${Math.round(panRaw*100)}`
                     : panRaw < -0.01 ? `L${Math.round(-panRaw*100)}`
                     : 'C';
      const volLabel = volPct === 85 ? '0 dB'
                     : `${volPct > 85 ? '+' : ''}${volPct - 85} dB`;

      const strip = document.createElement('div');
      strip.className = 'mixer-strip';
      strip.dataset.trackId = track.id;
      strip.innerHTML = `
        <div class="mixer-strip-name" title="${esc(track.name)}">${esc(track.name)}</div>

        <canvas class="mixer-eq-canvas"></canvas>

        <div class="mixer-fader-section">
          <div class="mixer-fader-container">
            <input type="range" class="mixer-fader" min="0" max="100" value="${volPct}">
          </div>
          <div class="mixer-vol-label">${volLabel}</div>
        </div>

        <div class="mixer-pan-section">
          <div class="mixer-pan-label">PAN</div>
          <input type="range" class="mixer-pan" min="-100" max="100" value="${panInt}">
          <div class="mixer-pan-value">${panLabel}</div>
        </div>

        <div class="mixer-btn-row">
          <button class="mixer-btn mixer-mute${track.muted ? ' active-mute' : ''}">M</button>
          <button class="mixer-btn mixer-solo${track.solo ? ' active-solo' : ''}">S</button>
        </div>

        <button class="mixer-plugin-btn" title="Plugin settings">
          <svg viewBox="0 0 24 24">
            <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61
              l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54
              c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94
              l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58
              c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32
              c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84
              c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22
              l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6
              s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
          </svg>
          Plugins
        </button>
      `;

      container.appendChild(strip);

      // Draw initial flat EQ
      const canvas = strip.querySelector('.mixer-eq-canvas');
      drawEQCanvas(canvas, []);

      // Volume fader
      const fader    = strip.querySelector('.mixer-fader');
      const volLbl   = strip.querySelector('.mixer-vol-label');
      let _volDebounce;
      fader.addEventListener('input', (e) => {
        const v = parseInt(e.target.value);
        volLbl.textContent = v === 85 ? '0 dB' : `${v > 85 ? '+' : ''}${v - 85} dB`;
        clearTimeout(_volDebounce);
        _volDebounce = setTimeout(() => {
          api('POST', `/api/track/${track.id}/volume`, { volume: v / 100 });
        }, 80);
      });

      // Pan slider
      const panSlider = strip.querySelector('.mixer-pan');
      const panLbl    = strip.querySelector('.mixer-pan-value');
      let _panDebounce;
      panSlider.addEventListener('input', (e) => {
        const v = parseInt(e.target.value); // -100..+100
        panLbl.textContent = v > 0 ? `R${v}` : v < 0 ? `L${-v}` : 'C';
        clearTimeout(_panDebounce);
        _panDebounce = setTimeout(() => {
          api('POST', `/api/track/${track.id}/pan`, { pan: v / 100 });
        }, 80);
      });

      // Mute
      strip.querySelector('.mixer-mute').addEventListener('click', (e) => {
        const isMuted = e.currentTarget.classList.contains('active-mute');
        api('POST', `/api/track/${track.id}/mute`, { muted: !isMuted }).then(loadMixer);
      });

      // Solo
      strip.querySelector('.mixer-solo').addEventListener('click', (e) => {
        const isSolo = e.currentTarget.classList.contains('active-solo');
        api('POST', `/api/track/${track.id}/solo`, { solo: !isSolo }).then(loadMixer);
      });

      // Plugin settings
      strip.querySelector('.mixer-plugin-btn').addEventListener('click', () => {
        openPluginModal(track);
      });
    });

    // Load EQ data asynchronously — doesn't block the mixer appearing
    loadMixerEQ(_mixerTracks);

  } catch (e) {
    console.error('[mixer]', e);
    container.innerHTML = '<div class="loading-tracks">Error loading mixer.</div>';
  }
}

async function loadMixerEQ(tracks) {
  for (const track of tracks) {
    try {
      const data    = await api('GET', `/api/track/${track.id}/devices`);
      const devices = data.devices || [];
      const eqDev   = devices.find(d =>
        /eq.?eight|eq.?8|channel.?eq/i.test(d.name || '')
      );
      if (!eqDev) continue;
      const bands  = parseEQEightBands(eqDev.params);
      const canvas = document.querySelector(
        `.mixer-strip[data-track-id="${track.id}"] .mixer-eq-canvas`
      );
      if (canvas) drawEQCanvas(canvas, bands);
    } catch { /* non-fatal */ }
  }
}

/* ── Plugin modal ─────────────────────────────────────────────────────────── */
async function openPluginModal(track) {
  pluginTrackContext = track;
  document.getElementById('plugin-modal-track-name').textContent = track.name;
  document.getElementById('plugin-devices').innerHTML =
    '<div class="plugin-loading">Loading devices…</div>';
  document.getElementById('plugin-modal').classList.remove('hidden');

  try {
    const data    = await api('GET', `/api/track/${track.id}/devices`);
    const devices = data.devices || [];
    const container = document.getElementById('plugin-devices');

    if (!devices.length) {
      container.innerHTML = '<div class="plugin-loading">No devices on this track.</div>';
      return;
    }

    container.innerHTML = '';
    devices.forEach(device => {
      const el = document.createElement('div');
      el.className = 'plugin-device';

      const header = document.createElement('div');
      header.className = 'plugin-device-header';
      header.innerHTML = `
        <span class="plugin-device-name">${esc(device.name)}</span>
        <span class="plugin-device-count">${device.params.length} params</span>
        <span class="plugin-device-toggle-icon">▶</span>
      `;
      header.addEventListener('click', () => el.classList.toggle('open'));

      const body = document.createElement('div');
      body.className = 'plugin-device-body';

      // Only show params with a real range
      const params = (device.params || []).filter(p => p.name && p.max > p.min);
      params.forEach(param => {
        const range = param.max - param.min;
        const norm  = range > 0 ? (param.value - param.min) / range : 0;
        const disp  = param.value % 1 === 0 ? param.value : param.value.toFixed(3);

        const row = document.createElement('div');
        row.className = 'plugin-param';
        row.innerHTML = `
          <div class="plugin-param-header">
            <span class="plugin-param-name" title="${esc(param.name)}">${esc(param.name)}</span>
            <span class="plugin-param-value">${disp}</span>
          </div>
          <input type="range" class="plugin-param-slider"
            min="0" max="1000" value="${Math.round(norm * 1000)}"
            data-device-id="${device.id}" data-param-id="${param.id}"
            data-min="${param.min}" data-max="${param.max}">
        `;

        const slider  = row.querySelector('.plugin-param-slider');
        const valueLbl= row.querySelector('.plugin-param-value');
        let _debounce;
        slider.addEventListener('input', (e) => {
          const n   = parseInt(e.target.value) / 1000;
          const val = param.min + n * range;
          const d   = val % 1 === 0 ? val : val.toFixed(3);
          valueLbl.textContent = d;
          clearTimeout(_debounce);
          _debounce = setTimeout(() => {
            api('POST',
              `/api/track/${track.id}/device/${device.id}/param/${param.id}`,
              { value: val }
            ).then(() => {
              // Refresh EQ canvas if this is an EQ device
              if (/eq.?eight|eq.?8|channel.?eq/i.test(device.name)) {
                loadMixerEQ([track]);
              }
            });
          }, 80);
        });

        body.appendChild(row);
      });

      if (params.length === 0) {
        body.innerHTML = '<div class="plugin-loading" style="padding:10px 0">No automatable parameters.</div>';
      }

      el.appendChild(header);
      el.appendChild(body);
      container.appendChild(el);
    });

    // Open first device by default
    container.querySelector('.plugin-device')?.classList.add('open');

  } catch {
    document.getElementById('plugin-devices').innerHTML =
      '<div class="plugin-loading">Error loading devices.</div>';
  }
}

/* ── Event bindings ──────────────────────────────────────────────────────── */
document.getElementById('btn-play').addEventListener('click', () => {
  state.isPlaying ? api('POST', '/api/stop') : api('POST', '/api/play');
});
document.getElementById('btn-prev').addEventListener('click',   () => api('POST', '/api/prev-cue'));
document.getElementById('btn-next').addEventListener('click',   () => api('POST', '/api/next-cue'));
document.getElementById('btn-reload').addEventListener('click', () => api('POST', '/api/reload'));

// Loop — capture the current section position at moment of toggle
document.getElementById('btn-loop').addEventListener('click', () => {
  loopActive = !loopActive;
  if (loopActive) {
    loopTargetSong    = state.activeSongIndex;
    loopTargetSection = state.activeSectionIndex;
    _loopLastJump     = 0;
  } else {
    loopTargetSong    = -1;
    loopTargetSection = -1;
  }
  document.getElementById('btn-loop').classList.toggle('active', loopActive);
});

// Tempo
document.getElementById('tempo-value').addEventListener('click', () => {
  const cur   = Math.round(state.tempo * 10) / 10;
  const input = prompt('Set tempo (BPM):', cur);
  if (input === null) return;
  const bpm = parseFloat(input);
  if (!isNaN(bpm) && bpm > 20 && bpm < 400) api('POST', '/api/tempo', { bpm });
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

// Plugin modal
document.getElementById('plugin-close').addEventListener('click', () => {
  document.getElementById('plugin-modal').classList.add('hidden'); pluginTrackContext = null;
});
document.querySelector('#plugin-modal .modal-backdrop').addEventListener('click', () => {
  document.getElementById('plugin-modal').classList.add('hidden'); pluginTrackContext = null;
});

// Mixer refresh button
document.getElementById('mixer-refresh').addEventListener('click', loadMixer);

// Tab bar
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn')
      .forEach(b => b.classList.toggle('tab-btn--active', b.dataset.tab === activeTab));

    document.querySelector('.setlist-container')?.classList.toggle('hidden', activeTab !== 'setlist');
    document.getElementById('tracks-panel')?.classList.toggle('hidden', activeTab !== 'tracks');
    document.getElementById('mixer-panel')?.classList.toggle('hidden', activeTab !== 'mixer');

    if (activeTab === 'tracks') loadTracks();
    if (activeTab === 'mixer')  loadMixer();
  });
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space')      { e.preventDefault(); document.getElementById('btn-play').click(); }
  if (e.code === 'ArrowRight') api('POST', '/api/next-cue');
  if (e.code === 'ArrowLeft')  api('POST', '/api/prev-cue');
});

/* ── Init ────────────────────────────────────────────────────────────────── */
connect();
