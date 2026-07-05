/**
 * storage.js — Reads/writes setlist-meta.json for persistent metadata
 * (notes, colors, virtual order, excluded songs)
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_FILE = path.join(__dirname, "setlist-meta.json");

let cache = null;

// Serializes writes so rapid-fire calls (e.g. drag-reorder followed
// immediately by a notes save) can't interleave and clobber each other —
// each write now waits for the previous one to finish before starting.
let writeQueue = Promise.resolve();

export async function loadMeta() {
  if (cache) return cache;
  if (!existsSync(META_FILE)) {
    cache = { songs: {}, order: [] };
    return cache;
  }
  try {
    const raw = await readFile(META_FILE, "utf8");
    cache = JSON.parse(raw);
    cache.songs = cache.songs || {};
    cache.order = cache.order || [];
    return cache;
  } catch (e) {
    console.error("[storage] Failed to load meta:", e.message);
    cache = { songs: {}, order: [] };
    return cache;
  }
}

function saveMeta() {
  writeQueue = writeQueue.then(async () => {
    try {
      await writeFile(META_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
      console.error("[storage] Failed to save meta:", e.message);
    }
  });
  return writeQueue;
}

export async function setSongMeta(songName, updates) {
  const meta = await loadMeta();
  meta.songs[songName] = { ...(meta.songs[songName] || {}), ...updates };
  await saveMeta();
  return meta.songs[songName];
}

export async function saveOrder(orderedNames) {
  const meta = await loadMeta();
  meta.order = orderedNames;
  await saveMeta();
}

export async function clearCache() {
  cache = null;
}
