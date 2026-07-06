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

let data = { total: 0, ids: {} };
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* fresh start */ }

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
    let body = '';
    req.on('data', c => { body += c; if (body.length > 300) req.destroy(); });
    req.on('end', () => {
      let id = '';
      try { id = String(JSON.parse(body).id || '').slice(0, 64); } catch (e) {}
      if (/^[\w-]{6,64}$/.test(id)) {
        if (!data.ids[id]) { data.ids[id] = 1; data.total++; dirty = true; }
        online[id] = Date.now();
      }
      res.end(JSON.stringify({ total: data.total, online: Math.max(1, onlineCount()) }));
    });
  } else if (url === '/api/stats') {
    res.end(JSON.stringify({ total: data.total, online: onlineCount() }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});

server.listen(PORT, '127.0.0.1', () => console.log('parktopia stats listening on 127.0.0.1:' + PORT));
