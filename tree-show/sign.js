'use strict';
// The guest site's QR code (with a little TV-and-tree logo in the middle) and a printable sign for passers-by.
//   qrSvg(link)              -> SVG text (for downloading or printing)
//   signPdf(link, title)     -> PDF bytes: a US Letter sign welcoming people to light up the tree
// Level H error correction keeps the code readable with the logo over its middle (the logo covers ~6% of it).
const QR = require('./qr.js');

// The logo, in a 100 x 100 box: an 80s TV (wood, rabbit ears, knobs) showing a little Christmas tree.
const LOGO = [
  { k: 'line', x1: 50, y1: 26, x2: 34, y2: 6, w: 3.4, c: '#9aa1ad' }, { k: 'line', x1: 50, y1: 26, x2: 68, y2: 4, w: 3.4, c: '#9aa1ad' },
  { k: 'circle', cx: 34, cy: 6, r: 3.6, c: '#9aa1ad' }, { k: 'circle', cx: 68, cy: 4, r: 3.6, c: '#9aa1ad' },
  { k: 'rect', x: 6, y: 24, w: 88, h: 64, r: 9, c: '#8a5a2b' },
  { k: 'rect', x: 12, y: 30, w: 58, h: 52, r: 11, c: '#1a1a1a' },
  { k: 'rect', x: 16, y: 34, w: 50, h: 44, r: 9, c: '#0c3a24' },
  { k: 'poly', pts: [[41, 38], [54, 56], [49, 56], [59, 70], [23, 70], [33, 56], [28, 56]], c: '#2fbf5f' },
  { k: 'rect', x: 38, y: 70, w: 6, h: 5, r: 0, c: '#7a4a24' },
  { k: 'circle', cx: 41, cy: 37, r: 3.2, c: '#ffd23b' },
  { k: 'circle', cx: 36, cy: 60, r: 2, c: '#ff3b3b' }, { k: 'circle', cx: 47, cy: 64, r: 2, c: '#3bb3ff' }, { k: 'circle', cx: 43, cy: 52, r: 1.8, c: '#ffd23b' },
  { k: 'rect', x: 74, y: 30, w: 16, h: 52, r: 3, c: '#6e4521' },
  { k: 'circle', cx: 82, cy: 41, r: 5, c: '#2a2a2a' }, { k: 'circle', cx: 82, cy: 56, r: 5, c: '#2a2a2a' },
  { k: 'rect', x: 77, y: 67, w: 10, h: 3, r: 1.5, c: '#2a2a2a' }, { k: 'rect', x: 77, y: 73, w: 10, h: 3, r: 1.5, c: '#2a2a2a' },
  { k: 'line', x1: 22, y1: 88, x2: 18, y2: 96, w: 4, c: '#4a2e14' }, { k: 'line', x1: 78, y1: 88, x2: 82, y2: 96, w: 4, c: '#4a2e14' },
];
function logoSvg(x, y, s) {
  const k = s / 100, P = (v) => +(v * k).toFixed(2);
  const parts = LOGO.map((e) => e.k === 'rect' ? `<rect x="${P(e.x)}" y="${P(e.y)}" width="${P(e.w)}" height="${P(e.h)}" rx="${P(e.r)}" fill="${e.c}"/>`
    : e.k === 'circle' ? `<circle cx="${P(e.cx)}" cy="${P(e.cy)}" r="${P(e.r)}" fill="${e.c}"/>`
      : e.k === 'line' ? `<line x1="${P(e.x1)}" y1="${P(e.y1)}" x2="${P(e.x2)}" y2="${P(e.y2)}" stroke="${e.c}" stroke-width="${P(e.w)}" stroke-linecap="round"/>`
        : `<polygon points="${e.pts.map(([a, b]) => P(a) + ',' + P(b)).join(' ')}" fill="${e.c}"/>`);
  return `<g transform="translate(${x},${y})">${parts.join('')}</g>`;
}

// The QR code's modules, with the middle cleared for the logo. Returns { n, dark(x,y), hole: [x0,y0,size] } in modules.
function codeWithHole(link) {
  const q = QR.make(link), n = q.size;
  let h = Math.round(n * 0.26); if ((n - h) % 2) h++;                    // the logo square, centred
  const h0 = (n - h) / 2;
  return { n, hole: [h0, h0, h], dark: (x, y) => !(x >= h0 && x < h0 + h && y >= h0 && y < h0 + h) && q.dark(x, y) };
}

function qrSvg(link) {
  const c = codeWithHole(link), Q = 4, W = c.n + Q * 2, [hx, hy, hs] = c.hole;
  let d = '';
  for (let y = 0; y < c.n; y++) for (let x = 0; x < c.n; x++) {          // one path, runs of dark modules per row
    if (!c.dark(x, y) || (x > 0 && c.dark(x - 1, y))) continue;
    let r = x; while (r + 1 < c.n && c.dark(r + 1, y)) r++;
    d += `M${x + Q} ${y + Q}h${r - x + 1}v1h-${r - x + 1}z`;
  }
  const pad = hs * 0.08;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="1024" height="1024" shape-rendering="crispEdges">`
    + `<rect width="${W}" height="${W}" fill="#fff"/><path d="${d}" fill="#000"/>`
    + `<rect x="${hx + Q + pad / 2}" y="${hy + Q + pad / 2}" width="${hs - pad}" height="${hs - pad}" rx="${hs * 0.12}" fill="#fff" shape-rendering="auto"/>`
    + `<g shape-rendering="auto">${logoSvg(hx + Q + pad, hy + Q + pad, hs - pad * 2)}</g></svg>`;
}

// ---------- the sign: black and white, simple enough to 3D print ----------
// 200 x 250 mm. Everything is filled shapes (no strokes, no fonts): the lettering is the tree's own 5x7 dot font
// (the one it scrolls messages in), drawn as solid blocks, so slicers and CAD programs take it as it is.
// signSvg(): for 3D printing (import into a slicer / CAD; black = raised, white = the base). signPdf(): the same, true size.
const SW = 200, SH = 250;
const FONT = (() => { // from engine.js, so the sign's letters are exactly the tree's
  const src = require('fs').readFileSync(require('path').join(__dirname, 'public', 'engine.js'), 'utf8');
  return JSON.parse(/var FONT = (\{[^;]*\});/.exec(src)[1]);
})();
const GLYPH_W = 5, GLYPH_H = 7;
function pixelText(shapes, str, cx, top, px) { // centred on cx; each lit dot a solid square (touching dots merge)
  str = String(str).toUpperCase();
  const w = str.length * (GLYPH_W + 1) * px - px, x0 = cx - w / 2, e = 0.02;      // e: a hair of overlap, no seams
  [...str].forEach((ch, i) => {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < GLYPH_H; r++) {
      for (let c = 0; c < GLYPH_W; c++) {
        if (g[r * 5 + c] !== '1' || (c > 0 && g[r * 5 + c - 1] === '1')) continue;
        let e2 = c; while (e2 + 1 < GLYPH_W && g[r * 5 + e2 + 1] === '1') e2++;
        shapes.push({ k: 'rect', x: x0 + (i * (GLYPH_W + 1) + c) * px - e, y: top + r * px - e, w: (e2 - c + 1) * px + 2 * e, h: px + 2 * e });
      }
    }
  });
  return w;
}
// The TV and tree as outlines and solid parts (no colours): body ring, screen ring, tree, antennas, knobs, legs.
function tvShapes(shapes, x, y, s) { // in a 100-unit box at (x, y), scale s mm per 100 units
  const k = s / 100, X = (v) => x + v * k, Y = (v) => y + v * k, L = (v) => v * k;
  const bar = (x1, y1, x2, y2, w) => { const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy), nx = -dy / l * w / 2, ny = dx / l * w / 2; shapes.push({ k: 'poly', pts: [[X(x1) + L(nx), Y(y1) + L(ny)], [X(x2) + L(nx), Y(y2) + L(ny)], [X(x2) - L(nx), Y(y2) - L(ny)], [X(x1) - L(nx), Y(y1) - L(ny)]] }); };
  bar(50, 26, 32, 6, 5); bar(50, 26, 70, 4, 5);
  shapes.push({ k: 'circle', cx: X(32), cy: Y(6), r: L(5) }, { k: 'circle', cx: X(70), cy: Y(4), r: L(5) });
  shapes.push({ k: 'ring', x: X(4), y: Y(24), w: L(92), h: L(64), r: L(10), t: L(7) });          // the cabinet
  shapes.push({ k: 'ring', x: X(14), y: Y(32), w: L(54), h: L(48), r: L(9), t: L(4) });           // the screen's edge
  shapes.push({ k: 'poly', pts: [[41, 38], [54, 55], [48, 55], [58, 70], [24, 70], [34, 55], [28, 55]].map(([a, b]) => [X(a), Y(b)]) }); // the tree
  shapes.push({ k: 'rect', x: X(38), y: Y(69), w: L(6), h: L(6) });
  shapes.push({ k: 'circle', cx: X(82), cy: Y(42), r: L(6) }, { k: 'circle', cx: X(82), cy: Y(60), r: L(6) });
  bar(20, 87, 15, 97, 6); bar(80, 87, 85, 97, 6);
}
function signShapes(link) {
  const sh = [];
  sh.push({ k: 'ring', x: 4, y: 4, w: SW - 8, h: SH - 8, r: 9, t: 3.5 });                          // the frame
  pixelText(sh, 'LIGHT UP', SW / 2, 13, 3);
  pixelText(sh, 'OUR TREE!', SW / 2, 39, 3);
  // the QR code: 118 mm, a hole in the middle for the TV
  const c = codeWithHole(link), Q = 4, size = 124, mod = size / (c.n + Q * 2), qx = (SW - size) / 2, qy = 63, e = 0.02;
  for (let y = 0; y < c.n; y++) for (let x = 0; x < c.n; x++) {
    if (!c.dark(x, y) || (x > 0 && c.dark(x - 1, y))) continue;
    let r = x; while (r + 1 < c.n && c.dark(r + 1, y)) r++;
    sh.push({ k: 'rect', x: qx + (x + Q) * mod - e, y: qy + (y + Q) * mod - e, w: (r - x + 1) * mod + 2 * e, h: mod + 2 * e });
  }
  const [hx, hy, hs] = c.hole, pad = hs * 0.1;
  tvShapes(sh, qx + (hx + Q + pad) * mod, qy + (hy + Q + pad) * mod, (hs - 2 * pad) * mod);
  pixelText(sh, 'SCAN ME', SW / 2, qy + size + 6, 2.4);
  const shown = String(link).replace(/^https?:\/\//, '').replace(/\/$/, '').toUpperCase();
  const px = Math.min(1.4, (SW - 24) / (shown.length * 6));
  pixelText(sh, shown, SW / 2, qy + size + 27, px);
  pixelText(sh, 'TREE-MOTE CONTROL', SW / 2, qy + size + 27 + px * 7 + 5, 1.1);
  return sh;
}
// rounded rectangle path (y down), for SVG; the ring is two of them, the inner one wound the other way (even-odd)
function rrPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}
const f2 = (v) => +v.toFixed(3);
function signSvg(link) {
  const body = signShapes(link).map((s) => {
    if (s.k === 'rect') return `<rect x="${f2(s.x)}" y="${f2(s.y)}" width="${f2(s.w)}" height="${f2(s.h)}"/>`;
    if (s.k === 'circle') return `<circle cx="${f2(s.cx)}" cy="${f2(s.cy)}" r="${f2(s.r)}"/>`;
    if (s.k === 'poly') return `<polygon points="${s.pts.map(([a, b]) => f2(a) + ',' + f2(b)).join(' ')}"/>`;
    return `<path fill-rule="evenodd" d="${rrPath(f2(s.x), f2(s.y), f2(s.w), f2(s.h), f2(s.r))}${rrPath(f2(s.x + s.t), f2(s.y + s.t), f2(s.w - 2 * s.t), f2(s.h - 2 * s.t), f2(Math.max(0, s.r - s.t)))}"/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${SW}mm" height="${SH}mm" viewBox="0 0 ${SW} ${SH}">\n`
    + `<!-- Tree sign for 3D printing: ${SW} x ${SH} mm. White = the base plate, black = raised (or a second colour). -->\n`
    + `<rect id="base" width="${SW}" height="${SH}" rx="12" fill="#ffffff"/>\n<g id="raised" fill="#000000">\n${body}\n</g>\n</svg>\n`;
}
// The same sign as a PDF page of exactly 200 x 250 mm (print at 100%).
function signPdf(link, title) {
  const K = 72 / 25.4, PW = SW * K, PH = SH * K, X = (v) => (v * K).toFixed(2), Y = (v) => ((SH - v) * K).toFixed(2), ops = ['0 0 0 rg'];
  const rr = (x, y, w, h, r) => { // a rounded rectangle path in PDF space (y up), from sign mm (y down)
    r = Math.min(r, w / 2, h / 2); const k = 0.5523 * r;
    return `${X(x + r)} ${Y(y)} m ${X(x + w - r)} ${Y(y)} l ${X(x + w - r + k)} ${Y(y)} ${X(x + w)} ${Y(y + r - k)} ${X(x + w)} ${Y(y + r)} c `
      + `${X(x + w)} ${Y(y + h - r)} l ${X(x + w)} ${Y(y + h - r + k)} ${X(x + w - r + k)} ${Y(y + h)} ${X(x + w - r)} ${Y(y + h)} c `
      + `${X(x + r)} ${Y(y + h)} l ${X(x + r - k)} ${Y(y + h)} ${X(x)} ${Y(y + h - r + k)} ${X(x)} ${Y(y + h - r)} c `
      + `${X(x)} ${Y(y + r)} l ${X(x)} ${Y(y + r - k)} ${X(x + r - k)} ${Y(y)} ${X(x + r)} ${Y(y)} c h `;
  };
  for (const s of signShapes(link)) {
    if (s.k === 'rect') ops.push(`${X(s.x)} ${Y(s.y + s.h)} ${(s.w * K).toFixed(2)} ${(s.h * K).toFixed(2)} re f`);
    else if (s.k === 'circle') { const k = 0.5523 * s.r; ops.push(`${X(s.cx + s.r)} ${Y(s.cy)} m ${X(s.cx + s.r)} ${Y(s.cy - k)} ${X(s.cx + k)} ${Y(s.cy - s.r)} ${X(s.cx)} ${Y(s.cy - s.r)} c ${X(s.cx - k)} ${Y(s.cy - s.r)} ${X(s.cx - s.r)} ${Y(s.cy - k)} ${X(s.cx - s.r)} ${Y(s.cy)} c ${X(s.cx - s.r)} ${Y(s.cy + k)} ${X(s.cx - k)} ${Y(s.cy + s.r)} ${X(s.cx)} ${Y(s.cy + s.r)} c ${X(s.cx + k)} ${Y(s.cy + s.r)} ${X(s.cx + s.r)} ${Y(s.cy + k)} ${X(s.cx + s.r)} ${Y(s.cy)} c f`); }
    else if (s.k === 'poly') ops.push(s.pts.map(([a, b], i) => `${X(a)} ${Y(b)} ${i ? 'l' : 'm'}`).join(' ') + ' h f');
    else ops.push(rr(s.x, s.y, s.w, s.h, s.r) + rr(s.x + s.t, s.y + s.t, s.w - 2 * s.t, s.h - 2 * s.t, Math.max(0, s.r - s.t)) + 'f*');
  }
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW.toFixed(2)} ${PH.toFixed(2)}] /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title (${String((title || 'Tree') + ' sign').replace(/[^\x20-\x7e]/g, '').replace(/[\\()]/g, '\\$&')}) /Producer (tree-show) >>`,
  ];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- the 3D-printed sign (Bambu-size, two colours on white) ----------
// printLayout(link) -> { w, h, holes, slots, red: [shapes], green: [shapes] } in mm, y down from the top edge.
// tools/sign3d.py turns it into STL/3MF parts. 185 x 235 mm leaves room for the prime tower on a 256 mm bed.
const PW3 = 185, PH3 = 235;
function printLayout(link) {
  const red = [], green = [], cx = PW3 / 2;
  // text is drawn by tools/sign3d.py from a real font (smooth curves): { k: 'text', s, cx, top, h = capital height, maxw }
  red.push({ k: 'text', s: 'LIGHT UP', cx, top: 18, h: 17, maxw: PW3 - 20 });
  red.push({ k: 'text', s: 'OUR TREE!', cx, top: 41, h: 17, maxw: PW3 - 20 });
  const c = codeWithHole(link), Q = 4, size = 124, mod = size / (c.n + Q * 2), qx = (PW3 - size) / 2, qy = 60, e = 0.02; // 4-module quiet zone
  for (let y = 0; y < c.n; y++) for (let x = 0; x < c.n; x++) {
    if (!c.dark(x, y) || (x > 0 && c.dark(x - 1, y))) continue;
    let r = x; while (r + 1 < c.n && c.dark(r + 1, y)) r++;
    green.push({ k: 'rect', x: qx + (x + Q) * mod - e, y: qy + (y + Q) * mod - e, w: (r - x + 1) * mod + 2 * e, h: mod + 2 * e });
  }
  const [hx, hy, hs] = c.hole, pad = hs * 0.1, tv = [];
  tvShapes(tv, qx + (hx + Q + pad) * mod, qy + (hy + Q + pad) * mod, (hs - 2 * pad) * mod);
  tv.forEach((s, i) => (i === 6 || i === 7 ? green : red).push(s));   // the tree and its trunk green, the TV red
  green.push({ k: 'text', s: 'SCAN ME', cx, top: qy + size + 6, h: 12, maxw: PW3 - 30 });
  const shown = String(link).replace(/^https?:\/\//, '').replace(/\/$/, '');
  green.push({ k: 'text', s: shown, cx, top: qy + size + 25, h: 7, maxw: PW3 - 24 });
  return { w: PW3, h: PH3, holes: [[cx, 8.5], [cx, PH3 - 8.5]], slots: [[cx - 15, 8.5], [cx + 15, 8.5], [cx - 15, PH3 - 8.5], [cx + 15, PH3 - 8.5]], red, green };
}

module.exports = { qrSvg, signSvg, signPdf, logoSvg, printLayout };
