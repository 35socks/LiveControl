import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrackName, parseLine, buildLyricsPayload } from "../lyrics-parser.js";

test("track name flags", () => {
  const { name, opts } = parseTrackName("Lead Vocals +LYRICS [blue] [small] [left] [top+2] [+150ms] [progress] +CC");
  assert.equal(name, "Lead Vocals");
  assert.equal(opts.color, "blue");
  assert.equal(opts.size, "small");
  assert.equal(opts.align, "left");
  assert.equal(opts.top, 2);
  assert.equal(opts.delayMs, 150);
  assert.equal(opts.progress, true);
  assert.equal(opts.clipColors, true);
});

test("negative delays and beat delays", () => {
  assert.equal(parseTrackName("V +LYRICS [-200ms]").opts.delayMs, -200);
  assert.equal(parseTrackName("V +LYRICS [+1n]").opts.delayBeats, 1);
  assert.equal(parseTrackName("V +LYRICS [-2n]").opts.delayBeats, -2);
});

test("transpose flag stays in the name (not ours)", () => {
  assert.equal(parseTrackName("V +LYRICS [+2]").name, "V [+2]");
});

test("line attributes; unknown brackets (chords) are kept", () => {
  assert.deepEqual(parseLine("[blue] [large] Why We Are").color, "blue");
  assert.equal(parseLine("[blue] [large] Why We Are").size, "large");
  assert.equal(parseLine("[blue] [large] Why We Are").text, "Why We Are");
  assert.equal(parseLine("[F] I know").text, "[F] I know");
  assert.equal(parseLine("[<] Line").side, "before");
  assert.equal(parseLine("[>] Line").side, "after");
});

const songs = [
  { id: "a", name: "Song A", time: 0, sections: [{ id: "a1", name: "Verse", time: 0 }, { id: "a2", name: "Chorus", time: 16 }] },
  { id: "b", name: "Song B", time: 100, sections: [] },
];
const clip = (start, end, name, color = 0) => ({ start, end, name, color });

test("lines are assigned to songs and interleaved with sections", () => {
  const { tracks } = buildLyricsPayload([{
    name: "Vocals +LYRICS", clips: [clip(0, 4, "one"), clip(8, 12, "two"), clip(16, 20, "three"), clip(104, 108, "four")],
  }], songs);
  const [a, b] = tracks[0].songs;
  assert.deepEqual(a.items.map((i) => i.type === "section" ? `#${i.name}` : i.text), ["#Verse", "one", "two", "#Chorus", "three"]);
  assert.deepEqual(b.items.map((i) => i.text), ["four"]);
});

test("line crossing a section: more than half after → after header; [<] overrides", () => {
  const mk = (name) => buildLyricsPayload([{ name: "V +LYRICS", clips: [clip(0, 4, "x"), clip(14, 20, name)] }], songs)
    .tracks[0].songs[0].items.map((i) => i.type === "section" ? `#${i.name}` : i.text);
  assert.deepEqual(mk("cross"), ["#Verse", "x", "#Chorus", "cross"]);
  assert.deepEqual(mk("[<] cross"), ["#Verse", "x", "cross", "#Chorus"]);
});

test("empty clips dropped, missing end handled, clip colours only with +CC", () => {
  const p = buildLyricsPayload([{ name: "V +LYRICS +CC", clips: [clip(0, NaN, "a", 0xff0000), clip(4, 8, "  ")] }], songs);
  const lines = p.tracks[0].songs[0].items.filter((i) => i.type === "line");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].end, 1);
  assert.equal(lines[0].clipColor, "#ff0000");
  const q = buildLyricsPayload([{ name: "V +LYRICS", clips: [clip(0, 2, "a", 0xff0000)] }], songs);
  assert.equal(q.tracks[0].songs[0].items.find((i) => i.type === "line").clipColor, null);
});

test("multiple tracks keep separate payloads", () => {
  const p = buildLyricsPayload([
    { name: "Lead +LYRICS", clips: [clip(0, 4, "lead")] },
    { name: "Backing +LYRICS", clips: [clip(0, 4, "backing")] },
  ], songs);
  assert.deepEqual(p.tracks.map((t) => t.name), ["Lead", "Backing"]);
});
