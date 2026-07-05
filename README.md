# LiveControl

A free, open source app to control Ableton Live from any device on your local network via a browser.
## Features

- 🎵 **Setlist from cue points** — automatically parses Ableton locators into a setlist
- 🎛️ **Web control** — open on any phone, tablet, or computer on the same WiFi
- ▶️ **Transport** — play, stop, continue, next/prev cue
- 🔀 **Song jumping** — tap any song to jump to it in Ableton
- 📋 **Sections** — expand songs to see and jump to sub-sections
- 🛑 **Auto-stop markers** — `[STOP]` cue points automatically pause playback
- 🎨 **Song colors** — color-code your setlist
- 📝 **Song notes** — add notes, chords, or instructions per song
- ↕️ **Reorder** — drag-and-drop setlist order (without touching Ableton)
- 🔇 **Track mute/solo** — control any track from the Tracks tab
- ⌨️ **Keyboard shortcuts** — Space (play/stop), ←→ (prev/next cue)
- 📱 **Fully responsive** — works great on iPhone, iPad, and desktop

## Setup

### 1. Install the MIDI Remote Script

Copy the MIDI script into Ableton's Remote Scripts folder:

**macOS:**
```bash
cp -r node_modules/ableton-js/midi-script ~/Music/Ableton/User\ Library/Remote\ Scripts/AbletonJS
```

**Windows:**
```
Copy node_modules\ableton-js\midi-script to:
C:\Users\[YourName]\Documents\Ableton\User Library\Remote Scripts\AbletonJS
```

### 2. Activate in Ableton

1. Open Ableton Live
2. Go to **Preferences → Link, Tempo & MIDI**
3. Under **Control Surfaces**, add **AbletonJS** as a control surface
4. No input/output assignment needed

### 3. Run LiveControl

```bash
npm install
npm start
```

### 4. Open in browser

- **This machine:** http://localhost:3000
- **Other devices:** http://[your-ip]:3000

The server prints your local IP on startup.

---

## Setlist notation

LiveControl reads cue point names from your Ableton arrangement view:

| Cue point name | Effect |
|---|---|
| `Song Title` | Creates a song entry |
| `[Song Title]` | Creates a song entry (bracket notation) |
| `> Verse` | Section within the current song |
| `> Chorus` | Another section |
| `[NEXTMARKER]` | Real starting point of the song — jumping to the song jumps here instead, skipping lead-in silence |
| `[STOP]` or `--- STOP ---` | Auto-stop marker (pauses playback) |
| `// comment` | Ignored |

**Example arrangement:**
```
0:00  Intro
0:08  [NEXTMARKER]      ← song actually starts here; jumping skips the 8s of lead-in silence
1:30  > Verse 1
2:30  > Chorus
4:00  [STOP]
4:05  Second Song
4:05  > Drop
6:00  [STOP]
```

After editing cue points in Ableton, click the **↺** button in LiveControl to reload.

---

## API Reference

All endpoints return `{ ok: true, ... }` or `{ ok: false, error: "..." }`.

### Transport
| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/play` | — | Start playback |
| POST | `/api/stop` | — | Stop playback |
| POST | `/api/continue` | — | Continue from current position |
| POST | `/api/next-cue` | — | Jump to next cue point |
| POST | `/api/prev-cue` | — | Jump to previous cue point |
| POST | `/api/tempo` | `{ bpm: 120 }` | Set tempo |

### Setlist
| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/state` | — | Full current state |
| POST | `/api/reload` | — | Re-read cue points from Ableton |
| POST | `/api/jump/song/:id` | — | Jump to song |
| POST | `/api/jump/section/:songId/:sectionId` | — | Jump to section |
| POST | `/api/setlist/reorder` | `{ order: [id, ...] }` | Reorder songs |

### Song metadata
| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/song/:id/notes` | `{ notes: "..." }` | Save notes |
| POST | `/api/song/:id/color` | `{ color: "red" }` | Set color |
| POST | `/api/song/:id/exclude` | `{ excluded: true }` | Skip song in setlist |

---

## Configuration

Set the `PORT` environment variable to change the port (default: 3000):

```bash
PORT=8080 npm start
```

---

## Architecture

```
Ableton Live
   ↕ UDP (localhost only)
ableton-js MIDI script
   ↕
Node.js server (server.js)
   ├── Express HTTP → serves static files + REST API
   └── WebSocket → real-time state push to browsers

Browser (any device on local network)
   ├── Fetches UI from http://[server-ip]:3000
   └── WebSocket connection for live updates
```

---

## Tech stack

- `ableton-js` — Ableton Live bridge (MIT)
- `express` — HTTP server
- `ws` — WebSocket server
- Vanilla HTML/CSS/JS frontend (no build step)
