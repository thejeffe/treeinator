/* Tree light engine — shared by the browser page and the server.
 * Layout comes from TREE_CONFIG (set by the server: global.TREE_CONFIG in Node, window.TREE_CONFIG from /config.js in
 * the browser) = { ribs, rows, arc, topStart, map, flip, gamma }; DEFAULT_CONFIG is used when it's missing.
 * map 'strip': send in physical strand order (serpentine). map 'matrix': WLED has a 2D matrix (ribs wide x rows tall) and
 * does the wiring itself, so send row by row from the top-left (flip mirrors left/right). gamma is applied to WLED output only.
 * Pixels: ribs x rows (tree) + 4 rings 10/20/30/40 (topper, 100).
 * Internal pixel order: k = rib*rows + row (row 0 = top), then topper NT..N-1 center ring out, clockwise from 12.
 * WLED order: tree serpentine from bottom of rib 1 (rib 1 up, rib 2 down, ...) at 0..NT-1, topper at topStart..topStart+99.
 * WLED frames are WN pixels long; indexes between the tree and the topper stay black.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(typeof global !== 'undefined' ? global.TREE_CONFIG : null);
  else root.TreeEngine = factory(root.TREE_CONFIG);
})(typeof self !== 'undefined' ? self : this, function (CONF) {
  'use strict';
  var PI = Math.PI, TAU = 2 * PI;
  var DEFAULT_CONFIG = { ribs: 19, rows: 50, arc: 270, topStart: 1000, map: 'strip', flip: false, gamma: 2.8, deskew: 100, textTop: 5, textSize: 2.5, textWidth: 1, topper: true };
  function cleanConfig(c) {
    c = c || {}; var d = DEFAULT_CONFIG, o = {};
    function int(v, lo, hi, def) { v = Math.round(+v); return isFinite(v) && v >= lo && v <= hi ? v : def; }
    o.ribs = int(c.ribs, 1, 64, d.ribs); o.rows = int(c.rows, 2, 300, d.rows); o.arc = int(c.arc, 10, 360, d.arc);
    o.topStart = int(c.topStart, o.ribs * o.rows, 6000, Math.max(o.ribs * o.rows, d.topStart));
    o.map = c.map === 'matrix' ? 'matrix' : 'strip'; o.flip = c.flip === true;
    o.topper = c.topper !== false; // false: topper not connected, so nothing is sent for it and the preview hides it
    o.deskew = int(c.deskew, 0, 100, d.deskew);
    function dec(v, lo, hi, def) { v = Math.round(+v * 10) / 10; return isFinite(v) && v >= lo && v <= hi ? v : def; }
    o.textTop = int(c.textTop, 0, o.rows - 1, Math.min(d.textTop, o.rows - 1)); o.textSize = dec(c.textSize, 1, 8, d.textSize); o.textWidth = dec(c.textWidth, 0.5, 4, d.textWidth);
    var g = Math.round(+c.gamma * 10) / 10; o.gamma = isFinite(g) && g >= 1 && g <= 3 ? g : d.gamma;
    return o;
  }
  var CFG = cleanConfig(CONF);
  var NR = CFG.ribs, ROWS = CFG.rows, NT = NR * ROWS, NTOP = 100, N = NT + NTOP; // ribs, pixels per rib, tree pixels, topper pixels
  var TOP_START = CFG.topStart, WN = CFG.topper ? TOP_START + NTOP : NT;                          // WLED index of the first topper pixel, WLED frame length

  // ---------- geometry ----------
  var RIBSTEP = CFG.arc >= 360 ? 360 / NR : NR > 1 ? CFG.arc / (NR - 1) : 0; // a full circle doesn't repeat the first rib
  var RIBS = []; for (var i = 0; i < NR; i++) RIBS.push(-CFG.arc / 2 + RIBSTEP * i);
  var RINGS = [[2.4, 10], [4.8, 20], [7.2, 30], [9.6, 40]];
  var TOPW = 12 / 68;
  function starPts(R, r) { var p = []; for (var k = 0; k < 10; k++) { var a = (-90 + 36 * k) * PI / 180, rr = k % 2 ? r : R; p.push([rr * Math.cos(a), rr * Math.sin(a)]); } return p; }
  function inPoly(x, y, P) { var c = false; for (var i = 0, j = P.length - 1; i < P.length; j = i++) { var x1 = P[i][0], y1 = P[i][1], x2 = P[j][0], y2 = P[j][1]; if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) c = !c; } return c; }
  var SP = starPts(10.4, 5.2);

  // deterministic seeds so server and browser draw the same thing
  function rng(seed) { var s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  var R0 = rng(20261223), SEEDS = []; for (i = 0; i < N; i++) SEEDS.push(R0());
  var RIBSEED = []; for (i = 0; i < NR; i++) RIBSEED.push([R0(), R0(), R0()]);

  var PX = [];
  for (i = 0; i < NR; i++) {
    var ar = RIBS[i] * PI / 180;
    for (var r = 0; r < ROWS; r++) {
      var u = r / (ROWS - 1), wid = TOPW + (1 - TOPW) * u;
      PX.push({ tree: true, rib: i, row: r, col: i, u: u, wid: wid, X: (i - (NR - 1) / 2) * RIBSTEP * PI / 180 * wid * 12, Y: r * 49 / (ROWS - 1), x: wid * Math.sin(ar), ang: (RIBS[i] + 180) * PI / 180, depth: Math.cos(ar), seed: SEEDS[i * ROWS + r] });
    }
  }
  var TOPPX = [];
  RINGS.forEach(function (rn, ri) {
    for (var k = 0; k < rn[1]; k++) {
      var a = TAU * k / rn[1], x = rn[0] * Math.sin(a), y = -rn[0] * Math.cos(a);
      TOPPX.push({ x: x, y: y, ri: ri, a: a, star: inPoly(x, y, SP) });
    }
  });
  TOPPX.forEach(function (tp, k) {
    var rr = Math.hypot(tp.x, tp.y) / 9.6;
    PX.push({ tree: false, tp: tp, X: tp.x / 2, Y: -6 + tp.y / 2, row: tp.ri * 3 + k % 3, rib: Math.floor(tp.a / TAU * NR) % NR, col: tp.a / TAU * NR, u: -0.25 + rr * 0.2, x: tp.x / 9.6 * 0.18, ang: tp.a, depth: 1, seed: SEEDS[NT + k] });
  });

  // ---------- color helpers ----------
  function hex(h) { h = String(h || '#000000'); return [parseInt(h.substr(1, 2), 16) || 0, parseInt(h.substr(3, 2), 16) || 0, parseInt(h.substr(5, 2), 16) || 0]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function scl(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
  function frac(v) { return ((v % 1) + 1) % 1; }
  function hsv(h, s, v) { h = frac(h); var i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s), m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]; return [m[0] * 255, m[1] * 255, m[2] * 255]; }
  var BLACK = [0, 0, 0];
  function smooth(a, b, v) { v = (v - a) / (b - a); v = v < 0 ? 0 : v > 1 ? 1 : v; return v * v * (3 - 2 * v); }
  function lat(i, j, k) { var x = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return x - Math.floor(x); }
  function noise3(x, y, z) { // smooth value noise, 0..1
    var i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    function l(a, b, v) { return a + (b - a) * v; }
    return l(l(l(lat(i, j, k), lat(i + 1, j, k), fx), l(lat(i, j + 1, k), lat(i + 1, j + 1, k), fx), fy),
      l(l(lat(i, j, k + 1), lat(i + 1, j, k + 1), fx), l(lat(i, j + 1, k + 1), lat(i + 1, j + 1, k + 1), fx), fy), fz);
  }
  // ---- helpers for the WLED-style effects ----
  // X, Y = position on the tree in pixel spacings (2"): X across the cone at that height (0 = front center), Y down from
  // the top (0..49); the topper sits above (Y < 0). XMAX(y) = how far X reaches at height y (edge ribs).
  function XMAX(y) { y = y < 0 ? 0 : y > 49 ? 49 : y; return (NR - 1) / 2 * RIBSTEP * PI / 180 * 12 * (TOPW + (1 - TOPW) * y / 49); }
  // Classic colors: patterns marked cl use their own multicolor palettes unless the deck turns them off (deck.cl === false,
  // passed as c.mono). Then they use shades between the design's colors (shades of color 2 if color 1 is black/dark).
  function dark(col) { return col[0] + col[1] + col[2] < 60; }
  function monoPal(c, h) { var v = 0.5 - 0.5 * Math.cos(frac(h) * TAU), o = dark(c[0]) ? scl(c[1], 0.3) : c[0]; return mix(c[1], o, v * 0.85); }
  function mc(c, h) { return c.mono ? monoPal(c, h) : hue(h); }
  function rp(c, h) { return c.mono ? monoPal(c, h) : mix(hue(h), c[1], 0.3); }   // rainbow palette, tinted toward color 2
  function glit(p, t, rate) { return hash(p.seed * 991 + Math.floor(t * 18)) < rate; }   // random glitter
  function bg(c, k) { return scl(c[0], k == null ? 0.05 : k); }
  function dot(p, x, y, r) { var dx = p.X - x, dy = p.Y - y, d2 = dx * dx + dy * dy; return d2 < r * r ? 1 - Math.sqrt(d2) / r : 0; }
  // Rockets: launch from the bottom with a spark trail, burst into a ring that falls and glitters.
  // Starburst: bursts in place with a random number of rays.
  function rockets(p, t, c, star) {
    var out = bg(c, 0.04);
    for (var j = 0; j < 7; j++) {
      var P = star ? 1.2 : 2.0, tt = t / P + j / 7 + hash(j) * 0.3, slot = Math.floor(tt), ph = tt - slot, h = slot * 7 + j + (star ? 100 : 0);
      var by = 5 + hash(h + 0.4) * 22, bx = (hash(h) * 2 - 1) * XMAX(by) * 0.85, col = hash(h + 0.8) < 0.3 ? c[1] : mc(c, hash(h + 0.6));
      var up = star ? 0 : 0.28;
      if (ph < up) {
        var y = 49 - (49 - by) * Math.sin(ph / up * PI / 2), dx = p.X - bx, dy = p.Y - y;
        if (Math.abs(dx) < 1 && dy > -0.6 && dy < 7) out = mix(out, dy < 0.9 ? (c.mono ? mix(c[1], [255, 255, 255], 0.5) : [255, 230, 180]) : (c.mono ? c[1] : [255, 140, 40]), dy < 0.9 ? 1 : 0.7 * (1 - dy / 7) * (glit(p, t, 0.6) ? 1 : 0.3));
        continue;
      }
      var age = (ph - up) / (1 - up), r = (star ? 10 : 13) * Math.sqrt(age), gy = star ? 0 : 14 * age * age;
      var ddx = p.X - bx, ddy = p.Y - (by + gy), d = Math.sqrt(ddx * ddx + ddy * ddy), fade = Math.pow(1 - age, 1.3);
      if (age < 0.08 && d < 3) out = mix(out, [255, 255, 255], 1 - age / 0.08);            // flash at the burst
      var hit;
      if (star) { var rays = 6 + Math.floor(hash(h + 0.2) * 5); hit = d < r && Math.abs(Math.sin(Math.atan2(ddy, ddx) * rays / 2 + h)) > 0.9 ? 1 - d / (r + 0.01) * 0.5 : 0; }
      else hit = Math.exp(-Math.pow((d - r) / 1.3, 2)) + (d < r ? 0.25 * (glit(p, t, 0.15) ? 1 : 0) : 0);
      if (hit > 0.05) out = mix(out, age > 0.6 && glit(p, t, 0.3) ? [255, 255, 255] : col, Math.min(1, hit * fade * (0.55 + 0.45 * Math.sin(p.seed * 70 + t * 30))));
    }
    return out;
  }
  // Moving dots with fading tails. The dot paths only depend on time, so they're worked out once per frame (cached by
  // effect and time; a few entries so two decks on the same effect don't thrash) instead of once per pixel.
  var PCACHE = {};
  function memo(name, t, build) { var C = PCACHE[name] || (PCACHE[name] = []); for (var i = 0; i < C.length; i++) if (C[i].t === t) return C[i].v; var v = build(t); C.unshift({ t: t, v: v }); if (C.length > 4) C.pop(); return v; }
  function trailPts(path, t, n, steps, dt) { var all = []; for (var j = 0; j < n; j++) { var pts = []; for (var k = 0; k < steps; k++) pts.push(path(j, t - k * dt)); all.push(pts); } return all; }
  function trailHit(p, pts, r) { var best = 0, steps = pts.length; for (var k = 0; k < steps; k++) { var dx = p.X - pts[k][0]; if (dx > r || dx < -r) continue; var v = dot(p, pts[k][0], pts[k][1], r) * (1 - k / steps); if (v > best) best = v; } return best; }
  function jugglePath(j, tt) { var y = 25 + Math.sin(tt * (0.9 + j * 0.17) + j * 2) * 23; return [Math.sin(tt * (1.1 + j * 0.23) + j) * XMAX(y) * 0.95, y]; }
  function holePath(j, tt) { var R = 4 + 13 * (0.5 + 0.5 * Math.sin(tt * 0.35 + j * 1.9)), a = tt * (0.9 + j * 0.11) * (j % 2 ? 1 : -1) + j; return [Math.cos(a) * R * XMAX(22) / 14, 22 + Math.sin(a) * R * 1.4]; }
  function beeTgt(j, k) { var y = 4 + hash(j * 17 + k) * 42; return [(hash(j * 31 + k * 1.3) * 2 - 1) * XMAX(y) * 0.9, y]; }
  function beeSp(j) { return 0.6 + hash(j) * 0.5; }
  function beePath(j, tt) { var q = tt * beeSp(j) + j * 0.37, k = Math.floor(q), f = smooth(0, 1, q - k), A = beeTgt(j, k), B = beeTgt(j, k + 1); return [A[0] + (B[0] - A[0]) * f + Math.sin(tt * 9 + j) * 0.6, A[1] + (B[1] - A[1]) * f + Math.cos(tt * 11 + j) * 0.6]; }
  function hash(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function hue(h) { return hsv(h, 0.85, 1); }
  var C9 = [[255, 30, 20], [20, 200, 60], [30, 80, 255], [255, 120, 0], [255, 200, 20]]; // classic bulb colors
  var ORN = [[220, 20, 30], [242, 169, 0], [30, 90, 230], [210, 220, 230], [160, 40, 200]];

  // 5x7 font for the text marquee ('<' draws a heart)
  var FONT = {"A":"01110100011000111111100011000110001","B":"11110100011000111110100011000111110","C":"01110100011000010000100001000101110","D":"11100100101000110001100011001011100","E":"11111100001000011110100001000011111","F":"11111100001000011110100001000010000","G":"01110100011000010111100011000101111","H":"10001100011000111111100011000110001","I":"01110001000010000100001000010001110","J":"00111000100001000010000101001001100","K":"10001100101010011000101001001010001","L":"10000100001000010000100001000011111","M":"10001110111010110101100011000110001","N":"10001100011100110101100111000110001","O":"01110100011000110001100011000101110","P":"11110100011000111110100001000010000","Q":"01110100011000110001101011001001101","R":"11110100011000111110101001001010001","S":"01111100001000001110000010000111110","T":"11111001000010000100001000010000100","U":"10001100011000110001100011000101110","V":"10001100011000110001100010101000100","W":"10001100011000110101101011010101010","X":"10001100010101000100010101000110001","Y":"10001100011000101010001000010000100","Z":"11111000010001000100010001000011111","0":"01110100011001110101110011000101110","1":"00100011000010000100001000010001110","2":"01110100010000100010001000100011111","3":"11111000100010000010000011000101110","4":"00010001100101010010111110001000010","5":"11111100001111000001000011000101110","6":"00110010001000011110100011000101110","7":"11111000010001000100010000100001000","8":"01110100011000101110100011000101110","9":"01110100011000101111000010001001100"," ":"00000000000000000000000000000000000","!":"00100001000010000100001000000000100","?":"01110100010000100010001000000000100",".":"00000000000000000000000000110001100",",":"00000000000000000000011000010001000","'":"01100001000100000000000000000000000","-":"00000000000000011111000000000000000","&":"01100100101010001000101011001001101","*":"00000001001010101110101010010000000","+":"00000001000010011111001000010000000","#":"01010010101111101010111110101001010",":":"00000011000110000000011000110000000","<":"00000010101111111111011100010000000"};
  var TEXTCACHE = {};
  // Text deskew: ribs are closer together near the top of the cone, so a letter one rib wide is physically narrower there.
  // Measure text columns by distance around the cone (rib offset x cone width at that height), scaled about the center rib
  // so the middle of the lettering keeps its size and letters don't lean. deskew 0 = by rib, 100 = fully by distance.
  // Text placement: letters are 7 dots tall starting textTop pixels from the top, each dot textSize pixels tall and textWidth
  // ribs wide (measured at the middle of the lettering).


  // ---- Christmas effects helpers ----
  // Ornament drop: falls from the top, bounces on the bottom (each bounce lower), then rests. y at time a after release.
  function dropY(a) {
    var g = 110, h = 49, T = Math.sqrt(2 * h / g), v = g * T, e = 0.45;
    if (a < T) return 0.5 * g * a * a;
    a -= T;
    for (var k = 0; k < 3; k++) { v *= e; var fl = 2 * v / g; if (a < fl) return h - (v * a - 0.5 * g * a * a); a -= fl; }
    return h;
  }
  function sleighPath(j, tt) { var y = 18 + Math.sin(tt * 0.9 + j * 0.45) * 11; return [Math.sin(tt * 0.45 - j * 0.16) * XMAX(y) * 0.92, y]; }
  function flakePath(j, tt) { var h = hash(j * 3.1), r = 3 + h * 15, w = (0.8 + hash(j * 1.7) * 1.2) * (j % 2 ? 1 : -1), a = tt * w + h * TAU, y = 25 + Math.sin(a) * r * 1.3 + Math.sin(tt * 0.3 + j) * 3; return [Math.cos(a) * r * XMAX(y) / 16, y]; }
  // ---- autumn / Thanksgiving ----
  var AUT = [[220, 40, 10], [255, 120, 0], [230, 170, 20], [140, 60, 15]];
  // ---- retro pixel graphics (original 1-bit-style art in the spirit of 1980s home-computer greeting-card clip art) ----
  // Letters: R red, O orange, D dark orange, Y yellow, G green, B brown, T tan, W white, U blue; '.' = background.
  var GFX = {
    turkey: { n: "Turkey", r: [".R.O.Y.O.R.", "RROOYYYOORR", "ROOYBBBYOOR", ".OYBWBWBYO.", "..YBBOBBY..", "...BBRBB...", "..BBBBBBB..", ".BBBBBBBBB.", ".BBBBBBBBB.", "..BBBBBBB..", "...BBBBB...", "...Y...Y...", "..YYY.YYY.."] },
    pumpkin: { n: "Pumpkin", r: [".....G.....", "....GG.....", "..OOOGOOO..", ".OODOOODOO.", "OODOOOOODOO", "OODOOOOODOO", "OODOOOOODOO", "OODOOOOODOO", ".OODOOODOO.", "..OOOOOOO.."] },
    leaf: { n: "Maple leaf", r: [".....R.....", "....RRR....", ".R..RRR..R.", ".RR.RRR.RR.", "..RRRRRRR..", "RRRRRRRRRRR", ".RRRRRRRRR.", "..RRRRRRR..", "...RRRRR...", "....RRR....", ".....B.....", ".....B.....", ".....B....."] },
    acorn: { n: "Acorn", r: [".....B.....", "....BB.....", "..BBBBBBB..", ".BBBBBBBBB.", ".BBBBBBBBB.", "..TTTTTTT..", "..TTTTTTT..", "..TTTTTTT..", "...TTTTT...", "...TTTTT...", "....TTT....", ".....T....."] },
    pie: { n: "Pumpkin pie", r: ["...W.W.W...", "..WWWWWWW..", ".TTTTTTTTT.", "TOOOOOOOOOT", "TOOOOOOOOOT", "TDDDDDDDDDT", "TTTTTTTTTTT", ".TTTTTTTTT."] },
    hat: { n: "Pilgrim hat", r: ["...BBBBB...", "...BBBBB...", "...BBBBB...", "...BBBBB...", "...YYYYY...", "...YBBBY...", "...YYYYY...", "...BBBBB...", "BBBBBBBBBBB", "BBBBBBBBBBB"] },
    corn: { n: "Corn", r: [".....Y.....", "....YYY....", "...YYYYY...", "...YOYOY...", "...YYYYY...", "...YOYOY...", "..GYYYYYG..", "..GYYYYYG..", ".GG.YYY.GG.", ".G...Y...G.", "GG.......GG"] },
    heart: { n: "Heart", r: [".RRR...RRR.", "RRRRR.RRRRR", "RRRRRRRRRRR", "RRRRRRRRRRR", ".RRRRRRRRR.", "..RRRRRRR..", "...RRRRR...", "....RRR....", ".....R....."] },
    star: { n: "Star", r: [".....Y.....", ".....Y.....", "....YYY....", "YYYYYYYYYYY", ".YYYYYYYYY.", "..YYYYYYY..", "..YYYYYYY..", ".YYYY.YYYY.", ".YYY...YYY.", "YY.......YY"] },
    bell: { n: "Bell", r: [".....Y.....", "....YYY....", "...YYYYY...", "...YYYYY...", "..YYYYYYY..", "..YYYYYYY..", ".YYYYYYYYY.", "YYYYYYYYYYY", ".....R.....", "....RRR...."] },
    tree: { n: "Christmas tree", r: [".....Y.....", "....GGG....", "...GGRGG...", "..GGGGGGG..", "...GUGGG...", "..GGGGGYG..", ".GRGGGGGGG.", "..GGGGUGG..", ".GGGGGGGGG.", "GGYGGGGGRGG", "....BBB....", "....BBB...."] },
    gift: { n: "Gift", r: ["...R...R...", "....R.R....", ".....R.....", "UUUUURUUUUU", "UUUUURUUUUU", "RRRRRRRRRRR", "UUUUURUUUUU", "UUUUURUUUUU", "UUUUURUUUUU", "UUUUURUUUUU"] },
    snowman: { n: "Snowman", r: ["...BBBBB...", "...BBBBB...", "..BBBBBBB..", "...WWWWW...", "...W.W.W...", "...WWOWW...", "....WWW....", "..WWWWWWW..", ".WWWWRWWWW.", ".WWWWWWWWW.", "..WWWRWWW..", "...WWWWW..."] },
    snowflake: { n: "Snowflake", r: [".....W.....", "..W..W..W..", "...W.W.W...", "....WWW....", "WWWWWWWWWWW", "....WWW....", "...W.W.W...", "..W..W..W..", ".....W....."] },
    candycane: { n: "Candy cane", r: ["...RWRW....", "..W....R...", "..R....W...", ".......R...", ".......W...", ".......R...", ".......W...", ".......R...", ".......W...", ".......R..."] },
    candle: { n: "Candle", r: [".....Y.....", "....YOY....", "....YOY....", ".....Y.....", "....WWW....", "....WWW....", "....WWW....", "....WWW....", "....WWW....", "..GGGGGGG.."] },
    stocking: { n: "Stocking", r: ["...WWWWW...", "...RRRRR...", "...RRRRR...", "...RRRRR...", "...RRRRR...", "...RRRRRR..", "..RRRRRRRR.", ".RRRRRRRRRW", ".RRRRRRRRWW", "..RRRR....."] },
    wreath: { n: "Wreath", r: ["...GGGGG...", "..GG...GG..", ".GG.....GG.", ".G.......G.", ".G.......G.", ".GG.....GG.", "..GGRRRGG..", "...RRRRR...", "....R.R...."] },
    football: { n: "Football", r: ["...BBBBB...", ".BBBBBBBBB.", "BBBWBWBWBBB", "BBBWWWWWBBB", "BBBWBWBWBBB", ".BBBBBBBBB.", "...BBBBB..."] },
    trophy: { n: "Trophy", r: [".YYYYYYYYY.", "YY.YYYYY.YY", "Y..YYYYY..Y", "YY.YYYYY.YY", "..YYYYYYY..", "...YYYYY...", "....YYY....", ".....Y.....", "....YYY....", "..YYYYYYY.."] },
    champagne: { n: "Champagne", r: [".W...W..W..", "..W.W.W....", "..Y.....Y..", "..YYYYYYY..", "..YYWYYYY..", "...YYYWY...", "....YYY....", ".....Y.....", ".....Y.....", "...YYYYY..."] }
  };
  var GPAL = { R: [220, 25, 30], O: [255, 110, 0], D: [190, 60, 0], Y: [255, 200, 20], G: [20, 170, 50], B: [120, 60, 15], T: [215, 150, 80], W: [240, 240, 240], U: [30, 80, 230] };
  var GSETS = { fall: ['turkey', 'pumpkin', 'leaf', 'acorn', 'pie', 'hat', 'corn'], holiday: ['tree', 'star', 'bell', 'gift', 'snowman', 'snowflake', 'candycane', 'candle', 'stocking', 'wreath', 'heart'], newyear: ['champagne', 'star', 'heart', 'bell'], gameday: ['football', 'trophy', 'star'], everyday: ['heart', 'star', 'trophy', 'football'] };
  GSETS.all = Object.keys(GFX);
  function gfxList(spec) { return GFX[spec] ? [spec] : GSETS[spec] || GSETS.all; }
  // Draws graphic g with its middle at around-the-tree position x0 (rib units from the front center); deskewed like text.
  function gfxAt(p, t, c, g, x) {
    var H = g.r.length, W = g.r[0].length, S = Math.min(3, (ROWS - 4) / H), top = Math.max(1, Math.round((ROWS - H * S) / 2) - 2);
    var gy = Math.floor((p.row - top) / S), gx = Math.floor(x + W / 2);
    if (gy < 0 || gy >= H || gx < 0 || gx >= W) return null;
    var ch = g.r[gy][gx]; if (ch === '.') return null;
    var col = c.mono ? c[1] : GPAL[ch] || c[1];
    return scl(col, 0.88 + 0.12 * Math.sin(t * 3 + p.seed * 20));
  }
  function gfxX(p, H) { var S = Math.min(3, (ROWS - 4) / H), mid = Math.max(1, Math.round((ROWS - H * S) / 2) - 2) + H * S / 2, wref = TOPW + (1 - TOPW) * Math.min(1, mid / (ROWS - 1)); var k = 1 + CFG.deskew / 100 * (p.wid / wref - 1); return (p.col - (NR - 1) / 2) * k; }
  var TEXT_WREF = TOPW + (1 - TOPW) * Math.min(1, (CFG.textTop + CFG.textSize * 3.5) / (ROWS - 1)), TEXT_CX = (NR - 1) / 2;
  function textX(p) { var k = 1 + CFG.deskew / 100 * (p.wid / TEXT_WREF - 1); return (TEXT_CX + (p.col - TEXT_CX) * k) / CFG.textWidth; }
  // The space around the text (deck.below = a pattern id, 'none', or unset = twinkle). One dark row separates it from the
  // letters, and it's dimmed so the words stay readable.
  var NO_FILL = { text: 1, image: 1, graphic: 1, parade: 1 };
  function textFill(p, t, c, b, img, k, deck) {
    var bel = deck && deck.below != null ? deck.below : 'twinkle', pat = PATMAP[bel];
    if (bel === 'none' || !pat || NO_FILL[bel]) return scl(c[0], 0.15);
    var top = CFG.textTop, end = CFG.textTop + 7 * CFG.textSize;
    if (p.row === top - 1 || (p.row >= end && p.row < end + 1)) return scl(c[0], 0.05);
    return scl(pat.f(p, t, c, b, img, k, deck), 0.7);
  }
  function textCols(str) {
    str = String(str == null ? 'MERRY CHRISTMAS' : str).toUpperCase();
    if (TEXTCACHE[str]) return TEXTCACHE[str];
    var cols = [];
    for (var i = 0; i < str.length; i++) {
      var g = FONT[str[i]] || FONT['?'];
      for (var x = 0; x < 5; x++) { var m = 0; for (var y = 0; y < 7; y++) if (g[y * 5 + x] === '1') m |= 1 << y; cols.push(m); }
      cols.push(0);
    }
    for (i = 0; i < 8; i++) cols.push(0); // gap before the text repeats
    TEXTCACHE[str] = cols; return cols;
  }

  // ---------- patterns: f(pixel, time, [color1, color2], beat, img) -> [r,g,b] ----------
  var PATS = [
    { id: 'spin', n: 'Spin', f: function (p, t, c) { return Math.floor(p.col * 8 / NR + t * 2) % 2 ? c[1] : c[0]; } },
    { id: 'rise', n: 'Rise', f: function (p, t, c) { return Math.floor(p.u * 6 + t * 2) % 2 ? c[1] : c[0]; } },
    { id: 'helix', n: 'Helix', f: function (p, t, c) { var v = frac(p.col / NR + p.u * 0.6 - t * 0.5); return v < 0.25 ? c[1] : scl(c[0], 0.35); } },
    { id: 'sparkle', n: 'Sparkle', f: function (p, t, c) { var s = Math.sin(t * 4 + p.seed * 60); return s > 0.9 ? c[1] : scl(c[0], 0.45); } },
    { id: 'pulse', n: 'Pulse', f: function (p, t, c, b) { var e = 0.5 - 0.5 * Math.cos(b / 2 * TAU); return mix(scl(c[0], 0.35), c[1], 0.2 + 0.8 * e); } } /* a smooth swell every two beats (no flashing) */,
    { id: 'radar', n: 'Radar', f: function (p, t, c) { var d = frac(p.ang / TAU - t * 0.35); return d < 0.12 ? c[1] : scl(c[0], 0.2 + 0.6 * Math.max(0, 1 - d * 3)); } },
    { id: 'rainbow', cl: 1, n: 'Rainbow', f: function (p, t, c) { var h = p.col / NR + p.u * 0.3 - t * 0.25; return c.mono ? monoPal(c, h) : hsv(h, 1, 1); } },
    { id: 'plasma', n: 'Plasma', f: function (p, t, c) { var v = Math.sin(p.x * 3 + t * 1.3) + Math.sin(p.u * 5 - t * 1.7) + Math.sin((p.x + p.u) * 4 + t); return mix(c[0], c[1], (v + 3) / 6); } },
    { id: 'candy', n: 'Candy', f: function (p, t, c) { return Math.floor((p.col / NR * 3 + p.u * 2.4 - t * 0.6) * 2) % 2 ? c[1] : c[0]; } },
    { id: 'twinkle', n: 'Twinkle', f: function (p, t, c) { var ph = frac(p.seed * 7.3 + t * (0.15 + p.seed * 0.25)); var b = Math.pow(Math.max(0, Math.sin(ph * TAU)), 3); return mix(scl(c[0], 0.18), c[1], b); } },
    { id: 'snow', n: 'Snow', f: function (p, t, c) { var s = RIBSEED[(p.rib + NR) % NR], best = 0; for (var j = 0; j < 3; j++) { var pos = frac(s[j] + t * 0.18 * (0.8 + s[j] * 0.6)); var d = Math.abs(p.u - pos); if (d < 0.035) best = Math.max(best, 1 - d / 0.035); } return mix(scl(c[0], 0.22), c[1], best); } },
    { id: 'fire', n: 'Fire', f: function (p, t, c) { var flick = 0.55 + 0.45 * Math.sin(t * 7 + p.seed * 40) * Math.sin(t * 3.1 + p.rib * 1.7); var heat = Math.max(0, Math.min(1, Math.pow(Math.max(0, p.u), 1.4) * 1.25 * flick)); return heat < 0.5 ? mix(BLACK, c[0], heat * 2) : mix(c[0], c[1], (heat - 0.5) * 2); } },
    { id: 'comet', n: 'Comet', f: function (p, t, c) { var head = 1 - frac(t * 0.45 + RIBSEED[(p.rib + NR) % NR][0]); var d = p.u - head; if (d >= 0 && d < 0.28) return mix(c[1], scl(c[0], 0.15), d / 0.28); return scl(c[0], 0.08); } },
    { id: 'glow', n: 'Glow', f: function (p, t, c) { return mix(c[0], c[1], 0.5 + 0.5 * Math.sin(p.u * 3 - t * 0.8)); } },
    // Bulbs: classic colors (deck.cl, or color 2 white when the design predates that option) = the multicolor C9 set;
    // otherwise bulbs alternate color 2 and color 1, or are all color 2 when color 1 is black/very dark.
    { id: 'bulbs', cl: 1, n: 'Bulbs', h: 'Classic colors: the five C9 bulb colors. Off: bulbs alternate color 2 and color 1 (all color 2 if color 1 is black).', f: function (p, t, c, b, img, k, deck) { var i = p.row + p.rib * 3 + 50, col; var classic = deck && deck.cl != null ? deck.cl : c[1][0] > 245 && c[1][1] > 245 && c[1][2] > 245; if (classic) col = C9[i % 5]; else if (c[0][0] + c[0][1] + c[0][2] < 60) col = c[1]; else col = i % 2 ? c[0] : c[1]; return scl(col, 0.82 + 0.18 * Math.sin(t * 2 + p.seed * 30)); } },
    { id: 'ornaments', cl: 1, n: 'Ornament', f: function (p, t, c) { if (p.seed > 0.86) { var o = c.mono ? monoPal(c, p.seed * 7) : ORN[Math.floor(p.seed * 997) % 5]; if (Math.floor(p.seed * 991) % 3 === 0) o = c[1]; return scl(o, 0.75 + 0.25 * Math.sin(t * 3 + p.seed * 50)); } return scl(c[0], 0.45); } },
    { id: 'garland', n: 'Garland', f: function (p, t, c) { var v = frac(p.col / NR + p.u * 0.9 - t * 0.12); if (v < 0.07) return c[1]; if (Math.abs(v - 0.5) < 0.05) return [242, 193, 78]; return scl(c[0], 0.5); } },
    { id: 'aurora', n: 'Aurora', f: function (p, t, c) { var w = Math.sin(p.col * 0.45 + t * 0.6 + Math.sin(p.u * 4 + t * 0.35) * 1.6); var b = 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(p.u * 5 - t * 0.9 + p.col * 0.25), 2); return scl(mix(c[0], c[1], 0.5 + 0.5 * w), b); } },
    { id: 'meteor', n: 'Meteor', f: function (p, t, c) { var head = frac(t * 0.4 + RIBSEED[(p.rib + NR) % NR][1]); var d = head - p.u; if (d >= 0 && d < 0.3) return mix(c[1], scl(c[0], 0.1), d / 0.3); return scl(c[0], 0.06); } },
    { id: 'icicles', n: 'Icicle', f: function (p, t, c) { var s = RIBSEED[(p.rib + NR) % NR]; var len = 0.15 + 0.55 * frac(t * 0.12 + s[2]); if (p.u < len) { var b = Math.pow(1 - p.u / len, 0.6); var drip = Math.abs(p.u - len) < 0.025 ? 1 : 0; return mix(scl(c[0], 0.2), c[1], Math.max(b * 0.85, drip)); } return scl(c[0], 0.12); } },
    { id: 'chase', n: 'Chase', f: function (p, t, c) { return (p.row + p.rib + Math.floor(t * 6)) % 3 === 0 ? c[1] : scl(c[0], 0.3); } },
    { id: 'wipe', n: 'Wipe', f: function (p, t, c) { var k = Math.floor(t * 0.3), f = frac(t * 0.3); var newC = k % 2 ? c[0] : c[1], oldC = k % 2 ? c[1] : c[0]; return (1 - p.u) < f ? newC : oldC; } },
    { id: 'gift', n: 'Gift', f: function (p, t, c) { var rib = Math.abs(p.rib - (NR - 1) / 2) < 1, band = p.u > 0.58 && p.u < 0.68; if (rib || band) return scl(c[1], 0.8 + 0.2 * Math.sin(t * 4 + p.seed * 40)); return scl(c[0], 0.75); } },
    { id: 'fireworks', cl: 1, n: 'Firework', f: function (p, t, c) { var out = scl(c[0], 0.05); for (var j = 0; j < 5; j++) { var tt = t * 0.7 + j * 0.23, slot = Math.floor(tt), age = tt - slot, h = slot * 5 + j; var cr = hash(h) * (NR - 1), cu = 0.12 + hash(h + 0.5) * 0.55; var dx = (p.col - cr) / NR * 1.5, du = p.u - cu, d = Math.sqrt(dx * dx + du * du), r = 0.04 + age * 0.3; if (d < r && d > r - 0.06 && age > 0.05) { var col = hash(h + 0.9) < 0.35 ? c[1] : mc(c, hash(h + 0.7)); var spark = 0.55 + 0.45 * Math.sin(p.seed * 90 + t * 20); out = mix(out, col, Math.pow(1 - age, 0.7) * spark); } } return out; } },
    { id: 'confetti', cl: 1, n: 'Confetti', f: function (p, t, c) { var s = Math.sin(t * 3 + p.seed * 80); return s > 0.75 ? mc(c, p.seed * 7 + Math.floor(t * 0.5)) : scl(c[0], 0.25); } },
    { id: 'breathe', n: 'Breathe', f: function (p, t, c) { return mix(scl(c[0], 0.35), c[1], 0.5 + 0.5 * Math.sin(t * 1.2)); } },
    { id: 'text', n: 'Text', h: 'Below the text: an animation in the space under the words (same colors, a little dimmer). None leaves it plain.', f: function (p, t, c, b, img, k, deck) { var cols = textCols(deck && deck.text); var row = Math.floor((p.row - CFG.textTop) / CFG.textSize); if (!p.tree) return scl(c[0], 0.15); if (row < 0 || row > 6) return textFill(p, t, c, b, img, k, deck); var x = Math.floor(textX(p) + t * 4); var m = cols[((x % cols.length) + cols.length) % cols.length]; return (m >> row) & 1 ? c[1] : scl(c[0], 0.15); } },
    // ---- effects in the style of WLED favorites (own implementations; see helpers above) ----
    { id: 'soap', cl: 1, n: 'Soap', f: function (p, t, c) { var s = 0.08, w1 = noise3(p.X * 0.05, p.Y * 0.05, t * 0.3) * 2, w2 = noise3(p.X * 0.05 + 7, p.Y * 0.05 + 3, t * 0.3) * 2; var n = noise3(p.X * s + w1, p.Y * s + w2 + t * 0.2, t * 0.45); var v = smooth(0.15, 0.85, n); var base = mix(c[0], c[1], v); return mix(base, mc(c, n * 2 + t * 0.06), 0.5 * (1 - Math.abs(v - 0.5) * 1.6)); } },
    { id: 'rockets', cl: 1, n: 'Rockets', f: function (p, t, c) { return rockets(p, t, c, false); } },
    { id: 'starburst', cl: 1, n: 'Starburst', f: function (p, t, c) { return rockets(p, t, c, true); } },
    { id: 'pacifica', n: 'Pacifica', f: function (p, t, c) { var w = Math.sin(p.X * 0.35 + t * 1.5) + Math.sin(p.Y * 0.21 - t * 1.1 + p.X * 0.12) + Math.sin((p.X + p.Y) * 0.17 + t * 2) + 1.2 * noise3(p.X * 0.15, p.Y * 0.15 - t * 0.4, t * 0.5); var v = (w + 3.6) / 7.6; var col = mix(scl(c[0], 0.4), c[1], smooth(0.2, 0.85, v)); col = mix(col, hue(0.5 + 0.08 * Math.sin(t * 0.3 + p.Y * 0.05)), 0.2); if (v > 0.74) col = mix(col, [230, 255, 255], smooth(0.74, 0.93, v)); return col; } },
    { id: 'matrix', n: 'Matrix', f: function (p, t, c) { var out = bg(c, 0.03), lane = p.tree ? p.rib : 1000 + Math.round(p.X * 2); for (var j = 0; j < 3; j++) { var h = hash(lane * 7.3 + j * 3.1), sp = 12 + h * 22, head = frac(t * sp / 75 + h) * 75 - 14, d = head - p.Y; if (d >= 0 && d < 1) return mix(c[1], [255, 255, 255], 0.7); if (d > 0 && d < 16) { var f = Math.pow(1 - d / 16, 1.5) * (glit(p, t, 0.12) ? 1.3 : 0.8); out = mix(out, c[1], Math.min(1, f)); } } return out; } },
    { id: 'dna', cl: 1, n: 'DNA', f: function (p, t, c) { var cx = (NR - 1) / 2, a = p.Y * 0.22 - t * 3, amp = NR * 0.32, s1 = cx + Math.sin(a) * amp, s2 = cx - Math.sin(a) * amp, x = p.tree ? p.col : cx + p.X; var d1 = Math.abs(x - s1), d2 = Math.abs(x - s2), front = Math.cos(a) > 0; var c2 = c[0][0] + c[0][1] + c[0][2] < 60 ? (c.mono ? monoPal(c, 0.5) : [255, 255, 255]) : c[0]; if (d1 < 0.75) return scl(c[1], front ? 1 : 0.4); if (d2 < 0.75) return scl(c2, front ? 0.4 : 1); var rung = Math.floor(p.Y + 0.5) % 5 === 0 && x > Math.min(s1, s2) + 0.7 && x < Math.max(s1, s2) - 0.7; return rung ? scl(mc(c, p.Y / 50 + t * 0.1), 0.45) : bg(c); } },
    { id: 'rain', cl: 1, n: 'Rain', f: function (p, t, c) { var out = bg(c, 0.07); for (var j = 0; j < 10; j++) { var tt = t * 0.8 + j / 10, slot = Math.floor(tt), age = tt - slot, h = slot * 10 + j; var cy = 4 + hash(h + 0.3) * 40, dx = p.X - (hash(h) * 2 - 1) * XMAX(cy) * 0.9, dy = p.Y - cy, d = Math.sqrt(dx * dx + dy * dy), r = age * 13; var band = Math.exp(-Math.pow((d - r) / 0.9, 2)) * (1 - age); if (age < 0.06 && d < 1.2) band = 1; if (band > 0.02) out = mix(out, hash(h + 0.5) < 0.5 ? c[1] : rp(c, hash(h + 0.9)), Math.min(1, band * 1.5)); } return out; } },
    { id: 'bounce', cl: 1, n: 'Bounce', f: function (p, t, c) { if (!p.tree) return bg(c, 0.08); var out = bg(c, 0.05); for (var j = 0; j < 8; j++) { var cyc = t * (0.45 + hash(j * 2.3) * 0.45) + j * 0.3, n = Math.floor(cyc), ph = cyc - n, rib = Math.floor(hash(j * 5.1 + Math.floor(n / 4)) * NR); if (p.rib !== rib) continue; var damp = Math.pow(0.7, n % 4), y = 49 - 4 * ph * (1 - ph) * (40 + hash(j) * 8) * damp, d = Math.abs(p.Y - y); if (d < 1.8) out = mix(out, j % 3 ? rp(c, hash(j + 0.7) + t * 0.05) : c[1], 1 - d / 1.8); } return out; } },
    { id: 'lava', n: 'Lava', f: function (p, t, c) { var s = 0; for (var j = 0; j < 6; j++) { var by = 24 + Math.sin(t * (0.35 + j * 0.07) + j * 1.3) * 23, bx = Math.sin(t * (0.33 + j * 0.08) + j * 2.1) * XMAX(by) * 0.7, dx = p.X - bx, dy = (p.Y - by) * 0.6; s += 18 / (dx * dx + dy * dy + 1); } var v = smooth(0.6, 1.5, s); return mix(scl(c[0], 0.15), mix(c[1], hue(0.02 + 0.06 * Math.sin(t * 0.4 + s)), 0.3), v); } },
    { id: 'octopus', cl: 1, n: 'Octopus', f: function (p, t, c) { var dx = p.X, dy = (p.Y - 18) * 0.8, a = Math.atan2(dy, dx), r = Math.sqrt(dx * dx + dy * dy); var v = 0.5 + 0.5 * Math.sin(5 * a + 2.2 * Math.sin(r * 0.28 - t * 2.2) - r * 0.32 + t * 2.4); return scl(rp(c, a / TAU + r * 0.025 - t * 0.06), v * v); } },
    { id: 'pride', cl: 1, n: 'Pride', f: function (p, t, c) { var h = t * 0.07 + p.X * 0.015 + p.Y * 0.012 + Math.sin(t * 0.6 + p.Y * 0.08) * 0.12; var b = 0.5 + 0.5 * Math.sin(p.Y * 0.28 - t * 3.2 + Math.sin(p.X * 0.18 + t * 1.3) * 1.5); return scl(mix(mc(c, h), c[1], 0.12), 0.15 + 0.85 * b * b); } },
    { id: 'juggle', cl: 1, n: 'Juggle', f: function (p, t, c) { var out = bg(c, 0.04); var P = memo('juggle', t, function (t) { return trailPts(jugglePath, t, 8, 8, 0.05); }); for (var j = 0; j < 8; j++) { var v = trailHit(p, P[j], 1.8); if (v > 0) out = mix(out, rp(c, j / 8 + t * 0.03), Math.min(1, v * 1.3)); } return out; } },
    { id: 'blackhole', cl: 1, n: 'Black hole', f: function (p, t, c) { var out = bg(c, 0.03), cy = 22; var P = memo('hole', t, function (t) { return trailPts(holePath, t, 10, 6, 0.06); }); for (var j = 0; j < 10; j++) { var v = trailHit(p, P[j], 1.5); if (v > 0) out = mix(out, rp(c, j / 10 + t * 0.04), Math.min(1, v * 1.4)); } var core = dot(p, 0, cy, 2.2); return core ? mix(out, [255, 255, 255], core * (0.6 + 0.4 * Math.sin(t * 6))) : out; } },
    { id: 'swirl', cl: 1, n: 'Swirl', f: function (p, t, c) { var ax = Math.sin(t * 0.7) * XMAX(20) * 0.5, ay = 20 + Math.cos(t * 0.53) * 14, bx = Math.sin(t * 0.61 + 2) * XMAX(30) * 0.5, by = 30 + Math.cos(t * 0.47 + 1) * 14; var d1 = Math.hypot(p.X - ax, p.Y - ay), d2 = Math.hypot(p.X - bx, p.Y - by); var v = (Math.sin(d1 * 0.45 - t * 3.5) + Math.sin(d2 * 0.45 + t * 2.7) + 2) / 4; var col = scl(rp(c, (d1 - d2) * 0.025 + t * 0.08), v * v * 1.2); return glit(p, t, 0.02) ? [255, 255, 255] : col; } },
    { id: 'waverly', cl: 1, n: 'Waverly', f: function (p, t, c) { var lane = p.tree ? p.col : p.col; var h = 12 + 34 * noise3(lane * 0.35, t * 1.1, 0.5), top = 49 - h, d = p.Y - top; if (p.tree && Math.abs(d) < 0.8) return [255, 255, 255]; if (!p.tree) return scl(rp(c, lane / NR + t * 0.05), 0.5 + 0.5 * Math.sin(t * 4)); if (d < 0) return bg(c); return scl(rp(c, (49 - p.Y) / 70 + t * 0.05), 0.35 + 0.65 * (1 - d / (h + 1))); } },
    { id: 'popcorn', cl: 1, n: 'Popcorn', f: function (p, t, c) { if (!p.tree) return bg(c, 0.08); var out = bg(c, 0.05); for (var j = 0; j < 12; j++) { var f = 0.5 + hash(j * 3.7) * 0.4, cyc = t * f + hash(j), n = Math.floor(cyc), ph = cyc - n, rib = Math.floor(hash(j * 11 + n * 3) * NR); if (p.rib !== rib) continue; var y = 49 - 4 * ph * (1 - ph) * (18 + hash(j + n) * 30), d = Math.abs(p.Y - y); if (d < 1.4) out = mix(out, hash(j + n * 0.7) < 0.3 ? c[1] : mc(c, hash(j * 2 + n)), 1 - d / 1.4); } return out; } },
    { id: 'bees', cl: 1, n: 'Bees', f: function (p, t, c) { var out = bg(c, 0.04), P = memo('bees', t, function (t) { return { pts: trailPts(beePath, t, 6, 6, 0.04), fl: [0, 1, 2, 3, 4, 5].map(function (j) { return beeTgt(j, Math.floor(t * beeSp(j) + j * 0.37) + 1); }) }; }); for (var j = 0; j < 6; j++) { var v = trailHit(p, P.pts[j], 1.4); if (v > 0) out = mix(out, c.mono ? c[1] : mix(c[1], [255, 220, 0], 0.4), Math.min(1, v * 1.4)); var T = P.fl[j], fl = dot(p, T[0], T[1], 1.6); if (fl > 0) out = mix(out, mc(c, hash(j * 5)), fl * 0.7); } return out; } },
    { id: 'hiphotic', cl: 1, n: 'Hiphotic', f: function (p, t, c) { var v = Math.sin(p.X * 0.22 + Math.cos(p.Y * 0.17 + t * 0.9) * 2.4 + t * 1.4) + Math.cos(p.Y * 0.2 + Math.sin(p.X * 0.19 - t * 1.2) * 2.4 - t); var b = 0.5 + 0.5 * Math.sin(v * 3); return scl(rp(c, v * 0.2 + t * 0.05), 0.1 + 0.9 * b * b); } },
    { id: 'driftrose', cl: 1, n: 'Drift rose', f: function (p, t, c) { var dx = p.X, dy = (p.Y - 20) * 0.75, a = Math.atan2(dy, dx), r = Math.sqrt(dx * dx + dy * dy), out = bg(c, 0.03); for (var j = 0; j < 2; j++) { var k = j ? 3 : 5, rr = 15 * Math.abs(Math.cos(k * (a - t * (j ? -0.5 : 0.4)) / 2)), v = Math.exp(-Math.pow((r - rr) / 1.2, 2)); if (v > 0.03) out = mix(out, j ? c[1] : rp(c, a / TAU + t * 0.1), v); } return out; } },
    // ---- Christmas effects (smooth: no whole-tree flashing) ----
    { id: 'twinklelights', cl: 1, n: 'Twinkle lights', f: function (p, t, c) { if (p.seed > 0.7) return bg(c, 0.05); var ph = frac(t * 0.22 * (0.6 + p.seed) + p.seed * 7), v = Math.pow(Math.sin(ph * PI), 3); var col = c.mono ? monoPal(c, p.seed * 5) : C9[Math.floor(p.seed * 991) % 5]; return mix(bg(c, 0.05), col, v); } },
    { id: 'stringlights', cl: 1, n: 'String of lights', f: function (p, t, c) { if (!p.tree) return bg(c, 0.1); var wraps = 4, s = p.u * wraps - p.col / NR, d = Math.abs(s - Math.round(s)); if (d > 0.05) return bg(c, 0.07); var idx = Math.round(p.u * 60 + p.col * 3), col = c.mono ? monoPal(c, idx * 0.37) : C9[((idx % 5) + 5) % 5]; return scl(col, (0.55 + 0.45 * Math.sin(idx * 0.7 - t * 2.5)) * (1 - d / 0.05 * 0.5)); } },
    { id: 'ornamentdrop', cl: 1, n: 'Ornament drop', f: function (p, t, c) { var out = bg(c, 0.06); for (var j = 0; j < 9; j++) { var P = 5, q = t / P + j / 9, slot = Math.floor(q), a = (q - slot) * P, h = slot * 9 + j, life = 1 - smooth(3.6, P, a); if (life <= 0) continue; var y = -2 + dropY(a), x = (hash(h) * 2 - 1) * XMAX(y) * 0.85, d = dot(p, x, y, 2.2); if (d > 0) { var col = c.mono ? monoPal(c, hash(h + 0.3)) : ORN[Math.floor(hash(h + 0.3) * 5)]; var hl = dot(p, x - 0.6, y - 0.7, 0.9); out = mix(out, mix(col, [255, 255, 255], hl * 0.7), Math.min(1, d * 2) * life); } } return out; } },
    { id: 'sleigh', cl: 1, n: "Santa's sleigh", f: function (p, t, c) { var out = bg(c, 0.04); if (hash(p.seed * 313 + Math.floor(t * 2)) < 0.01) out = [120, 120, 140]; var P = memo('sleigh', t, function (t) { return { tr: trailPts(function (j, tt) { return sleighPath(0, tt); }, t, 1, 14, 0.06)[0], deer: [1, 2, 3, 4].map(function (j) { return sleighPath(j, t); }), s: sleighPath(0, t) }; }); for (var k = 1; k < P.tr.length; k++) { var q = P.tr[k], dd = dot(p, q[0], q[1], 1.3); if (dd > 0 && glit(p, t, 0.55)) out = mix(out, c.mono ? c[1] : [255, 200, 60], dd * (1 - k / P.tr.length)); } for (var j = 0; j < 4; j++) { var r = P.deer[j], dr = dot(p, r[0], r[1], 1.1); if (dr > 0) out = mix(out, j === 3 ? [255, 30, 20] : (c.mono ? scl(c[1], 0.6) : [150, 80, 30]), Math.min(1, dr * 2)); } var ds = dot(p, P.s[0], P.s[1], 1.8); if (ds > 0) out = mix(out, c.mono ? c[1] : [220, 20, 30], Math.min(1, ds * 2)); return out; } },
    { id: 'shootingstars', cl: 1, n: 'Shooting stars', f: function (p, t, c) { var out = bg(c, 0.04), tw = Math.pow(0.5 + 0.5 * Math.sin(t * 1.5 + p.seed * 40), 6); if (p.seed > 0.93) out = mix(out, [200, 200, 220], tw * 0.6); for (var j = 0; j < 4; j++) { var P = 3.2, q = t / P + j / 4, slot = Math.floor(q), a = q - slot, h = slot * 4 + j; if (a > 0.45) continue; var dir = hash(h) < 0.5 ? 1 : -1, sx = -dir * XMAX(10) * (0.5 + hash(h + 0.2) * 0.5), sy = 2 + hash(h + 0.4) * 18, hx = sx + dir * a * 60, hy = sy + a * 40, dx = p.X - hx, dy = p.Y - hy, ux = dir * 0.83, uy = 0.55, along = -(dx * ux + dy * uy), perp = Math.abs(dx * uy - dy * ux); if (along < -1 || along > 12 || perp > 1.1) continue; var v = (along < 0 ? 1 + along : 1 - along / 12) * (1 - perp / 1.1) * (1 - smooth(0.3, 0.45, a)); out = mix(out, along < 1 ? [255, 255, 240] : (c.mono ? c[1] : [255, 210, 120]), Math.max(0, Math.min(1, v))); } return out; } },
    { id: 'snowswirl', n: 'Snow globe swirl', f: function (p, t, c) { var out = mix(bg(c, 0.25), c[0], 0.15 * noise3(p.X * 0.1, p.Y * 0.1, t * 0.2)); var P = memo('swirl', t, function (t) { return trailPts(flakePath, t, 24, 3, 0.05); }); for (var j = 0; j < 24; j++) { var v = trailHit(p, P[j], 1.3); if (v > 0) out = mix(out, c[1], Math.min(1, v * 1.4)); } return out; } },
    { id: 'tinsel', cl: 1, n: 'Tinsel shimmer', f: function (p, t, c) { var band = Math.floor(frac(p.u * 3 + p.col / NR * 0.5) * 2), base = c.mono ? (band ? c[1] : c[0]) : (band ? [255, 190, 60] : [200, 210, 230]); var g = Math.pow(noise3(p.X * 0.7, p.Y * 0.7, t * 1.6), 3), s = Math.pow(0.5 + 0.5 * Math.sin(p.u * 30 - t * 4 + p.col), 8); return mix(scl(base, 0.3 + 0.35 * g), [255, 255, 255], Math.min(0.7, s * 0.5 + g * 0.4)); } },
    { id: 'ribbonwrap', n: 'Ribbon wrap', f: function (p, t, c) { if (!p.tree) return c[1]; var s = frac(p.u * 3 - p.col / NR - t * 0.12), w = Math.abs(s - 0.5); if (w < 0.09) return mix(c[1], [255, 255, 255], w < 0.02 ? 0.35 : 0); return scl(c[0], 0.45 + 0.15 * Math.sin(p.u * 20 + t)); } },
    // ---- Thanksgiving / autumn ----
    { id: 'leaves', cl: 1, n: 'Leaves', f: function (p, t, c) { var out = bg(c, 0.06); for (var j = 0; j < 14; j++) { var h = hash(j * 3.3), sp = 0.05 + h * 0.06, q = t * sp + hash(j * 7.7), ph = frac(q), y = -4 + ph * 58, x = (hash(j * 1.9 + Math.floor(q)) * 2 - 1) * XMAX(y) * 0.9 + Math.sin(t * 1.3 + j) * 2.2; var d = dot(p, x, y, 1.7); if (d > 0) out = mix(out, c.mono ? monoPal(c, h) : AUT[j % 4], Math.min(1, d * 1.6)); } return out; } },
    { id: 'wind', cl: 1, n: 'Wind', f: function (p, t, c) { var gust = 0.6 + 0.4 * Math.sin(t * 0.5), streak = noise3(p.X * 0.15 - t * 1.8 * gust, p.Y * 0.5, t * 0.2), out = mix(bg(c, 0.05), c[1], smooth(0.65, 0.9, streak) * 0.25); for (var j = 0; j < 12; j++) { var h = hash(j * 5.1), y = 3 + h * 44 + Math.sin(t * 2 + j) * 1.5, span = 2 * XMAX(y) + 12, x = frac(t * (0.12 + h * 0.1) * gust + hash(j * 2.7)) * span - span / 2, d = dot(p, x, y, 1.5); if (d > 0) out = mix(out, c.mono ? monoPal(c, h) : AUT[j % 4], Math.min(1, d * 1.6)); } return out; } },
    { id: 'harvestmoon', cl: 1, n: 'Harvest moon', f: function (p, t, c) { var mx = Math.sin(t * 0.07) * 3, my = 17 + Math.sin(t * 0.05) * 5, dx = p.X - mx, dy = (p.Y - my) * 0.75, d = Math.sqrt(dx * dx + dy * dy), R = 8, moon = c.mono ? c[1] : [255, 140, 30], out = bg(c, 0.04); if (hash(p.seed * 313 + Math.floor(t * 3)) < 0.012) out = [160, 160, 170]; if (d < R) out = scl(moon, 0.7 + 0.35 * noise3(p.X * 0.4, p.Y * 0.4, 3)); else out = mix(out, moon, Math.exp(-(d - R) / 3.5) * 0.5); var cl = smooth(0.5, 0.8, noise3(p.X * 0.07 - t * 0.12, p.Y * 0.2, 1.7)); return mix(out, scl(mix(c[0], [90, 90, 110], 0.6), 0.5), cl * 0.85); } },
    { id: 'turkeytail', cl: 1, n: 'Turkey strut', f: function (p, t, c, b) { var dx = p.X, dy = 49 - p.Y, a = Math.atan2(dx, dy), r = Math.sqrt(dx * dx + dy * dy), open = 1.0 + 0.35 * Math.sin(b * PI * 0.5); if (r < 7) return c.mono ? scl(c[1], 0.5) : [120, 60, 15]; if (Math.abs(a) > open || r > 34) return bg(c, 0.05); var f = (a / open + 1) * 5.5, i = Math.floor(f), col = c.mono ? monoPal(c, i / 11) : AUT[i % 4]; if (r > 29) col = c.mono ? c[1] : [245, 235, 210]; return scl(col, Math.abs(frac(f) - 0.5) > 0.42 ? 0.35 : 0.9); } },
    // ---- retro graphics ----
    { id: 'graphic', cl: 1, n: 'Graphic', h: 'Shows a retro pixel graphic on the front of the tree. Pick one, or a set to change every 8 beats.', f: function (p, t, c, b, img, k, deck) { if (!p.tree) return bg(c, 0.15); var L = gfxList(deck && deck.g), g = GFX[L[Math.floor(b / 8) % L.length]]; return gfxAt(p, t, c, g, gfxX(p, g.r.length)) || bg(c, 0.12); } },
    { id: 'parade', cl: 1, n: 'Graphic parade', h: 'Retro pixel graphics marching around the tree. Pick one, or a set.', f: function (p, t, c, b, img, k, deck) { if (!p.tree) return bg(c, 0.15); var L = gfxList(deck && deck.g), x = gfxX(p, 12) + t * 2.5, per = 15, i = Math.floor(x / per), g = GFX[L[((i % L.length) + L.length) % L.length]]; return gfxAt(p, t, c, g, x - i * per - per / 2) || bg(c, 0.12); } },
    // ---- Sir Mix-a-Lot only (mix: 1): strobe-like effects for live mixing; kept out of designs, random looks and the library ----
    { id: 'lightning', n: 'Lightning', mix: 1, f: function (p, t, c) { var slot = Math.floor(t * 0.9), ph = t * 0.9 - slot, h = slot * 13.7; var fl = 0; for (var j = 0; j < 4; j++) { var at = 0.1 + hash(h + j) * 0.55 + j * 0.05, dd = ph - at; if (dd > 0 && dd < 0.04) fl = Math.max(fl, 1 - dd / 0.04); } if (!fl) return bg(c, 0.04); var x = p.tree ? p.col : (NR - 1) / 2 + p.X, end = 22 + hash(h + 5) * 27, out = mix(bg(c, 0.04), c[1], 0.15 * fl); for (var b = 0; b < 2; b++) { var bend = (noise3(p.Y * 0.15, h + b * 9, 0) - 0.5) * 9, bolt = (NR - 1) * hash(h + 9 + b * 3) + bend, on = Math.abs(x - bolt) < 0.6 && p.Y < end - b * 8; var br = Math.abs(x - bolt - (p.Y - 14) * (hash(h + b) < 0.5 ? 0.3 : -0.3)) < 0.6 && p.Y > 14 && p.Y < end - 6; if (on || br) out = mix(c[1], [255, 255, 255], 0.75 * fl); } return out; } },
    { id: 'beatflash', n: 'Beat flash', mix: 1, f: function (p, t, c, b) { var e = Math.pow(1 - frac(b), 2.2); return mix(scl(c[0], 0.25), c[1], e); } },
    { id: 'image', n: 'Image', f: function (p, t, c, b, img, k) { if (!img) return BLACK; var o = k * 3; return [img[o], img[o + 1], img[o + 2]]; } }
  ];
  var PATMAP = {}; PATS.forEach(function (p) { PATMAP[p.id] = p; });


  var PALETTES = [
    { n: 'Blue and gold', c: ['#2d68c4', '#f2a900'] },
    { n: 'Cardinal and gold', c: ['#c8102e', '#ffc72c'] },
    { n: 'Christmas', c: ['#d4141e', '#13a538'] },
    { n: 'Candy cane', c: ['#e0101e', '#ffffff'] },
    { n: 'Ice', c: ['#1f5fd6', '#e8f4ff'] },
    { n: 'Warm white', c: ['#7a3a00', '#ffd9a0'] },
    { n: 'Evergreen', c: ['#0a5a2a', '#d8b14a'] },
    { n: 'Winter purple', c: ['#5a2bb8', '#9fe8ff'] },
    { n: 'Ember', c: ['#d42a00', '#ffcc33'] },
    { n: 'Peppermint', c: ['#ffffff', '#ff3355'] },
    { n: 'Holly', c: ['#0a5a2a', '#e0101e'] },
    { n: 'Gold and silver', c: ['#3a4048', '#f2c14e'] },
    { n: 'Silent night', c: ['#050a2a', '#cfd8ff'] },
    { n: 'Sugar plum', c: ['#5a2bb8', '#ff8ad8'] },
    { n: 'Gingerbread', c: ['#8a4a14', '#ffffff'] },
    { n: 'Northern lights', c: ['#0fb37a', '#7a3cff'] },
    { n: 'Frost', c: ['#1f5fd6', '#e8f4ff'] }
  ];

  // ---------- base64 for image pixels ----------
  function b64enc(u8) { if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64'); var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function b64dec(s) { if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64')); var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  var IMGCACHE = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function imgOf(look) {
    if (!look || !look.img) return null;
    if (look._img) return look._img;
    var u = b64dec(look.img);
    if (u.length !== N * 3) return null;
    try { Object.defineProperty(look, '_img', { value: u, enumerable: false, configurable: true }); } catch (e) { look._img = u; }
    return u;
  }

  // ---------- looks ----------
  // look = { A:{p,c:[hex,hex],sp}, B:{p,c,sp}, xf:0-1, auto:0|8|16, bpm, top:'star'|'follow'|'image', img?:base64 }
  function defaultLook() {
    return { A: { p: 'spin', c: ['#2d68c4', '#f2a900'], sp: 1 }, B: { p: 'rise', c: ['#c8102e', '#ffc72c'], sp: 1 }, xf: 0, auto: 0, bpm: 120, top: 'star' };
  }
  function newRun() { return { tA: 0, tB: 0, beat: 0, xf: 0 }; }

  // Renders one frame of a look into out (Float32Array 3300, internal order). Advances run by dt seconds.
  function render(look, run, dt, out) {
    var A = look.A || {}, B = look.B || {}, bps = (look.bpm || 120) / 120;
    run.beat += dt * (look.bpm || 120) / 60;
    run.tA += dt * (A.sp == null ? 1 : A.sp) * bps;
    run.tB += dt * (B.sp == null ? 1 : B.sp) * bps;
    var xf = look.xf || 0;
    if (look.auto) { var ph = (run.beat / look.auto) % 2; xf = ph < 1 ? Math.min(1, Math.max(0, (ph - 0.75) * 4)) : Math.min(1, Math.max(0, 1 - (ph - 1.75) * 4)); }
    run.xf = xf;
    var pa = PATMAP[A.p] || PATS[0], pb = PATMAP[B.p] || PATS[0];
    var ca = [hex(A.c && A.c[0]), hex(A.c && A.c[1])], cb = [hex(B.c && B.c[0]), hex(B.c && B.c[1])];
    ca.mono = A.cl === false; cb.mono = B.cl === false; // Classic colors turned off
    var img = imgOf(look), lead = look.tc ? [hex(look.tc[0]), hex(look.tc[1])] : xf < 0.5 ? ca : cb, top = look.top || 'star';
    var only = look.strict ? strictPal(look) : null;
    for (var k = 0; k < N; k++) {
      var p = PX[k], c;
      if (!p.tree && top === 'star') {
        c = p.tp.star ? scl(lead[1], 0.85 + 0.15 * Math.sin(run.beat * TAU)) : scl(lead[0], 0.12 + 0.25 * (0.5 + 0.5 * Math.sin(run.beat * PI - p.tp.ri)));
      } else if (!p.tree && top === 'flake') {
        var tp = p.tp, n = RINGS[tp.ri][1], ad = Math.abs(frac(tp.a / (TAU / 6) + run.beat * 0.02 + 0.5) - 0.5) * 60; // degrees from nearest arm
        var arm = tp.ri === 0 || ad <= 180 / n + 0.5;
        c = arm ? scl(lead[1], 0.8 + 0.2 * Math.sin(run.beat * PI + tp.ri)) : scl(lead[0], 0.12);
      } else if (!p.tree && top === 'ripple') {
        var lv = frac(run.beat / 2 - p.tp.ri * 0.22);
        c = mix(scl(lead[0], 0.15), lead[1], Math.pow(1 - lv, 2.2));
      } else if (!p.tree && top === 'image') {
        c = img ? [img[k * 3], img[k * 3 + 1], img[k * 3 + 2]] : BLACK;
      } else {
        var c1 = xf < 1 ? pa.f(p, run.tA, ca, run.beat, img, k, A) : null;
        var c2 = xf > 0 ? pb.f(p, run.tB, cb, run.beat, img, k, B) : null;
        c = !c2 ? c1 : !c1 ? c2 : mix(c1, c2, xf);
      }
      if (only) c = snapColor(c, only);
      out[k * 3] = c[0]; out[k * 3 + 1] = c[1]; out[k * 3 + 2] = c[2];
    }
    return out;
  }

  // "Only this design's colors" (look.strict): every pixel becomes the nearest of the design's colors (both decks and the
  // topper colors, ignoring near-black), at the pixel's brightness. Blends, white sparkles and tints all snap to team colors.
  function strictPal(look) {
    var cs = [], add = function (h) { var v = hex(h); if (v[0] + v[1] + v[2] >= 60 && !cs.some(function (x) { return x[0] === v[0] && x[1] === v[1] && x[2] === v[2]; })) cs.push(v); };
    [look.A, look.B].forEach(function (d) { if (d && d.c) { add(d.c[0]); add(d.c[1]); } }); if (look.tc) { add(look.tc[0]); add(look.tc[1]); }
    return cs.map(function (v) { var m = Math.max(v[0], v[1], v[2]), n = Math.hypot(v[0], v[1], v[2]); return { c: v, m: m, u: [v[0] / n, v[1] / n, v[2] / n] }; });
  }
  function snapColor(c, pal) {
    if (!pal.length) return c;
    var m = Math.max(c[0], c[1], c[2]); if (m < 1) return BLACK;
    var n = Math.hypot(c[0], c[1], c[2]), best = pal[0], bd = -2;
    for (var i = 0; i < pal.length; i++) { var u = pal[i].u, d = (c[0] * u[0] + c[1] * u[1] + c[2] * u[2]) / n; if (d > bd) { bd = d; best = pal[i]; } }
    return scl(best.c, Math.min(1, m / best.m));
  }
  function randomLook(rand) {
    rand = rand || Math.random;
    function pick(a) { return a[Math.floor(rand() * a.length)]; }
    var pool = PATS.filter(function (p) { return p.id !== 'image' && p.id !== 'text' && !p.mix; }).map(function (p) { return p.id; });
    var pal1 = pick(PALETTES), pal2 = rand() < 0.6 ? pal1 : pick(PALETTES);
    var pA = pick(pool), pB = pick(pool), sp = [0.5, 0.75, 1, 1, 1.25, 1.5, 2];
    var look = { A: { p: pA, c: pal1.c.slice(), sp: pick(sp) }, B: { p: pB, c: pal2.c.slice(), sp: pick(sp) }, xf: 0, auto: rand() < 0.45 ? pick([8, 16]) : 0, bpm: pick([90, 100, 110, 120, 128]), top: pick(['star', 'star', 'flake', 'ripple', 'follow']) };
    var name = (PATMAP[pA].n) + (look.auto ? ' / ' + PATMAP[pB].n : '') + ' · ' + pal1.n;
    return { id: 'random', name: name, look: look };
  }

  // ---------- WLED order ----------
  var WIDX = new Array(N);
  for (var q = 0; q < N; q++) {
    if (q >= NT) { WIDX[q] = CFG.topper ? q - NT + TOP_START : -1; continue; }
    var ri = Math.floor(q / ROWS), ro = q % ROWS; // ro 0 = top
    if (CFG.map === 'matrix') WIDX[q] = ro * NR + (CFG.flip ? NR - 1 - ri : ri);
    else { var rs = CFG.flip ? NR - 1 - ri : ri; WIDX[q] = rs * ROWS + (rs % 2 === 0 ? ROWS - 1 - ro : ro); }
  }
  var GAMMA = new Uint8Array(256); for (q = 0; q < 256; q++) GAMMA[q] = Math.round(255 * Math.pow(q / 255, CFG.gamma));
  function clamp8(v) { return v <= 0 ? 0 : v >= 255 ? 255 : v | 0; }
  function toWled(out, bright, bytes) {
    bytes = bytes || new Uint8Array(WN * 3); bright = bright == null ? 1 : bright;
    for (var q = 0; q < N; q++) { if (WIDX[q] < 0) continue; var o = WIDX[q] * 3, s = q * 3; bytes[o] = GAMMA[clamp8(out[s] * bright)]; bytes[o + 1] = GAMMA[clamp8(out[s + 1] * bright)]; bytes[o + 2] = GAMMA[clamp8(out[s + 2] * bright)]; }
    return bytes;
  }
  function toBytes(out, bright, bytes) {
    bytes = bytes || new Uint8Array(N * 3); bright = bright == null ? 1 : bright;
    for (var s = 0; s < N * 3; s++) bytes[s] = clamp8(out[s] * bright);
    return bytes;
  }

  // ---------- playlist player ----------
  // playlist = { items:[{id, sec}], mode:'order'|'shuffle'|'random', fade:sec, randSec:sec }
  function Player(opts) {
    this.getDesign = opts.getDesign;           // id -> {id,name,look} or null
    this.pl = { items: [], mode: 'order', fade: 3, randSec: 60 };
    this.running = false; this.cur = null; this.prev = null; this.fadeT = 0;
    this.bufA = new Float32Array(N * 3); this.bufB = new Float32Array(N * 3);
    this.order = []; this.pos = -1; this.rand = opts.rand || Math.random;
  }
  Player.prototype.setPlaylist = function (pl) {
    this.pl = { items: (pl.items || []).slice(), mode: pl.mode || 'order', fade: pl.fade == null ? 3 : +pl.fade, randSec: +pl.randSec || 60, sec: +pl.sec || 45 }; // sec: time per design; an item's own sec overrides it
    this.order = []; // rebuilt on next advance
  };
  Player.prototype._validItems = function () { var self = this; return this.pl.items.filter(function (it) { return self.getDesign(it.id); }); };
  Player.prototype._nextEntry = function () {
    if (this.pl.mode === 'random') { var d = randomLook(this.rand); return { d: d, sec: this.pl.randSec }; }
    var items = this._validItems(); if (!items.length) return null;
    if (this.pl.mode === 'shuffle') {
      if (!this.order.length) {
        this.order = items.map(function (_, i) { return i; });
        for (var i = this.order.length - 1; i > 0; i--) { var j = Math.floor(this.rand() * (i + 1)); var t = this.order[i]; this.order[i] = this.order[j]; this.order[j] = t; }
        if (this.cur && items.length > 1 && items[this.order[this.order.length - 1]].id === this.cur.d.id) this.order.reverse(); // avoid repeating across reshuffles
      }
      var it = items[this.order.pop()];
      return { d: this.getDesign(it.id), sec: +it.sec || this.pl.sec };
    }
    this.pos = (this.pos + 1) % items.length;
    var it2 = items[this.pos];
    return { d: this.getDesign(it2.id), sec: +it2.sec || this.pl.sec };
  };
  Player.prototype._go = function (entry) {
    if (!entry) { this.cur = null; return; }
    if (this.cur && this.pl.fade > 0) { this.prev = this.cur; this.fadeT = 0; } else this.prev = null;
    this.cur = { d: entry.d, look: entry.d.look, run: newRun(), left: entry.sec, sec: entry.sec };
  };
  // pos: resume an in-order playlist after this item index (default: from the top)
  Player.prototype.start = function (pos) { this.running = true; this.order = []; this.pos = pos == null ? -1 : pos; this.prev = null; this.cur = null; this._go(this._nextEntry()); };
  Player.prototype.stop = function () { this.running = false; this.cur = null; this.prev = null; };
  Player.prototype.next = function () { if (this.running) this._go(this._nextEntry()); };
  // hold: stay on this design until next(), start() or stop() (Hold on tree); otherwise play it for sec, then the playlist.
  Player.prototype.playDesign = function (d, sec, hold) { this.running = true; this._go({ d: d, sec: sec || this.pl.randSec || 60 }); if (hold) this.cur.hold = true; };
  // Returns false if nothing to show.
  Player.prototype.step = function (dt, out) {
    if (!this.running) return false;
    if (!this.cur) { this._go(this._nextEntry()); if (!this.cur) return false; }
    if (!this.cur.hold) { this.cur.left -= dt; if (this.cur.left <= 0) this._go(this._nextEntry()); }
    if (!this.cur) return false;
    render(this.cur.look, this.cur.run, dt, out);
    if (this.prev) {
      this.fadeT += dt; var f = Math.min(1, this.fadeT / Math.max(0.01, this.pl.fade));
      render(this.prev.look, this.prev.run, dt, this.bufB);
      for (var s = 0; s < N * 3; s++) out[s] = this.bufB[s] + (out[s] - this.bufB[s]) * f;
      if (f >= 1) this.prev = null;
    }
    return true;
  };
  Player.prototype.status = function () {
    return { running: this.running, mode: this.pl.mode, name: this.cur ? this.cur.d.name : null, id: this.cur ? this.cur.d.id : null, hold: !!(this.cur && this.cur.hold), left: this.cur ? Math.max(0, Math.round(this.cur.left)) : 0, sec: this.cur ? this.cur.sec : 0, count: this.pl.items.length };
  };

  // ---------- Christmas design library ----------
  // dk(pattern, color1, color2, speed, text) builds a deck. Topper: star | flake | ripple | follow | image. tc = topper colors.
  var GOLD = ['#3a2a00', '#ffc83a'];
  // Category names by the index L() uses. Display order (by season) is CAT_ORDER, exported as CATS.
  var CATS = ['Christmas · classic', 'Christmas · candy and sweets', 'Winter · snow and ice', 'Winter · fireside', "Christmas · Santa's workshop", 'Christmas · holy night', 'Christmas · messages', 'Party and everyday', "New Year's", 'Team colors', 'Effects', 'Thanksgiving and fall', 'Christmas · retro graphics', 'Christmas · party', 'Christmas · effects'];
  var CAT_ORDER = ['Thanksgiving and fall', 'Christmas · classic', 'Christmas · candy and sweets', "Christmas · Santa's workshop", 'Christmas · holy night', 'Christmas · messages', 'Christmas · party', 'Christmas · effects', 'Christmas · retro graphics', 'Winter · snow and ice', 'Winter · fireside', "New Year's", 'Team colors', 'Effects', 'Party and everyday'];
  // Earlier category names, so saved designs (including ones you edited) move to the new names.
  var OLD_CATS = { 'Classic Christmas': 'Christmas · classic', 'Candy and sweets': 'Christmas · candy and sweets', 'Snow and winter': 'Winter · snow and ice', 'Fireside': 'Winter · fireside', "Santa's workshop": "Christmas · Santa's workshop", 'Holy night': 'Christmas · holy night', 'Messages': 'Christmas · messages', 'Party lights': 'Party and everyday', "New Year's Eve": "New Year's", 'WLED-style effects': 'Effects', 'Thanksgiving': 'Thanksgiving and fall', 'Retro graphics': 'Christmas · retro graphics' };
  function dk(p, c0, c1, sp, text) { var d = { p: p, c: [c0, c1], sp: sp == null ? 1 : sp }; if (text) d.text = text; return d; }
  function tx(text, c0, c1, below, sp) { var d = dk('text', c0, c1, sp == null ? 0.9 : sp, text); d.below = below; return d; }
  function tdk(p, c0, c1, sp) { var d = dk(p, c0, c1, sp); d.cl = false; return d; }                 // team colors only (Classic colors off)
  function tgdk(gid, c0, c1) { var d = dk('graphic', c0, c1, 1); d.g = gid; d.cl = false; return d; }
  function gdk(gid, bgc) { var d = dk('graphic', bgc, '#ffffff', 1); d.g = gid; return d; }
  function L(id, name, cat, A, o) {
    o = o || {};
    if (o.A0g) A.g = o.A0g;
    var look = { A: A, B: o.B || dk('sparkle', A.c[0], A.c[1]), xf: o.xf || 0, auto: o.auto || 0, bpm: o.bpm || 120, top: o.top || 'star' };
    if (o.tc) look.tc = o.tc;
    if (o.strict) look.strict = true;
    var d = { id: id, name: name, cat: CATS[cat], look: look }; if (o.v) d.v = o.v; return d;
  }
  var LIBRARY = [
    // Classic Christmas
    L('x-c9', 'Classic C9 bulbs', 0, dk('bulbs', '#000000', '#ffffff'), { tc: GOLD }),
    L('x-redgreen-spin', 'Red and green spin', 0, dk('spin', '#d4141e', '#13a538', 0.75), { tc: GOLD }),
    L('x-ribbons', 'Red and green ribbons', 0, dk('helix', '#13a538', '#e0101e', 0.8), { tc: GOLD }),
    L('s-xmas', 'Christmas helix to sparkle', 0, dk('helix', '#d4141e', '#13a538'), { B: dk('sparkle', '#13a538', '#ffffff'), auto: 16 }),
    L('x-garland', 'Gold garland', 0, dk('garland', '#0a5a2a', '#d42a2a'), { tc: GOLD }),
    L('x-ornaments', 'Ornament tree', 0, dk('ornaments', '#0a5a2a', '#e0101e'), { tc: GOLD }),
    L('s-twinkle', 'Warm white twinkle', 0, dk('twinkle', '#7a3a00', '#ffd9a0')),
    L('x-evergreen', 'Evergreen glow', 0, dk('glow', '#06401c', '#2fbf5a', 0.6), { tc: GOLD }),
    L('x-holly', 'Holly and berries', 0, dk('sparkle', '#0a5a2a', '#e0101e'), { tc: ['#0a5a2a', '#e0101e'] }),
    L('x-tinsel', 'Silver tinsel', 0, dk('sparkle', '#3a4a5a', '#ffffff', 1.5), { B: dk('twinkle', '#3a4a5a', '#ffffff'), auto: 16, top: 'flake' }),
    L('x-marquee', 'Marquee lights', 0, dk('chase', '#7a1010', '#ffd200'), { tc: GOLD }),
    L('x-oldfashioned', 'Old-fashioned tree', 0, dk('bulbs', '#000000', '#ffffff', 0.4), { B: dk('ornaments', '#0a5a2a', '#ffd200'), auto: 16, tc: GOLD }),
    // Candy and sweets
    L('s-candy', 'Candy cane', 1, dk('candy', '#e0101e', '#ffffff')),
    L('x-candy-still', 'Candy cane stripes', 1, dk('candy', '#e0101e', '#ffffff', 0), { top: 'ripple', tc: ['#e0101e', '#ffffff'] }),
    L('x-peppermint', 'Peppermint swirl', 1, dk('candy', '#ffffff', '#ff2244', 1.5), { top: 'ripple', tc: ['#ffffff', '#ff2244'] }),
    L('x-sugarplum', 'Sugar plum fairy', 1, dk('twinkle', '#5a2bb8', '#ff8ad8'), { top: 'flake' }),
    L('x-gingerbread', 'Gingerbread house', 1, dk('chase', '#8a4a14', '#ffffff', 0.6), { tc: ['#8a4a14', '#ffffff'] }),
    L('x-gumdrops', 'Gumdrops', 1, dk('confetti', '#300818', '#ff5c9a')),
    L('x-cocoa', 'Hot cocoa', 1, dk('glow', '#3a1a08', '#d9a066', 0.5), { top: 'ripple' }),
    L('x-ribboncandy', 'Ribbon candy', 1, dk('rise', '#ff2244', '#2ec27e', 1.25)),
    L('x-cookies', 'Frosted cookies', 1, dk('plasma', '#ffb3c7', '#bfefff', 0.7)),
    L('x-lollipop', 'Lollipop spiral', 1, dk('helix', '#ff5c9a', '#ffffff', 1.3), { B: dk('candy', '#ff5c9a', '#ffffff'), auto: 8, top: 'ripple' }),
    // Snow and winter
    L('s-snow', 'Snowfall', 2, dk('snow', '#1f5fd6', '#e8f4ff'), { top: 'flake' }),
    L('x-heavysnow', 'Heavy snow', 2, dk('snow', '#0a1a5c', '#ffffff', 1.8), { top: 'flake' }),
    L('x-icicles', 'Icicles', 2, dk('icicles', '#0a2a6c', '#e8f4ff'), { top: 'flake' }),
    L('x-aurora', 'Northern lights', 2, dk('aurora', '#0fb37a', '#7a3cff'), { top: 'follow' }),
    L('x-frost', 'Frost', 2, dk('sparkle', '#1f5fd6', '#e8f4ff'), { top: 'flake' }),
    L('x-blizzard', 'Blizzard', 2, dk('snow', '#2a3a5a', '#ffffff', 2.5), { B: dk('sparkle', '#2a3a5a', '#ffffff', 2), auto: 8, top: 'flake' }),
    L('x-wonderland', 'Winter wonderland', 2, dk('twinkle', '#1f3fa6', '#ffffff'), { top: 'flake' }),
    L('x-icepalace', 'Ice palace', 2, dk('glow', '#1f5fd6', '#bff4ff', 0.6), { top: 'flake' }),
    L('x-snowglobe', 'Snow globe', 2, dk('snow', '#5a2bb8', '#ffffff', 0.7), { top: 'ripple', tc: ['#5a2bb8', '#ffffff'] }),
    L('x-polar', 'Polar night', 2, dk('radar', '#0a1a5c', '#9fe8ff', 0.6), { top: 'flake' }),
    L('x-frozenaurora', 'Aurora to snowfall', 2, dk('aurora', '#14c8b0', '#3a5cff'), { B: dk('snow', '#0a1a5c', '#ffffff'), auto: 16, top: 'flake' }),
    // Fireside
    L('s-fire', 'Yule fire', 3, dk('fire', '#d42a00', '#ffcc33'), { top: 'follow' }),
    L('x-yulelog', 'Yule log', 3, dk('fire', '#c41a00', '#ffb000', 0.75), { top: 'follow' }),
    L('x-candlelight', 'Candlelight', 3, dk('twinkle', '#4a1e00', '#ffb347', 0.5), { top: 'ripple' }),
    L('x-fireplace', 'Fireplace glow', 3, dk('breathe', '#3a0a00', '#ff6a00', 0.7), { top: 'ripple' }),
    L('x-embers', 'Embers', 3, dk('sparkle', '#3a0800', '#ff6a1a')),
    L('x-chestnuts', 'Chestnuts roasting', 3, dk('plasma', '#5a1a00', '#ffaa33', 0.6), { top: 'follow' }),
    L('x-hearth', 'Hearth and home', 3, dk('glow', '#7a3a00', '#ffd9a0', 0.5), { B: dk('twinkle', '#7a3a00', '#ffd9a0'), auto: 16 }),
    // Santa's workshop
    L('x-santasuit', 'Santa suit', 4, dk('rise', '#e0101e', '#ffffff', 0.75), { tc: ['#e0101e', '#ffffff'] }),
    L('x-elfchase', 'Elf chase', 4, dk('chase', '#13a538', '#e0101e', 1.5)),
    L('x-reindeer', 'Reindeer run', 4, dk('comet', '#3a1e08', '#ffcc66', 1.5), { tc: GOLD }),
    L('x-rednose', 'Red nose glow', 4, dk('pulse', '#2a0000', '#ff1010'), { top: 'ripple', bpm: 90 }),
    L('x-sleigh', 'Sleigh ride', 4, dk('meteor', '#0a1a5c', '#ffd200', 1.25), { tc: GOLD }),
    L('x-presents', 'Wrapped presents', 4, dk('gift', '#d4141e', '#f2a900')),
    L('x-giftwrap', 'Green gift wrap', 4, dk('gift', '#13a538', '#e0101e'), { tc: ['#13a538', '#e0101e'] }),
    L('x-toyfactory', 'Toy factory', 4, dk('confetti', '#1a1a2a', '#ffffff'), { top: 'ripple' }),
    L('x-northpole', 'North Pole stripes', 4, dk('spin', '#e0101e', '#ffffff', 2), { tc: ['#e0101e', '#ffffff'] }),
    L('x-naughtynice', 'Naughty or nice', 4, dk('wipe', '#e0101e', '#13a538')),
    // Holy night
    L('x-silentnight', 'Silent night', 5, dk('breathe', '#050a2a', '#1f3a8a', 0.4), { tc: GOLD }),
    L('x-bethlehem', 'Star of Bethlehem', 5, dk('twinkle', '#050a2a', '#cfd8ff', 0.6), { tc: GOLD }),
    L('x-angels', 'Angels', 5, dk('glow', '#d9c08a', '#ffffff', 0.4), { tc: GOLD }),
    L('x-holynight', 'O holy night', 5, dk('aurora', '#0a1a5c', '#f2c14e', 0.6), { tc: GOLD }),
    L('x-peace', 'Peace on earth', 5, dk('breathe', '#0a2a5c', '#e8f4ff', 0.5), { top: 'ripple', tc: ['#0a2a5c', '#ffffff'] }),
    L('x-midnightmass', 'Midnight candles', 5, dk('twinkle', '#2a0a3a', '#ffd9a0', 0.5), { tc: GOLD }),
    L('x-joyworld', 'Joy to the world', 5, dk('rise', '#f2a900', '#ffffff', 0.5), { tc: GOLD }),
    // Messages
    L('x-msg-merry', 'Merry Christmas', 6, dk('text', '#0a3a14', '#ff2a2a', 1, 'MERRY CHRISTMAS'), { B: dk('sparkle', '#0a3a14', '#ffffff'), tc: GOLD }),
    L('x-msg-hohoho', 'Ho ho ho', 6, dk('text', '#2a0000', '#ffffff', 1, 'HO HO HO'), { tc: ['#e0101e', '#ffffff'] }),
    L('x-msg-joy', 'Joy', 6, dk('text', '#0a2a14', '#f2c14e', 0.7, 'JOY JOY JOY'), { tc: GOLD }),
    L('x-msg-noel', 'Noel', 6, dk('text', '#0a1a5c', '#ffffff', 0.7, 'NOEL'), { tc: GOLD }),
    L('x-msg-peace', 'Peace', 6, dk('text', '#050a2a', '#9fe8ff', 0.7, 'PEACE'), { top: 'flake' }),
    L('x-msg-snow', 'Let it snow', 6, dk('text', '#0a1a5c', '#e8f4ff', 1, 'LET IT SNOW'), { top: 'flake' }),
    L('x-msg-believe', 'Believe', 6, dk('text', '#3a0020', '#ffd200', 0.8, 'BELIEVE'), { tc: GOLD }),
    L('x-msg-greetings', "Season's greetings", 6, dk('text', '#0a3a14', '#ffd9a0', 1, "SEASON'S GREETINGS"), { tc: GOLD }),
    L('x-msg-holidays', 'Happy holidays', 6, dk('text', '#2a0a3a', '#ff8ad8', 1, 'HAPPY HOLIDAYS'), { top: 'ripple' }),
    L('x-msg-feliz', 'Feliz Navidad', 6, dk('text', '#3a0a00', '#13d14e', 1, 'FELIZ NAVIDAD'), { tc: ['#e0101e', '#13d14e'] }),
    L('x-msg-naughty', 'Naughty or nice?', 6, dk('text', '#2a0000', '#13d14e', 1, 'NAUGHTY OR NICE?'), { tc: ['#e0101e', '#13d14e'] }),
    L('x-msg-love', 'Love and joy', 6, dk('text', '#2a0010', '#ff4060', 0.8, 'LOVE < JOY <'), { top: 'ripple', tc: ['#2a0010', '#ff4060'] }),
    L('x-msg-santa', 'Santa stop here', 6, dk('text', '#0a1a5c', '#ffffff', 1, 'SANTA STOP HERE!'), { tc: ['#e0101e', '#ffffff'] }),
    // Party lights
    L('s-rainbow', 'Rainbow comet', 7, dk('rainbow', '#000000', '#ffffff'), { B: dk('comet', '#5a2bb8', '#9fe8ff', 1.25), auto: 8, top: 'follow' }),
    L('x-rainbowspiral', 'Rainbow spiral', 7, dk('rainbow', '#000000', '#ffffff', 1.5), { top: 'follow' }),
    L('x-confetti', 'Confetti', 7, dk('confetti', '#101018', '#ffffff', 1.5), { top: 'ripple', tc: ['#101018', '#ffffff'] }),
    L('x-sweater', 'Ugly sweater', 7, dk('chase', '#13a538', '#e0101e', 1.5), { B: dk('candy', '#e0101e', '#ffffff', 1.5), auto: 8 }),
    L('x-disco', 'Christmas disco', 7, dk('radar', '#13a538', '#e0101e', 1.5), { B: dk('rainbow', '#000000', '#ffffff', 2), auto: 8, bpm: 128, top: 'ripple' }),
    L('x-bellrock', 'Jingle bell rock', 7, dk('pulse', '#13a538', '#f2a900'), { B: dk('chase', '#e0101e', '#f2a900', 2), auto: 8, bpm: 128, top: 'ripple' }),
    L('x-wipeshow', 'Color wipe', 7, dk('wipe', '#e0101e', '#13a538', 1.5), { B: dk('wipe', '#1f5fd6', '#f2a900', 1.5), auto: 16 }),
    L('x-plasmaparty', 'Plasma party', 7, dk('plasma', '#5a2bb8', '#13d1ff', 1.2), { top: 'follow' }),
    // New Year's Eve
    L('x-msg-newyear', 'Happy New Year', 8, dk('text', '#1a1400', '#ffd200', 1, 'HAPPY NEW YEAR!'), { B: dk('fireworks', '#000000', '#ffd200'), tc: GOLD }),
    L('x-fireworks', 'Fireworks', 8, dk('fireworks', '#000000', '#ffd200'), { top: 'ripple', tc: ['#000000', '#ffd200'] }),
    L('x-champagne', 'Champagne bubbles', 8, dk('sparkle', '#3a2a0a', '#ffe9a8', 1.3), { B: dk('rise', '#3a2a0a', '#ffe9a8'), auto: 16, tc: GOLD }),
    L('x-countdown', 'Countdown pulse', 8, dk('pulse', '#1a1a1a', '#ffd200'), { bpm: 60, top: 'ripple', tc: ['#1a1a1a', '#ffd200'] }),
    L('x-goldsilver', 'Gold and silver', 8, dk('twinkle', '#3a4048', '#f2c14e'), { B: dk('sparkle', '#3a4048', '#e6eef7'), auto: 8, tc: GOLD }),
    L('x-midnightdisco', 'Midnight disco', 8, dk('rainbow', '#000000', '#ffffff', 2), { B: dk('confetti', '#000000', '#ffffff', 2), auto: 8, bpm: 128, top: 'ripple', tc: ['#000000', '#ffffff'] }),
    // Team colors
    L('s-bluegold', 'Blue and gold spin', 9, dk('spin', '#2d68c4', '#f2a900')),
    L('s-cardinal', 'Cardinal rise', 9, dk('rise', '#c8102e', '#ffc72c')),
    L('x-bluegold-snow', 'Blue and gold snowfall', 9, dk('snow', '#2d68c4', '#f2a900'), { tc: ['#2d68c4', '#f2a900'] }),
    L('x-cardinal-fire', 'Cardinal and gold fire', 9, dk('fire', '#c8102e', '#ffc72c'), { tc: ['#c8102e', '#ffc72c'] }),
    // USC: cardinal #990000 and gold #ffcc00. UCLA: blue #2774ae and gold #ffd100. Team colors and words only, no logos.
    // Every team design shows BOTH colors strongly (v: 2): text has team stripes/spin/pulse below it, and effects use
    // Classic colors off with both team colors, so they blend between them instead of one color on a dim background.
    L('x-usc-fighton', 'USC Fight On', 9, tx('FIGHT ON', '#990000', '#ffcc00', 'candy'), { B: dk('spin', '#990000', '#ffcc00'), auto: 16, tc: ['#990000', '#ffcc00'], strict: 1, v: 3 }),
    L('x-usc-trojans', 'USC Trojans', 9, tx('TROJANS', '#990000', '#ffcc00', 'spin'), { tc: ['#990000', '#ffcc00'], strict: 1, v: 3 }),
    L('x-usc-pulse', 'USC heartbeat', 9, dk('pulse', '#990000', '#ffcc00'), { B: dk('pulse', '#ffcc00', '#990000'), auto: 8, bpm: 100, tc: ['#990000', '#ffcc00'], strict: 1, v: 3 }),
    L('x-usc-stripes', 'USC stripes', 9, dk('candy', '#990000', '#ffcc00', 0.8), { tc: ['#990000', '#ffcc00'], strict: 1, v: 3 }),
    L('x-usc-helix', 'USC color wheel', 9, tdk('rainbow', '#990000', '#ffcc00'), { tc: ['#990000', '#ffcc00'], strict: 1, v: 3 }),
    L('x-usc-marquee', 'USC bulbs', 9, tdk('bulbs', '#990000', '#ffcc00', 0.6), { tc: ['#990000', '#ffcc00'], strict: 1, v: 3 }),
    L('x-usc-rockets', 'USC rockets', 9, tdk('rockets', '#990000', '#ffcc00'), { tc: ['#990000', '#ffcc00'], strict: 1, v: 3 }),
    L('x-usc-octopus', 'USC octopus', 9, tdk('octopus', '#990000', '#ffcc00'), { tc: ['#990000', '#ffcc00'], strict: 1, v: 3 }),
    L('x-usc-football', 'USC football', 9, tgdk('football', '#990000', '#ffcc00'), { B: dk('candy', '#990000', '#ffcc00', 0.8), auto: 16, tc: ['#990000', '#ffcc00'], strict: 1, v: 3 }),
    L('x-ucla-gobruins', 'UCLA Go Bruins', 9, tx('GO BRUINS', '#2774ae', '#ffd100', 'candy'), { B: dk('spin', '#2774ae', '#ffd100'), auto: 16, tc: ['#2774ae', '#ffd100'], strict: 1, v: 3 }),
    L('x-ucla-bruins', 'UCLA Bruins', 9, tx('BRUINS', '#2774ae', '#ffd100', 'spin'), { tc: ['#2774ae', '#ffd100'], strict: 1, v: 3 }),
    L('x-ucla-8clap', 'UCLA 8 clap', 9, tx('8 CLAP', '#2774ae', '#ffd100', 'spin', 1), { B: dk('pulse', '#ffd100', '#2774ae'), auto: 8, bpm: 128, tc: ['#2774ae', '#ffd100'], strict: 1, v: 3 }),
    L('x-ucla-stripes', 'UCLA stripes', 9, dk('candy', '#2774ae', '#ffd100', 0.8), { tc: ['#2774ae', '#ffd100'], strict: 1, v: 3 }),
    L('x-ucla-waves', 'UCLA waves', 9, dk('pacifica', '#ffd100', '#2774ae', 0.9), { B: dk('pacifica', '#2774ae', '#ffd100', 0.9), auto: 16, tc: ['#2774ae', '#ffd100'], strict: 1, v: 3 }),
    L('x-ucla-swirl', 'UCLA swirl', 9, tdk('swirl', '#ffd100', '#2774ae'), { tc: ['#2774ae', '#ffd100'], strict: 1, v: 3 }),
    L('x-ucla-twinkle', 'UCLA bulbs', 9, tdk('bulbs', '#2774ae', '#ffd100', 0.6), { tc: ['#2774ae', '#ffd100'], strict: 1, v: 3 }),
    L('x-ucla-starburst', 'UCLA starburst', 9, tdk('starburst', '#2774ae', '#ffd100'), { tc: ['#2774ae', '#ffd100'], strict: 1, v: 3 }),
    L('x-ucla-football', 'UCLA football', 9, tgdk('football', '#2774ae', '#ffd100'), { B: dk('candy', '#2774ae', '#ffd100', 0.8), auto: 16, tc: ['#2774ae', '#ffd100'], strict: 1, v: 3 }),
    L('x-crosstown', 'Crosstown rivalry', 9, dk('spin', '#990000', '#ffcc00'), { B: dk('spin', '#2774ae', '#ffd100'), auto: 8, tc: ['#ffcc00', '#ffd100'], strict: 1, v: 3 }),
    L('x-gameday-parade', 'Game day parade', 9, dk('parade', '#000000', '#ffd100', 1), { top: 'follow', A0g: 'gameday' }),
    // Christmas effects (14)
    L('x-cx-twinkle', 'Twinkle lights', 14, dk('twinklelights', '#001a08', '#ffffff'), { top: 'star', tc: GOLD }),
    L('x-cx-string', 'String of lights', 14, dk('stringlights', '#021a08', '#ffffff'), { tc: GOLD }),
    L('x-cx-drop', 'Ornament drop', 14, dk('ornamentdrop', '#02140a', '#ffffff'), { tc: GOLD }),
    L('x-cx-sleigh', "Santa's sleigh", 14, dk('sleigh', '#020818', '#ffd200'), { top: 'star', tc: ['#020818', '#ffd200'] }),
    L('x-cx-stars', 'Shooting stars', 14, dk('shootingstars', '#020818', '#ffe9a0'), { top: 'star', tc: ['#020818', '#fff3c0'] }),
    L('x-cx-snowglobe', 'Snow globe swirl', 14, dk('snowswirl', '#06183a', '#ffffff'), { top: 'flake', tc: ['#06183a', '#ffffff'] }),
    L('x-cx-tinsel', 'Tinsel shimmer', 14, dk('tinsel', '#3a2a00', '#ffffff'), { tc: GOLD }),
    L('x-cx-ribbon', 'Ribbon wrap', 14, dk('ribbonwrap', '#0a5a1a', '#d0102a'), { tc: GOLD }),
    L('x-cx-candyribbon', 'Candy cane ribbon', 14, dk('ribbonwrap', '#ffffff', '#d0102a'), { tc: ['#d0102a', '#ffffff'] }),
    L('x-cx-eve', 'Christmas Eve sky', 14, dk('shootingstars', '#020818', '#ffe9a0'), { B: dk('sleigh', '#020818', '#ffd200'), auto: 16, top: 'star', tc: ['#020818', '#ffd200'] }),
    L('x-cx-dropsparkle', 'Ornaments and lights', 14, dk('ornamentdrop', '#02140a', '#ffffff'), { B: dk('twinklelights', '#001a08', '#ffffff'), auto: 16, tc: GOLD }),
    L('x-cx-wrapped', 'Wrapped in lights', 14, dk('stringlights', '#0a3a14', '#ffffff'), { B: dk('ribbonwrap', '#0a5a1a', '#d0102a'), auto: 16, tc: GOLD }),
    L('x-fx-soap', 'Soap bubbles', 10, dk('soap', '#1a3a8a', '#ff4fa0', 0.8), { top: 'follow' }),
    L('x-fx-soap-xmas', 'Christmas soap', 10, dk('soap', '#0a6a2a', '#d0102a', 0.7), { tc: GOLD }),
    L('x-fx-rockets', 'Rockets', 10, dk('rockets', '#000000', '#ffd200'), { top: 'ripple', tc: ['#000000', '#ffd200'] }),
    L('x-fx-starburst', 'Starburst', 10, dk('starburst', '#000000', '#ffffff'), { top: 'ripple', tc: ['#000000', '#ffffff'] }),
    L('x-fx-pacifica', 'Pacifica', 10, dk('pacifica', '#001a40', '#18c8d8', 0.8), { top: 'follow' }),
    L('x-fx-matrix', 'Digital rain', 10, dk('matrix', '#000000', '#20ff40'), { top: 'follow' }),
    L('x-fx-candycane-dna', 'Candy cane DNA', 10, dk('dna', '#000000', '#e0102a'), { tc: ['#3a0008', '#ffffff'] }),
    L('x-fx-rain', 'Winter rain', 10, dk('rain', '#020a20', '#9fe8ff', 0.8), { top: 'ripple', tc: ['#020a20', '#9fe8ff'] }),
    L('x-fx-lightning', 'Lightning storm', 10, dk('lightning', '#04081a', '#c8d8ff'), { top: 'follow' }),
    L('x-fx-bounce', 'Bouncing ornaments', 10, dk('bounce', '#000000', '#ffd200'), { tc: GOLD }),
    L('x-fx-lava', 'Lava lamp', 10, dk('lava', '#3a0010', '#ff6a00', 0.7), { top: 'follow' }),
    L('x-fx-octopus', 'Octopus', 10, dk('octopus', '#000000', '#ff2a8a'), { top: 'follow' }),
    L('x-fx-pride', 'Pride', 10, dk('pride', '#000000', '#ffffff'), { top: 'follow' }),
    L('x-fx-juggle', 'Juggle', 10, dk('juggle', '#000000', '#ffd200'), { top: 'ripple', tc: ['#000000', '#ffd200'] }),
    L('x-fx-blackhole', 'Black hole', 10, dk('blackhole', '#000000', '#8a4fff'), { top: 'follow' }),
    L('x-fx-swirl', 'Swirl', 10, dk('swirl', '#000000', '#18c8d8'), { top: 'follow' }),
    L('x-fx-waverly', 'Waverly', 10, dk('waverly', '#000000', '#20ff60'), { top: 'follow' }),
    L('x-fx-popcorn', 'Popcorn', 10, dk('popcorn', '#000000', '#fff3c0'), { tc: GOLD }),
    L('x-fx-bees', 'Crazy bees', 10, dk('bees', '#001a05', '#ffd200'), { tc: GOLD }),
    L('x-fx-hiphotic', 'Hiphotic', 10, dk('hiphotic', '#000000', '#ff6a00'), { top: 'follow' }),
    L('x-fx-driftrose', 'Drift rose', 10, dk('driftrose', '#000000', '#ff2a4a'), { top: 'follow' }),
    L('x-fx-xmas-octopus', 'Christmas octopus', 10, dk('octopus', '#000000', '#d0102a'), { B: dk('octopus', '#000000', '#0a8a2a'), auto: 16, tc: GOLD }),
    // Thanksgiving (11)
    L('x-tg-leaves', 'Falling leaves', 11, dk('leaves', '#1a0800', '#ff7a00'), { top: 'follow' }),
    L('x-tg-wind', 'Autumn wind', 11, dk('wind', '#120600', '#ffb000'), { top: 'follow' }),
    L('x-tg-moon', 'Harvest moon', 11, dk('harvestmoon', '#02040c', '#ff9a2a', 0.8), { top: 'follow' }),
    L('x-tg-strut', 'Turkey strut', 11, dk('turkeytail', '#000000', '#c0501a'), { tc: ['#3a1a00', '#ff9a2a'] }),
    L('x-tg-thanks', 'Give thanks', 11, dk('text', '#1a0800', '#ffb000', 0.8, 'GIVE THANKS'), { B: dk('leaves', '#1a0800', '#ff7a00'), auto: 16, tc: ['#3a1a00', '#ff9a2a'] }),
    L('x-tg-happy', 'Happy Thanksgiving', 11, dk('text', '#140600', '#ff7a00', 0.9, 'HAPPY THANKSGIVING'), { tc: ['#3a1a00', '#ff9a2a'] }),
    L('x-tg-gobble', 'Gobble gobble', 11, dk('text', '#000000', '#e05a1a', 1, 'GOBBLE GOBBLE'), { B: dk('turkeytail', '#000000', '#c0501a'), auto: 16, tc: ['#3a1a00', '#ff9a2a'] }),
    L('x-tg-turkey', 'Turkey and leaves', 11, gdk('turkey', '#0a0400'), { B: dk('leaves', '#1a0800', '#ff7a00'), auto: 16, tc: ['#3a1a00', '#ff9a2a'] }),
    L('x-tg-pumpkin', 'Retro pumpkin', 11, gdk('pumpkin', '#0a0400'), { tc: ['#3a1a00', '#ff9a2a'] }),
    L('x-tg-parade', 'Harvest parade', 11, dk('parade', '#0a0400', '#ff9a2a', 1), { top: 'follow', A0g: 'fall' }),
    L('x-tg-hearth', 'Warm hearth', 11, dk('fire', '#3a0a00', '#ff7a00'), { tc: ['#3a0a00', '#ff7a00'] }),
    // Retro graphics (12)
    L('x-gfx-parade', 'Holiday parade', 12, dk('parade', '#020818', '#ffffff', 1), { top: 'follow', A0g: 'holiday' }),
    L('x-gfx-newyear', 'New Year parade', 12, dk('parade', '#05030a', '#ffd200', 1), { top: 'follow', A0g: 'newyear' }),
    L('x-gfx-slideshow', 'Retro slideshow', 12, dk('graphic', '#020818', '#ffffff'), { top: 'follow', A0g: 'everyday', v: 2 }),
    L('x-gfx-turkey', 'Retro turkey', 12, gdk('turkey', '#020818'), { top: 'follow' }),
    L('x-gfx-pumpkin', 'Retro pumpkin', 12, gdk('pumpkin', '#020818'), { top: 'follow' }),
    L('x-gfx-leaf', 'Retro maple leaf', 12, gdk('leaf', '#020818'), { top: 'follow' }),
    L('x-gfx-acorn', 'Retro acorn', 12, gdk('acorn', '#020818'), { top: 'follow' }),
    L('x-gfx-pie', 'Retro pumpkin pie', 12, gdk('pie', '#020818'), { top: 'follow' }),
    L('x-gfx-hat', 'Retro pilgrim hat', 12, gdk('hat', '#020818'), { top: 'follow' }),
    L('x-gfx-corn', 'Retro corn', 12, gdk('corn', '#020818'), { top: 'follow' }),
    L('x-gfx-heart', 'Retro heart', 12, gdk('heart', '#020818'), { top: 'follow' }),
    L('x-gfx-star', 'Retro star', 12, gdk('star', '#020818'), { top: 'follow' }),
    L('x-gfx-bell', 'Retro bell', 12, gdk('bell', '#020818'), { top: 'follow' }),
    L('x-gfx-tree', 'Retro Christmas tree', 12, gdk('tree', '#020818'), { top: 'follow' }),
    L('x-gfx-gift', 'Retro gift', 12, gdk('gift', '#020818'), { top: 'follow' }),
    L('x-gfx-snowman', 'Retro snowman', 12, gdk('snowman', '#020818'), { top: 'follow' }),
    L('x-gfx-snowflake', 'Retro snowflake', 12, gdk('snowflake', '#020818'), { top: 'follow' }),
    L('x-gfx-candycane', 'Retro candy cane', 12, gdk('candycane', '#020818'), { top: 'follow' }),
    L('x-gfx-candle', 'Retro candle', 12, gdk('candle', '#020818'), { top: 'follow' }),
    L('x-gfx-stocking', 'Retro stocking', 12, gdk('stocking', '#020818'), { top: 'follow' }),
    L('x-gfx-wreath', 'Retro wreath', 12, gdk('wreath', '#020818'), { top: 'follow' }),
    L('x-gfx-champagne', 'Retro champagne', 12, gdk('champagne', '#020818'), { top: 'follow' })
  ];
  var STARTER_PLAYLIST = ['x-c9', 'x-msg-merry', 'x-ribbons', 's-candy', 'x-icicles', 'x-garland', 'x-msg-hohoho', 'x-aurora', 'x-ornaments', 's-twinkle',
    'x-elfchase', 'x-heavysnow', 'x-msg-joy', 'x-presents', 'x-peppermint', 'x-bethlehem', 'x-reindeer', 'x-tinsel', 'x-msg-snow', 'x-yulelog'];

  function starterShows() {
    var designs = JSON.parse(JSON.stringify(LIBRARY));
    return { designs: designs, removed: [], lib: LIBRARY.length, playlist: { sec: 45, items: STARTER_PLAYLIST.map(function (id) { return { id: id }; }), mode: 'shuffle', fade: 3, randSec: 60, bright: 1, running: false } };
  }
  // Adds library designs a saved show doesn't have yet (skipping ones the user deleted) and fills in categories. Returns how many were added.
  function mergeLibrary(db) {
    db.removed = db.removed || [];
    db.designs.forEach(function (d) { if (OLD_CATS[d.cat]) d.cat = OLD_CATS[d.cat]; });
    var gone = {}; db.designs = db.designs.filter(function (d) { var r = RETIRED.indexOf(d.id) >= 0 && !d.edited; if (r) gone[d.id] = 1; return !r; });
    if (Object.keys(gone).length) [db.playlist].concat(db.playlists || []).forEach(function (pl) { if (pl && pl.items) pl.items = pl.items.filter(function (it) { return !gone[it.id]; }); });
    var have = {}, added = 0; db.designs.forEach(function (d) { have[d.id] = d; });
    LIBRARY.forEach(function (d) {
      var h = have[d.id];
      if (h) { // a newer library version replaces a copy the user hasn't edited
        if ((d.v || 1) > (h.v || 1) && !h.edited) { var i = db.designs.indexOf(h); db.designs[i] = JSON.parse(JSON.stringify(d)); added++; }
        else if (!h.edited) { if (h.cat !== d.cat || h.name !== d.name) { h.cat = d.cat; h.name = d.name; added++; } } // keep sections/names current
        else if (!h.cat) h.cat = d.cat;
        return;
      }
      if (db.removed.indexOf(d.id) >= 0) return;
      db.designs.push(JSON.parse(JSON.stringify(d))); added++;
    });
    db.designs.forEach(function (d) { if (!d.cat) d.cat = 'My designs'; });
    return added;
  }
  // Designs that belong in a different section than where they were first written.
  var MOVE = {
    'Christmas · party': ['x-sweater', 'x-disco', 'x-bellrock'],
    'Christmas · effects': ['x-fx-soap-xmas', 'x-fx-xmas-octopus', 'x-fx-bounce'],
    'Christmas · candy and sweets': ['x-fx-candycane-dna'],
    'Winter · snow and ice': ['x-fx-rain', 'x-gfx-snowman', 'x-gfx-snowflake'],
    'Thanksgiving and fall': ['x-gfx-turkey', 'x-gfx-leaf', 'x-gfx-acorn', 'x-gfx-pie', 'x-gfx-hat', 'x-gfx-corn'],
    "New Year's": ['x-gfx-newyear', 'x-gfx-champagne'],
    'Party and everyday': ['x-gfx-heart', 'x-gfx-slideshow']
  };
  Object.keys(MOVE).forEach(function (cat) { MOVE[cat].forEach(function (id) { var d = LIBRARY.find(function (x) { return x.id === id; }); if (d) d.cat = cat; }); });
  var RETIRED = ['x-gfx-pumpkin', 'x-fx-lightning']; // duplicate pumpkin; Lightning storm (strobe-like flashing)
  LIBRARY = LIBRARY.filter(function (d) { return RETIRED.indexOf(d.id) < 0; });
  // Ready-made playlists, added to a show once (deleting one keeps it deleted).
  var LIBRARY_PLAYLISTS = [
    { id: 'pl-gameday', name: 'Game day: USC and UCLA', mode: 'shuffle', fade: 2, randSec: 60,
      ids: ['x-usc-fighton', 'x-usc-trojans', 'x-usc-stripes', 'x-usc-helix', 'x-usc-marquee', 'x-usc-rockets', 'x-usc-octopus', 'x-usc-pulse', 'x-usc-football',
        'x-ucla-gobruins', 'x-ucla-bruins', 'x-ucla-8clap', 'x-ucla-stripes', 'x-ucla-waves', 'x-ucla-swirl', 'x-ucla-starburst', 'x-ucla-twinkle', 'x-ucla-football',
        'x-crosstown', 'x-gameday-parade', 's-bluegold', 's-cardinal'] },
    { id: 'pl-thanksgiving', name: 'Leading up to Thanksgiving', mode: 'shuffle', fade: 3, randSec: 60,
      ids: ['x-tg-leaves', 'x-tg-wind', 'x-tg-moon', 'x-tg-strut', 'x-tg-thanks', 'x-tg-happy', 'x-tg-gobble', 'x-tg-turkey', 'x-tg-pumpkin', 'x-tg-parade', 'x-tg-hearth', 'x-gfx-leaf', 'x-gfx-corn', 'x-gfx-pie'] },
    { id: 'pl-newyear', name: "After Christmas: New Year's", mode: 'shuffle', fade: 3, randSec: 60,
      ids: ['x-msg-newyear', 'x-fireworks', 'x-champagne', 'x-countdown', 'x-goldsilver', 'x-midnightdisco', 'x-fx-rockets', 'x-fx-starburst', 'x-gfx-newyear', 'x-gfx-champagne', 'x-wonderland', 'x-frost', 'x-polar', 'x-msg-snow'] }
  ];
  var CHRISTMAS_PLAYLIST = ['x-c9', 'x-redgreen-spin', 'x-ribbons', 's-xmas', 'x-garland', 'x-ornaments', 's-twinkle', 'x-holly', 'x-tinsel', 'x-oldfashioned',
    's-candy', 'x-peppermint', 'x-gingerbread', 'x-santasuit', 'x-reindeer', 'x-sleigh', 'x-presents', 'x-silentnight', 'x-bethlehem',
    'x-msg-merry', 'x-msg-hohoho', 'x-msg-joy', 'x-msg-believe', 'x-msg-feliz', 'x-bellrock', 'x-sweater',
    'x-fx-bounce', 'x-fx-soap-xmas', 'x-fx-xmas-octopus', 'x-gfx-parade', 'x-gfx-tree', 'x-wonderland',
    'x-cx-twinkle', 'x-cx-string', 'x-cx-drop', 'x-cx-sleigh', 'x-cx-stars', 'x-cx-snowglobe', 'x-cx-tinsel', 'x-cx-ribbon', 'x-cx-candyribbon', 'x-cx-eve', 'x-cx-dropsparkle', 'x-cx-wrapped'];
  function mergePlaylists(db) {
    db.removedPlaylists = db.removedPlaylists || []; var added = 0, have = {}; db.designs.forEach(function (d) { have[d.id] = 1; });
    db.plOffered = db.plOffered || {};
    LIBRARY_PLAYLISTS.forEach(function (lp) {
      var ex = db.playlists.find(function (x) { return x.id === lp.id; });
      if (ex) { // new designs added to a library playlist show up in your copy once (removing them later sticks)
        var off = db.plOffered[lp.id] || (db.plOffered[lp.id] = ex.items.map(function (it) { return it.id; }).concat(lp.ids.filter(function (id) { return ex.items.some(function (it) { return it.id === id; }); })));
        lp.ids.forEach(function (id) { if (off.indexOf(id) < 0 && have[id]) { ex.items.push({ id: id }); off.push(id); added++; } });
        return;
      }
      if (db.removedPlaylists.indexOf(lp.id) >= 0) return;
      db.plOffered[lp.id] = lp.ids.slice();
      db.playlists.push({ id: lp.id, name: lp.name, mode: lp.mode, fade: lp.fade, randSec: lp.randSec, sec: 45, items: lp.ids.filter(function (id) { return have[id]; }).map(function (id) { return { id: id }; }) }); added++;
    });
    return added;
  }
  function isLibraryPlaylist(id) { return LIBRARY_PLAYLISTS.some(function (x) { return x.id === id; }); }
  function isLibraryId(id) { return LIBRARY.some(function (d) { return d.id === id; }); }

  return { N: N, NR: NR, NT: NT, WN: WN, TOP_START: TOP_START, CONFIG: CFG, DEFAULT_CONFIG: DEFAULT_CONFIG, cleanConfig: cleanConfig, PX: PX, TOPPX: TOPPX, RIBS: RIBS, TOPW: TOPW, PATS: PATS, PALETTES: PALETTES, hex: hex, render: render, newRun: newRun, defaultLook: defaultLook,
    randomLook: randomLook, toWled: toWled, toBytes: toBytes, WIDX: WIDX, b64enc: b64enc, b64dec: b64dec, imgOf: imgOf, Player: Player, starterShows: starterShows, starPts: starPts, LIBRARY: LIBRARY, CAT_ORDER: CAT_ORDER, CHRISTMAS_PLAYLIST: CHRISTMAS_PLAYLIST, LIBRARY_PLAYLISTS: LIBRARY_PLAYLISTS, mergePlaylists: mergePlaylists, isLibraryPlaylist: isLibraryPlaylist, GFX: GFX, GSETS: GSETS, CATS: CAT_ORDER, mergeLibrary: mergeLibrary, isLibraryId: isLibraryId };
});
