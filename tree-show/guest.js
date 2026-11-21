'use strict';
// Guest requests (Settings -> Guests): people scan a QR code, pick a design (colors, a message) and it joins a line
// for the tree. The queue lives on the guest site: on AWS (t.<domain>, guestcloud/ deployed by deploy/aws.sh) or, with
// no site address set, the sample tree-show hosts itself at /external (same code, in this process, saved in DATA_DIR).
// tree-show only ever calls out: every few seconds it checks in (open or not and why, what it's playing, its design
// list when that changed) and gets the waiting requests back. It plays them one after another for `sec` each, then
// hands the tree back to whatever it was doing (the playlist, or a held design).
// Requests are only taken while the tree is on for the schedule (or played by hand when there's no schedule), never
// while paused (with a note guests see), the mixer is live, or the feature is off.
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const GL = require('./public/guestlook.js');

const DEFAULTS = { enabled: false, paused: false, note: '', url: '', key: '', sec: 45, fav: '', title: 'Light Up the Tree', maxWaiting: 5, maxSent: 10, windowMin: 10 };
const SYNC_MS = 3000, FONT = /^[A-Z0-9 !?.,'\-&*+#:<]{0,24}$/;

function clean(g, old) {
  g = g || {}; old = Object.assign({}, DEFAULTS, old || {});
  const pick = (k) => (g[k] == null ? old[k] : g[k]);
  const url = String(pick('url') || '').trim().replace(/\/+$/, '');
  if (url && !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(url)) throw new Error('Guest site address should start with https://, like https://t.example.com.');
  const lim = (k, lo, hi, name) => { const v = Math.round(+(pick(k) == null ? DEFAULTS[k] : pick(k))); if (!(v >= lo && v <= hi)) throw new Error(`${name} should be between ${lo} and ${hi}.`); return v; };
  const sec = Math.round(+pick('sec'));
  if (!(sec >= 10 && sec <= 600)) throw new Error('Time per guest request should be between 10 and 600 seconds.');
  return {
    enabled: pick('enabled') === true, paused: pick('paused') === true, note: String(pick('note') || '').trim().slice(0, 120),
    url, key: g.clearKey ? '' : g.key ? String(g.key).trim().slice(0, 200) : old.key || '', sec, fav: String(pick('fav') || '').slice(0, 40),
    title: String(pick('title') || DEFAULTS.title).trim().slice(0, 40) || DEFAULTS.title,
    maxWaiting: lim('maxWaiting', 1, 20, 'Requests one phone can have waiting'),
    maxSent: lim('maxSent', 1, 60, 'Requests one phone can send'),
    windowMin: lim('windowMin', 1, 120, 'Minutes for the send limit'),
  };
}
function publicCfg(g) { const c = Object.assign({}, DEFAULTS, g || {}); c.keySet = !!c.key; delete c.key; return c; }

function create(ctx) {
  // ctx: cfg(), dataDir, log, layout, designs(), getDesign(id), playlists(), player, holdDesign(), running(), live(),
  //      scheduleOn() -> { on, back }   (back: when the schedule turns the tree on next, words like "5:30 PM")
  let cloud = null;            // the in-process queue (sample site), loaded on first use
  let items = [], cur = null, cloudHash = null, lastOk = 0, lastErr = null, busy = false, clearAsk = false, drop = [];
  let lastOpen = null;
  const played = new Set();

  async function local() {
    if (!cloud) {
      cloud = await import(path.join(__dirname, 'guestcloud', 'index.mjs'));
      cloud.useStore(await cloud.fileStore(path.join(ctx.dataDir, 'guest-queue.json')));
    }
    return cloud;
  }
  // The sample site's HTTP API (tree-show serves it at /external/api/...).
  async function serveLocal(method, apiPath, query, body, ip) {
    const c = await local();
    const ev = { requestContext: { http: { method, sourceIp: ip || 'local' } }, rawPath: '/api/' + apiPath, headers: {}, queryStringParameters: query, body: body == null ? '' : body };
    return c.handler(ev);
  }

  function state() {
    const c = ctx.cfg();
    if (!c.enabled) return { open: false, reason: 'The tree isn’t taking requests right now.' };
    if (c.paused) return { open: false, reason: c.note || 'Requests are paused right now. Check back soon!' };
    const s = ctx.scheduleOn();
    if (!s.on) return { open: false, reason: s.back ? `The tree is resting. Requests open again ${s.back}.` : 'The tree is resting right now.' };
    if (!ctx.running()) return { open: false, reason: 'The tree is off right now.' };
    if (ctx.live()) return { open: false, reason: 'Someone’s playing the tree live right now. Check back in a minute.' };
    return { open: true, reason: null };
  }

  function catalog() {
    const c = ctx.cfg(), pl = ctx.playlists().find((x) => x.id === c.fav);
    const designs = ctx.designs().map((d) => { const look = Object.assign({}, d.look); delete look.img; return { id: d.id, name: d.name, cat: d.cat, look }; });
    const favorites = pl ? pl.items.map((it) => it.id).filter((id) => designs.some((d) => d.id === id)) : [];
    const body = { title: c.title, designs, favorites, layout: ctx.layout };
    body.hash = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    return body;
  }

  function post(url, key, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body), u = new URL(url + '/api/tree');
      const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST', timeout: 8000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Tree-Key': key } }, (res) => {
        const ch = []; res.on('data', (c) => ch.push(c));
        res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (e) { /* not JSON */ }
          if (res.statusCode !== 200) reject(new Error(j.error || 'the guest site answered ' + res.statusCode)); else resolve(j); });
      });
      req.on('timeout', () => req.destroy(new Error('no answer from the guest site')));
      req.on('error', reject); req.end(data);
    });
  }

  // Checks in every 3 s while requests are open, every 15 s while closed, once a minute with the feature off
  // (on AWS each check-in is a request; this keeps it well inside the free tier).
  let lastSync = 0;
  async function sync(force) {
    const c = ctx.cfg(), st0 = state(), every = !c.enabled ? 60000 : st0.open || cur ? SYNC_MS : 15000;
    if (!force && Date.now() - lastSync < every - 200) return;
    if (busy) return; busy = true; lastSync = Date.now();
    try {
      const st = state(); lastOpen = st.open;
      const body = { open: st.open, reason: st.reason, sec: c.sec, limits: { waiting: c.maxWaiting, sent: c.maxSent, windowMin: c.windowMin }, now: cur ? { t: cur.t, left: Math.max(0, Math.round((cur.ends - Date.now()) / 1000)) } : null };
      if (clearAsk) body.clear = true;
      if (drop.length) body.drop = drop.slice();
      const cat = catalog(); if (cat.hash !== cloudHash) body.catalog = cat;
      let r;
      if (c.url) { if (!c.key) throw new Error('set the guest site key'); r = await post(c.url, c.key, body); }
      else { const m = await local(); r = JSON.parse((await m.treeSync(body, Date.now())).body); }
      if (body.clear) clearAsk = false;
      if (body.drop) drop = drop.filter((t) => !body.drop.includes(t));
      items = (r.items || []).filter((it) => !played.has(it.t)); cloudHash = r.catalogHash; lastOk = Date.now(); lastErr = null;
    } catch (e) {
      if (lastErr !== e.message) ctx.log('Guest requests:', e.message); lastErr = e.message;
    } finally { busy = false; }
  }

  function start(it) {
    const d = ctx.getDesign(it.id), msg = String(it.msg || '').toUpperCase();
    played.add(it.t); if (played.size > 500) played.delete(played.values().next().value);
    if (!d || !FONT.test(msg)) { drop.push(it.t); return false; }
    const c = ctx.cfg(), look = GL.guestLook(d.look, it.colors || [], msg);
    const name = d.name + (msg ? ' · “' + msg.replace(/</g, '♥') + '”' : '') + ' (guest)';
    const gd = { id: 'guest:' + it.t, name, look };
    ctx.player.playDesign(gd, c.sec, true);
    cur = { t: it.t, id: gd.id, ends: Date.now() + c.sec * 1000, name };
    ctx.log(`Guest request: ${name}`);
    return true;
  }
  function finish() {
    cur = null;
    const st = state();
    while (st.open && items.length) { if (start(items.shift())) return; }
    if (!ctx.running()) return;
    const hold = ctx.holdDesign();
    if (hold) ctx.player.playDesign(hold, 60, true); else ctx.player.next(); // back to the held design or the playlist
  }

  async function tick() {
    if (cur) {
      const p = ctx.player.cur;
      if (!p || p.d.id !== cur.id || !ctx.running()) { cur = null; return; } // someone played something else: the guest's turn ends
      if (Date.now() >= cur.ends) { finish(); sync(true); }
      return;
    }
    if (state().open && items.length) { while (items.length && !start(items.shift())); if (cur) sync(true); }
  }

  const timers = [];
  return {
    start() { timers.push(setInterval(() => sync(false), 1000), setInterval(tick, 500)); sync(true); },
    sync, serveLocal,
    clear() { clearAsk = true; items = []; sync(true); },
    skip() { if (cur) { cur.ends = 0; tick(); } },
    remove(t) { t = String(t); items = items.filter((x) => x.t !== t); played.add(t); drop.push(t); sync(true); }, // the owner takes one out of the line
    status() {
      const c = ctx.cfg(), st = state();
      return { enabled: c.enabled, paused: c.paused, open: st.open, reason: st.reason, site: c.url || null, waiting: items.length,
        now: cur ? { name: cur.name, left: Math.max(0, Math.round((cur.ends - Date.now()) / 1000)) } : null,
        items: items.map((it) => { const d = ctx.getDesign(it.id); return { t: it.t, name: d ? d.name : it.name || it.id, msg: it.msg || '', colors: it.colors || [], age: Math.round((Date.now() - (it.at || Date.now())) / 1000) }; }),
        lastContact: lastOk ? Math.round((Date.now() - lastOk) / 1000) : null, error: lastErr };
    },
  };
}

module.exports = { create, clean, publicCfg, DEFAULTS };
