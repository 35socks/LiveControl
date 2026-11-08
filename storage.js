/**
 * storage.js — Reads/writes setlist-meta.json for persistent metadata
 * (notes, colors, virtual order, excluded songs)
 */

import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LIVECONTROL_DATA_DIR || __dirname;
const META_FILE = path.join(DATA_DIR, "setlist-meta.json");

let cache = null;

// Serializes writes so rapid-fire calls (e.g. drag-reorder followed
// immediately by a notes save) can't interleave and clobber each other —
// each write now waits for the previous one to finish before starting.
let writeQueue = Promise.resolve();

export async function loadMeta() {
  if (cache) return cache;
  if (!existsSync(META_FILE)) {
    cache = { songs: {}, order: [], settings: {} };
    return cache;
  }
  try {
    const raw = await readFile(META_FILE, "utf8");
    const parsed = JSON.parse(raw);
    // Older releases could write `songs` as an array. Recover cleanly so
    // metadata edits can be saved again instead of silently disappearing.
    cache = {
      songs: parsed?.songs && !Array.isArray(parsed.songs) && typeof parsed.songs === "object"
        ? parsed.songs
        : {},
      order: Array.isArray(parsed?.order) ? parsed.order : [],
      settings: parsed?.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
        ? parsed.settings
        : {},
    };
    return cache;
  } catch (e) {
    console.error("[storage] Failed to load meta:", e.message);
    cache = { songs: {}, order: [], settings: {} };
    return cache;
  }
}

function saveMeta() {
  const snapshot = JSON.stringify(cache, null, 2);
  const write = writeQueue.catch(() => {}).then(async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      const tempFile = `${META_FILE}.tmp`;
      await writeFile(tempFile, snapshot, "utf8");
      await rename(tempFile, META_FILE);
    } catch (e) {
      console.error("[storage] Failed to save meta:", e.message);
      throw e;
    }
  });
  writeQueue = write;
  return write;
}

export async function setSongMeta(songName, updates) {
  const meta = await loadMeta();
  meta.songs[songName] = { ...(meta.songs[songName] || {}), ...updates };
  await saveMeta();
  return meta.songs[songName];
}

export async function saveOrder(orderKeys) {
  const meta = await loadMeta();
  meta.order = orderKeys;
  await saveMeta();
}

export async function setSetting(key, value) {
  const meta = await loadMeta();
  meta.settings[key] = value;
  await saveMeta();
  return value;
}

export async function clearCache() {
  cache = null;
}
