/**
 * qr.js — Tiny QR helpers (SVG for the web UI, half-block text for the terminal).
 */

import qrcode from "qrcode-generator";

function buildMatrix(text) {
  const qr = qrcode(0, "M"); // type 0 = smallest version that fits
  qr.addData(String(text));
  qr.make();
  const size = qr.getModuleCount();
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push(qr.isDark(y, x));
    rows.push(row);
  }
  return rows;
}

/** Black-on-white SVG with the 4-module quiet zone scanners need. */
export function qrSvg(text) {
  const rows = buildMatrix(text);
  const quiet = 4;
  const size = rows.length + quiet * 2;
  let path = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) { x++; continue; }
      let run = 1;
      while (x + run < row.length && row[x + run]) run++;
      path += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/** Terminal QR using half-block characters (dark-on-light inverted for dark terminals). */
export function qrTerminal(text) {
  const rows = buildMatrix(text);
  const quiet = 2;
  const width = rows.length + quiet * 2;
  const at = (x, y) => {
    const xx = x - quiet, yy = y - quiet;
    return yy >= 0 && yy < rows.length && xx >= 0 && xx < rows.length ? rows[yy][xx] : false;
  };
  const lines = [];
  for (let y = 0; y < width; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = at(x, y), bottom = at(x, y + 1);
      // Light modules are drawn as filled blocks so it scans on dark terminals.
      line += !top && !bottom ? "█" : !top && bottom ? "▀" : top && !bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
