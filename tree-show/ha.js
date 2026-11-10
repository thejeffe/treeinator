'use strict';
// Home Assistant over MQTT: tree-show shows up in HA as a device (MQTT discovery), no YAML needed in HA.
// Topics (base = "treeinator" unless changed in Settings -> Home Assistant):
//   <base>/status         online / offline (last will)
//   <base>/state/<key>    retained states        <base>/cmd/<key>   commands from HA
//   <prefix>/device/<base>/config                the discovery message (prefix = "homeassistant")
// A small built-in MQTT 3.1.1 client (QoS 0), so there is nothing to install. server.js passes in ctx, the same
// functions its web API uses, so HA and the page behave the same.
const net = require('net');

const DEFAULTS = { enabled: false, host: 'homeassistant.local', port: 1883, username: '', password: '', base: 'treeinator', prefix: 'homeassistant' };
const NAME_RE = /^[a-z0-9_-]{1,40}$/;
const NONE = '—';
const DIMMING = [['off', 'Off'], ['spatial', 'Spatial'], ['hue', 'Hue'], ['temporal', 'Temporal']];
const STATE_MS = 2000, OPTIONS_MS = 30000, RETRY_MS = 15000, KEEPALIVE = 30;

// ---------- MQTT packets ----------
function str(s) { const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
function varLen(n) { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; o.push(b); } while (n); return Buffer.from(o); }
function pkt(h, body) { return Buffer.concat([Buffer.from([h]), varLen(body.length), body]); }
const REFUSED = { 1: 'wrong MQTT version', 2: 'client id rejected', 3: 'broker unavailable', 4: 'wrong user name or password', 5: 'not authorized' };

function clean(m, old) { // settings from the page; an empty password keeps the saved one
  m = m || {}; old = Object.assign({}, DEFAULTS, old || {});
  const out = { enabled: m.enabled == null ? !!old.enabled : m.enabled === true };
  const host = String(m.host == null ? old.host : m.host).trim();
  if (host && !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host)) throw new Error('MQTT broker should be a hostname or IP address.');
  out.host = host;
  const port = Math.round(+(m.port == null ? old.port : m.port));
  if (!(port > 0 && port < 65536)) throw new Error('MQTT port should be between 1 and 65535 (usually 1883).');
  out.port = port;
  out.username = String(m.username == null ? old.username : m.username).trim().slice(0, 100);
  out.password = m.clearPassword ? '' : m.password ? String(m.password).slice(0, 200) : old.password || '';
  const base = String(m.base == null ? old.base : m.base).trim().toLowerCase();
  if (!NAME_RE.test(base)) throw new Error('MQTT topic name: use a-z, 0-9, - or _.');
  out.base = base; out.prefix = NAME_RE.test(old.prefix) ? old.prefix : DEFAULTS.prefix;
  return out;
}
function publicCfg(m) { const c = Object.assign({}, DEFAULTS, m || {}); c.passwordSet = !!c.password; delete c.password; return c; }

function create(ctx) {
  let sock = null, up = false, buf = Buffer.alloc(0), lastRx = 0, lastTx = 0, pid = 0;
  let sent = {}, disc = null, discKey = null, base = DEFAULTS.base, prefix = DEFAULTS.prefix, timers = [], retry = null, gen = 0;
  const status = { state: 'off', error: null, since: Date.now() };
  function setStatus(state, error) { if (state !== status.state) status.since = Date.now(); status.state = state; status.error = error || null; }
  function cfg() { const c = Object.assign({}, DEFAULTS, ctx.mqtt() || {}); if (!NAME_RE.test(c.base)) c.base = DEFAULTS.base; if (!NAME_RE.test(c.prefix)) c.prefix = DEFAULTS.prefix; return c; }
  function write(b) { if (sock && !sock.destroyed) { sock.write(b); lastTx = Date.now(); } }
  function publish(topic, payload, retain) { write(pkt(0x30 | (retain ? 1 : 0), Buffer.concat([str(topic), Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')]))); }

  function stop(cleanly) {
    timers.forEach(clearInterval); timers = []; clearTimeout(retry); retry = null;
    if (sock) {
      const s = sock; sock = null; up = false;
      if (cleanly && !s.destroyed) { try { s.write(pkt(0x31, Buffer.concat([str(base + '/status'), Buffer.from('offline')]))); s.end(pkt(0xE0, Buffer.alloc(0))); } catch (e) { s.destroy(); } }
      else s.destroy();
    }
  }
  function later() { clearTimeout(retry); retry = setTimeout(connect, RETRY_MS); }

  function connect() {
    stop(true);
    const c = cfg(), my = ++gen;
    if (!c.enabled || !c.host) { setStatus('off'); return; }
    base = c.base; prefix = c.prefix; setStatus('connecting');
    const s = net.connect({ host: c.host, port: c.port, timeout: 8000 }); sock = s; buf = Buffer.alloc(0);
    const fail = (msg) => {
      if (my !== gen) return;
      if (status.state !== 'error' || status.error !== msg) ctx.log(`Home Assistant (MQTT ${c.host}:${c.port}): ${msg}`);
      setStatus('error', msg); stop(false); later();
    };
    s.on('connect', () => {
      s.setTimeout(0);
      let flags = 0x02 | 0x04 | 0x20; // clean session, retained last will
      const parts = [str(`treeinator-${base}`), str(base + '/status'), str('offline')];
      if (c.username) { flags |= 0x80; parts.push(str(c.username)); if (c.password) { flags |= 0x40; parts.push(str(c.password)); } }
      const hdr = Buffer.concat([str('MQTT'), Buffer.from([4, flags, 0, KEEPALIVE])]);
      write(pkt(0x10, Buffer.concat([hdr, ...parts]))); lastRx = Date.now();
    });
    s.on('timeout', () => fail('no answer from the broker'));
    s.on('error', (e) => fail(e.code === 'ECONNREFUSED' ? 'connection refused (is the MQTT broker running?)' : e.message));
    s.on('close', () => { if (my === gen && sock === s) fail('the broker closed the connection'); });
    s.on('data', (d) => {
      lastRx = Date.now(); buf = Buffer.concat([buf, d]);
      for (;;) {
        let n = 0, mult = 1, i = 1;
        for (;;) { if (i >= buf.length) return; const b = buf[i++]; n += (b & 127) * mult; mult *= 128; if (!(b & 128)) break; if (i > 4) return fail('bad packet from the broker'); }
        if (buf.length < i + n) return;
        const head = buf[0], body = buf.subarray(i, i + n); buf = buf.subarray(i + n);
        const t = head >> 4;
        if (t === 2) { if (body[1]) return fail('broker refused: ' + (REFUSED[body[1]] || 'code ' + body[1])); online(c); }
        else if (t === 3) {
          const qos = (head >> 1) & 3, tl = body.readUInt16BE(0), topic = body.subarray(2, 2 + tl).toString('utf8'); let pos = 2 + tl;
          if (qos) { if (qos === 1) write(pkt(0x40, body.subarray(pos, pos + 2))); pos += 2; }
          onMessage(topic, Buffer.from(body.subarray(pos)));
        }
      }
    });
  }

  function online(c) {
    up = true; sent = {}; disc = null;
    if (discKey && discKey !== prefix + '/' + base) publish(`${discKey.split('/')[0]}/device/${discKey.split('/')[1]}/config`, '', true); // renamed: drop the old device
    pid = pid % 65535 + 1;
    const p = Buffer.alloc(2); p.writeUInt16BE(pid);
    write(pkt(0x82, Buffer.concat([p, str(base + '/cmd/#'), Buffer.from([0]), str(prefix + '/status'), Buffer.from([0])])));
    publishDiscovery(); publish(base + '/status', 'online', true); publishStates();
    setStatus('connected'); ctx.log(`Home Assistant: connected to MQTT ${c.host}:${c.port} as ${base}`);
    timers.push(setInterval(publishStates, STATE_MS), setInterval(publishDiscovery, OPTIONS_MS), setInterval(() => {
      if (Date.now() - lastTx >= KEEPALIVE * 500) write(Buffer.from([0xC0, 0])); // ping
      if (Date.now() - lastRx > KEEPALIVE * 1500 && sock) { sock.destroy(new Error('the broker stopped answering')); }
    }, 5000));
  }

  function onMessage(topic, payload) {
    if (topic === prefix + '/status') { if (payload.toString().trim() === 'online') { disc = null; sent = {}; publishDiscovery(); publishStates(); } return; }
    if (!topic.startsWith(base + '/cmd/')) return;
    const key = topic.slice(base.length + 5), v = payload.toString('utf8').trim();
    try { command(key, v); } catch (e) { ctx.log(`Home Assistant command ${key}=${JSON.stringify(v.slice(0, 80))} failed: ${e.message}`); }
    publishStates();
  }

  function command(key, v) {
    const pls = ctx.playlists(), des = ctx.designs();
    if (key === 'light') {
      let j; try { j = v.startsWith('{') ? JSON.parse(v) : { state: v.toUpperCase() }; } catch (e) { j = {}; }
      if (j.brightness != null) ctx.setBright(Math.max(5, Math.min(100, Math.round(+j.brightness))) / 100);
      if (j.state === 'ON' && !ctx.playing()) ctx.player({ action: 'play' });
      else if (j.state === 'OFF') ctx.player({ action: 'stop' });
    } else if (key === 'playlist') { const p = pls.find((x) => x.name === v); if (p) ctx.player({ action: 'play', playlist: p.id }); }
    else if (key === 'design') { const d = des.find((x) => x.name === v); if (d) ctx.player({ action: 'design', id: d.id, hold: true }); }
    else if (key === 'next') ctx.player({ action: ctx.holding() ? 'release' : 'next' });
    else if (key === 'resume') ctx.resume();
    else if (key === 'schedule') ctx.setSchedule(v.toUpperCase() === 'ON');
    else if (key === 'dimming') { const m = (DIMMING.find((x) => x[1] === v) || [])[0]; if (m) ctx.applySettings({ dither: Object.assign({}, ctx.settings().dither, { mode: m }) }); }
    else if (key === 'fps_auto') ctx.applySettings({ fpsAuto: v.toUpperCase() === 'ON' });
    else if (key === 'fps_max') ctx.applySettings({ fpsMax: Math.max(5, Math.min(120, Math.round(+v))) });
  }

  function states() {
    const st = ctx.status(), pl = st.player || {}, sc = st.schedule || {}, s = ctx.settings(), fps = ctx.wledFps();
    const mode = !sc.enabled ? 'Manual' : sc.following ? 'On schedule' : 'Override';
    return {
      light: JSON.stringify({ state: st.playing ? 'ON' : 'OFF', brightness: Math.round((st.bright || 1) * 100), color_mode: 'brightness' }),
      playlist: st.playlistName || NONE,
      design: st.playing && pl.hold && pl.name ? pl.name : NONE,
      showing: !st.playing ? 'Off' : st.live ? 'Live mixer' : (pl.name || 'Nothing') + (pl.hold ? ' (held)' : ''),
      mode, schedule: sc.enabled ? 'ON' : 'OFF',
      wled_fps: fps == null ? 'None' : String(fps),
      wled_online: st.wled && st.wled.resolved && !st.wled.error ? 'ON' : 'OFF',
      dimming: (DIMMING.find((x) => x[0] === (s.dither || {}).mode) || DIMMING[0])[1],
      fps_auto: s.fpsAuto ? 'ON' : 'OFF', fps_max: String(s.fpsMax),
    };
  }
  function publishStates() {
    if (!up) return;
    const s = states();
    for (const k in s) if (sent[k] !== s[k]) { publish(`${base}/state/${k}`, s[k], true); sent[k] = s[k]; }
  }

  function discovery() {
    const cmps = {};
    const add = (key, p, name, o) => {
      const d = Object.assign({ p, name, unique_id: `${base}_${key}` }, o.cmd === false ? {} : { command_topic: `${base}/cmd/${key}` }, o.state === false ? {} : { state_topic: `${base}/state/${key}` });
      delete o.cmd; delete o.state; cmps[key] = Object.assign(d, o);
    };
    const pls = ctx.playlists().map((x) => x.name), des = ctx.designs().map((x) => x.name);
    add('light', 'light', null, { schema: 'json', brightness_scale: 100, supported_color_modes: ['brightness'], icon: 'mdi:pine-tree' });
    add('playlist', 'select', 'Playlist', { options: pls.length ? pls : [NONE], icon: 'mdi:playlist-play' });
    add('design', 'select', 'Hold design', { options: [NONE].concat(des), icon: 'mdi:palette' });
    add('next', 'button', 'Next design', { state: false, icon: 'mdi:skip-next' });
    add('resume', 'button', 'Resume schedule', { state: false, icon: 'mdi:calendar-sync' });
    add('schedule', 'switch', 'Run on schedule', { icon: 'mdi:calendar-clock' });
    add('showing', 'sensor', 'Showing', { cmd: false, icon: 'mdi:television-play' });
    add('mode', 'sensor', 'Mode', { cmd: false, icon: 'mdi:calendar-check' });
    add('dimming', 'select', 'Dimming', { options: DIMMING.map((x) => x[1]), icon: 'mdi:brightness-6', entity_category: 'config' });
    add('fps_auto', 'switch', 'Auto frame rate', { icon: 'mdi:speedometer', entity_category: 'config' });
    add('fps_max', 'number', 'Max frame rate', { min: 5, max: 120, step: 1, mode: 'box', unit_of_measurement: 'fps', icon: 'mdi:speedometer', entity_category: 'config' });
    add('wled_fps', 'sensor', 'WLED frame rate', { cmd: false, unit_of_measurement: 'fps', state_class: 'measurement', icon: 'mdi:speedometer', entity_category: 'diagnostic' });
    add('wled_online', 'binary_sensor', 'WLED controller', { cmd: false, device_class: 'connectivity', entity_category: 'diagnostic' });
    const ip = sock && sock.localAddress ? sock.localAddress.replace(/^::ffff:/, '') : '';
    const dev = { ids: [base], name: 'Treeinator', mf: 'Treeinator', mdl: 'Light cone tree' };
    if (ip) dev.cu = `http://${ip}:${ctx.httpPort}/`;
    return { dev, o: Object.assign({ name: 'tree-show' }, dev.cu ? { url: dev.cu } : {}), availability_topic: base + '/status', cmps };
  }
  function publishDiscovery() {
    if (!up) return;
    const p = JSON.stringify(discovery());
    if (p !== disc) { publish(`${prefix}/device/${base}/config`, p, true); disc = p; discKey = prefix + '/' + base; }
  }

  return { start: connect, restart: connect, stop: () => stop(true), status: () => Object.assign({}, status), states, discovery };
}

module.exports = { create, clean, publicCfg, DEFAULTS };
