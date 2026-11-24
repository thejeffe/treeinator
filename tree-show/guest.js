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
const fs = require('fs');
const path = require('path');
const https = require('https');
const GL = require('./public/guestlook.js');

const DEFAULTS = { enabled: false, paused: false, note: '', url: '', key: '', sec: 45, fav: '', title: 'Light Up the Tree', lineMin: 10, geo: false, radius: 200, qrLink: '', anyTime: false };
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
    lineMin: lim('lineMin', 1, 60, 'Line length'),
    geo: pick('geo') === true, radius: (() => { const v = Math.round(+(pick('radius') == null ? DEFAULTS.radius : pick('radius'))); if (!(v >= 30 && v <= 5000)) throw new Error('Nearby distance should be between 100 and 16,000 feet.'); return v; })(), // metres inside; feet on the page
    qrLink: (() => { const v = String(pick('qrLink') || '').trim(); if (v && !/^https?:\/\/[^\s]{3,200}$/i.test(v)) throw new Error('The QR code link should start with https://'); return v; })(),
    anyTime: pick('anyTime') === true, // testing: take requests outside the schedule's hours too (the tree wakes for each)
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

  // ---- activity log: DATA_DIR/guest-log.jsonl, one event a line, kept 90 days ----
  // From the guest site (opens, taps, sent, refused, cancelled; collected at each check-in) and from here (played and
  // how it ended). summary() groups it into visits for Settings -> Guests -> Activity.
  const LOG = path.join(ctx.dataDir, 'guest-log.jsonl'), LOG_STATE = path.join(ctx.dataDir, 'guest-log-state.json'), KEEP_DAYS = 90;
  let evSeq = 0; try { evSeq = +JSON.parse(fs.readFileSync(LOG_STATE, 'utf8')).seq || 0; } catch (e) { /* new */ }
  function note(list) {
    if (!list.length) return;
    try { fs.appendFileSync(LOG, list.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch (e) { ctx.log('Guest log not saved:', e.message); }
  }
  function took(r) { // events from the guest site
    if (r.lastSeq != null && r.lastSeq < evSeq) evSeq = 0;           // a new guest site (its numbering started over)
    const fresh = (r.events || []).filter((e) => e.seq > evSeq);
    note(fresh.map((e) => { const o = Object.assign({}, e); delete o.seq; return o; }));
    const top = Math.max(evSeq, r.lastSeq || 0, ...fresh.map((e) => e.seq));
    if (top !== evSeq) { evSeq = top; try { fs.writeFileSync(LOG_STATE, JSON.stringify({ seq: evSeq })); } catch (e) { /* next time */ } }
  }
  function prune() {
    try {
      const cut = Date.now() - KEEP_DAYS * 864e5, lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
      const keep = lines.filter((l) => { try { return JSON.parse(l).at >= cut; } catch (e) { return false; } });
      if (keep.length !== lines.length) { fs.writeFileSync(LOG + '.tmp', keep.join('\n') + (keep.length ? '\n' : '')); fs.renameSync(LOG + '.tmp', LOG); }
    } catch (e) { /* no log yet */ }
  }
  function readLog(days) {
    const since = Date.now() - days * 864e5;
    try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((e) => e && e.at >= since).sort((a, b) => a.at - b.at); }
    catch (e) { return []; }
  }
  // A phone's name in the activity: three Christmas words picked from its visitor id (the same phone always gets the
  // same name; 30 x 30 x 12 = 10,800 of them), instead of a string of random letters.
  const XA = ['Jolly', 'Merry', 'Twinkly', 'Frosty', 'Sparkly', 'Cozy', 'Snowy', 'Glittery', 'Toasty', 'Fuzzy', 'Jingly', 'Starry', 'Sugary', 'Cheery', 'Shimmery',
    'Giggly', 'Snuggly', 'Rosy', 'Golden', 'Silver', 'Bouncy', 'Dashing', 'Wintry', 'Festive', 'Plucky', 'Peppy', 'Dazzling', 'Glowing', 'Nifty', 'Spry'];
  const XB = ['Gingerbread', 'Peppermint', 'Candy Cane', 'Mistletoe', 'Holly', 'Cocoa', 'Eggnog', 'Snowflake', 'Sleigh Bell', 'Sugarplum', 'Tinsel', 'Chestnut',
    'Cranberry', 'Marshmallow', 'Fruitcake', 'Pinecone', 'Icicle', 'Snowball', 'Ornament', 'Stocking', 'Wreath', 'Cinnamon', 'Nutmeg', 'Garland', 'Toffee',
    'Fireside', 'Northpole', 'Velvet', 'Frost', 'Starlight'];
  // the last word: the gifts of "The Twelve Days of Christmas"
  const XC = ['Partridge', 'Turtle Dove', 'French Hen', 'Calling Bird', 'Golden Ring', 'Goose', 'Swan', 'Milkmaid', 'Dancing Lady', 'Leaping Lord',
    'Piper', 'Drummer'];
  function xmasName(id) {
    let h = 2166136261;                                  // FNV-1a: the same id, the same name
    for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return `${XA[h % 30]} ${XB[Math.floor(h / 30) % 30]} ${XC[Math.floor(h / 900) % XC.length]}`;
  }
  // Visits: a visitor's events with no gap over 30 minutes; each request with how it went.
  // Over the whole log (90 days), so a phone is "new" only on its very first visit, and its rank (how active it is,
  // against every phone seen) doesn't depend on the days shown.
  function summary(days) {
    const since = Date.now() - days * 864e5;
    const ev = readLog(KEEP_DAYS), byT = {}, visits = [], open = {}, names = {}, taken = {};
    const nameOf = (id) => {                             // unique in the list: a clash gets the next name along
      if (names[id]) return names[id];
      let n = xmasName(id);
      for (let k = 1; taken[n] && taken[n] !== id; k++) n = xmasName(id + '#' + k);
      taken[n] = id; return (names[id] = n);
    };
    for (const e of ev) if (e.t && ['played', 'done', 'cut', 'skipped', 'removed', 'dropped', 'cancelled'].includes(e.k)) (byT[e.t] = byT[e.t] || []).push(e);
    for (const e of ev) {
      if (!e.v && !e.who) continue;
      if (['played', 'done', 'cut', 'skipped', 'removed', 'dropped'].includes(e.k) && !e.v) continue; // the tree's own notes join their request below
      const id = e.v || e.who, cur = open[id];
      const vs = cur && e.at - cur.last <= 30 * 60000 ? cur : (open[id] = { id, visitor: nameOf(id), code: String(id).slice(0, 6), dev: e.dev || '', start: e.at, last: e.at, looked: [], cats: [], sent: [], refused: [], geo: null, dist: null });
      if (vs !== cur) visits.push(vs);
      vs.last = e.at; if (e.dev && !vs.dev) vs.dev = e.dev;
      if (e.k === 'pick' && e.name && !vs.looked.includes(e.name)) vs.looked.push(e.name);
      if (e.k === 'cat' && e.c && !vs.cats.includes(e.c)) vs.cats.push(e.c);
      if (e.k === 'geo-denied') vs.geo = 'refused to share location';
      if (e.k === 'share') vs.shared = true;
      if (e.k === 'game') vs.game = true;
      if (e.k === 'sent') {
        if (e.dist != null) vs.dist = e.dist;
        const what = byT[e.t] || [], pl = what.find((x) => x.k === 'played'), end = what.find((x) => x.k !== 'played');
        vs.sent.push({ at: e.at, name: e.name, msg: e.msg || '', colors: e.colors || [], played: pl ? pl.at : null,
          outcome: end ? end.k : pl ? 'played' : 'waiting' });
      }
      if (e.k === 'refused' && e.why !== 'flood' && !/^One moment/.test(e.reason || '')) vs.refused.push({ at: e.at, reason: e.reason, why: e.why }); // (quick taps aren't turn-aways)
    }
    // each phone: its visits in order, and a score (sends count most, then visits, then designs looked at) to rank it
    const per = {};
    for (const v of visits) { const q = per[v.id] = per[v.id] || { n: 0, score: 0 }; v.nth = ++q.n; q.score += 2 + v.sent.length * 3 + v.looked.length * 0.5; }
    const order = Object.keys(per).sort((a, b) => per[b].score - per[a].score), phones = order.length;
    order.forEach((id, i) => { per[id].rank = i + 1; });
    for (const v of visits) {
      const q = per[v.id];
      v.visits = q.n; v.rank = q.rank; v.phones = phones;
      v.level = q.n < 2 ? '' : q.rank <= Math.max(1, Math.ceil(phones * 0.1)) ? 'Superfan' : q.rank <= Math.ceil(phones * 0.33) ? 'Regular' : 'Drops by';
      delete v.id;
    }
    return visits.filter((v) => v.last >= since).sort((a, b) => b.last - a.last).slice(0, 300); // most recently active first
  }
  prune(); setInterval(prune, 864e5).unref();

  async function local() {
    if (!cloud) {
      cloud = await import(path.join(__dirname, 'guestcloud', 'index.mjs'));
      cloud.useStore(await cloud.fileStore(path.join(ctx.dataDir, 'guest-queue.json')));
    }
    return cloud;
  }
  // The sample site's HTTP API (tree-show serves it at /external/api/...).
  async function serveLocal(method, apiPath, query, body, ip, ua) {
    const c = await local();
    const ev = { requestContext: { http: { method, sourceIp: ip || 'local' } }, rawPath: '/api/' + apiPath, headers: { 'user-agent': ua || '' }, queryStringParameters: query, body: body == null ? '' : body };
    return c.handler(ev);
  }

  function state() {
    const c = ctx.cfg();
    if (!c.enabled) return { open: false, why: 'closed', reason: 'The tree isn’t taking requests right now.' };
    if (c.paused) return { open: false, why: 'paused', reason: c.note || 'Requests are paused right now. Check back soon!' };
    if (c.anyTime) { if (ctx.live()) return { open: false, why: 'live', reason: 'Someone’s playing the tree live right now. Check back in a minute.' }; return { open: true, reason: null }; }
    const s = ctx.scheduleOn();
    if (!s.on) return { open: false, why: 'resting', back: s.back || null, reason: s.back ? `The tree is resting. Requests open again ${s.back}.` : 'The tree is resting right now.' };
    if (!ctx.running()) return { open: false, why: 'closed', reason: 'The tree is off right now.' };
    if (ctx.live()) return { open: false, why: 'live', reason: 'Someone’s playing the tree live right now. Check back in a minute.' };
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
      const loc = ctx.location(); // nearby only: the tree's spot (the schedule's location) goes to the guest site, never to guests
      const body = { geo: c.geo && loc ? { lat: loc.lat, lon: loc.lon, radius: c.radius } : null, open: st.open, reason: st.reason, why: st.why || null, back: st.back || null, sec: c.sec, limits: { lineMin: c.lineMin }, now: cur ? { t: cur.t, left: Math.max(0, Math.round((cur.ends - Date.now()) / 1000)) } : null };
      body.evAfter = evSeq;
      if (clearAsk) body.clear = true;
      if (drop.length) body.drop = drop.slice();
      const cat = catalog(); if (cat.hash !== cloudHash) body.catalog = cat;
      let r;
      if (c.url) { if (!c.key) throw new Error('set the guest site key'); r = await post(c.url, c.key, body); }
      else { const m = await local(); r = JSON.parse((await m.treeSync(body, Date.now())).body); }
      if (body.clear) clearAsk = false;
      if (body.drop) drop = drop.filter((t) => !body.drop.includes(t));
      took(r);
      items = (r.items || []).filter((it) => !played.has(it.t)); cloudHash = r.catalogHash; lastOk = Date.now(); lastErr = null;
    } catch (e) {
      if (lastErr !== e.message) ctx.log('Guest requests:', e.message); lastErr = e.message;
    } finally { busy = false; }
  }

  function start(it) {
    const d = ctx.getDesign(it.id), msg = String(it.msg || '').toUpperCase();
    played.add(it.t); if (played.size > 500) played.delete(played.values().next().value);
    if (!d || !FONT.test(msg)) { drop.push(it.t); note([{ at: Date.now(), k: 'dropped', t: it.t }]); return false; }
    const c = ctx.cfg(), look = GL.guestLook(d.look, it.colors || [], msg);
    const name = d.name + (msg ? ' · “' + msg.replace(/</g, '♥') + '”' : '') + ' (guest)';
    const gd = { id: 'guest:' + it.t, name, look };
    const woke = !ctx.running();                 // only with the testing override: the tree was off
    ctx.player.playDesign(gd, c.sec, true);
    cur = { t: it.t, id: gd.id, ends: Date.now() + c.sec * 1000, name, woke: cur && cur.woke ? true : woke };
    note([{ at: Date.now(), k: 'played', t: it.t, name: d.name, msg }]);
    ctx.log(`Guest request: ${name}`);
    return true;
  }
  function finish(how) {
    if (cur) note([{ at: Date.now(), k: how || 'done', t: cur.t }]);
    const woke = cur && cur.woke; cur = null;
    const st = state();
    while (st.open && items.length) { if (start(items.shift())) { if (woke) cur.woke = true; return; } }
    if (woke) { ctx.player.stop(); return; }     // the override woke it: back to sleep
    if (!ctx.running()) return;
    const hold = ctx.holdDesign();
    if (hold) ctx.player.playDesign(hold, 60, true); else ctx.player.next(); // back to the held design or the playlist
  }

  async function tick() {
    if (cur) {
      const p = ctx.player.cur;
      if (!p || p.d.id !== cur.id || !ctx.player.running) { note([{ at: Date.now(), k: 'cut', t: cur.t }]); cur = null; return; } // someone played something else: the guest's turn ends
      if (Date.now() >= cur.ends) { finish(cur.skip ? 'skipped' : 'done'); sync(true); }
      return;
    }
    if (state().open && items.length) { while (items.length && !start(items.shift())); if (cur) sync(true); }
  }

  const timers = [];
  return {
    start() { timers.push(setInterval(() => sync(false), 1000), setInterval(tick, 500)); sync(true); },
    sync, serveLocal, playing: () => !!cur,
    clear() { clearAsk = true; items = []; sync(true); },
    skip() { if (cur) { cur.skip = true; cur.ends = 0; tick(); } },
    remove(t) { t = String(t); items = items.filter((x) => x.t !== t); played.add(t); drop.push(t); note([{ at: Date.now(), k: 'removed', t }]); sync(true); }, // the owner takes one out of the line
    summary, log: (days) => readLog(days),
    // what the tree's own page shows while a guest's pick plays: whose design, how long it has left, and how many wait
    playing() { return cur ? { name: cur.name, left: Math.max(0, Math.round((cur.ends - Date.now()) / 1000)), waiting: items.length } : null; },
    status() {
      const c = ctx.cfg(), st = state();
      return { enabled: c.enabled, paused: c.paused, geo: c.geo, geoReady: !!ctx.location(), open: st.open, reason: st.reason, site: c.url || null, waiting: items.length,
        now: cur ? { name: cur.name, left: Math.max(0, Math.round((cur.ends - Date.now()) / 1000)) } : null,
        items: items.map((it) => { const d = ctx.getDesign(it.id); return { t: it.t, name: d ? d.name : it.name || it.id, msg: it.msg || '', colors: it.colors || [], age: Math.round((Date.now() - (it.at || Date.now())) / 1000) }; }),
        lastContact: lastOk ? Math.round((Date.now() - lastOk) / 1000) : null, error: lastErr };
    },
  };
}

module.exports = { create, clean, publicCfg, DEFAULTS };
