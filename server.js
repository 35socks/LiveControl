/**
 * server.js — LiveControl main server
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { AbletonBridge } from "./ableton.js";
import { setSongMeta, saveOrder } from "./storage.js";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
// Malformed JSON bodies would otherwise throw inside express.json() and
// crash the request with an unhandled error / raw stack trace.
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Malformed JSON body" });
  }
  next(err);
});
app.use(express.static(path.join(__dirname, "public")));

const server = createServer(app);
const wss    = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

const bridge = new AbletonBridge((state) => {
  broadcast({ type: "state", payload: state });
});

wss.on("connection", (ws) => {
  console.log("[ws] Client connected");
  ws.send(JSON.stringify({ type: "state", payload: bridge.state }));
  ws.on("close", () => console.log("[ws] Client disconnected"));
  ws.on("error", (e) => console.error("[ws] Error:", e.message));
});

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function ok(res, data = {}) { res.json({ ok: true, ...data }); }
function fail(res, msg, status = 400) { res.status(status).json({ ok: false, error: msg }); }
async function wrap(res, fn) {
  try { await fn(); }
  catch (e) { console.error("[api]", e.message); fail(res, e.message, 500); }
}

/* ── State ───────────────────────────────────────────────────────────────── */
app.get("/api/state", (req, res) => res.json({ ok: true, payload: bridge.state }));

/* ── Transport ───────────────────────────────────────────────────────────── */
app.post("/api/play",     (req, res) => wrap(res, async () => { await bridge.play();            ok(res); }));
app.post("/api/stop",     (req, res) => wrap(res, async () => { await bridge.stop();            ok(res); }));
app.post("/api/continue", (req, res) => wrap(res, async () => { await bridge.continuePlaying(); ok(res); }));
app.post("/api/next-cue", (req, res) => wrap(res, async () => { await bridge.jumpToNextCue();  ok(res); }));
app.post("/api/prev-cue", (req, res) => wrap(res, async () => { await bridge.jumpToPrevCue();  ok(res); }));

app.post("/api/tempo", (req, res) => wrap(res, async () => {
  const { bpm } = req.body;
  const val = parseFloat(bpm);
  if (!Number.isFinite(val)) return fail(res, "bpm required");
  await bridge.setTempo(val);
  ok(res);
}));

/* ── Setlist navigation ──────────────────────────────────────────────────── */
app.post("/api/jump/song/:songId", (req, res) =>
  wrap(res, async () => { await bridge.jumpToSong(req.params.songId); ok(res); })
);

app.post("/api/jump/section/:songId/:sectionId", (req, res) =>
  wrap(res, async () => {
    await bridge.jumpToSection(req.params.songId, req.params.sectionId);
    ok(res);
  })
);

app.post("/api/reload", (req, res) =>
  wrap(res, async () => { await bridge.reloadSetlist(); ok(res); })
);

/* ── Song metadata ───────────────────────────────────────────────────────── */
app.post("/api/song/:songId/notes", (req, res) =>
  wrap(res, async () => {
    const song = bridge.setlist.find((s) => s.id === req.params.songId);
    if (!song) return fail(res, "Song not found");
    const notes = req.body.notes ?? "";
    await setSongMeta(song.name, { notes });
    bridge.updateSongMeta(song.id, { notes });
    ok(res);
  })
);

app.post("/api/song/:songId/color", (req, res) =>
  wrap(res, async () => {
    const song = bridge.setlist.find((s) => s.id === req.params.songId);
    if (!song) return fail(res, "Song not found");
    const color = req.body.color ?? "";
    await setSongMeta(song.name, { color });
    bridge.updateSongMeta(song.id, { color });
    ok(res);
  })
);

app.post("/api/song/:songId/exclude", (req, res) =>
  wrap(res, async () => {
    const song = bridge.setlist.find((s) => s.id === req.params.songId);
    if (!song) return fail(res, "Song not found");
    const excluded = !!req.body.excluded;
    await setSongMeta(song.name, { excluded });
    bridge.updateSongMeta(song.id, { excluded });
    ok(res);
  })
);

app.post("/api/setlist/reorder", (req, res) =>
  wrap(res, async () => {
    const { order } = req.body;
    if (!Array.isArray(order)) return fail(res, "order must be an array of IDs");
    bridge.reorderSetlist(order);
    await saveOrder(bridge.setlist.map((s) => s.name));
    ok(res);
  })
);

/* ── 404 + error handling ────────────────────────────────────────────────── */
app.use("/api", (req, res) => fail(res, "Not found", 404));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err);
  if (res.headersSent) return next(err);
  fail(res, "Internal server error", 500);
});

/* ── Start ───────────────────────────────────────────────────────────────── */
server.listen(PORT, "0.0.0.0", async () => {
  const interfaces = os.networkInterfaces();
  let localIP = "localhost";
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) { localIP = iface.address; break; }
    }
  }
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║         LiveControl is running         ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║  Local:   http://localhost:${PORT}         ║`);
  console.log(`║  Network: http://${localIP}:${PORT}    ║`);
  console.log("╚════════════════════════════════════════╝\n");
  try {
    await bridge.start();
  } catch (e) {
    console.error("[server] Failed to start Ableton bridge:", e.message);
  }
});

/* ── Graceful shutdown ───────────────────────────────────────────────────── */
function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down…`);
  for (const client of wss.clients) client.close();
  server.close(() => {
    console.log("[server] Closed. Bye!");
    process.exit(0);
  });
  // Force-exit if something keeps the event loop alive
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
