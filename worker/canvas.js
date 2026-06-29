/**
 * PixelCanvas Durable Object
 *
 * Holds all pixel state in memory (sparse Map).
 * Persists to DO storage so restarts don't lose data.
 * Manages all WebSocket connections for real-time broadcast.
 *
 * Binary protocol (same as Node.js server):
 *   Init  0x00 + count(4LE) + n×8 bytes [index:4LE r g b isOwn:1]
 *   Paint 0x01 + index(4LE) + r + g + b + isOwn
 *   Erase 0x02 + index(4LE)
 */

const WIDTH  = 1000;
const HEIGHT = 1000;
const TOTAL  = WIDTH * HEIGHT;

// Durable Objects storage key prefix
const PX_PREFIX = 'px:';
const CHUNK     = 500; // pixels persisted per storage key

export class PixelCanvas {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;
    this.pixels  = new Map();   // index → {r, g, b, ownerId}
    this.clients = new Map();   // WebSocket → userId
    this.loaded  = false;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    // Load all pixel chunks from storage
    const stored = await this.state.storage.list({ prefix: PX_PREFIX });
    for (const [, chunk] of stored) {
      for (const [idx, p] of Object.entries(chunk)) {
        this.pixels.set(Number(idx), p);
      }
    }
  }

  async fetch(request) {
    await this.ensureLoaded();

    const url = new URL(request.url);

    // Serve static assets
    if (request.headers.get('Upgrade') !== 'websocket') {
      return this.serveStatic(url.pathname);
    }

    // WebSocket handshake
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── WebSocket event handlers (Durable Object hibernation API) ────────────────

  async webSocketMessage(ws, raw) {
    const userId = this.clients.get(ws);

    if (typeof raw === 'string') {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'hello') {
        const candidate = msg.userId;
        const uid = (typeof candidate === 'string' && /^[\da-f-]{36}$/.test(candidate))
          ? candidate
          : crypto.randomUUID();
        this.clients.set(ws, uid);
        ws.send(JSON.stringify({ type: 'welcome', userId: uid }));
        ws.send(this.buildInit(uid));
        this.broadcastJSON({ type: 'users', count: this.clients.size });
      }
      return;
    }

    if (!userId) return;

    const buf  = new Uint8Array(raw);
    const view = new DataView(buf.buffer);
    const type = buf[0];

    if (type === 0x01 && buf.length >= 8) {
      const idx = view.getUint32(1, true);
      if (idx >= TOTAL) return;
      const r = buf[5], g = buf[6], b = buf[7];

      const ex = this.pixels.get(idx);
      if (ex && ex.ownerId !== userId) return;

      this.pixels.set(idx, { r, g, b, ownerId: userId });
      this.schedulePersist(idx);

      for (const [ws2, uid2] of this.clients) {
        try { ws2.send(this.buildPaint(idx, r, g, b, uid2 === userId)); } catch {}
      }

    } else if (type === 0x02 && buf.length >= 5) {
      const idx = view.getUint32(1, true);
      if (idx >= TOTAL) return;

      const ex = this.pixels.get(idx);
      if (!ex || ex.ownerId !== userId) return;

      this.pixels.delete(idx);
      this.schedulePersist(idx);

      const pkt = this.buildErase(idx);
      for (const [ws2] of this.clients) {
        try { ws2.send(pkt); } catch {}
      }
    }
  }

  async webSocketClose(ws) {
    this.clients.delete(ws);
    this.broadcastJSON({ type: 'users', count: this.clients.size });
  }

  async webSocketError(ws) {
    this.clients.delete(ws);
  }

  // ── Persistence (batched by chunk) ───────────────────────────────────────────

  _dirty = new Set();
  _persistTimer = null;

  schedulePersist(idx) {
    this._dirty.add(Math.floor(idx / CHUNK));
    if (!this._persistTimer) {
      this._persistTimer = setTimeout(() => this.flush(), 2000);
    }
  }

  async flush() {
    this._persistTimer = null;
    const chunks = [...this._dirty];
    this._dirty.clear();
    for (const chunkId of chunks) {
      const start = chunkId * CHUNK;
      const end   = Math.min(start + CHUNK, TOTAL);
      const data  = {};
      for (let i = start; i < end; i++) {
        if (this.pixels.has(i)) data[i] = this.pixels.get(i);
      }
      if (Object.keys(data).length > 0) {
        await this.state.storage.put(PX_PREFIX + chunkId, data);
      } else {
        await this.state.storage.delete(PX_PREFIX + chunkId);
      }
    }
  }

  // ── Packet builders ──────────────────────────────────────────────────────────

  buildInit(forUserId) {
    const n   = this.pixels.size;
    const buf = new ArrayBuffer(5 + n * 8);
    const v   = new DataView(buf);
    const u8  = new Uint8Array(buf);
    u8[0] = 0x00;
    v.setUint32(1, n, true);
    let off = 5;
    for (const [idx, p] of this.pixels) {
      v.setUint32(off, idx, true);
      u8[off+4] = p.r; u8[off+5] = p.g; u8[off+6] = p.b;
      u8[off+7] = p.ownerId === forUserId ? 1 : 0;
      off += 8;
    }
    return buf;
  }

  buildPaint(idx, r, g, b, isOwn) {
    const buf = new ArrayBuffer(9);
    const v   = new DataView(buf);
    const u8  = new Uint8Array(buf);
    u8[0] = 0x01;
    v.setUint32(1, idx, true);
    u8[5] = r; u8[6] = g; u8[7] = b; u8[8] = isOwn ? 1 : 0;
    return buf;
  }

  buildErase(idx) {
    const buf = new ArrayBuffer(5);
    const v   = new DataView(buf);
    new Uint8Array(buf)[0] = 0x02;
    v.setUint32(1, idx, true);
    return buf;
  }

  broadcastJSON(obj) {
    const s = JSON.stringify(obj);
    for (const [ws] of this.clients) {
      try { ws.send(s); } catch {}
    }
  }

  // ── Static file serving ──────────────────────────────────────────────────────
  // In production use Cloudflare Pages or R2 for assets.
  // This stub redirects the root so the DO doesn't need to hold HTML.

  serveStatic(pathname) {
    return new Response(
      'Deploy static assets via Cloudflare Pages or Workers Sites.\n' +
      'See README for setup instructions.',
      { status: 200, headers: { 'Content-Type': 'text/plain' } }
    );
  }
}
