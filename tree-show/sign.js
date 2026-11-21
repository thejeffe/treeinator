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

// ---------- a hand-made PDF (no libraries): US Letter, the standard Helvetica fonts ----------
const HV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
function textW(s, size, bold) { const t = bold ? HVB : HV; let w = 0; for (const ch of String(s)) { const c = ch.charCodeAt(0); w += t[c >= 32 && c <= 126 ? c - 32 : 0]; } return w * size / 1000; }
const pdfStr = (s) => '(' + String(s).replace(/[^\x20-\x7e]/g, '').replace(/[\\()]/g, '\\$&') + ')';
function rgb(hex) { const v = parseInt(hex.slice(1), 16); return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map((x) => x.toFixed(3)).join(' '); }

function signPdf(link, title) {
  const PW = 612, PH = 792, ops = [];
  const fill = (c) => ops.push(rgb(c) + ' rg'), stroke = (c) => ops.push(rgb(c) + ' RG');
  const rect = (x, y, w, h, c) => { fill(c); ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); };
  const rrect = (x, y, w, h, r, c) => { // rounded rectangle (y up)
    fill(c); const k = 0.5523 * r;
    ops.push(`${x + r} ${y} m ${x + w - r} ${y} l ${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r} c ${x + w} ${y + h - r} l ${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h} c `
      + `${x + r} ${y + h} l ${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r} c ${x} ${y + r} l ${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y} c f`);
  };
  const circle = (cx, cy, r, c) => { fill(c); const k = 0.5523 * r; ops.push(`${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c f`); };
  const text = (s, x, y, size, bold, c, align) => {
    const w = textW(s, size, bold), xx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    fill(c); ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${xx.toFixed(2)} ${y.toFixed(2)} Td ${pdfStr(s)} Tj ET`);
  };
  const star = (cx, cy, r, c) => { fill(c); const p = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.42 : r; p.push([cx + rr * Math.cos(a), cy - rr * Math.sin(a)]); } ops.push(p.map(([a, b], i) => `${a.toFixed(2)} ${b.toFixed(2)} ${i ? 'l' : 'm'}`).join(' ') + ' h f'); };
  // the logo in PDF space: a 100-unit box at (x, y top-left), scale s
  const logo = (x, y, s) => {
    const k = s / 100, X = (v) => x + v * k, Y = (v) => y - v * k;
    for (const e of LOGO) {
      if (e.k === 'rect') { if (e.r) rrect(X(e.x), Y(e.y + e.h), e.w * k, e.h * k, e.r * k, e.c); else rect(X(e.x), Y(e.y + e.h), e.w * k, e.h * k, e.c); }
      else if (e.k === 'circle') circle(X(e.cx), Y(e.cy), e.r * k, e.c);
      else if (e.k === 'line') { stroke(e.c); ops.push(`${(e.w * k).toFixed(2)} w 1 J ${X(e.x1).toFixed(2)} ${Y(e.y1).toFixed(2)} m ${X(e.x2).toFixed(2)} ${Y(e.y2).toFixed(2)} l S`); }
      else { fill(e.c); ops.push(e.pts.map(([a, b], i) => `${X(a).toFixed(2)} ${Y(b).toFixed(2)} ${i ? 'l' : 'm'}`).join(' ') + ' h f'); }
    }
  };
  const RED = '#c0262d', GREEN = '#1f7a45', GOLD = '#e0a91f', INK = '#1d1d1d';
  // background: a red band at the top, a green one at the bottom, a few stars
  rect(0, PH - 150, PW, 150, RED);
  rect(0, 0, PW, 54, GREEN);
  [[118, 772, 7], [494, 772, 8], [206, 650, 0], [306, 777, 5]].filter((s) => s[2]).forEach(([x, y, r]) => star(x, y, r, '#ffd76a'));
  logo(24, PH - 34, 78);
  logo(PW - 102, PH - 34, 78);
  text('Light up our tree!', PW / 2, PH - 78, 40, true, '#ffffff', 'center');
  text('Pick what our Christmas tree shows next', PW / 2, PH - 116, 20, false, '#ffe9e9', 'center');
  text('with ' + (title || 'Tree-mote Control'), PW / 2, PH - 140, 15, true, '#ffd76a', 'center');
  // the QR code, big, with the logo in the middle
  const c = codeWithHole(link), size = 340, Q = 4, mod = size / (c.n + Q * 2), qx = (PW - size) / 2, qy = PH - 175 - size;
  rrect(qx - 10, qy - 10, size + 20, size + 20, 18, GREEN);
  rect(qx, qy, size, size, '#ffffff');
  fill('#000000');
  for (let y = 0; y < c.n; y++) for (let x = 0; x < c.n; x++) {
    if (!c.dark(x, y) || (x > 0 && c.dark(x - 1, y))) continue;
    let r = x; while (r + 1 < c.n && c.dark(r + 1, y)) r++;
    ops.push(`${(qx + (x + Q) * mod).toFixed(2)} ${(qy + size - (y + Q + 1) * mod).toFixed(2)} ${((r - x + 1) * mod + 0.05).toFixed(2)} ${(mod + 0.05).toFixed(2)} re f`);
  }
  const [hx, hy, hs] = c.hole, pad = hs * 0.08;
  rrect(qx + (hx + Q + pad / 2) * mod, qy + size - (hy + Q + hs - pad / 2) * mod, (hs - pad) * mod, (hs - pad) * mod, hs * 0.12 * mod, '#ffffff');
  logo(qx + (hx + Q + pad) * mod, qy + size - (hy + Q + pad) * mod, (hs - pad * 2) * mod);
  // how it works
  const shown = String(link).replace(/^https?:\/\//, '').replace(/\/$/, '');
  text('Scan with your phone camera', PW / 2, qy - 40, 24, true, INK, 'center');
  text('or visit  ' + shown, PW / 2, qy - 64, 15, false, '#555555', 'center');
  const steps = [['1', 'Scan the code'], ['2', 'Pick a design,', 'colors and a message'], ['3', 'Watch the tree', 'light up for you!']];
  steps.forEach((s, i) => {
    const cx = 126 + i * 180, cy = qy - 112;
    circle(cx, cy, 17, i === 1 ? GOLD : i === 2 ? GREEN : RED);
    text(s[0], cx, cy - 7, 20, true, '#ffffff', 'center');
    text(s[1], cx, cy - 40, 13, true, INK, 'center');
    if (s[2]) text(s[2], cx, cy - 56, 13, false, INK, 'center');
  });
  text('Requests play while the tree is on. Please keep messages friendly. Merry Christmas!', PW / 2, 22, 12, false, '#ffffff', 'center');
  // the file
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title ${pdfStr((title || 'Tree-mote Control') + ' sign')} /Producer (tree-show) >>`,
  ];
  let out = '%PDF-1.4\n', offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { qrSvg, signPdf, logoSvg };
