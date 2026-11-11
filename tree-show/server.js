'use strict';
/* tree-show: stores designs and playlists, plays them to WLED over DDP, and relays live frames from the mixer page.
 *
 *  browser (mixer page) --HTTP/WebSocket--> tree-show --DDP/UDP 4048--> WLED (ESP32)
 *
 * The playlist runs here, so the tree keeps going with no phone or browser open.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const dns = require('dns');
const { WebSocketServer } = require('ws');

const CFG = {
  wledHost: process.env.WLED_HOST || 'wled.local',
  wledPort: +(process.env.WLED_DDP_PORT || 4048),
  httpPort: +(process.env.HTTP_PORT || 8080),
  fps: +(process.env.FPS || 40),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
};

// ---------- settings (edited on the web page; env values are only the starting defaults) ----------
// DATA_DIR/settings.json = { wledHost, wledPort, ribs, rows, arc, topStart }. Layout changes need a restart, since the
// engine builds its pixel map once at load; the service exits and systemd (Restart=always) starts it again.
const SETTINGS_FILE = path.join(CFG.dataDir, 'settings.json');
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const LAYOUT_KEYS = ['ribs', 'rows', 'arc', 'topStart', 'map', 'flip', 'gamma', 'deskew', 'textTop', 'textSize', 'textWidth', 'topper'];
let settings = {};
let ha = null;
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT') console.log('Could not read', SETTINGS_FILE, '-', e.message); }
if (typeof settings.wledHost === 'string' && HOST_RE.test(settings.wledHost)) CFG.wledHost = settings.wledHost;
if (Number.isInteger(settings.wledPort) && settings.wledPort > 0 && settings.wledPort < 65536) CFG.wledPort = settings.wledPort;
global.TREE_CONFIG = settings;
const E = require('./public/engine.js');
const D = require('./dither.js');     // accurate colors when the tree is dim (Settings -> Colors when dim)
const ditherer = D.create(E);
const H = require('./ha.js');      // Home Assistant over MQTT (Settings -> Home Assistant)
const LAYOUT = E.CONFIG; // what the engine actually uses after validation
function currentSettings() { const fc = fpsCfg(); return Object.assign({ wledHost: CFG.wledHost, wledPort: CFG.wledPort, wledPower: settings.wledPower !== false, wledBlank: !!settings.wledBlank, dither: D.clean(settings.dither), fpsAuto: fc.auto, fpsMax: fc.max, mqtt: H.publicCfg(settings.mqtt) }, LAYOUT); }
function cleanSettings(b) {
  const out = {};
  const host = String(b.wledHost == null ? CFG.wledHost : b.wledHost).trim();
  if (!HOST_RE.test(host)) throw new Error('WLED host should be a hostname or IP address, like 3.led.example.com or 192.168.1.50.');
  out.wledHost = host;
  const port = Math.round(+(b.wledPort == null ? CFG.wledPort : b.wledPort));
  if (!(port > 0 && port < 65536)) throw new Error('DDP port should be between 1 and 65535 (WLED uses 4048).');
  out.wledPort = port;
  const want = { ribs: [1, 64, 'Ribs'], rows: [2, 300, 'Pixels per rib'], arc: [10, 360, 'Arc'], topStart: [0, 6000, 'Topper start'], deskew: [0, 100, 'Text deskew'] };
  for (const k of ['ribs', 'rows', 'arc', 'topStart', 'deskew']) {
    const v = Math.round(+(b[k] == null ? LAYOUT[k] : b[k])); const [lo, hi, name] = want[k];
    if (!(v >= lo && v <= hi)) throw new Error(`${name} should be between ${lo} and ${hi}.`);
    out[k] = v;
  }
  const map = b.map == null ? LAYOUT.map : b.map;
  if (map !== 'strip' && map !== 'matrix') throw new Error('WLED mapping should be strip or matrix.');
  out.map = map; out.flip = b.flip == null ? LAYOUT.flip : b.flip === true;
  const gamma = Math.round(+(b.gamma == null ? LAYOUT.gamma : b.gamma) * 10) / 10;
  if (!(gamma >= 1 && gamma <= 3)) throw new Error('Gamma should be between 1.0 (none) and 3.0.');
  out.gamma = gamma;
  out.topper = b.topper == null ? LAYOUT.topper : b.topper === true;
  out.wledPower = b.wledPower == null ? settings.wledPower !== false : b.wledPower === true;
  out.wledBlank = !!settings.wledBlank;
  out.dither = D.clean(b.dither == null ? settings.dither : b.dither);
  out.fpsAuto = b.fpsAuto == null ? settings.fpsAuto !== false : b.fpsAuto === true;
  const fmax = Math.round(+(b.fpsMax == null ? fpsCfg().max : b.fpsMax));
  if (!(fmax >= 5 && fmax <= 120)) throw new Error('Frames per second should be between 5 and 120.');
  out.fpsMax = fmax;
  out.mqtt = H.clean(b.mqtt, settings.mqtt);
  const dec = { textTop: [0, 299, 'Text position', 1], textSize: [1, 8, 'Text height', 0.1], textWidth: [0.5, 4, 'Text width', 0.1] };
  for (const k in dec) {
    const [lo, hi, name, step] = dec[k]; const v = Math.round(+(b[k] == null ? LAYOUT[k] : b[k]) / step) * step;
    if (!(v >= lo && v <= hi)) throw new Error(`${name} should be between ${lo} and ${hi}.`);
    out[k] = Math.round(v * 10) / 10;
  }
  if (out.textTop >= out.rows) throw new Error(`Text position should be less than ${out.rows} (pixels per rib).`);
  if (out.topStart < out.ribs * out.rows) throw new Error(`Topper start must be ${out.ribs * out.rows} or more, after the tree's ${out.ribs} x ${out.rows} = ${out.ribs * out.rows} pixels.`);
  return out;
}
const PUBLIC = path.join(__dirname, 'public');
// Build id: changes whenever the installed code changes, so the page (and the iPad home-screen app) can tell it's out of date.
const BUILD = (() => { const h = require('crypto').createHash('sha1');
  for (const f of ['server.js', 'dither.js', 'ha.js', 'public/index.html', 'public/engine.js']) { try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (_) {} }
  return h.digest('hex').slice(0, 10); })();
// Home-screen app: manifest + Apple tags so "Add to Home Screen" on an iPad/iPhone opens tree-show full screen with its icon.
const PAGE_HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0A0E15">'
  + '<title>Treeinator</title><link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="icon-180.png">'
  + '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Treeinator"><meta name="apple-mobile-web-app-status-bar-style" content="black">'
  + '<style>body{margin:0}</style></head><body>';
const DATA_FILE = path.join(CFG.dataDir, 'shows.json');
const LIVE_HOLD_MS = 1500; // playlist pauses while live frames keep arriving

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- storage ----------
let db;
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(db.designs) || !db.playlist) throw new Error('bad file');
    const added = E.mergeLibrary(db);
    if (added) { log(`Added ${added} new library designs`); saveDb(); }
  } catch (e) {
    if (e.code !== 'ENOENT') log('Could not read', DATA_FILE, '-', e.message, '- starting with starter shows');
    db = E.starterShows();
    saveDb();
  }
}
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(CFG.dataDir, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}
const getDesign = (id) => db.designs.find((d) => d.id === id) || null;

// ---------- DDP to WLED ----------
const udp = dgram.createSocket('udp4');
let wledAddr = null, seq = 0, lastDnsErr = 0, lastSendErr = null;
function resolveWled() {
  dns.lookup(CFG.wledHost, { family: 4 }, (err, addr) => {
    if (err) { if (Date.now() - lastDnsErr > 30000) { log(`Can't resolve WLED host ${CFG.wledHost}: ${err.code}`); lastDnsErr = Date.now(); } wledAddr = null; return; }
    if (addr !== wledAddr) log(`Sending DDP to ${CFG.wledHost} (${addr}:${CFG.wledPort})`);
    wledAddr = addr;
  });
}
resolveWled(); setInterval(resolveWled, 60000);
const CHUNK = 480 * 3; // keeps each UDP packet under a 1500-byte MTU
let dimBuf = null;
// Frames to the tree. With "Colors when dim" off, brightness is applied here
// (rounding a second time); otherwise the frame was already dimmed and
// dithered in one step (dither.js) and goes out as it is.
function sendFrame(frame) {
  const dz = D.clean(settings.dither);
  if (dz.mode === 'off') return sendDDP(E.toWled(frame, 1, wledBytes));
  if (dz.mode === 'wled') return sendDDP(ditherer.plainFrame(frame), true);   // WLED does gamma + dimming
  sendDDP(ditherer.frame(frame, masterBright(), dz.mode, dz.darkest), true);
}
function sendLive(bytes) {
  const dz = D.clean(settings.dither);
  if (dz.mode === 'off') return sendDDP(bytes);
  if (dz.mode === 'wled') return sendDDP(ditherer.plainBytes(bytes), true);
  sendDDP(ditherer.bytes(bytes, masterBright(), dz.mode, dz.darkest), true);
}
function sendDDP(bytes, prepared) {
  if (!wledAddr) return;
  const mb = masterBright();
  if (mb < 1 && !prepared) { // general brightness: scales everything sent to the tree
    if (!dimBuf || dimBuf.length !== bytes.length) dimBuf = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i++) dimBuf[i] = Math.round(bytes[i] * mb);
    bytes = dimBuf;
  }
  seq = (seq % 15) + 1;
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const data = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
    const last = off + CHUNK >= bytes.length;
    const h = Buffer.alloc(10);
    h[0] = 0x40 | (last ? 0x01 : 0); h[1] = seq; h[2] = 0x01; h[3] = 0x01; // v1, push on last; RGB 8-bit; display
    h.writeUInt32BE(off, 4); h.writeUInt16BE(data.length, 8);
    udp.send(Buffer.concat([h, data]), CFG.wledPort, wledAddr, (err) => { if (err) lastSendErr = err.message; else lastSendErr = null; });
  }
}

// Reads a WLED controller's LED outputs over its JSON API, so the settings page can show what the tree layout should be.
function getJson(u) {
  return new Promise((resolve, reject) => {
    const req = http.get(u, { timeout: 4000 }, (res) => {
      let n = 0; const chunks = [];
      res.on('data', (c) => { n += c.length; if (n > 512 * 1024) req.destroy(new Error('Reply too large')); else chunks.push(c); });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('Reply was not WLED JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('No answer within 4 seconds')));
    req.on('error', reject);
  });
}
async function readWled(host) {
  try {
    const [info, cfg] = await Promise.all([getJson(`http://${host}/json/info`), getJson(`http://${host}/json/cfg`)]);
    const ins = (((cfg || {}).hw || {}).led || {}).ins || [];
    return { ok: true, host, name: info.name, version: info.ver, ip: info.ip, count: (info.leds || {}).count, live: !!info.live, liveSource: info.lip || '',
      realtime: !!(((cfg || {}).if || {}).live || {}).en, ledMaps: !!(((cfg || {}).if || {}).live || {}).rlm,
      realtimeGamma: !(((cfg || {}).if || {}).live || {})['no-gc'], boot: (cfg || {}).def || null, matrix: (info.leds || {}).matrix || null, outputs: ins.map((o) => ({ start: o.start, len: o.len, pin: (o.pin || [])[0] })) };
  } catch (e) {
    return { ok: false, host, error: e.message || String(e) };
  }
}

// "Set up WLED for tree-show": WLED boots off (no boot preset), and its own look is set to plain black. From then on
// (settings.wledBlank) tree-show sets that black look every time it turns WLED on, so when tree-show stops sending,
// WLED's realtime timeout falls back to black instead of its own designs. WLED presets are left alone.
const BLACK_SEG = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
async function setupWled(host) {
  const base = `http://${host}`, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = await getJson(base + '/json/state'), cfg = await getJson(base + '/json/cfg');
  await postJson(base + '/json/state', { seg: (st.seg || [{ id: 0 }]).map((g) => ({ id: g.id, fx: 0, col: BLACK_SEG })) });
  await postJson(base + '/json/cfg', { def: Object.assign({}, cfg.def || {}, { ps: 0, on: false }) });
  await wait(1500); // WLED may restart to save its config
  let after = null, st2 = null;
  for (let i = 0; i < 6 && !after; i++) { try { after = await getJson(base + '/json/cfg'); st2 = await getJson(base + '/json/state'); } catch (e) { await wait(1500); } }
  const boot = !!(after && after.def && after.def.ps === 0 && after.def.on === false);
  const black = !!(st2 && (st2.seg || []).every((g) => g.fx === 0 && (g.col || [])[0] && g.col[0].slice(0, 3).every((v) => v === 0)));
  return { ok: boot && black, boot, black, def: after && after.def, wasBootPreset: (cfg.def || {}).ps };
}

// ---------- player loop ----------
const player = new E.Player({ getDesign });
const frame = new Float32Array(E.N * 3);
const wledBytes = new Uint8Array(E.WN * 3), viewBytes = new Uint8Array(E.N * 3);
let liveUntil = 0, liveFrom = null, tick = 0, lastT = Date.now();

// Where each in-order playlist got to, so switching back resumes instead of starting over at the first design.
function rememberPos() { if (player.running && db.playlist.id && db.playlist.mode === 'order') (db.positions = db.positions || {})[db.playlist.id] = player.pos; }
function alreadyPlaying(id) { return !!(db.playlist.running && player.running && !(player.cur && player.cur.hold) && db.playlist.id === id); }
function syncPlayer(restart) {
  player.setPlaylist(db.playlist);
  if (db.playlist.running && (restart || !player.running)) player.start(db.playlist.mode === 'order' ? (db.positions || {})[db.playlist.id] : null);
  if (!db.playlist.running && player.running) player.stop();
}

// ---------- frame rate: follow what WLED can show ----------
// WLED reports how many frames it shows per second (never more than we send).
// Probe: send at the maximum; WLED's count is then what it can really show, and
// we settle at 95% of that (headroom so it doesn't skip frames). Probe again
// every 5 minutes, and start over when WLED reboots or its LED count changes.
// Readings are ignored until a new rate has run a few seconds (WLED's count lags).
// Patterns are timed by the clock, so the frame rate never changes their speed.
const FPS_MIN = 10, FPS_SETTLE_MS = 6000, FPS_PROBE_MS = +(process.env.FPS_PROBE_MS || 300000);
let fpsTarget = null, fpsChangedAt = Date.now(), fpsProbeAt = 0, fpsWledKey = null, wledFps = null, sendFps = 0, lastSendAt = 0;
function fpsCfg() {
  const max = Math.round(+settings.fpsMax);
  return { auto: settings.fpsAuto !== false, max: max >= 5 && max <= 120 ? max : Math.max(CFG.fps, 60) };
}
function currentFps() { const c = fpsCfg(); return c.auto && fpsTarget ? Math.max(FPS_MIN, Math.min(c.max, fpsTarget)) : c.max; }
function setFpsTarget(v) { fpsTarget = v; fpsChangedAt = Date.now(); }
async function pollWledFps() {
  const sending = db && db.playlist.running && player.running && Date.now() >= liveUntil; // judge only our own frames
  if (!sending || !wledAddr) return;
  let info; try { info = await getJson(`http://${process.env.WLED_HTTP || CFG.wledHost}/json/info`); } catch (e) { return; } // WLED_HTTP: tests only
  const leds = info.leds || {}; wledFps = leds.fps == null ? null : leds.fps;
  wledDither = info.dither || null;
  if (wledDither && wledDitherSent) { // WLED restarted or changed: send the dither settings again
    const want = JSON.parse(wledDitherSent);
    if (!!wledDither.on !== want.on || (want.on && wledDither.bri16 !== want.bri16)) wledDitherSent = null;
  }
  const c = fpsCfg(); if (!c.auto) { fpsTarget = null; return; }
  if (!wledFps || !info.live) return;
  const key = [leds.count, info.uptime || 0];
  if (fpsWledKey && (key[0] !== fpsWledKey[0] || key[1] < fpsWledKey[1])) { log('WLED changed (LED count or reboot): measuring its frame rate again'); setFpsTarget(null); }
  fpsWledKey = key;
  if (Date.now() - fpsChangedAt < FPS_SETTLE_MS) return;
  const sent = sendFps || currentFps();
  if (wledFps < sent * 0.9) {
    const nv = Math.max(FPS_MIN, Math.min(c.max, Math.floor(wledFps * 0.95)));
    if (nv !== fpsTarget) { log(`WLED shows ${wledFps} fps of ${Math.round(sent)} sent: sending ${nv}`); setFpsTarget(nv); }
    fpsProbeAt = Date.now() + FPS_PROBE_MS;
  } else if (fpsTarget && fpsTarget < c.max && Date.now() >= fpsProbeAt) {
    log(`probing: can WLED show more than ${fpsTarget} fps?`); setFpsTarget(null);
  }
}
setInterval(pollWledFps, 8000);

(function frameLoop() {
  const now = Date.now(), dt = Math.min(0.2, (now - lastT) / 1000); lastT = now; tick++;
  const live = now < liveUntil;
  const active = player.step(dt, frame); // keep time moving even while live overrides
  if (active && !live) {
    sendFrame(frame);
    if (lastSendAt) sendFps = sendFps * 0.95 + (1000 / Math.max(1, now - lastSendAt)) * 0.05;
    lastSendAt = now;
    if (tick % 2 === 0 && watchers.size) {
      E.toBytes(frame, Math.pow(masterBright(), 0.4), viewBytes); // eyes see dim LEDs as brighter than linear; at 5% the preview still shows the lights
      for (const ws of watchers) if (ws.readyState === 1 && ws.bufferedAmount < 20000) ws.send(viewBytes);
    }
  } else lastSendAt = 0;
  setTimeout(frameLoop, Math.max(0, 1000 / currentFps() - (Date.now() - now)));
})();

function status() {
  return { type: 'status', player: player.status(), playing: !!db.playlist.running, live: Date.now() < liveUntil, bright: masterBright(), build: BUILD, schedule: scheduleStatus(), activeId: db.activeId, playlistName: db.playlist.name, wled: { host: CFG.wledHost, resolved: !!wledAddr, error: lastSendErr } };
}
setInterval(() => broadcast(status()), 1000);

// ---------- general brightness ----------
// db.bright (0.05-1) scales everything sent to the tree. Older data kept a playlist-only brightness; it moves over once.
function masterBright() { return db && db.bright != null ? db.bright : 1; }

// ---------- WLED power ----------
// When nothing is being sent, WLED falls back to its own preset after its realtime timeout. With wledPower on (setting,
// default on) tree-show turns WLED off while the tree is stopped and back on when it plays, so "off" means dark.
let wledOn = null, wledRetryAt = 0;
function postJson(u, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body), q = new URL(u);
    const req = http.request({ hostname: q.hostname, port: q.port || 80, path: q.pathname, method: 'POST', timeout: 4000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(data);
  });
}
function syncWledPower() {
  if (settings.wledPower === false) return;
  const want = !!db.playlist.running || Date.now() < liveUntil;
  if (want === wledOn || Date.now() < wledRetryAt) return;
  wledOn = want;
  const body = want && settings.wledBlank ? { on: true, seg: [{ id: 0, fx: 0, col: BLACK_SEG }] } : { on: want };
  postJson(`http://${CFG.wledHost}/json/state`, body).then(() => log(`WLED turned ${want ? 'on' : 'off'}`))
    .catch((e) => { wledOn = null; wledRetryAt = Date.now() + 30000; log('Could not switch WLED', want ? 'on' : 'off', '-', e.message, '(trying again in 30 s)'); });
}
setInterval(syncWledPower, 1000);
// Heartbeat: WLED may have restarted (and come up off, or forgotten its dithering): re-send both every 30 s.
setInterval(() => { if (Date.now() >= wledRetryAt) wledOn = null; wledDitherSent = null; }, 30000);

// ---------- WLED's own temporal dithering (Settings -> Color -> Dimming -> "in WLED") ----------
// Needs Jeff's WLED build (dither1). tree-show then sends the plain picture and sets WLED's dithering,
// fine brightness (bri16 from the general brightness) and gamma. Other modes turn it off.
let wledDither, wledDitherSent = null, wledDitherRetryAt = 0;  // wledDither: undefined = not checked, null = stock WLED
function wledDitherWant() {
  const dz = D.clean(settings.dither);
  if (dz.mode !== 'wled') return { on: false };
  return { on: true, bri16: Math.max(1, Math.round(masterBright() * 65535)), g: LAYOUT.gamma, wb: [255, 255, 255], dark: dz.darkest, fps: dz.wledFps, minHz: dz.minHz };
}
function syncWledDither() {
  if (!db || Date.now() < wledDitherRetryAt) return;
  const want = wledDitherWant(), key = JSON.stringify(want);
  if (key === wledDitherSent) return;
  if (!want.on && wledDither === null) { wledDitherSent = key; return; } // stock WLED: nothing to turn off
  wledDitherSent = key;
  postJson(`http://${CFG.wledHost}/json/state`, { dither: want })
    .then(() => log(`WLED dithering ${want.on ? 'on, brightness ' + want.bri16 + '/65535' : 'off'}`))
    .catch((e) => { wledDitherSent = null; wledDitherRetryAt = Date.now() + 30000; log('Could not set WLED dithering -', e.message); });
}
setInterval(syncWledDither, 500);

// ---------- schedule ----------
// db.schedule = { enabled, entries: [{ id, days: [0-6, Sun=0], start: 'HH:MM', end: 'HH:MM', what: 'playlist' | 'design:<id>' }] }
// Times are this server's local time. A window whose end is at or before its start runs past midnight (its day is the
// day it starts). Overlaps: a design window beats a playlist window. Outside every window the tree is off.
// The schedule only acts when what it wants changes, so pressing Play/Stop/Hold by hand sticks until the next change.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3);
const hhmm = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

// ---- sun times ----
// A start or end can be a clock time 'HH:MM' or a sun event with an offset in minutes: 'sunset', 'dusk+30', 'sunrise-60'.
// dawn/dusk = civil twilight (sun 6 degrees below the horizon). Needs db.schedule.lat/lon. Standard sunrise equation
// (Almanac for Computers), good to a minute or two, which is plenty for lights.
const SUN = /^(sunrise|sunset|dawn|dusk)([+-]\d{1,3})?$/;
const ZENITH = { sunrise: 90.833, sunset: 90.833, dawn: 96, dusk: 96 };
function sunEvent(date, lat, lon, ev) {
  const rad = Math.PI / 180, rising = ev === 'sunrise' || ev === 'dawn';
  const start = new Date(date.getFullYear(), 0, 0), N = Math.floor((new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12) - start) / 864e5);
  const lngHour = lon / 15, t = N + ((rising ? 6 : 18) - lngHour) / 24, M = 0.9856 * t - 3.289;
  let L = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634 + 720) % 360;
  let RA = (Math.atan(0.91764 * Math.tan(L * rad)) / rad + 720) % 360;
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(ZENITH[ev] * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null; // the sun doesn't get there today (polar day/night)
  const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
  const UT = ((H + RA - 0.06571 * t - 6.622 - lngHour) % 24 + 24) % 24;
  const tz = -new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTimezoneOffset(); // minutes, DST-aware
  return ((UT * 60 + tz) % 1440 + 1440) % 1440;
}
function hasLoc() { const sc = db.schedule || {}; return typeof sc.lat === 'number' && typeof sc.lon === 'number'; }
function resolveSpec(spec, date) { // minutes after local midnight on that date, or null
  if (HM.test(spec)) return mins(spec);
  const m = SUN.exec(spec); if (!m || !hasLoc()) return null;
  const v = sunEvent(date, db.schedule.lat, db.schedule.lon, m[1]); return v == null ? null : (v + (+m[2] || 0) + 1440) % 1440;
}
function sunToday() { if (!hasLoc()) return null; const d = new Date(), o = {}; for (const ev of ['dawn', 'sunrise', 'sunset', 'dusk']) { const v = sunEvent(d, db.schedule.lat, db.schedule.lon, ev); o[ev] = v == null ? null : hhmm(v); } return o; }
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function onDay(e, d) { // does this entry run on the day d (the day its window starts)?
  if (e.date) {
    const to = e.dateTo || e.date, x = ymd(d);
    if (!e.yearly) return x >= e.date && x <= to;
    const a = e.date.slice(5), b = to.slice(5), md = x.slice(5); // every year: month-day range, may wrap past New Year
    return a <= b ? md >= a && md <= b : md >= a || md <= b;
  }
  return e.days.includes(d.getDay());
}
function entryActive(e, d) {
  const m = d.getHours() * 60 + d.getMinutes(), day = d.getDay(), y = new Date(d.getTime() - 864e5);
  const s = resolveSpec(e.start, d), en = resolveSpec(e.end, d);
  if (s != null && en != null) {
    if (en > s) { if (onDay(e, d) && m >= s && m < en) return true; }
    else if (onDay(e, d) && m >= s) return true;
  }
  const sy = resolveSpec(e.start, y), ey = resolveSpec(e.end, y); // a window that started yesterday and runs past midnight
  return sy != null && ey != null && ey <= sy && onDay(e, y) && m < ey;
}
function scheduleWant(d) {
  const sc = db.schedule;
  if (!sc || !sc.enabled) return null;
  // The time highest in the list wins when several are on (move a time up to make it override the ones below).
  const e = sc.entries.find((x) => entryActive(x, d) && !(x.what.startsWith('design:') && !getDesign(x.what.slice(7))));
  if (!e) return { kind: 'off' };
  if (e.what.startsWith('design:')) return { kind: 'design', id: e.what.slice(7), entry: e };
  const id = e.what.startsWith('playlist:') ? e.what.slice(9) : null;
  return { kind: 'playlist', id: id && db.playlists.some((x) => x.id === id) ? id : null, entry: e };
}
let lastWant = null;
function runSchedule(force) {
  const w = scheduleWant(new Date());
  if (!w) { lastWant = null; return; }
  const key = w.kind + (w.id ? ':' + w.id : '');
  if (!force && key === lastWant) return;
  lastWant = key;
  if (w.kind === 'off') { rememberPos(); db.playlist.hold = null; db.playlist.running = false; syncPlayer(false); log('Schedule: tree off'); }
  else if (w.kind === 'playlist') {
    const target = w.id || db.activeId;
    if (alreadyPlaying(target)) { db.playlist.hold = null; log(`Schedule: "${db.playlist.name}" is already playing`); }
    else { rememberPos(); db.activeId = target; syncActive(); db.playlist.hold = null; db.playlist.running = true; syncPlayer(true); log(`Schedule: playing "${db.playlist.name}"`); }
  }
  else { const d = getDesign(w.id); db.playlist.running = true; db.playlist.hold = d; player.setPlaylist(db.playlist); player.playDesign(d, 60, true); log(`Schedule: holding "${d.name}"`); }
  saveDb(); broadcast(status());
}
setInterval(() => runSchedule(false), 15000);
// What the schedule is doing right now, for the mode badge: following it or overridden by hand, until when, and what's next.
// The 2-day plan behind "next" is cached for a minute (status goes out every second).
let nextCache = { key: '', v: null };
function scheduleNext(sc) {
  const now = new Date(), key = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate() + ' ' + now.getHours() + ':' + now.getMinutes() + '|' + JSON.stringify(sc);
  if (nextCache.key === key) return nextCache.v;
  const plan = schedulePlan(sc, 2), nowM = now.getHours() * 60 + now.getMinutes(), blocks = [];
  plan.forEach((day, di) => day.segs.forEach((g) => blocks.push({ di, from: di * 1440 + mins(g.from), to: di * 1440 + (g.to === '24:00' ? 1440 : mins(g.to)), g })));
  for (let k = 1; k < blocks.length; k++) if (blocks[k].from === blocks[k - 1].to && blocks[k].g.i === blocks[k - 1].g.i) { blocks[k].from = blocks[k - 1].from; blocks[k].g = Object.assign({}, blocks[k].g, { from: blocks[k - 1].g.from, fromSun: blocks[k - 1].g.fromSun }); blocks[k - 1] = null; } // join across midnight
  const bl = blocks.filter(Boolean), cur = bl.find((b) => b.from <= nowM && nowM < b.to), nxt = bl.find((b) => b.from > nowM);
  const dayWord = (m) => (m >= 1440 ? 'tomorrow' : 'today');
  let far = null;
  if (!cur && !bl.find((b) => b.from > nowM)) withSched(sc, () => { // look further ahead, a day at a time
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    for (let k = 2; k < 400 && !far; k++) {
      const d = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + k), idx = (sc.entries || []).findIndex((e) => dayWindows(e, d).some(([a]) => a > 0));
      if (idx >= 0) { const e = sc.entries[idx], st = resolveSpec(e.start, d); far = { at: st == null ? null : hhmm(st), sun: SUN.exec(e.start) ? e.start : null, day: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() !== t0.getFullYear() ? 'numeric' : undefined }), what: '' }; }
    }
  });
  const v = {
    until: cur ? { at: cur.g.toSun ? cur.g.to : hhmm(cur.to % 1440), sun: cur.g.toSun, day: dayWord(cur.to) } : null,
    next: nxt ? { at: nxt.g.from, sun: nxt.g.fromSun, day: dayWord(nxt.from), what: nxt.g.what } : far
  };
  nextCache = { key, v }; return v;
}
function scheduleStatus() {
  const sc = db && db.schedule; if (!sc || !sc.enabled) return { enabled: false };
  const w = scheduleWant(new Date());
  const ue = w.entry ? resolveSpec(w.entry.end, new Date()) : null;
  // following = the tree is doing what the schedule wants (otherwise someone pressed Play/Stop/Hold: a manual override)
  const holding = !!(player.cur && player.cur.hold), running = !!db.playlist.running;
  const following = w.kind === 'off' ? !running : w.kind === 'design' ? running && holding && player.cur.d.id === w.id : running && !holding && db.playlist.id === (w.id || db.activeId);
  const nx = scheduleNext(sc);
  return { enabled: true, want: w.kind, following, until: ue == null ? null : hhmm(ue), untilInfo: nx.until, next: nx.next,
    design: w.kind === 'design' ? (getDesign(w.id) || {}).name : null, playlist: w.kind === 'playlist' ? (db.playlists.find((x) => x.id === w.id) || activePl()).name : null };
}
function cleanSchedule(b) {
  const lat = b.lat === '' || b.lat == null ? null : +b.lat, lon = b.lon === '' || b.lon == null ? null : +b.lon;
  if (lat != null && !(lat >= -90 && lat <= 90)) throw new Error('Latitude should be between -90 and 90.');
  if (lon != null && !(lon >= -180 && lon <= 180)) throw new Error('Longitude should be between -180 and 180.');
  if ((lat == null) !== (lon == null)) throw new Error('Give both latitude and longitude, or neither.');
  const entries = (Array.isArray(b.entries) ? b.entries : []).slice(0, 50).map((e, i) => {
    const days = [...new Set((Array.isArray(e.days) ? e.days : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    const date = e.date ? String(e.date) : null;
    if (date && !(/^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(new Date(date + 'T12:00')))) throw new Error(`Time ${i + 1}: pick a date.`);
    if (!date && !days.length) throw new Error(`Time ${i + 1}: pick at least one day.`);
    for (const k of ['start', 'end']) {
      e[k] = String(e[k] || '').trim().toLowerCase();
      const sm = SUN.exec(e[k]);
      if (!HM.test(e[k]) && !sm) throw new Error(`Time ${i + 1}: ${k} should be a time like 17:00, or sunrise, sunset, dawn or dusk.`);
      if (sm && Math.abs(+sm[2] || 0) > 360) throw new Error(`Time ${i + 1}: keep the offset within 6 hours of ${sm[1]}.`);
      if (sm && !(typeof lat === 'number')) throw new Error('Set your location (latitude and longitude) to use sunrise, sunset, dawn or dusk.');
    }
    if (e.start === e.end) throw new Error(`Time ${i + 1}: start and end are the same.`);
    const what = String(e.what || 'playlist');
    if (what.startsWith('playlist:') && !db.playlists.some((x) => x.id === what.slice(9))) throw new Error(`Time ${i + 1}: that playlist no longer exists.`);
    if (what !== 'playlist' && !what.startsWith('playlist:') && !(what.startsWith('design:') && getDesign(what.slice(7)))) throw new Error(`Time ${i + 1}: that design no longer exists.`);
    const out = { id: String(e.id || 'w-' + Date.now().toString(36) + i).slice(0, 40), days: date ? [] : days, start: e.start, end: e.end, what };
    if (date) {
      out.date = date; out.yearly = !!e.yearly;
      const to = e.dateTo ? String(e.dateTo) : '';
      if (to && to !== date) {
        if (!(/^\d{4}-\d{2}-\d{2}$/.test(to) && !isNaN(new Date(to + 'T12:00')))) throw new Error(`Time ${i + 1}: the end date isn’t a date.`);
        if (!out.yearly && to < date) throw new Error(`Time ${i + 1}: the end date is before the start date.`);
        out.dateTo = to;
      }
    }
    return out;
  });
  const out = { enabled: !!b.enabled, entries, ordered: true };
  if (lat != null) { out.lat = Math.round(lat * 1e4) / 1e4; out.lon = Math.round(lon * 1e4) / 1e4; }
  return out;
}
// Windows [start, end) in minutes that entry e covers on day d (including yesterday's overnight tail).
function dayWindows(e, d) {
  const y = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1), r = [];
  const s = resolveSpec(e.start, d), en = resolveSpec(e.end, d), sy = resolveSpec(e.start, y), ey = resolveSpec(e.end, y);
  if (onDay(e, y) && sy != null && ey != null && ey <= sy) r.push([0, ey]);
  if (onDay(e, d) && s != null && en != null) r.push(en > s ? [s, en] : [s, 1440]);
  return r;
}
const withSched = (sc, fn) => { const keep = db.schedule; db.schedule = sc; try { return fn(); } finally { db.schedule = keep; } }; // resolveSpec reads lat/lon
// Looks a year ahead in 15-minute steps. Reports overlapping pairs (the higher one in the list plays) and times that never
// get to play because something above always covers them, or that don't happen at all.
function scheduleConflicts(sc) {
  const E2 = sc.entries || [], n = E2.length; if (!n) return [];
  return withSched(sc, () => {
    const pairs = {}, act = new Array(n).fill(0), won = new Array(n).fill(0), start = new Date(); start.setHours(0, 0, 0, 0);
    for (let day = 0; day < 366; day++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day), win = E2.map((e) => dayWindows(e, d));
      for (let m = 0; m < 1440; m += 15) {
        const on = []; for (let i = 0; i < n; i++) if (win[i].some(([a, b]) => m >= a && m < b)) on.push(i);
        on.forEach((i) => act[i]++); if (on.length) won[on[0]]++;
        for (let b = 1; b < on.length; b++) {
          const k = on[0] + ':' + on[b], P = pairs[k] || (pairs[k] = { a: on[0], b: on[b], days: new Set(), first: null });
          P.days.add(day); if (!P.first) P.first = new Date(d.getTime() + m * 60000);
        }
      }
    }
    const fmt = (t) => t.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const out = Object.values(pairs).map((P) => ({ type: 'overlap', a: P.a + 1, b: P.b + 1, winner: P.a + 1, loser: P.b + 1, days: P.days.size, firstLocal: fmt(P.first) }));
    for (let i = 0; i < n; i++) {
      if (!act[i]) out.push({ type: 'never', a: i + 1, why: 'none' });
      else if (!won[i]) out.push({ type: 'never', a: i + 1, why: 'covered' });
    }
    return out.sort((x, y) => (x.type === 'never' ? 0 : 1) - (y.type === 'never' ? 0 : 1) || x.a - y.a || (x.b || 0) - (y.b || 0));
  });
}
// What will play over the next `days` days: for each day, the blocks (from, to, what) after priorities are applied.
// Boundaries that come from a sun time say so (solar), so the page can show "sunset (≈4:55 PM)".
function planDays(sc) { // far enough to show every dated time (between 30 and 120 days)
  const today = new Date(); today.setHours(0, 0, 0, 0); let need = 30;
  for (const e of sc.entries || []) if (e.date && !e.yearly) { const end = new Date((e.dateTo || e.date) + 'T12:00'); need = Math.max(need, Math.ceil((end - today) / 864e5) + 1); }
    else if (e.date && e.yearly) { const y = today.getFullYear(); let st = new Date(y + e.date.slice(4) + 'T12:00'); if (st < today) st = new Date((y + 1) + e.date.slice(4) + 'T12:00'); const len = e.dateTo ? Math.max(0, Math.round((new Date(e.dateTo + 'T12:00') - new Date(e.date + 'T12:00')) / 864e5)) : 0; need = Math.max(need, Math.ceil((st - today) / 864e5) + len + 1); }
  return Math.min(120, need);
}
function schedulePlan(sc, days) {
  const E2 = sc.entries || [];
  return withSched(sc, () => {
    const out = [], start = new Date(); start.setHours(0, 0, 0, 0);
    const name = (e) => e.what.startsWith('design:') ? '“' + ((getDesign(e.what.slice(7)) || {}).name || 'missing design') + '” (held)' : ((db.playlists.find((x) => x.id === e.what.slice(9)) || activePl() || {}).name || 'playlist');
    // a boundary at minute m (5-minute steps) that comes from a sun time: { spec, v } with the exact minute
    const solarAt = (e, d, m) => { for (const k of ['start', 'end']) { if (SUN.exec(e[k])) { const v = resolveSpec(e[k], d); if (v != null && v <= m && m - v < 5) return { spec: e[k], v }; } } return null; };
    const at = (x, m) => x ? hhmm(x.v) : (m >= 1440 ? '24:00' : hhmm(m));
    for (let day = 0; day < days; day++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day), win = E2.map((e) => dayWindows(e, d)), segs = [];
      let cur = -1, from = 0, fromSun = null;
      for (let m = 0; m <= 1440; m += 5) {
        let w = -1; if (m < 1440) for (let i = 0; i < E2.length; i++) if (win[i].some(([a, b]) => m >= a && m < b)) { w = i; break; }
        if (w !== cur) {
          const sun = (cur >= 0 && solarAt(E2[cur], d, m)) || (w >= 0 && solarAt(E2[w], d, m)) || null; // is this boundary a sun time?
          if (cur >= 0) segs.push({ i: cur + 1, what: name(E2[cur]), from, to: m, fromSun, toSun: sun });
          cur = w; from = m; fromSun = sun;
        }
      }
      out.push({ date: ymd(d), dow: d.getDay(), segs: segs.map((g) => ({ i: g.i, what: g.what, from: at(g.fromSun, g.from), to: at(g.toSun, g.to), fromSun: g.fromSun && g.fromSun.spec, toSun: g.toSun && g.toSun.spec })) });
    }
    return out;
  });
}
function nowInfo() { const d = new Date(); return { time: hhmm(d.getHours() * 60 + d.getMinutes()), day: d.getDay(), tz: TZ, sun: sunToday() }; }

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function send(res, code, body, type) { res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 2e6) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('Body is not valid JSON')); } });
    req.on('error', reject);
  });
}
function cleanDesign(d) {
  if (!d || typeof d !== 'object' || !d.look || typeof d.look !== 'object') throw new Error('Design needs a look');
  const name = String(d.name || 'Untitled').slice(0, 60).trim() || 'Untitled';
  const id = String(d.id || ('d-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))).slice(0, 40);
  const look = JSON.parse(JSON.stringify(d.look));
  if (look.img && (typeof look.img !== 'string' || look.img.length !== E.N * 4)) delete look.img; // image must match this tree's pixel count
  const cat = String(d.cat || 'My designs').slice(0, 40);
  return { id, name, cat, look, edited: true }; // saved by a person: library updates leave it alone
}
// ---------- named playlists ----------
// db.playlists = [{ id, name, items, mode, fade, randSec }], db.activeId = the one the tree plays. db.playlist is the
// player's state (running, hold) plus a copy of the active playlist's contents, kept in step by syncActive().
function activePl() { return db.playlists.find((x) => x.id === db.activeId) || db.playlists[0]; }
function syncActive() { const a = activePl(); db.activeId = a.id; Object.assign(db.playlist, { id: a.id, name: a.name, items: a.items, sec: a.sec || 45, mode: a.mode, fade: a.fade, randSec: a.randSec }); }
function cleanNamedPl(b, id, oldName) {
  const c = cleanPlaylist(b), name = String(b.name == null ? oldName || '' : b.name).trim().slice(0, 50);
  if (!name) throw new Error('Give the playlist a name.');
  return { id, name, items: c.items, sec: c.sec, mode: c.mode, fade: c.fade, randSec: c.randSec };
}
function playlistsOut() { return db.playlists.map((x) => ({ id: x.id, name: x.name, items: x.items, sec: x.sec || 45, mode: x.mode, fade: x.fade, randSec: x.randSec })); }
function cleanPlaylist(p) {
  const items = (Array.isArray(p.items) ? p.items : []).slice(0, 500).map((it) => { const o = { id: String(it.id) }; if (+it.sec > 0) o.sec = Math.max(3, Math.min(3600, Math.round(+it.sec))); return o; }); // an item's sec overrides the playlist's
  return { items, sec: Math.max(3, Math.min(3600, Math.round(+p.sec || 45))), mode: ['order', 'shuffle', 'random'].includes(p.mode) ? p.mode : 'order', fade: Math.max(0, Math.min(30, +p.fade || 0)), randSec: Math.max(3, Math.min(3600, Math.round(+p.randSec || 60))), bright: Math.max(0.05, Math.min(1, p.bright == null ? 1 : +p.bright)), running: !!db.playlist.running, hold: db.playlist.hold || null };
}

// ---------- actions shared by the web API and Home Assistant ----------
function httpError(code, msg) { const e = new Error(msg); e.status = code; return e; }
function playerAction(b) {
  // hold = Hold on tree: a copy of the design stays on the tree (across restarts) until release, play, next or stop.
  if (b.action !== 'design') db.playlist.hold = null;
  if (b.action === 'play') {
    const target = b.playlist != null ? b.playlist : db.activeId;
    if (!db.playlists.some((x) => x.id === target)) throw httpError(404, 'That playlist no longer exists.');
    if (!alreadyPlaying(target)) { rememberPos(); db.activeId = target; syncActive(); db.playlist.running = true; syncPlayer(true); } // already on: keep going
  }
  else if (b.action === 'stop') { rememberPos(); db.playlist.running = false; syncPlayer(false); }
  else if (b.action === 'next' || b.action === 'release') { if (player.running) player.next(); else { db.playlist.running = false; } }
  else if (b.action === 'design') {
    const d = b.design ? cleanDesign(b.design) : getDesign(b.id);
    if (!d) throw httpError(404, 'That design no longer exists.');
    db.playlist.running = true; player.setPlaylist(db.playlist);
    db.playlist.hold = b.hold ? d : null; player.playDesign(d, +b.sec || db.playlist.randSec, !!b.hold);
  } else throw httpError(400, 'Unknown action.');
  saveDb(); const st = status(); broadcast(st); return st;
}
function setBright(v) {
  if (!(v >= 0.05 && v <= 1)) throw httpError(400, 'Brightness should be between 5% and 100%.');
  db.bright = Math.round(v * 100) / 100; saveDb(); const st = status(); broadcast(st); return st;
}
function resumeSchedule() { // end a manual override: do whatever the schedule wants right now
  if (!db.schedule || !db.schedule.enabled) throw httpError(409, 'The schedule is off, so there’s nothing to go back to.');
  liveFrom = null; liveUntil = 0; lastWant = null; runSchedule(true); log('Schedule resumed by hand');
  return status();
}
function setScheduleEnabled(on) {
  db.schedule = db.schedule || { enabled: false, entries: [] };
  if (!!db.schedule.enabled === on) return;
  db.schedule.enabled = on; saveDb(); lastWant = null; if (on) runSchedule(true); else broadcast(status());
  log(`Schedule turned ${on ? 'on' : 'off'} from Home Assistant`);
}
// Save new settings (already cleaned) and apply what can change live. Returns true when the layout changed (restart).
function applySettings(next) {
  const restart = LAYOUT_KEYS.some((k) => next[k] !== LAYOUT[k]);
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE + '.tmp', JSON.stringify(next, null, 1)); fs.renameSync(SETTINGS_FILE + '.tmp', SETTINGS_FILE);
  if (next.wledHost !== CFG.wledHost || next.wledPort !== CFG.wledPort) {
    CFG.wledHost = next.wledHost; CFG.wledPort = next.wledPort; wledAddr = null; lastSendErr = null; resolveWled();
    log(`Settings: WLED is now ${CFG.wledHost}:${CFG.wledPort}`);
  }
  settings.wledPower = next.wledPower; wledOn = null;
  settings.dither = next.dither;   // applies to the next frame, no restart
  if (next.fpsAuto !== (settings.fpsAuto !== false) || next.fpsMax !== fpsCfg().max) setFpsTarget(null); // measure again
  settings.fpsAuto = next.fpsAuto; settings.fpsMax = next.fpsMax;
  const mqttChanged = JSON.stringify(next.mqtt) !== JSON.stringify(settings.mqtt);
  settings.mqtt = next.mqtt; if (mqttChanged && ha) ha.restart();
  return restart;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, { designs: db.designs, removed: db.removed || [], playlist: db.playlist, playlists: playlistsOut(), activeId: db.activeId, status: status() });
    if (p === '/health') return send(res, 200, { ok: true, wled: CFG.wledHost, resolved: wledAddr, designs: db.designs.length, playing: !!db.playlist.running });
    let m = p.match(/^\/api\/designs\/([\w.-]+)$/);
    if (m && req.method === 'PUT') {
      const d = cleanDesign(Object.assign(await readBody(req), { id: m[1] }));
      const i = db.designs.findIndex((x) => x.id === d.id);
      if (i >= 0) db.designs[i] = d; else db.designs.push(d);
      if (player.cur && player.cur.d.id === d.id) { player.cur.d = d; player.cur.look = d.look; } // edits show on the tree right away
      if (db.playlist.hold && db.playlist.hold.id === d.id) db.playlist.hold = d;
      saveDb(); return send(res, 200, d);
    }
    if (m && req.method === 'DELETE') {
      db.designs = db.designs.filter((x) => x.id !== m[1]);
      if (E.isLibraryId(m[1]) && !(db.removed || []).includes(m[1])) (db.removed = db.removed || []).push(m[1]);
      for (const pl of db.playlists) pl.items = pl.items.filter((it) => it.id !== m[1]);
      syncActive();
      saveDb(); syncPlayer(false); return send(res, 200, { ok: true });
    }
    if (p === '/api/library/restore' && req.method === 'POST') {
      db.removed = []; const added = E.mergeLibrary(db); saveDb();
      return send(res, 200, { added, designs: db.designs });
    }
    m = p.match(/^\/api\/playlists\/([\w.-]{1,40})$/);
    if (m && req.method === 'PUT') { // create or update a named playlist
      const b = await readBody(req), i = db.playlists.findIndex((x) => x.id === m[1]);
      if (i < 0 && db.playlists.length >= 100) return send(res, 400, { error: 'That’s a lot of playlists. Delete some first.' });
      const pl = cleanNamedPl(b, m[1], i >= 0 ? db.playlists[i].name : '');
      if (i >= 0) db.playlists[i] = pl; else db.playlists.push(pl);
      if (pl.id === db.activeId) { syncActive(); syncPlayer(false); }
      saveDb(); return send(res, 200, { playlist: pl, playlists: playlistsOut(), activeId: db.activeId });
    }
    if (m && req.method === 'DELETE') {
      if (db.playlists.length <= 1) return send(res, 400, { error: 'Keep at least one playlist.' });
      const used = ((db.schedule || {}).entries || []).some((e) => e.what === 'playlist:' + m[1]);
      if (used) return send(res, 400, { error: 'The schedule plays this playlist. Change the schedule first.' });
      db.playlists = db.playlists.filter((x) => x.id !== m[1]);
      if (E.isLibraryPlaylist(m[1])) (db.removedPlaylists = db.removedPlaylists || []).includes(m[1]) || db.removedPlaylists.push(m[1]);
      if (db.activeId === m[1]) { db.activeId = db.playlists[0].id; syncActive(); syncPlayer(!!db.playlist.running); }
      saveDb(); return send(res, 200, { playlists: playlistsOut(), activeId: db.activeId });
    }
    if (p === '/api/playlist' && req.method === 'PUT') {
      const a = activePl(); Object.assign(a, cleanNamedPl(await readBody(req), a.id, a.name)); syncActive(); saveDb(); syncPlayer(false);
      return send(res, 200, db.playlist);
    }
    if (p === '/api/player' && req.method === 'POST') { const st = playerAction(await readBody(req)); return send(res, 200, st); }
    if (p === '/api/brightness' && req.method === 'PUT') { const st = setBright(+(await readBody(req)).value); return send(res, 200, st); }
    if (p === '/api/schedule' && req.method === 'GET') { const sc = db.schedule || { enabled: false, entries: [] }; return send(res, 200, { schedule: sc, now: nowInfo(), status: scheduleStatus(), conflicts: scheduleConflicts(sc), plan: schedulePlan(sc, planDays(sc)) }); }
    if (p === '/api/schedule/check' && req.method === 'POST') { const sc = cleanSchedule(await readBody(req)); return send(res, 200, { conflicts: scheduleConflicts(sc), plan: schedulePlan(sc, planDays(sc)), sun: (() => { const keep = db.schedule; db.schedule = sc; try { return sunToday(); } finally { db.schedule = keep; } })() }); }
    if (p === '/api/schedule/resume' && req.method === 'POST') { // end a manual override: do whatever the schedule wants right now
      return send(res, 200, resumeSchedule());
    }
    if (p === '/api/schedule' && req.method === 'PUT') {
      db.schedule = cleanSchedule(await readBody(req)); saveDb(); lastWant = null; runSchedule(true);
      return send(res, 200, { schedule: db.schedule, now: nowInfo(), status: scheduleStatus(), conflicts: scheduleConflicts(db.schedule) });
    }
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, { settings: currentSettings(), pixels: { tree: E.NT, topper: E.N - E.NT, wledFrame: E.WN },
      frameRate: { target: Math.round(currentFps()), sending: Math.round(sendFps * 10) / 10, wled: wledFps }, wledDither, mqtt: ha ? ha.status() : null });
    if (p === '/api/settings' && req.method === 'PUT') {
      const next = cleanSettings(await readBody(req)), restart = applySettings(next);
      send(res, 200, { settings: Object.assign({}, next, { mqtt: H.publicCfg(next.mqtt) }), restart });
      if (restart) { log('Settings: tree layout changed, restarting to apply', JSON.stringify(Object.assign({}, next, { mqtt: H.publicCfg(next.mqtt) }))); setTimeout(shutdown, 300); }
      return;
    }
    if (p === '/api/wled' && req.method === 'GET') {
      const host = String(url.searchParams.get('host') || CFG.wledHost).trim();
      if (!HOST_RE.test(host)) return send(res, 400, { error: 'That is not a valid hostname or IP address.' });
      return send(res, 200, await readWled(host));
    }
    if (p === '/api/wled/setup' && req.method === 'POST') {
      try { const r = await setupWled(CFG.wledHost); log('WLED setup:', JSON.stringify(r));
        if (r.ok) { settings.wledBlank = true; fs.mkdirSync(CFG.dataDir, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(Object.assign(currentSettings(), { wledBlank: true }), null, 1)); } return send(res, r.ok ? 200 : 502, r.ok ? r : Object.assign({ error: 'WLED didn’t take all the settings. Check it’s reachable and try again.' }, r)); }
      catch (e) { return send(res, 502, { error: `Couldn’t reach WLED at ${CFG.wledHost}: ${e.message}` }); }
    }
    if (p === '/api/version') return send(res, 200, { build: BUILD });
    if (p === '/config.js') return send(res, 200, `window.TREE_CONFIG=${JSON.stringify(LAYOUT)};`, 'text/javascript; charset=utf-8');
    if (p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    // static files
    const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      if (path.basename(file) === 'index.html' && !/^\s*<!doctype/i.test(buf.slice(0, 20).toString())) {
        buf = Buffer.concat([Buffer.from(PAGE_HEAD), buf]); // page source is written as a fragment; add the document shell
      }
      if (path.basename(file) === 'index.html') { // stamp the build so scripts are never served from an old cache
        buf = Buffer.from(buf.toString().replace(/src="(config|engine)\.js"/g, `src="$1.js?v=${BUILD}"`).replace('<body>', `<body data-build="${BUILD}">`));
      }
      send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    send(res, e.status || 400, { error: e.message });
  }
});

// ---------- WebSocket: live frames in, status and tree view out ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const watchers = new Set();
// A live frame is in WLED order with gamma applied; turn it back into tree order for previews (same look as the playlist view).
let liveTick = 0; const liveView = Buffer.alloc(E.N * 3);
const INV_GAMMA = new Uint8Array(256); for (let i = 0; i < 256; i++) INV_GAMMA[i] = Math.round(255 * Math.pow(i / 255, 1 / E.CONFIG.gamma));
function liveToView(data, out) {
  const k = Math.pow(masterBright(), 0.4);
  for (let q = 0; q < E.N; q++) { const w = E.WIDX[q], o = q * 3; if (w < 0 || w * 3 + 2 >= data.length) { out[o] = out[o + 1] = out[o + 2] = 0; continue; }
    out[o] = Math.round(INV_GAMMA[data[w * 3]] * k); out[o + 1] = Math.round(INV_GAMMA[data[w * 3 + 1]] * k); out[o + 2] = Math.round(INV_GAMMA[data[w * 3 + 2]] * k); }
  return out;
}
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s); }
wss.on('connection', (ws, req) => {
  log('Page connected from', req.socket.remoteAddress);
  ws.send(JSON.stringify(status()));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (data.length !== E.WN * 3) return ws.send(JSON.stringify({ type: 'error', error: `Frame is ${data.length} bytes; expected ${E.WN * 3}.` }));
      if (liveFrom && liveFrom !== ws && Date.now() < liveUntil) return; // one live mixer at a time
      liveFrom = ws; liveUntil = Date.now() + LIVE_HOLD_MS;
      sendLive(data);
      if (watchers.size && (++liveTick % 2 === 0)) { // let other screens' previews show the live mix too (what the tree really gets)
        liveToView(data, liveView);
        for (const w of watchers) if (w !== ws && w.readyState === 1 && w.bufferedAmount < 20000) w.send(liveView);
      }
      return;
    }
    try { const m = JSON.parse(data.toString()); if (m.type === 'watch') { if (m.on) watchers.add(ws); else watchers.delete(ws); } else if (m.type === 'unlive' && liveFrom === ws) { liveFrom = null; liveUntil = 0; } /* mixer stopped: hand the tree back now */ } catch (e) { /* ignore */ }
  });
  ws.on('close', () => { watchers.delete(ws); if (liveFrom === ws) { liveFrom = null; liveUntil = 0; } });
});

loadDb();
if (!Array.isArray(db.playlists) || !db.playlists.length) { // one playlist before named playlists existed
  const o = db.playlist || {}; db.playlists = [{ id: 'main', name: 'Main playlist', items: o.items || [], mode: o.mode || 'order', fade: o.fade == null ? 3 : o.fade, randSec: o.randSec || 60 }]; db.activeId = 'main'; saveDb();
}
if (E.mergePlaylists(db)) saveDb();
if (!db.mainIsChristmas) { // owner's request (Nov 2026): "Main playlist" becomes the Christmas playlist, once
  const m = db.playlists.find((x) => x.id === 'main'), have = new Set(db.designs.map((d) => d.id));
  if (m) { m.name = 'Christmas'; m.items = E.CHRISTMAS_PLAYLIST.filter((id) => have.has(id)).map((id) => ({ id })); m.mode = 'shuffle'; m.sec = m.sec || 45; log(`"Main playlist" is now "Christmas" with ${m.items.length} designs`); }
  db.mainIsChristmas = true; saveDb();
}
if (db.schedule && db.schedule.entries && !db.schedule.ordered) { // priority used to be dated > weekly, design > playlist; now it's list order
  const rank = (e) => (e.date ? 2 : 0) + (String(e.what).startsWith('design:') ? 1 : 0);
  db.schedule.entries = db.schedule.entries.map((e, i) => [e, i]).sort((a, b) => rank(b[0]) - rank(a[0]) || a[1] - b[1]).map((x) => x[0]);
  db.schedule.ordered = true; saveDb();
}
for (const pl of db.playlists) if (!pl.sec) { // older data kept the time on every item
  const secs = [...new Set(pl.items.map((it) => it.sec).filter(Boolean))];
  const count = {}; pl.items.forEach((it) => { if (it.sec) count[it.sec] = (count[it.sec] || 0) + 1; });
  pl.sec = secs.length ? +Object.keys(count).sort((x, y) => count[y] - count[x])[0] : 45; // the most common time
  if (secs.length <= 1) pl.items.forEach((it) => delete it.sec); else pl.items.forEach((it) => { if (it.sec === pl.sec) delete it.sec; });
  saveDb();
}
syncActive();
if (db.bright == null) { db.bright = db.playlist.bright == null ? 1 : db.playlist.bright; db.playlist.bright = 1; saveDb(); }
syncPlayer(true);
if (db.playlist.running && db.playlist.hold && db.playlist.hold.look) { player.playDesign(db.playlist.hold, 60, true); log(`Holding "${db.playlist.hold.name}" on the tree`); }
runSchedule(true);
ha = H.create({
  log, httpPort: CFG.httpPort, mqtt: () => settings.mqtt, status, settings: currentSettings, wledFps: () => wledFps,
  playlists: () => db.playlists, designs: () => db.designs, playing: () => !!db.playlist.running,
  holding: () => !!(player.cur && player.cur.hold), player: playerAction, setBright, resume: resumeSchedule, setSchedule: setScheduleEnabled,
  applySettings: (patch) => { if (applySettings(cleanSettings(Object.assign(currentSettings(), patch)))) setTimeout(shutdown, 300); },
});
ha.start();
server.listen(CFG.httpPort, () => log(`tree-show on http://0.0.0.0:${CFG.httpPort} · WLED ${CFG.wledHost}:${CFG.wledPort} · data ${DATA_FILE} · playlist ${db.playlist.running ? 'playing' : 'stopped'}`));
function shutdown() { clearTimeout(saveTimer); try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 1)); } catch (e) { /* ignore */ } process.exit(0); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
