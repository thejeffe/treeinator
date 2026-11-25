// Treeinator guest requests: the API behind t.<domain>/api/*, a Lambda function URL behind CloudFront.
//
//   guests (phone)  --HTTPS-->  CloudFront  --/api/*-->  this function  <--polls every few seconds--  tree-show (home)
//
// The queue lives in one DynamoDB item (k = 'queue'), the design list in another (k = 'catalog'). Writes are conditional
// on a version number, so two requests at the same moment can't lose each other. The home server only ever calls out
// (POST /api/tree with the tree key), so nothing at home is reachable from the internet.
//
// Environment: TABLE (DynamoDB table), TREE_KEY (secret shared with tree-show), ORIGIN_KEY (secret header CloudFront
// adds, so the function URL can't be used directly), SALT (for hashing guests' addresses).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { checkMessage } from './words.mjs';

// How much one phone (address) may line up. The line is measured in tree time: `lineMin` minutes (set in tree-show,
// Settings -> Guests, sent with each check-in) is `cap` requests at `sec` seconds each.
//  - quiet (the whole line is shorter than that): anyone may line up to `cap` of their own
//  - busy (the line is that long or longer): a fair share each, cap / (guests waiting, counting a newcomer), at least 1,
//    so a newcomer always gets a turn and nobody fills the line
// Only scripts are stopped otherwise: QUEUE_MAX in the whole line, FLOOD_N requests per FLOOD_MS per phone.
const QUEUE_MAX = 60, FLOOD_N = 5, FLOOD_MS = 10000; // scripts only: more than 5 requests in 10 s from one phone
function share(q, who) {
  const lineMin = Math.max(1, Math.min(60, +((q.limits || {}).lineMin) || 10));
  const cap = Math.max(1, Math.floor(lineMin * 60 / (q.sec || 45)));
  const busy = q.items.length >= cap;
  if (!busy) return { cap, busy, max: cap, lineMin };
  const guests = new Set(q.items.map((x) => x.who));
  if (who) guests.add(who);
  return { cap, busy, max: Math.max(1, Math.floor(cap / Math.max(1, guests.size))), lineMin };
}
const TREE_STALE_MS = 30 * 1000; // no word from the tree for this long: requests are closed
const COLOR = /^#[0-9a-f]{6}$/;

// ---------- storage (DynamoDB, or an in-memory stand-in for tests) ----------
let store = null;
export function useStore(s) { store = s; }
async function dynamoStore() {
  const { DynamoDBClient, GetItemCommand, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
  const db = new DynamoDBClient({}), T = process.env.TABLE;
  return {
    async get(k) {
      const r = await db.send(new GetItemCommand({ TableName: T, Key: { k: { S: k } }, ConsistentRead: true }));
      return r.Item ? { v: +r.Item.v.N, d: JSON.parse(r.Item.d.S) } : null;
    },
    async put(k, d, v) { // v = the version read (0 = new); false if someone else wrote meanwhile
      try {
        await db.send(new PutItemCommand({ TableName: T, Item: { k: { S: k }, v: { N: String(v + 1) }, d: { S: JSON.stringify(d) } },
          ConditionExpression: v ? 'v = :v' : 'attribute_not_exists(k)', ExpressionAttributeValues: v ? { ':v': { N: String(v) } } : undefined }));
        return true;
      } catch (e) { if (e.name === 'ConditionalCheckFailedException') return false; throw e; }
    },
  };
}
// A JSON file (the sample site tree-show hosts at /external).
export async function fileStore(file) {
  const fs = await import('node:fs');
  let m = {}; try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* new */ }
  let timer = null;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(m)); fs.renameSync(file + '.tmp', file); } catch (e) { console.error('guest queue not saved:', e.message); } }, 300); };
  return {
    async get(k) { const x = m[k]; return x ? { v: x.v, d: JSON.parse(x.d) } : null; },
    async put(k, d, v) { const x = m[k]; if ((x ? x.v : 0) !== v) return false; m[k] = { v: v + 1, d: JSON.stringify(d) }; save(); return true; },
  };
}
export function memoryStore() {
  const m = new Map();
  return {
    async get(k) { const x = m.get(k); return x ? { v: x.v, d: JSON.parse(x.d) } : null; },
    async put(k, d, v) { const x = m.get(k); if ((x ? x.v : 0) !== v) return false; m.set(k, { v: v + 1, d: JSON.stringify(d) }); return true; },
  };
}

const EMPTY = () => ({ items: [], now: null, open: false, seen: 0, sec: 45, rate: {}, reason: 'The tree hasn’t checked in yet.' });
// Read, change, write; again if another request wrote in between.
async function update(k, fn, empty) {
  for (let i = 0; i < 8; i++) {
    const cur = await store.get(k), d = cur ? cur.d : empty();
    const out = await fn(d);
    if (out && out.skip) return out;
    if (await store.put(k, d, cur ? cur.v : 0)) return out;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
  }
  throw httpError(503, 'Busy right now. Try again.');
}

// ---------- activity log ----------
// What guests did, for the owner: the page reports opens and taps (POST /api/log, in batches), this function adds what
// it decides (sent, refused, cancelled). Kept in the 'events' item (the newest EVENTS_MAX, numbered); tree-show
// collects them as it checks in (evAfter) and keeps its own log, where it also notes what played.
// A visitor is a random id the page keeps on the phone (v), plus a hash of the address (who); no names, no addresses.
const EVENTS_MAX = 2000, CLIENT_KINDS = ['open', 'cat', 'pick', 'color', 'line', 'reload', 'geo-ok', 'geo-denied', 'geo-far', 'leave', 'share', 'game'];
function device(ev) {
  const ua = String((ev.headers || {})['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const br = /CriOS|Chrome\//.test(ua) && !/Edg/.test(ua) ? (/SamsungBrowser/.test(ua) ? 'Samsung' : 'Chrome') : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Edg/.test(ua) ? 'Edge' : /Safari/.test(ua) ? 'Safari' : 'Other';
  return os + ' · ' + br;
}
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
async function logEvents(list) {
  if (!list.length) return;
  await update('events', (E) => {
    for (const e of list) E.list.push(Object.assign({ seq: ++E.seq }, e));
    if (E.list.length > EVENTS_MAX) E.list.splice(0, E.list.length - EVENTS_MAX);
    return {};
  }, () => ({ seq: 0, list: [] }));
}

// ---------- helpers ----------
function httpError(code, msg, why) { const e = new Error(msg); e.status = code; if (why) e.why = why; return e; }
// Nearby only (q.geo = { lat, lon, radius } from the tree): metres between two points.
function meters(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180, x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2);
  return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
}
function far(m) { // in feet and miles: "800 ft", "2.1 miles", "14 miles"
  const ft = m * 3.28084, mi = m / 1609.344;
  return ft < 1000 ? Math.max(10, Math.round(ft / 10) * 10) + ' ft' : mi < 10 ? mi.toFixed(1) + ' miles' : Math.round(mi) + ' miles';
}
function reply(code, body, cache) {
  return { statusCode: code, headers: { 'content-type': 'application/json', 'cache-control': cache || 'no-store' }, body: JSON.stringify(body) };
}
function sameSecret(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function guestId(ev) { // a hash of the guest's address (never stored as is)
  const h = ev.headers || {}, v = h['cloudfront-viewer-address'];
  const ip = v ? v.slice(0, v.lastIndexOf(':')) : (ev.requestContext && ev.requestContext.http && ev.requestContext.http.sourceIp) || 'unknown';
  return createHash('sha256').update((process.env.SALT || '') + ip).digest('base64url').slice(0, 16);
}
function treeOpen(q, now) { return q.open && now - q.seen < TREE_STALE_MS; }
// What everyone may see: no addresses or tickets.
function publicQueue(q, now, mine) { // mine: the guest's own tickets (a Set)
  const isMine = (x) => !!mine && mine.has(x);
  const open = treeOpen(q, now);
  return {
    open, why: open ? null : now - q.seen >= TREE_STALE_MS ? 'offline' : q.why || 'closed', back: open ? null : q.back || null,
    reason: open ? null : now - q.seen >= TREE_STALE_MS ? 'The tree isn’t taking requests right now.' : q.reason || 'The tree isn’t taking requests right now.',
    geo: !!q.geo, sec: q.sec, perGuest: share(q).max, busy: share(q).busy, cat: q.catHash || null, // cat: the design list's version
    show: open && !q.now && q.show ? { name: q.show.name, left: q.show.ends ? Math.max(0, Math.round((q.show.ends - now) / 1000)) : null, mode: q.show.mode, next: q.show.next } : null,
    now: q.now ? { name: q.now.name, msg: q.now.msg, colors: q.now.colors, left: Math.max(0, Math.round((q.now.ends - now) / 1000)), mine: isMine(q.now.t) } : null,
    items: q.items.map((it, i) => Object.assign({ pos: i + 1, name: it.name, msg: it.msg, colors: it.colors, mine: isMine(it.t) }, isMine(it.t) ? { t: it.t } : {})),
  };
}

// ---------- the API ----------
export async function handler(ev) {
  try {
    if (!store) store = await dynamoStore();
    const h = ev.headers || {};
    if (process.env.ORIGIN_KEY && !sameSecret(h['x-origin-key'], process.env.ORIGIN_KEY)) return reply(403, { error: 'Forbidden' });
    const method = ev.requestContext.http.method, path = ev.rawPath || '/';
    let body = {};
    if (method === 'POST') {
      const raw = ev.body ? (ev.isBase64Encoded ? Buffer.from(ev.body, 'base64').toString('utf8') : ev.body) : '';
      if (raw.length > 400000) return reply(413, { error: 'Too large' });
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return reply(400, { error: 'Not JSON' }); }
    }
    const now = Date.now();

    if (path === '/api/queue' && method === 'GET') {
      const q = (await store.get('queue')) || { d: EMPTY() };
      // the guest's own tickets (t=a,b,c): marks their requests
      const mine = new Set(String((ev.queryStringParameters || {}).t || '').split(',').slice(0, 25).map((x) => x.slice(0, 40)).filter(Boolean));
      return reply(200, publicQueue(q.d, now, mine));
    }
    if (path === '/api/catalog' && method === 'GET') {
      const c = await store.get('catalog');
      return reply(200, c ? c.d : { hash: null, designs: [], favorites: [], layout: null }, 'public, max-age=30'); // pages ask with ?h=<hash> when it changed
    }
    if (path === '/api/request' && method === 'POST') {
      const base = { at: now, v: clip(body.v, 16), who: guestId(ev), dev: device(ev) };
      try {
        const r = await request(ev, body, now), j = JSON.parse(r.body);
        await logEvents([Object.assign(base, { k: 'sent', t: j.t, id: clip(body.id, 40), name: j.name, msg: j.msg, colors: body.colors || [], dist: j.dist, pos: j.pos })]);
        delete j.name; delete j.dist; r.body = JSON.stringify(j);
        return r;
      } catch (e) {
        if (e.status && e.status < 500 && e.why !== 'flood') await logEvents([Object.assign(base, { k: 'refused', id: clip(body.id, 40), why: e.why || null, reason: clip(e.message, 160), msg: clip(body.msg, 30) })]).catch(() => {});
        throw e;
      }
    }
    if (path === '/api/log' && method === 'POST') { // the page's batch of opens and taps
      const v = clip(body.v, 16), who = guestId(ev), dev = device(ev);
      const list = (Array.isArray(body.ev) ? body.ev : []).slice(0, 30).filter((e) => e && CLIENT_KINDS.includes(e.k)).map((e) => ({
        at: Math.min(now, Math.max(now - 3600000, +e.at || now)), k: e.k, v, who, dev,
        id: e.id ? clip(e.id, 40) : undefined, name: e.name ? clip(e.name, 60) : undefined, c: e.c ? clip(e.c, 60) : undefined }));
      await logEvents(list);
      return reply(200, { ok: true });
    }
    if (path === '/api/cancel' && method === 'POST') {
      const t = String(body.t || '');
      const out = await update('queue', (q) => {
        const i = q.items.findIndex((x) => x.t === t);
        if (i < 0) return { skip: true, ok: false };
        q.items.splice(i, 1); return { ok: true };
      }, EMPTY);
      if (out.ok) await logEvents([{ at: now, k: 'cancelled', t, v: clip(body.v, 16), who: guestId(ev), dev: device(ev) }]);
      return reply(out.ok ? 200 : 404, out.ok ? { ok: true } : { error: 'That request isn’t waiting any more.' });
    }
    if (path === '/api/tree' && method === 'POST') {
      if (!sameSecret(h['x-tree-key'], process.env.TREE_KEY)) return reply(403, { error: 'Wrong tree key' });
      return await treeSync(body, now);
    }
    return reply(404, { error: 'Not found' });
  } catch (e) {
    if (!e.status) console.error(e);
    return reply(e.status || 500, Object.assign({ error: e.status ? e.message : 'Something went wrong.' }, e.why ? { why: e.why } : {}));
  }
}

async function request(ev, b, now) {
  const cat = await store.get('catalog');
  const designs = cat ? cat.d.designs : [];
  const d = designs.find((x) => x.id === String(b.id || ''));
  if (!d) throw httpError(400, 'Pick a design.');
  const colors = (Array.isArray(b.colors) ? b.colors : []).slice(0, 2).map((c) => String(c).toLowerCase());
  if (colors.some((c) => !COLOR.test(c))) throw httpError(400, 'Those colors don’t look right.');
  const m = checkMessage(b.msg);
  if (!m.ok) throw httpError(400, m.error);
  const who = guestId(ev), t = randomBytes(12).toString('base64url');
  let dist = null; // how far from the tree, when the phone said (for the owner's log; rounded to 10 m)
  const out = await update('queue', (q) => {
    if (!treeOpen(q, now)) throw httpError(409, publicQueue(q, now).reason);
    if (q.geo) { // only people near the tree (the phone's own reading; its accuracy is allowed for, up to 300 m)
      const la = +b.lat, lo = +b.lon, acc = Math.min(300, Math.max(0, +b.acc || 0));
      if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) throw httpError(428, 'Share your location so we know you’re near the tree.', 'location');
      const d = meters(la, lo, q.geo.lat, q.geo.lon); dist = d;
      if (d - acc > q.geo.radius) throw httpError(403, `You need to be near the tree to light it up. You’re about ${far(d)} away. Come by and try again!`, 'far');
    }
    for (const k in q.rate) { const v = (Array.isArray(q.rate[k]) ? q.rate[k] : [q.rate[k]]).filter((x) => now - x < FLOOD_MS); if (v.length) q.rate[k] = v; else delete q.rate[k]; }
    if ((q.rate[who] || []).length >= FLOOD_N) throw httpError(429, 'Whoa, that’s fast! Try again in a few seconds.', 'flood');
    const S = share(q, who), mine = q.items.filter((x) => x.who === who).length;
    if (mine >= S.max) throw httpError(429, S.busy
      ? `The line is busy, so everyone gets a turn: you have ${mine} waiting. You can add another when one of yours has played.`
      : `You have ${S.lineMin} minutes of the tree lined up already. You can add another when one of yours has played.`);
    if (q.items.length >= QUEUE_MAX) throw httpError(429, 'The queue is full right now. Try again in a few minutes.');
    // Fair turns (start-time fair queuing): each request gets a slot, the time it would start if its phone had the
    // tree to itself: now, or one play after that phone's previous request, whichever is later. The line is in slot
    // order. So busy phones take turns (A, B, A, B...), a newcomer goes in at "now" (ahead of the extra requests a busy
    // phone lined up), and nothing played earlier counts against anyone: no phone waits more than about one turn per
    // other phone that's using the tree.
    const step = (q.sec || 45) * 1000, slot = Math.max(now, ((q.slot || {})[who] || 0) + step);
    let at = q.items.length;
    for (let i = 0; i < q.items.length; i++) if ((q.items[i].slot || q.items[i].at) > slot) { at = i; break; }
    q.items.splice(at, 0, { t, who, id: d.id, name: d.name, colors, msg: m.text, at: now, slot });
    q.slot = q.slot || {}; q.slot[who] = slot;
    for (const k in q.slot) if (q.slot[k] < now - 3600000) delete q.slot[k];
    q.rate[who] = (q.rate[who] || []).concat(now);
    return { pos: at + 1 };
  }, EMPTY);
  return reply(200, { ok: true, t, pos: out.pos, msg: m.text, name: d.name, dist: dist == null ? undefined : Math.round(dist / 10) * 10 });
}

// The tree checks in: whether it takes requests, what it's playing (a guest ticket, which leaves the queue), its
// design list when that changed. It gets back the waiting requests.
export async function treeSync(b, now) {
  if (!store) store = await dynamoStore();
  const sec = Math.max(10, Math.min(600, Math.round(+b.sec || 45)));
  if (b.catalog && b.catalog.hash) {
    const c = b.catalog;
    const designs = (Array.isArray(c.designs) ? c.designs : []).slice(0, 1000).map((x) => ({ id: String(x.id).slice(0, 40), name: String(x.name).slice(0, 60), cat: String(x.cat || '').slice(0, 40), look: x.look || {} }));
    const data = { hash: String(c.hash).slice(0, 64), title: String(c.title || '').slice(0, 40), designs, favorites: (Array.isArray(c.favorites) ? c.favorites : []).map(String).slice(0, 100), layout: c.layout || null, at: now };
    if (JSON.stringify(data).length > 380000) throw httpError(413, 'Design list too large');
    for (let i = 0; i < 5; i++) { const cur = await store.get('catalog'); if (await store.put('catalog', data, cur ? cur.v : 0)) break; }
  }
  const out = await update('queue', (q) => {
    if (b.clear) { q.items = []; q.slot = {}; }                    // the owner cleared the queue
    delete q.played;                                               // (older versions counted plays for 30 minutes)
    if (Array.isArray(b.drop)) q.items = q.items.filter((x) => !b.drop.includes(x.t)); // requests the tree can't play
    q.open = !!b.open; q.seen = now; q.sec = sec;
    q.show = b.show && b.show.name ? { name: String(b.show.name).slice(0, 60), ends: b.show.left == null ? null : now + Math.max(0, +b.show.left || 0) * 1000,
      mode: ['order', 'shuffle', 'random'].includes(b.show.mode) ? b.show.mode : 'order', next: (Array.isArray(b.show.next) ? b.show.next : []).slice(0, 10).map((x) => String(x).slice(0, 60)) } : null;
    q.geo = b.geo && isFinite(+b.geo.lat) && isFinite(+b.geo.lon) ? { lat: +b.geo.lat, lon: +b.geo.lon, radius: Math.max(30, Math.min(5000, +b.geo.radius || 200)) } : null;
    q.why = b.open ? null : ['paused', 'resting', 'live', 'closed'].includes(b.why) ? b.why : 'closed'; q.back = b.open ? null : String(b.back || '').slice(0, 40) || null;
    if (b.limits) q.limits = { lineMin: +b.limits.lineMin }; q.reason = b.open ? null : String(b.reason || 'The tree isn’t taking requests right now.').slice(0, 120);
    const n = b.now && b.now.t ? b.now : null;
    if (n) {
      const i = q.items.findIndex((x) => x.t === n.t);
      const it = i >= 0 ? q.items.splice(i, 1)[0] : q.now && q.now.t === n.t ? q.now : null;
      if (it) q.now = { t: it.t, name: it.name, msg: it.msg, colors: it.colors, ends: now + Math.max(0, +n.left || 0) * 1000 };
    } else q.now = null;
    return { items: q.items.map(({ t, id, name, colors, msg, at }) => ({ t, id, name, colors, msg, at })) };
  }, EMPTY);
  const cat = await store.get('catalog');
  const h = cat ? cat.d.hash : null;
  if (h) await update('queue', (q) => (q.catHash === h ? { skip: true } : (q.catHash = h, {})), EMPTY); // pages reload the list when it changes
  // the activity since the tree last collected it
  let events = [], lastSeq = 0;
  if (b.evAfter != null) { const E = await store.get('events'); if (E) { lastSeq = E.d.seq; events = E.d.list.filter((e) => e.seq > +b.evAfter).slice(0, 500); } }
  return reply(200, { items: out.items, catalogHash: h, events, lastSeq });
}
