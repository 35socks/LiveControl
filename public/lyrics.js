/**
 * lyrics.js — standalone synchronized lyrics page (/lyrics)
 *
 * Gets position from the normal "state" WebSocket messages and the
 * pre-laid-out lyrics from the separate "lyrics" message (all in beats).
 */

const GAP_BEATS = 4;      // gaps at least this long show the countdown bubbles
const BUBBLES = 4;
const COLORS = {
  gray: '#9ca3af', red: '#f87171', orange: '#fb923c', amber: '#fbbf24', yellow: '#facc15',
  lime: '#a3e635', green: '#4ade80', emerald: '#34d399', teal: '#2dd4bf', cyan: '#22d3ee',
  sky: '#38bdf8', blue: '#60a5fa', indigo: '#818cf8', violet: '#a78bfa', purple: '#c084fc',
  fuchsia: '#e879f9', pink: '#f472b6', rose: '#fb7185',
};

/* ── Persistent per-device settings ───────────────────────────────────────── */
const store = {
  get(key, fallback) { try { const v = localStorage.getItem('lc-lyrics-' + key); return v === null ? fallback : v; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('lc-lyrics-' + key, value); } catch {} },
};
try { document.documentElement.setAttribute('data-theme', localStorage.getItem('lc-theme') || 'midnight'); } catch {}

/* ── State ───────────────────────────────────────────────────────────────── */
let state = { connected: false, isPlaying: false, tempo: 120, currentBeat: 0, currentTime: 0 };
let lyrics = { tracks: [] };
let stateRx = performance.now();
let wsOpen = false;

let selectedTrackName = new URLSearchParams(location.search).get('track') || store.get('track', '');
let locked = store.get('locked', '0') === '1';
let sizePct = Math.min(220, Math.max(60, Number(store.get('size', '100')) || 100));

// Rendered song
let view = null;   // { track, song, entries[], timeline[], activeIdx, lastLineEl }
let renderKey = '';
let lyricsVersion = 0;

const $ = (id) => document.getElementById(id);
const page = $('lyrics-page'), inner = $('lyrics-inner'), viewport = $('lyrics-viewport');

/* ── WebSocket ───────────────────────────────────────────────────────────── */
let reconnectDelay = 1000;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => { wsOpen = true; reconnectDelay = 1000; updateMessage(); };
  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === 'state') {
      state = { ...state, ...msg.payload };
      stateRx = performance.now();
      updateControls();
      updateMessage();
    } else if (msg.type === 'lyrics') {
      lyrics = msg.payload && Array.isArray(msg.payload.tracks) ? msg.payload : { tracks: [] };
      lyricsVersion++;
      updateTrackSelect();
      renderKey = '';
      updateMessage();
    }
  };
  ws.onclose = () => {
    wsOpen = false;
    updateMessage();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
  ws.onerror = () => ws.close();
}

/* ── Position ────────────────────────────────────────────────────────────── */
// Beat position extrapolated between the server's 100 ms updates.
function liveBeat() {
  const tempo = Number(state.tempo) > 0 ? Number(state.tempo) : 120;
  const elapsed = state.isPlaying ? Math.min((performance.now() - stateRx) / 1000, 0.5) : 0;
  const beat = Number.isFinite(state.currentBeat) ? state.currentBeat : (state.currentTime * tempo) / 60;
  return beat + elapsed * tempo / 60;
}

// Lyrics delay ([+150ms], [+1n]) only applies while Live is playing.
function delayBeats(track) {
  if (!state.isPlaying) return 0;
  const tempo = Number(state.tempo) > 0 ? Number(state.tempo) : 120;
  return (track.opts.delayMs / 1000) * (tempo / 60) + track.opts.delayBeats;
}

/* ── Tracks ──────────────────────────────────────────────────────────────── */
function currentTrack() {
  const tracks = lyrics.tracks;
  if (!tracks.length) return null;
  const wanted = selectedTrackName.toLowerCase();
  return tracks.find((t) => t.name.toLowerCase() === wanted) || tracks[0];
}

function updateTrackSelect() {
  const select = $('track-select');
  const tracks = lyrics.tracks;
  select.replaceChildren(...tracks.map((t) => {
    const o = document.createElement('option');
    o.value = t.name; o.textContent = t.name || 'Lyrics';
    return o;
  }));
  select.classList.toggle('hidden', tracks.length < 2);
  const track = currentTrack();
  if (track) select.value = track.name;
}

function applyTrackClasses(track) {
  const o = track?.opts || {};
  page.classList.toggle('nofade-page', !!o.nofade);
  page.classList.toggle('nozoom-page', !!o.nozoom);
  page.classList.toggle('progress-page', !!o.progress);
  page.classList.toggle('linemarker-page', !!o.linemarker);
  page.classList.toggle('left-page', o.align === 'left');
}

/* ── Rendering ───────────────────────────────────────────────────────────── */
// **bold**, *italic* and "\" line breaks, built with text nodes (no innerHTML).
function renderInline(text, parent) {
  const rows = text.split(/\s*\\\s*/);
  rows.forEach((row, i) => {
    if (i > 0) parent.appendChild(document.createElement('br'));
    for (const part of row.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/)) {
      if (!part) continue;
      let el = null, content = part;
      if (/^\*\*[^*]+\*\*$/.test(part)) { el = document.createElement('strong'); content = part.slice(2, -2); }
      else if (/^\*[^*]+\*$/.test(part)) { el = document.createElement('em'); content = part.slice(1, -1); }
      if (el) { el.textContent = content; parent.appendChild(el); }
      else parent.appendChild(document.createTextNode(content));
    }
  });
}

function makeLine(track, line) {
  const el = document.createElement('div');
  el.className = 'ly-line item clickable';
  const size = line.size || track.opts.size;
  const align = line.align || track.opts.align;
  if (size) el.classList.add('size-' + size);
  if (align) el.classList.add('align-' + align);
  if (line.mono || track.opts.mono) el.classList.add('mono');
  const color = line.clipColor || COLORS[line.color] || COLORS[track.opts.color];
  if (color) el.style.setProperty('--c', color);
  const text = document.createElement('span');
  text.className = 'ly-text';
  renderInline(line.text, text);
  el.appendChild(text);
  el.dataset.start = String(line.start);
  return el;
}

function makeSpacer() {
  const el = document.createElement('div');
  el.className = 'ly-spacer item';
  for (let i = 0; i < BUBBLES; i++) {
    const b = document.createElement('div');
    b.className = 'ly-bubble';
    el.appendChild(b);
  }
  return el;
}

function renderSong(track, song) {
  inner.replaceChildren();
  inner.classList.remove('animate');
  const timeline = [];   // lines + spacers, in order (drive the cursor)
  const all = [];        // every element, including headers
  const add = (el) => { inner.appendChild(el); all.push(el); return el; };

  const title = document.createElement('div');
  title.className = 'ly-section ly-song-title clickable';
  title.textContent = song.name;
  title.dataset.songId = song.songId;
  add(title);

  let prevEnd = song.start;
  let pendingHeaders = [];
  const flushHeaders = () => { pendingHeaders.forEach((h) => add(h)); pendingHeaders = []; };

  for (const item of song.items) {
    if (item.type === 'section') {
      if (track.opts.nosections) continue;
      const h = document.createElement('div');
      h.className = 'ly-section clickable';
      h.textContent = item.name;
      h.dataset.songId = song.songId;
      h.dataset.sectionId = item.id;
      h._start = item.start;
      pendingHeaders.push(h);
      continue;
    }
    if (item.start - prevEnd >= GAP_BEATS) {
      const sp = makeSpacer();
      add(sp);
      timeline.push({ el: sp, kind: 'spacer', start: prevEnd, end: item.start, order: all.length - 1 });
    }
    flushHeaders();
    const el = makeLine(track, item);
    add(el);
    timeline.push({ el, kind: 'line', start: item.start, end: item.end, order: all.length - 1 });
    prevEnd = Math.max(prevEnd, item.end);
  }
  flushHeaders();

  view = { track, song, all, timeline, activeIdx: -2 };
  applyTrackClasses(track);
}

function ensureRendered(beat) {
  const track = currentTrack();
  if (!track || !track.songs.length) { view = null; inner.replaceChildren(); renderKey = ''; return false; }
  let song = track.songs[0];
  for (const s of track.songs) if (s.start <= beat + 0.001) song = s;
  const key = `${lyricsVersion}|${track.id}|${song.songId}`;
  if (key !== renderKey) { renderKey = key; renderSong(track, song); }
  return true;
}

function activeIndex(timeline, beat) {
  let idx = -1;
  for (let i = 0; i < timeline.length; i++) if (timeline[i].start <= beat) idx = i; else break;
  return idx;
}

function updateCursor(idx, firstTime) {
  const { timeline, all, track } = view;
  const activeOrder = idx >= 0 ? timeline[idx].order : -1;
  const activeEntry = timeline[idx];
  timeline.forEach((t, i) => {
    const el = t.el;
    const rel = i - idx;
    el.classList.toggle('active', rel === 0);
    el.classList.toggle('before-current', rel < 0);
    el.classList.toggle('after-current', rel > 0);
    el.classList.toggle('previous', rel === -1);
    el.classList.toggle('next', rel === 1);
    el.style.setProperty('--d', String(Math.min(5, Math.abs(rel))));
    if (t.kind === 'line') el.style.setProperty('--progress', rel < 0 ? '100%' : '0%');
    else el.querySelectorAll('.ly-bubble').forEach((b) => { b.style.opacity = rel < 0 ? '1' : '.1'; });
  });
  // Highlight the section the cursor is in (last header at/before the active element).
  let current = null;
  all.forEach((el) => {
    if (el.classList.contains('ly-section') && !el.classList.contains('ly-song-title')) {
      el.classList.remove('current');
      if (el.nextSibling && activeOrder >= 0 && all.indexOf(el) < activeOrder) current = el;
    }
  });
  if (current) current.classList.add('current');
  scrollTo(idx, firstTime);
}

function scrollTo(idx, instant) {
  const { timeline, all, track } = view;
  const vh = viewport.clientHeight;
  let target;
  if (idx < 0) target = 0;
  else if (track.opts.top !== null) {
    const anchor = timeline[Math.max(0, idx - track.opts.top)];
    // Include a header that sits directly above the anchor line.
    let el = anchor.el;
    const prev = all[anchor.order - 1];
    if (prev && prev.classList.contains('ly-section')) el = prev;
    target = el.offsetTop - vh * 0.12;
  } else {
    const el = timeline[idx].el;
    target = el.offsetTop + el.offsetHeight / 2 - vh / 2;
  }
  target = Math.max(0, target);
  if (instant) inner.classList.remove('animate'); else inner.classList.add('animate');
  inner.style.transform = `translateY(${-Math.round(target)}px)`;
  if (instant) { void inner.offsetHeight; inner.classList.add('animate'); }
}

/* ── Animation loop ──────────────────────────────────────────────────────── */
function frame() {
  requestAnimationFrame(frame);
  const rawBeat = liveBeat();
  const track = currentTrack();
  const beat = rawBeat - (track ? delayBeats(track) : 0);
  if (!ensureRendered(beat)) return;
  const first = view.activeIdx === -2;
  const idx = activeIndex(view.timeline, beat);
  if (idx !== view.activeIdx) {
    view.activeIdx = idx;
    updateCursor(idx, first);
  }
  const t = view.timeline[idx];
  if (!t) return;
  const span = Math.max(0.0001, t.end - t.start);
  const p = Math.min(1, Math.max(0, (beat - t.start) / span));
  if (t.kind === 'line') {
    t.el.style.setProperty('--progress', (p * 100).toFixed(1) + '%');
  } else {
    t.el.querySelectorAll('.ly-bubble').forEach((b, i) => {
      b.style.opacity = String(Math.min(1, Math.max(0.1, p * BUBBLES - i)));
    });
  }
}

/* ── Interaction ─────────────────────────────────────────────────────────── */
async function post(path, body) {
  try {
    await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  } catch (e) { console.error(e); }
}

inner.addEventListener('click', (e) => {
  if (locked) return;
  const hit = e.target.closest('.ly-line, .ly-section');
  if (!hit) return;
  if (hit.dataset.sectionId) post(`/api/jump/section/${hit.dataset.songId}/${hit.dataset.sectionId}`);
  else if (hit.classList.contains('ly-song-title')) post(`/api/jump/song/${hit.dataset.songId}`);
  else if (hit.dataset.start) post('/api/jump/time', { beat: Number(hit.dataset.start) });
});

$('play-btn').addEventListener('click', () => post(state.isPlaying ? '/api/stop' : '/api/play'));

function applyLocked() {
  $('lock-btn').setAttribute('aria-pressed', String(locked));
  $('lock-btn').querySelector('.i-locked').classList.toggle('hidden', !locked);
  $('lock-btn').querySelector('.i-unlocked').classList.toggle('hidden', locked);
  inner.classList.toggle('is-locked', locked);
}
$('lock-btn').addEventListener('click', () => { locked = !locked; store.set('locked', locked ? '1' : '0'); applyLocked(); });

$('settings-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('settings-pop');
  pop.classList.toggle('hidden');
  $('settings-btn').setAttribute('aria-expanded', String(!pop.classList.contains('hidden')));
});
document.addEventListener('click', (e) => {
  const pop = $('settings-pop');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target)) pop.classList.add('hidden');
});

function applySize() {
  page.style.setProperty('--scale', String(sizePct / 100));
  $('size-range').value = String(sizePct);
  if (view) view.activeIdx = -2;   // re-centre after the layout changes
}
$('size-range').addEventListener('input', (e) => {
  sizePct = Number(e.target.value);
  store.set('size', String(sizePct));
  applySize();
});

$('track-select').addEventListener('change', (e) => {
  selectedTrackName = e.target.value;
  store.set('track', selectedTrackName);
  renderKey = '';
});

window.addEventListener('resize', () => { if (view) view.activeIdx = -2; });

function updateControls() {
  $('play-btn').querySelector('.i-play').classList.toggle('hidden', !!state.isPlaying);
  $('play-btn').querySelector('.i-stop').classList.toggle('hidden', !state.isPlaying);
}

function updateMessage() {
  const msg = $('lyrics-message');
  let text = '';
  if (!wsOpen) text = 'Connecting to LiveControl…';
  else if (!state.connected) text = 'Waiting for Ableton Live…';
  else if (!lyrics.tracks.length) text = 'No lyrics found.\nAdd a MIDI track named “Vocals +LYRICS” with one clip per line, then press reload in LiveControl.';
  else if (!currentTrack()?.songs.length) text = 'This lyrics track has no lines under any song.';
  msg.textContent = text;
  msg.style.whiteSpace = 'pre-line';
  msg.classList.toggle('hidden', !text);
}

// Keep the screen on while lyrics are up (best effort).
async function keepAwake() {
  try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

applyLocked();
applySize();
updateMessage();
keepAwake();
connect();
requestAnimationFrame(frame);
