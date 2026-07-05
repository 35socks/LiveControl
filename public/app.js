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
};

let expandedSongId = null;

// Modal state
let pendingJump = null;
let pendingNotesSong = null;
let pendingColorSong = null;

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
  const label = document.getElementById('conn-label');
  if (label) label.textContent = connected ? 'Connected' : 'Disconnected';
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

    const introSkipHtml = song.introSkip != null
      ? `<div class="song-intro-skip" title="Jumping skips intro silence to ${formatTime(song.introSkip)}">
           <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.9V8.1z"/><path d="M16 6h2v12h-2z"/></svg>
         </div>` : '';

    item.innerHTML = `
      <div class="song-row">
        <svg class="drag-handle" viewBox="0 0 24 24"><path d="M20 9H4v2h16V9zM4 15h16v-2H4v2z"/></svg>
        <div class="song-color-dot" style="background:${colorBg}"></div>
        <div class="song-number">${visibleIdx + 1}</div>
        <div class="song-name">${esc(song.name)}</div>
        ${introSkipHtml}
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
