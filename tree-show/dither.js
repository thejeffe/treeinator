'use strict';
// Accurate colors when the tree is dim (server side only).
//
// Without this, tree-show applies gamma and rounds to whole levels, then scales
// by the general brightness and rounds again, so at low brightness weak color
// channels drop out and hues drift. These modes dim with fractions of a level
// and round only once, in one of four ways:
//   off       old behavior (round twice)
//   spatial   neighbors share the in-between levels in a fixed 4x4 pattern
//             (by rib and row on the tree), steady, exact on average
//   hue       each pixel holds one steady color, chosen to keep its hue
//   temporal  each pixel flips between neighboring levels over time (needs a
//             fast WLED refresh, i.e. short strands per output)
//   wled      WLED's own temporal dithering (Jeff's WLED build "dither1", from Lickety Split):
//             tree-show sends the plain picture (no gamma, no dimming) and sets WLED's
//             dithering, brightness (bri16) and gamma through /json/state
// "darkest": also dither values under one level (else they are rounded).

const MODES = ['off', 'spatial', 'hue', 'temporal', 'wled'];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const SHIFT = [[0, 0], [2, 1], [1, 3]]; // per channel, so R/G/B don't step up together

function create(E) {
  const WN = E.WN, N = E.N, NT = E.NT, ROWS = E.CONFIG.rows, WIDX = E.WIDX;
  // float gamma table: input level 0..255 -> output level 0..255 (not rounded)
  const GF = new Float32Array(256);
  for (let i = 0; i < 256; i++) GF[i] = 255 * Math.pow(i / 255, E.CONFIG.gamma);
  // spatial pattern position of each WLED pixel: rib/row on the tree, ring index on the topper
  const cell = new Uint8Array(WN);
  for (let q = 0; q < N; q++) {
    const w = WIDX[q]; if (w == null || w < 0 || w >= WN) continue;
    let x, y;
    if (q < NT) { x = Math.floor(q / ROWS); y = q % ROWS; } else { const t = q - NT; x = t % 4; y = Math.floor(t / 4); }
    cell[w] = ((y & 3) << 2) | (x & 3);
  }
  const thr = SHIFT.map(([sx, sy]) => { const a = new Float32Array(16); for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) a[y * 4 + x] = (BAYER[((y + sy) & 3) * 4 + ((x + sx) & 3)] + 0.5) / 16; return a; });
  const target = new Float32Array(WN * 3);   // exact dimmed levels, WLED order
  const out = new Uint8Array(WN * 3);
  const err = new Float32Array(WN * 3);
  for (let i = 0; i < err.length; i++) err[i] = Math.random(); // decorrelate temporal flips

  // exact output levels for a server-rendered frame (float, tree order)
  function fromFrame(frame, bright) {
    target.fill(0);
    for (let q = 0; q < N; q++) {
      const w = WIDX[q]; if (w == null || w < 0) continue;
      const s = q * 3, o = w * 3;
      for (let c = 0; c < 3; c++) {
        let v = frame[s + c]; v = v < 0 ? 0 : v > 255 ? 255 : v;
        const lo = v | 0, f = v - lo;             // interpolate the gamma table
        target[o + c] = (lo >= 255 ? GF[255] : GF[lo] + (GF[lo + 1] - GF[lo]) * f) * bright;
      }
    }
    return target;
  }
  // a live-mixer frame arrives already gamma'd in WLED order: dim it exactly
  function fromBytes(bytes, bright) {
    const n = Math.min(bytes.length, WN * 3);
    for (let i = 0; i < n; i++) target[i] = bytes[i] * bright;
    for (let i = n; i < WN * 3; i++) target[i] = 0;
    return target;
  }

  function quantize(t, mode, darkest) {
    if (mode === 'spatial') {
      for (let w = 0; w < WN; w++) {
        const k = cell[w];
        for (let c = 0; c < 3; c++) {
          const i = w * 3 + c, v = t[i];
          let o;
          if (v < 1 && !darkest) o = v >= 0.5 ? 1 : 0;
          else { o = v | 0; if (v - o > thr[c][k]) o++; if (o > 255) o = 255; }
          out[i] = o;
        }
      }
    } else if (mode === 'temporal') {
      for (let i = 0; i < WN * 3; i++) {
        const v = t[i];
        if (v < 1 && !darkest) { out[i] = v >= 0.5 ? 1 : 0; continue; }
        const a = err[i] + v; let o = a | 0; if (o > 255) o = 255;
        err[i] = a - o; out[i] = o;
      }
    } else if (mode === 'hue') {
      for (let w = 0; w < WN; w++) hueRound(t, w * 3);
    } else {
      for (let i = 0; i < WN * 3; i++) { const v = Math.round(t[i]); out[i] = v > 255 ? 255 : v; }
    }
    return out;
  }

  // floor/ceil per channel: minimize brightness error + weighted direction
  // (hue) error, so a weak channel isn't dropped when that changes the color
  function hueRound(t, i) {
    const tr = t[i], tg = t[i + 1], tb = t[i + 2];
    const nt = Math.sqrt(tr * tr + tg * tg + tb * tb);
    if (nt < 0.35) { out[i] = out[i + 1] = out[i + 2] = 0; return; }
    let best = null, bestCost = Infinity;
    const rs = [tr | 0, Math.min(255, (tr | 0) + 1)], gs = [tg | 0, Math.min(255, (tg | 0) + 1)], bs = [tb | 0, Math.min(255, (tb | 0) + 1)];
    for (const r of rs) for (const g of gs) for (const b of bs) {
      const nc = Math.sqrt(r * r + g * g + b * b); if (!nc) continue;
      const lum = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
      const hue = (r / nc - tr / nt) ** 2 + (g / nc - tg / nt) ** 2 + (b / nc - tb / nt) ** 2;
      const cost = lum + 6 * nt * nt * hue;
      if (cost < bestCost) { bestCost = cost; best = [r, g, b]; }
    }
    if (best) { out[i] = best[0]; out[i + 1] = best[1]; out[i + 2] = best[2]; } else out[i] = out[i + 1] = out[i + 2] = 0;
  }

  // "wled" mode: plain picture in WLED order, no gamma, no dimming
  const INV = new Uint8Array(256);
  for (let i = 0; i < 256; i++) INV[i] = Math.round(255 * Math.pow(i / 255, 1 / E.CONFIG.gamma));
  function plainFrame(frame) {
    out.fill(0);
    for (let q = 0; q < N; q++) {
      const w = WIDX[q]; if (w == null || w < 0) continue;
      for (let c = 0; c < 3; c++) { const v = frame[q * 3 + c]; out[w * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
    }
    return out;
  }
  function plainBytes(bytes) { // live-mixer bytes arrive gamma'd: undo it, WLED applies gamma again
    const n = Math.min(bytes.length, WN * 3);
    for (let i = 0; i < n; i++) out[i] = INV[bytes[i]];
    out.fill(0, n);
    return out;
  }

  return {
    plainFrame, plainBytes,
    frame: (frame, bright, mode, darkest) => quantize(fromFrame(frame, bright), mode, darkest),
    bytes: (bytes, bright, mode, darkest) => quantize(fromBytes(bytes, bright), mode, darkest),
  };
}

function clean(d) {
  d = d || {};
  // WLED re-sends per second: 'auto' (default) = as fast as the LEDs allow, or a fixed 0-250
  const wf = d.wledFps === 'auto' || d.wledFps == null ? 'auto' : Math.round(+d.wledFps);
  const hz = Math.round(+d.minHz || 0);
  return { mode: MODES.includes(d.mode) ? d.mode : 'off', darkest: d.darkest === true, minHz: hz >= 0 && hz <= 120 ? hz : 0, wledFps: wf === 'auto' || (wf >= 0 && wf <= 250) ? wf : 'auto' };
}

module.exports = { create, clean, MODES };
