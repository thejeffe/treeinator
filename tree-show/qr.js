'use strict';
// A small QR code maker (byte mode, error correction H, versions 1-10: up to 119 bytes, plenty for a web address).
// Level H recovers 30% damage, so a logo can sit in the middle. Follows ISO/IEC 18004; the structure follows Project
// Nayuki's well-known reference implementation (written fresh here, no outside code).
//   make(text) -> { size, dark(x, y) }   (x = column, y = row; no quiet zone)

// codewords at level H: [error correction per block, [blocks, data codewords each], ...]
const BLOCKS_H = [null,
  [17, [1, 9]], [28, [1, 16]], [22, [2, 13]], [16, [4, 9]], [22, [2, 11], [2, 12]],
  [28, [4, 15]], [26, [4, 13], [1, 14]], [26, [4, 14], [2, 15]], [24, [4, 12], [4, 13]], [28, [6, 15], [2, 16]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 255; }
function rsDivisor(n) {
  const r = new Array(n).fill(0); r[n - 1] = 1; let root = 1;
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { r[j] = gfMul(r[j], root); if (j + 1 < n) r[j] ^= r[j + 1]; } root = gfMul(root, 2); }
  return r;
}
function rsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
  return r;
}

function make(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  let ver = 0, dataCw = 0;
  for (let v = 1; v <= 10; v++) {
    const b = BLOCKS_H[v], n = b.slice(1).reduce((s, g) => s + g[0] * g[1], 0), cc = v < 10 ? 8 : 16;
    if (4 + cc + bytes.length * 8 <= n * 8) { ver = v; dataCw = n; break; }
  }
  if (!ver) throw new Error('Too long for a QR code here (keep the address under 119 characters).');
  // the bit stream: byte mode, length, data, terminator, padding
  const bits = [], put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataCw * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0xec; data.length < dataCw; p ^= 0xec ^ 0x11) data.push(p);
  // split into blocks, add error correction, interleave
  const spec = BLOCKS_H[ver], ecLen = spec[0], div = rsDivisor(ecLen), blocks = [];
  let k = 0;
  for (const [count, len] of spec.slice(1)) for (let i = 0; i < count; i++) { const d = data.slice(k, k + len); k += len; blocks.push({ d, e: rsRemainder(d, div) }); }
  const out = [], maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);

  // the grid: function patterns first
  const size = ver * 4 + 17, mod = [], fn = [];
  for (let y = 0; y < size; y++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
  const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }                 // timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])                                         // finders
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  const al = ALIGN[ver], last = al.length - 1;                                                         // alignment
  al.forEach((a, i) => al.forEach((b, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = (mask) => {
    const d = (2 << 3) | mask; let r = d;                       // level H = 2
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const f = ((d << 10) | r) ^ 0x5412, bit = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);                                     // the dark module
  };
  format(0);
  if (ver >= 7) {                                                                                      // version info
    let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const v = (ver << 12) | r;
    for (let i = 0; i < 18; i++) { const b = ((v >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, b); set(c, a, b); }
  }
  // the data, zigzag up and down two columns at a time
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && i < out.length * 8) { mod[y][x] = ((out[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  // the mask that reads best (lowest penalty)
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
  const apply = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    apply(m); format(m);
    const s = penalty(mod, size);
    if (s < bestScore) { bestScore = s; best = m; }
    apply(m);                                                   // undo (XOR twice)
  }
  apply(best); format(best);
  return { size, version: ver, dark: (x, y) => mod[y][x] };
}

function penalty(mod, n) {
  let p = 0, dark = 0;
  const lines = [];
  for (let y = 0; y < n; y++) lines.push(mod[y].map((d) => (d ? 1 : 0)).join(''));
  for (let x = 0; x < n; x++) { let c = ''; for (let y = 0; y < n; y++) c += mod[y][x] ? 1 : 0; lines.push(c); }
  for (const l of lines) {
    for (const run of l.match(/0{5,}|1{5,}/g) || []) p += 3 + run.length - 5;             // long runs
    p += 40 * ((l.match(/(?=(00001011101|10111010000))/g) || []).length);               // finder look-alikes
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; // 2x2 blocks
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (mod[y][x]) dark++;
  p += 10 * Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5);
  return p;
}

module.exports = { make };
