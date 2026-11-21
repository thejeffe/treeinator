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

const QUEUE_MAX = 30;            // waiting requests
const GAP_MS = 60 * 1000;        // one request per phone (address) per minute, and one waiting at a time
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

// ---------- helpers ----------
function httpError(code, msg) { const e = new Error(msg); e.status = code; return e; }
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
function publicQueue(q, now, t) {
  const open = treeOpen(q, now);
  return {
    open, reason: open ? null : now - q.seen >= TREE_STALE_MS ? 'The tree isn’t taking requests right now.' : q.reason || 'The tree isn’t taking requests right now.',
    sec: q.sec,
    now: q.now ? { name: q.now.name, msg: q.now.msg, colors: q.now.colors, left: Math.max(0, Math.round((q.now.ends - now) / 1000)), mine: !!t && q.now.t === t } : null,
    items: q.items.map((it, i) => ({ pos: i + 1, name: it.name, msg: it.msg, colors: it.colors, mine: !!t && it.t === t })),
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
      const t = ((ev.queryStringParameters || {}).t || '').slice(0, 40); // the guest's own ticket: marks their request
      return reply(200, publicQueue(q.d, now, t));
    }
    if (path === '/api/catalog' && method === 'GET') {
      const c = await store.get('catalog');
      return reply(200, c ? c.d : { hash: null, designs: [], favorites: [], layout: null }, 'public, max-age=30');
    }
    if (path === '/api/request' && method === 'POST') return await request(ev, body, now);
    if (path === '/api/cancel' && method === 'POST') {
      const t = String(body.t || '');
      const out = await update('queue', (q) => {
        const i = q.items.findIndex((x) => x.t === t);
        if (i < 0) return { skip: true, ok: false };
        q.items.splice(i, 1); return { ok: true };
      }, EMPTY);
      return reply(out.ok ? 200 : 404, out.ok ? { ok: true } : { error: 'That request isn’t waiting any more.' });
    }
    if (path === '/api/tree' && method === 'POST') {
      if (!sameSecret(h['x-tree-key'], process.env.TREE_KEY)) return reply(403, { error: 'Wrong tree key' });
      return await treeSync(body, now);
    }
    return reply(404, { error: 'Not found' });
  } catch (e) {
    if (!e.status) console.error(e);
    return reply(e.status || 500, { error: e.status ? e.message : 'Something went wrong.' });
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
  const out = await update('queue', (q) => {
    if (!treeOpen(q, now)) throw httpError(409, publicQueue(q, now).reason);
    for (const k in q.rate) if (now - q.rate[k] > GAP_MS) delete q.rate[k];
    if (q.items.some((x) => x.who === who)) throw httpError(429, 'You already have a request waiting. Once it’s on the tree you can pick another.');
    if (q.rate[who]) throw httpError(429, 'One request a minute, please. Try again in a moment.');
    if (q.items.length >= QUEUE_MAX) throw httpError(429, 'The queue is full right now. Try again in a few minutes.');
    q.items.push({ t, who, id: d.id, name: d.name, colors, msg: m.text, at: now });
    q.rate[who] = now;
    return { pos: q.items.length };
  }, EMPTY);
  return reply(200, { ok: true, t, pos: out.pos, msg: m.text });
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
    if (b.clear) q.items = [];                                     // the owner cleared the queue
    if (Array.isArray(b.drop)) q.items = q.items.filter((x) => !b.drop.includes(x.t)); // requests the tree can't play
    q.open = !!b.open; q.seen = now; q.sec = sec; q.reason = b.open ? null : String(b.reason || 'The tree isn’t taking requests right now.').slice(0, 120);
    const n = b.now && b.now.t ? b.now : null;
    if (n) {
      const i = q.items.findIndex((x) => x.t === n.t);
      const it = i >= 0 ? q.items.splice(i, 1)[0] : q.now && q.now.t === n.t ? q.now : null;
      if (it) q.now = { t: it.t, name: it.name, msg: it.msg, colors: it.colors, ends: now + Math.max(0, +n.left || 0) * 1000 };
    } else q.now = null;
    return { items: q.items.map(({ t, id, name, colors, msg, at }) => ({ t, id, name, colors, msg, at })) };
  }, EMPTY);
  const cat = await store.get('catalog');
  return reply(200, { items: out.items, catalogHash: cat ? cat.d.hash : null });
}
