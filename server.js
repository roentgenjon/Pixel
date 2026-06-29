'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('crypto');

const WIDTH  = 1000;
const HEIGHT = 1000;
const TOTAL  = WIDTH * HEIGHT;

// Sparse pixel store: pixelIndex → {r, g, b, ownerId}
const pixels  = new Map();
// Connected clients: WebSocket → userId string
const clients = new Map();

// ── HTTP ─────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const fp  = path.join(__dirname, 'public', path.normalize(url));

  // Prevent path traversal
  if (!fp.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── Binary packet builders ───────────────────────────────────────────────────

// Init  → [0x00][count:4LE][...per pixel: index:4LE r g b isOwn:1]
function buildInit(forUserId) {
  const n   = pixels.size;
  const buf = Buffer.allocUnsafe(5 + n * 8);
  buf[0] = 0x00;
  buf.writeUInt32LE(n, 1);
  let off = 5;
  for (const [idx, p] of pixels) {
    buf.writeUInt32LE(idx, off);
    buf[off + 4] = p.r;
    buf[off + 5] = p.g;
    buf[off + 6] = p.b;
    buf[off + 7] = p.ownerId === forUserId ? 1 : 0;
    off += 8;
  }
  return buf;
}

// Paint broadcast → [0x01][index:4LE][r][g][b][isOwn:1]
function buildPaint(idx, r, g, b, isOwn) {
  const buf = Buffer.allocUnsafe(9);
  buf[0] = 0x01;
  buf.writeUInt32LE(idx, 1);
  buf[5] = r; buf[6] = g; buf[7] = b; buf[8] = isOwn ? 1 : 0;
  return buf;
}

// Erase broadcast → [0x02][index:4LE]
function buildErase(idx) {
  const buf = Buffer.allocUnsafe(5);
  buf[0] = 0x02;
  buf.writeUInt32LE(idx, 1);
  return buf;
}

function broadcastJSON(obj) {
  const s = JSON.stringify(obj);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────────

// Optional password protection — set PIXEL_PASSWORD env variable to enable.
// If not set, the canvas is open to everyone.
const REQUIRED_PASSWORD = process.env.PIXEL_PASSWORD || null;

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.on('error', () => ws.terminate());

  // Kill connection if no hello arrives within 10 s
  const authTimer = setTimeout(() => {
    if (!clients.has(ws)) ws.terminate();
  }, 10_000);

  ws.on('message', (raw, isBinary) => {
    if (!isBinary) {
      // JSON handshake: {type:'hello', userId:'...', password:'...'}
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'hello') {
        // Password check
        if (REQUIRED_PASSWORD && msg.password !== REQUIRED_PASSWORD) {
          ws.send(JSON.stringify({ type: 'error', code: 'wrong_password' }));
          ws.terminate();
          return;
        }

        clearTimeout(authTimer);
        const candidate = msg.userId;
        const userId = (typeof candidate === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(candidate))
          ? candidate
          : randomUUID();

        clients.set(ws, userId);
        ws.send(JSON.stringify({ type: 'welcome', userId }));
        ws.send(buildInit(userId));
        broadcastJSON({ type: 'users', count: clients.size });
      }
      return;
    }

    const userId = clients.get(ws);
    if (!userId) return;

    const buf  = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const type = buf[0];

    if (type === 0x01 && buf.length >= 8) {
      // Paint request
      const idx = buf.readUInt32LE(1);
      if (idx >= TOTAL) return;
      const r = buf[5], g = buf[6], b = buf[7];

      const existing = pixels.get(idx);
      if (existing && existing.ownerId !== userId) return; // can't overwrite others

      pixels.set(idx, { r, g, b, ownerId: userId });

      for (const [ws2, uid2] of clients) {
        if (ws2.readyState === WebSocket.OPEN) {
          ws2.send(buildPaint(idx, r, g, b, uid2 === userId));
        }
      }

    } else if (type === 0x02 && buf.length >= 5) {
      // Erase request
      const idx = buf.readUInt32LE(1);
      if (idx >= TOTAL) return;

      const existing = pixels.get(idx);
      if (!existing || existing.ownerId !== userId) return; // can only erase own

      pixels.delete(idx);

      const pkt = buildErase(idx);
      for (const [ws2] of clients) {
        if (ws2.readyState === WebSocket.OPEN) ws2.send(pkt);
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastJSON({ type: 'users', count: clients.size });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Pixel canvas → http://localhost:${PORT}`);
});
