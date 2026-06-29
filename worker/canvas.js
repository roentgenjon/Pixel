/**
 * PixelCanvas Durable Object
 *
 * Pixel state is kept in memory (sparse Map) and persisted via DO Alarms
 * at most once per minute — a single storage.put() call regardless of
 * how many pixels changed. This keeps writes well within the free tier
 * (≤ 44,640 writes/month at max alarm frequency vs. 1 M free).
 *
 * Storage layout:
 *   Key "canvas"  →  ArrayBuffer:
 *     [count: 4 LE] + per pixel [index: 4 LE, r, g, b] + owner map
 *   Key "owners"  →  JSON { index: ownerId }
 *
 * Binary WS protocol (same as Node.js server):
 *   Init  0x00 + count(4LE) + n×8 [index:4LE r g b isOwn]
 *   Paint 0x01 + index(4LE) + r + g + b + isOwn
 *   Erase 0x02 + index(4LE)
 */

const WIDTH  = 1000;
const HEIGHT = 1000;
const TOTAL  = WIDTH * HEIGHT;

// Alarm fires every 60 s while there are unsaved changes.
const FLUSH_INTERVAL_MS = 60_000;

// Max DO storage value size is 128 KB.
// 7 bytes per pixel (4-byte index + 3 RGB) → 128 KB / 7 ≈ 18,700 pixels/chunk.
const PIXELS_PER_CHUNK = 18_000;

export class PixelCanvas {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;
    this.pixels  = new Map();   // pixelIndex → {r, g, b, ownerId}
    this.clients = new Map();   // WebSocket  → userId
    this.loaded  = false;
    this.dirty   = false;       // any unsaved changes?
  }

  // ── Load from storage ─────────────────────────────────────────────────────────

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;

    // Load all chunks
    const stored = await this.state.storage.list({ prefix: 'chunk:' });
    for (const [, buf] of stored) {
      this._deserializeChunk(buf);
    }
  }

  _deserializeChunk(buf) {
    if (!(buf instanceof ArrayBuffer)) return;
    const view  = new DataView(buf);
    const u8    = new Uint8Array(buf);
    const count = view.getUint32(0, true);
    let off = 4;
    for (let i = 0; i < count; i++) {
      const idx     = view.getUint32(off,   true);
      const r       = u8[off + 4];
      const g       = u8[off + 5];
      const b       = u8[off + 6];
      // ownerId stored as 36-char ASCII starting at off+7
      const ownerId = String.fromCharCode(...u8.slice(off + 7, off + 43));
      this.pixels.set(idx, { r, g, b, ownerId });
      off += 43;
    }
  }

  // ── Alarm-based persistence (at most 1 write/minute) ─────────────────────────

  markDirty() {
    if (!this.dirty) {
      this.dirty = true;
      // Schedule alarm if not already set — DO alarm won't double-fire
      this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }

  async alarm() {
    await this.flush();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;

    // Pack all pixels into fixed-size chunks (≤ 128 KB each)
    // Format per entry: index:4LE r:1 g:1 b:1 ownerId:36ASCII = 43 bytes
    const entries = [...this.pixels.entries()];
    const numChunks = Math.ceil(entries.length / PIXELS_PER_CHUNK) || 1;
    const puts = {};

    for (let c = 0; c < numChunks; c++) {
      const slice  = entries.slice(c * PIXELS_PER_CHUNK, (c + 1) * PIXELS_PER_CHUNK);
      const buf    = new ArrayBuffer(4 + slice.length * 43);
      const view   = new DataView(buf);
      const u8     = new Uint8Array(buf);
      view.setUint32(0, slice.length, true);
      let off = 4;
      for (const [idx, p] of slice) {
        view.setUint32(off, idx, true);
        u8[off + 4] = p.r;
        u8[off + 5] = p.g;
        u8[off + 6] = p.b;
        // Pad or truncate ownerId to exactly 36 bytes
        const id = (p.ownerId || '').padEnd(36, '\0').slice(0, 36);
        for (let j = 0; j < 36; j++) u8[off + 7 + j] = id.charCodeAt(j);
        off += 43;
      }
      puts[`chunk:${c}`] = buf;
    }

    // Delete any old chunks beyond current count (canvas shrank)
    const existing = await this.state.storage.list({ prefix: 'chunk:' });
    for (const key of existing.keys()) {
      const n = Number(key.replace('chunk:', ''));
      if (n >= numChunks) await this.state.storage.delete(key);
    }

    // One batched put — counts as `numChunks` write units (≤ 56 for full canvas)
    await this.state.storage.put(puts);
  }

  // ── Incoming requests ─────────────────────────────────────────────────────────

  async fetch(request) {
    await this.ensureLoaded();

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(
      'Static assets are served by GitHub Pages.\nWebSocket endpoint is ready.',
      { headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } }
    );
  }

  // ── WebSocket handlers ────────────────────────────────────────────────────────

  async webSocketMessage(ws, raw) {
    const userId = this.clients.get(ws);

    if (typeof raw === 'string') {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'hello') {
        // Password check (env var PIXEL_PASSWORD)
        if (this.env.PIXEL_PASSWORD && msg.password !== this.env.PIXEL_PASSWORD) {
          ws.send(JSON.stringify({ type: 'error', code: 'wrong_password' }));
          ws.close(1008, 'Unauthorized');
          return;
        }

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

    const buf  = new Uint8Array(typeof raw === 'string' ? new TextEncoder().encode(raw) : raw);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const type = buf[0];

    if (type === 0x01 && buf.length >= 8) {
      const idx = view.getUint32(1, true);
      if (idx >= TOTAL) return;
      const r = buf[5], g = buf[6], b = buf[7];

      const ex = this.pixels.get(idx);
      if (ex && ex.ownerId !== userId) return;

      this.pixels.set(idx, { r, g, b, ownerId: userId });
      this.markDirty();

      for (const [ws2, uid2] of this.clients) {
        try { ws2.send(this.buildPaint(idx, r, g, b, uid2 === userId)); } catch {}
      }

    } else if (type === 0x02 && buf.length >= 5) {
      const idx = view.getUint32(1, true);
      if (idx >= TOTAL) return;

      const ex = this.pixels.get(idx);
      if (!ex || ex.ownerId !== userId) return;

      this.pixels.delete(idx);
      this.markDirty();

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

  // ── Packet builders ───────────────────────────────────────────────────────────

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
    new Uint8Array(buf)[0] = 0x02;
    new DataView(buf).setUint32(1, idx, true);
    return buf;
  }

  broadcastJSON(obj) {
    const s = JSON.stringify(obj);
    for (const [ws] of this.clients) {
      try { ws.send(s); } catch {}
    }
  }
}
