/* PARKTOPIA realtime stats API — zero dependencies.
   Run with: pm2 start stats-server.js --name parktopia-stats
   nginx proxies /api/ -> 127.0.0.1:3001 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'stats-data.json');
const PORT = 3001;
const ONLINE_WINDOW_MS = 70e3;

let data = { total: 0, ids: {}, names: {}, players: {}, scores: {}, plays: 0,
  seen: {}, refs: {}, refRewards: {}, saves: {} };
try {
  Object.assign(data, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  data.ids = data.ids || {};
  data.names = data.names || {};      // lowercased name -> owner id
  data.players = data.players || {};  // id -> { name, key }
  data.scores = data.scores || {};    // id -> { name, score, wallet, updatedAt }
  data.plays = data.plays || 0;       // total "tap to play" events (conversion)
  data.seen = data.seen || {};        // id -> first-seen ms (for score plausibility)
  data.refs = data.refs || {};        // id -> referrer id (who invited them)
  data.refRewards = data.refRewards || {}; // id -> unclaimed referral rewards
  data.saves = data.saves || {};      // wallet|id -> { blob, t } cloud saves
} catch (e) { /* fresh start */ }

const ID_RE = /^[\w-]{6,64}$/;
const NAME_RE = /^[\w \-]{2,16}$/;    // letters, digits, space, hyphen, underscore
const MAX_SCORE = 1e12;               // hard clamp
const SCORE_MIN_AGE = 20;             // seconds a player must exist before a score counts
const SCORE_RATE = 60000;             // max plausible park-value growth per second
const SCORE_BASE = 100000;            // starting plausibility headroom
const SCORE_ABS = 1e8;                // no legit park exceeds this
const SCORE_COOLDOWN = 2500;          // min ms between accepted submissions per id
const SAVE_MAX = 8000;                // max cloud-save blob size (chars)

function leaderboard(limit) {
  const rows = [];
  for (const id in data.scores) {
    const s = data.scores[id];
    rows.push({ name: s.name || 'Player', score: s.score || 0, wallet: !!s.wallet });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, Math.max(1, Math.min(100, limit || 20)));
}

function readBody(req, res, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 12000) req.destroy(); });
  req.on('end', () => { let j = {}; try { j = JSON.parse(body); } catch (e) {} cb(j); });
}

let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  fs.writeFile(FILE, JSON.stringify(data), err => { if (err) console.error('save failed:', err.message); });
}, 5000);

const online = {}; // id -> last heartbeat ms
function onlineCount() {
  const now = Date.now();
  let n = 0;
  for (const id in online) {
    if (now - online[id] < ONLINE_WINDOW_MS) n++;
    else delete online[id];
  }
  return n;
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const url = req.url.split('?')[0];

  if (url === '/api/hello' && req.method === 'POST') {
    readBody(req, res, j => {
      const id = String(j.id || '').slice(0, 64);
      let name = null, refRewards = 0;
      if (ID_RE.test(id)) {
        if (!data.ids[id]) { data.ids[id] = 1; data.total++; dirty = true; }
        if (!data.seen[id]) { data.seen[id] = Date.now(); dirty = true; }
        online[id] = Date.now();
        name = (data.players[id] || {}).name || null;
        refRewards = data.refRewards[id] || 0;
      }
      res.end(JSON.stringify({ total: data.total, online: Math.max(1, onlineCount()), name: name, refRewards: refRewards }));
    });
  } else if (url === '/api/name' && req.method === 'POST') {
    readBody(req, res, j => {
      const id = String(j.id || '').slice(0, 64);
      const name = String(j.name == null ? '' : j.name).trim().slice(0, 16);
      if (!ID_RE.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad_id' })); return; }
      if (!NAME_RE.test(name)) { res.end(JSON.stringify({ ok: false, error: 'bad_name' })); return; }
      const key = name.toLowerCase();
      const owner = data.names[key];
      if (owner && owner !== id) { res.end(JSON.stringify({ ok: false, error: 'taken' })); return; }
      const prev = data.players[id];
      if (prev && prev.key && prev.key !== key) delete data.names[prev.key]; // release old name
      data.names[key] = id;
      data.players[id] = { name: name, key: key };
      dirty = true;
      res.end(JSON.stringify({ ok: true, name: name }));
    });
  } else if (url === '/api/score' && req.method === 'POST') {
    readBody(req, res, j => {
      const id = String(j.id || '').slice(0, 64);
      if (!ID_RE.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad_id' })); return; }
      const now = Date.now();
      const prev = data.scores[id] || {};
      // rate-limit: ignore rapid re-submissions (keep the current best)
      if (prev.updatedAt && now - prev.updatedAt < SCORE_COOLDOWN) {
        res.end(JSON.stringify({ ok: true, best: prev.score || 0, throttled: true })); return;
      }
      let score = Number(j.score);
      if (!isFinite(score) || score < 0) score = 0;
      score = Math.floor(score);
      // plausibility: cap by how long the player has existed (anti-fake)
      const first = data.seen[id] || now;
      const ageSec = Math.max(0, (now - first) / 1000);
      const cap = ageSec < SCORE_MIN_AGE ? SCORE_BASE
        : Math.min(SCORE_ABS, SCORE_BASE + SCORE_RATE * ageSec);
      score = Math.min(score, cap, MAX_SCORE);
      const name = (data.players[id] || {}).name || (NAME_RE.test(String(j.name || '').trim()) ? String(j.name).trim() : (prev.name || 'Player'));
      const wallet = j.wallet ? String(j.wallet).slice(0, 64) : (prev.wallet || null);
      const best = Math.max(score, prev.score || 0);
      data.scores[id] = { name: name, score: best, wallet: wallet, updatedAt: now };
      dirty = true;
      res.end(JSON.stringify({ ok: true, best: best, capped: score < Math.floor(Number(j.score) || 0) }));
    });
  } else if (url === '/api/ref' && req.method === 'POST') {
    readBody(req, res, j => {
      const id = String(j.id || '').slice(0, 64);
      const ref = String(j.ref || '').slice(0, 64);
      if (!ID_RE.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad_id' })); return; }
      // only credit once, must be a real different player, and not circular
      if (data.refs[id] || !ID_RE.test(ref) || ref === id || !data.seen[ref] || data.refs[ref] === id) {
        res.end(JSON.stringify({ ok: false, error: 'ineligible' })); return;
      }
      data.refs[id] = ref;
      data.refRewards[ref] = (data.refRewards[ref] || 0) + 1;
      dirty = true;
      res.end(JSON.stringify({ ok: true }));
    });
  } else if (url === '/api/claimref' && req.method === 'POST') {
    readBody(req, res, j => {
      const id = String(j.id || '').slice(0, 64);
      if (!ID_RE.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ ok: false })); return; }
      const n = data.refRewards[id] || 0;
      if (n > 0) { delete data.refRewards[id]; dirty = true; }
      res.end(JSON.stringify({ ok: true, claimed: n }));
    });
  } else if (url === '/api/csave' && req.method === 'POST') {
    readBody(req, res, j => {
      const id = String(j.id || '').slice(0, 64);
      const wallet = String(j.wallet || '').slice(0, 64);
      const key = wallet || id;
      if (!ID_RE.test(id) || !key) { res.statusCode = 400; res.end(JSON.stringify({ ok: false })); return; }
      const blob = String(j.blob == null ? '' : j.blob).slice(0, SAVE_MAX);
      if (!blob) { res.end(JSON.stringify({ ok: false, error: 'empty' })); return; }
      data.saves[key] = { blob: blob, t: Date.now() };
      dirty = true;
      res.end(JSON.stringify({ ok: true }));
    });
  } else if (url === '/api/cload') {
    const q = req.url.split('?')[1] || '';
    const mm = q.match(/key=([\w-]{1,64})/);
    const s = mm ? data.saves[mm[1]] : null;
    res.end(JSON.stringify(s ? { ok: true, blob: s.blob, t: s.t } : { ok: false }));
  } else if (url === '/api/leaderboard') {
    let limit = 20; const q = req.url.split('?')[1] || '';
    const mm = q.match(/limit=(\d+)/); if (mm) limit = parseInt(mm[1], 10);
    res.end(JSON.stringify({ top: leaderboard(limit), players: Object.keys(data.scores).length }));
  } else if (url === '/api/play' && req.method === 'POST') {
    data.plays++; dirty = true;
    res.end(JSON.stringify({ plays: data.plays }));
  } else if (url === '/api/stats') {
    res.end(JSON.stringify({ total: data.total, online: onlineCount(), plays: data.plays }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});

server.listen(PORT, '127.0.0.1', () => console.log('parktopia stats listening on 127.0.0.1:' + PORT));
