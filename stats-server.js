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

let data = { total: 0, ids: {}, names: {}, players: {}, scores: {}, plays: 0 };
try {
  Object.assign(data, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  data.ids = data.ids || {};
  data.names = data.names || {};      // lowercased name -> owner id
  data.players = data.players || {};  // id -> { name, key }
  data.scores = data.scores || {};    // id -> { name, score, wallet }
  data.plays = data.plays || 0;       // total "tap to play" events (conversion)
} catch (e) { /* fresh start */ }

const ID_RE = /^[\w-]{6,64}$/;
const NAME_RE = /^[\w \-]{2,16}$/;    // letters, digits, space, hyphen, underscore
const MAX_SCORE = 1e12;               // clamp to keep obvious junk out of the board

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
  req.on('data', c => { body += c; if (body.length > 400) req.destroy(); });
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
      let name = null;
      if (ID_RE.test(id)) {
        if (!data.ids[id]) { data.ids[id] = 1; data.total++; dirty = true; }
        online[id] = Date.now();
        name = (data.players[id] || {}).name || null;
      }
      res.end(JSON.stringify({ total: data.total, online: Math.max(1, onlineCount()), name: name }));
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
      let score = Number(j.score);
      if (!isFinite(score) || score < 0) score = 0;
      score = Math.min(Math.floor(score), MAX_SCORE);
      const prev = data.scores[id] || {};
      const name = (data.players[id] || {}).name || (NAME_RE.test(String(j.name || '').trim()) ? String(j.name).trim() : (prev.name || 'Player'));
      const wallet = j.wallet ? String(j.wallet).slice(0, 64) : (prev.wallet || null);
      data.scores[id] = { name: name, score: Math.max(score, prev.score || 0), wallet: wallet };
      dirty = true;
      res.end(JSON.stringify({ ok: true, best: data.scores[id].score }));
    });
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
