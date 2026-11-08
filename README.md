# LiveControl

A free, open source app to control Ableton Live from any device on your local network via a browser.
## Features

- 🎵 **Setlist from cue points** — automatically parses Ableton locators into a setlist
- 🎛️ **Web control** — open on any phone, tablet, or computer on the same WiFi
- ▶️ **Transport** — play, stop, continue, next/prev cue
- 🔀 **Song jumping** — tap any song to jump to it in Ableton
- 📋 **Sections** — expand songs to see and jump to sub-sections
- 🛑 **Song end markers** — `[STOP]` ends the song, stops playback, and parks the playhead on the next song so Play starts it; the previous section runs up to that marker
- 🔁 **Section loops** — use the loop button or add `+LOOP` / `+LOOPFULL` to a section cue; LiveControl draws and enables Ableton's own loop brackets
- 🎤 **Performance mode** — a large, second-device-friendly now-playing view with shared loop feedback
- 🎨 **Song colors** — color-code your setlist
- 📝 **Song notes** — add notes, chords, or instructions per song
- ↕️ **Reorder** — drag setlist songs with a mouse or touch; order survives reloads, including duplicate titles
- 🔇 **Track mute/solo** — control any track from the Tracks tab
- ⌨️ **Keyboard shortcuts** — Space (play/stop), ←→ (prev/next cue)
- 📷 **QR device syncing** — scan a QR code (QR button in the header, or the Mac app's menu bar) to open LiveControl on a phone or tablet
- 📱 **Fully responsive** — works great on iPhone, iPad, and desktop

## Setup

### macOS app

Open `LiveControl.app` to run LiveControl from the menu bar. Click the **LC** menu bar icon to see that LiveControl is running, scan the QR code to open it on a phone or tablet on your Wi-Fi, or copy the phone / tablet and local URLs. The gear in that panel lets you show/hide the LiveControl window or quit. The app starts and stops its local Ableton bridge automatically. Setlist notes, colors, and ordering are stored in `~/Library/Application Support/LiveControl`.

The app bundle includes Node.js and all server dependencies. You do not need to use Terminal or install Node.js. Ableton Live must have the **AbletonJS** control surface enabled under **Settings → Link, Tempo & MIDI → Control Surface**. The Remote Script is bundled inside the app at `Contents/Resources/LiveControl/node_modules/ableton-js/midi-script`; copy its `AbletonJS` folder into Ableton's `User Library/Remote Scripts` folder if it is not already installed, then restart Live.

To rebuild the Mac app from this source project, run `npm install` and `npm run build:app`.

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
| `> Chorus +LOOP` | Loops from this section cue to the next cue |
| `> Chorus +LOOPFULL` | Marks a full section loop |
| `> Chorus` | Another section |
| `[NEXTMARKER]` | Real starting point of the song — jumping to the song jumps here instead, skipping lead-in silence |
| `[STOP]` or `--- STOP ---` | End of the song; playback stops at this marker |
| `// comment` | Ignored |

**Example arrangement:**
```
1.1.1  Intro
3.1.1  [NEXTMARKER]      ← song actually starts here; jumping skips the lead-in
33.1.1 > Verse 1
65.1.1 > Chorus +LOOP
97.1.1 [STOP]
97.1.1 Second Song
97.1.1 > Drop
161.1.1 [STOP]
```

Ableton reports locator and playhead positions in beats. LiveControl converts them to minutes and seconds using the current tempo.

After editing cue points in Ableton, click the **↺** button in LiveControl to reload.

---

## API Reference

All endpoints return `{ ok: true, ... }` or `{ ok: false, error: "..." }`.

### Transport
| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/play` | — | Start playback |
| POST | `/api/stop` | — | Stop playback |
| GET | `/api/connect` | — | LAN addresses other devices can use |
| GET | `/api/connect/qr.svg?i=0` | — | QR code (SVG) for a LAN address |
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
| POST | `/api/loop` | `{ songId, sectionId }` or `{ active: false }` | Enable or clear the shared loop |
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
