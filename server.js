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
import { writeFile } from "fs/promises";
import { qrSvg, qrTerminal } from "./qr.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "3000", 10);

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

/* ── Connect info (QR / device syncing) ──────────────────────────────────── */
// LAN IPv4 addresses other devices can reach, best candidate first
// (Wi-Fi/Ethernet "en0", then private ranges, then anything else).
function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(iface.address);
      found.push({ name, address: iface.address, score: (name === "en0" ? 2 : 0) + (priv ? 1 : 0) });
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

function connectUrls() {
  const port = server.address()?.port;
  if (!port) return [];
  return lanAddresses().map(({ name, address }) => ({ label: name, url: `http://${address}:${port}` }));
}

app.get("/api/connect", (req, res) => ok(res, { urls: connectUrls() }));

app.get("/api/connect/qr.svg", (req, res) => {
  const urls = connectUrls();
  const index = Number.parseInt(req.query.i ?? "0", 10);
  const target = urls[Number.isInteger(index) && index >= 0 ? index : 0];
  if (!target) return res.status(404).type("text/plain").send("No network address found");
  res.set("Cache-Control", "no-store").type("image/svg+xml").send(qrSvg(target.url));
});

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
  wrap(res, async () => { await bridge.requestJump("song", req.params.songId); ok(res); })
);

app.post("/api/jump/section/:songId/:sectionId", (req, res) =>
  wrap(res, async () => {
    await bridge.requestJump("section", req.params.songId, req.params.sectionId);
    ok(res);
  })
);

app.post("/api/jump-mode", (req, res) => wrap(res, async () => {
  await bridge.setJumpMode(req.body.mode);
  ok(res, { mode: bridge.jumpMode });
}));

app.post("/api/settings/stop-after-song", (req, res) => wrap(res, async () => {
  await bridge.setStopAfterSong(req.body.enabled);
  ok(res, { enabled: bridge.stopAfterSong });
}));

app.post("/api/settings/setlist-name", (req, res) => wrap(res, async () => {
  await bridge.setSetlistName(req.body.name);
  ok(res, { name: bridge.state.setlistName });
}));

app.post("/api/jump/commit", (req, res) => wrap(res, async () => {
  await bridge.commitPendingJump(req.body.quantized !== false);
  ok(res);
}));

app.post("/api/jump/cancel", (req, res) => {
  bridge.cancelPendingJump();
  ok(res);
});

app.post("/api/reload", (req, res) =>
  wrap(res, async () => { await bridge.reloadSetlist(); ok(res); })
);

app.post("/api/loop", (req, res) => wrap(res, async () => {
  if (req.body.active === false) {
    await bridge.clearLoop();
    return ok(res);
  }
  const loop = await bridge.setLoop(req.body.songId, req.body.sectionId || null);
  ok(res, { loop });
}));

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
    await saveOrder(bridge.setlist.map((s) => ({ key: s.orderKey })));
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
  const actualPort = server.address().port;
  if (process.env.PORT_FILE) {
    try { await writeFile(process.env.PORT_FILE, String(actualPort), "utf8"); }
    catch (e) { console.error("[server] Could not write port file:", e.message); }
  }
  const localIP = lanAddresses()[0]?.address ?? "localhost";
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║         LiveControl is running         ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║  Local:   http://localhost:${actualPort}         ║`);
  console.log(`║  Network: http://${localIP}:${actualPort}    ║`);
  console.log("╚════════════════════════════════════════╝\n");
  if (localIP !== "localhost") {
    console.log("Scan to open LiveControl on your phone or tablet:\n");
    console.log(qrTerminal(`http://${localIP}:${actualPort}`) + "\n");
  }
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
