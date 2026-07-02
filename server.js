'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('crypto');
const { MongoClient } = require('mongodb');

const WIDTH  = 1000;
const HEIGHT = 1000;
const TOTAL  = WIDTH * HEIGHT;

// In-memory pixel store — loaded from MongoDB on startup
const pixels  = new Map();   // pixelIndex → {r, g, b, ownerId}
const clients = new Map();   // WebSocket → userId

// ── MongoDB ───────────────────────────────────────────────────────────────────

let col;

async function initMongo() {
  const uri    = process.env.MONGODB_URI;
  const client = new MongoClient(uri);
  await client.connect();
  col = client.db('pixelcanvas').collection('pixels');
  console.log('MongoDB connected');

  const docs = await col.find({}).toArray();
  for (const { _id, r, g, b, ownerId } of docs) {
    pixels.set(_id, { r, g, b, ownerId });
  }
  console.log(`Loaded ${pixels.size} pixels`);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const fp  = path.join(__dirname, 'public', path.normalize(url));

  if (!fp.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── Binary packet builders ─────────────────────────────────────────────────────

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

function buildPaint(idx, r, g, b, isOwn) {
  const buf = Buffer.allocUnsafe(9);
  buf[0] = 0x01;
  buf.writeUInt32LE(idx, 1);
  buf[5] = r; buf[6] = g; buf[7] = b; buf[8] = isOwn ? 1 : 0;
  return buf;
}

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

// ── WebSocket ──────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.on('error', () => ws.terminate());

  ws.on('message', async (raw, isBinary) => {
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'hello') {
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
      const idx = buf.readUInt32LE(1);
      if (idx >= TOTAL) return;
      const r = buf[5], g = buf[6], b = buf[7];

      const existing = pixels.get(idx);
      if (existing && existing.ownerId !== userId) return;

      pixels.set(idx, { r, g, b, ownerId: userId });
      await col.replaceOne({ _id: idx }, { _id: idx, r, g, b, ownerId: userId }, { upsert: true });

      for (const [ws2, uid2] of clients) {
        if (ws2.readyState === WebSocket.OPEN) {
          ws2.send(buildPaint(idx, r, g, b, uid2 === userId));
        }
      }

    } else if (type === 0x02 && buf.length >= 5) {
      const idx = buf.readUInt32LE(1);
      if (idx >= TOTAL) return;

      const existing = pixels.get(idx);
      if (!existing || existing.ownerId !== userId) return;

      pixels.delete(idx);
      await col.deleteOne({ _id: idx });

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

// ── Start ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

initMongo().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`Pixel canvas → http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('MongoDB init failed:', err);
  process.exit(1);
});
