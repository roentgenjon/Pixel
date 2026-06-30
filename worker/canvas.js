/**
 * PixelCanvas Durable Object
 *
 * Pixel state is kept in memory (sparse Map) and persisted via DO Alarms
 * at most once every 2 minutes — a single batched storage.put() call
 * regardless of how many pixels changed. Keeps writes far under the
 * free tier (≤ 21,600 writes/month at max alarm frequency vs. 1 M free).
 *
 * Durable Objects can be evicted from memory (hibernated) between
 * WebSocket messages to save compute cost. Two things must survive
 * that eviction:
 *   1. Which userId belongs to which open WebSocket  → stored via
 *      ws.serializeAttachment() / state.getWebSockets(), not a plain Map.
 *   2. Pixel state                                    → reloaded from
 *      storage on first use after wake (ensureLoaded()).
 *
 * Binary WS protocol (same as Node.js server):
 *   Init  0x00 + count(4LE) + n×8 [index:4LE r g b isOwn]
 *   Paint 0x01 + index(4LE) + r + g + b + isOwn
 *   Erase 0x02 + index(4LE)
 */

const WIDTH  = 1000;
const HEIGHT = 1000;
const TOTAL  = WIDTH * HEIGHT;

// Alarm fires every 2 minutes while there are unsaved changes.
const FLUSH_INTERVAL_MS = 120_000;

// Max DO storage value size is 128 KiB (131,072 bytes).
// 43 bytes per pixel (index + RGB + 36-byte ownerId) + 4-byte header →
// 2,900 pixels/chunk ≈ 124,704 bytes, comfortably under the limit.
const PIXELS_PER_CHUNK = 2_900;

export class PixelCanvas {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;
    this.pixels  = new Map();   // pixelIndex → {r, g, b, ownerId}
    this.loaded  = false;
    this.dirty   = false;       // any unsaved changes since last flush?
  }

  // ── Load from storage ─────────────────────────────────────────────────────────

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;

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
      const ownerId = String.fromCharCode(...u8.slice(off + 7, off + 43)).replace(/\0+$/, '');
      this.pixels.set(idx, { r, g, b, ownerId });
      off += 43;
    }
  }

  // ── Alarm-based persistence (at most 1 write batch / 2 min) ──────────────────

  markDirty() {
    if (!this.dirty) {
      this.dirty = true;
      this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }

  async alarm() {
    await this.ensureLoaded(); // pixels may be unset if DO restarted before this fired
    await this.flush();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;

    // Format per entry: index:4LE r:1 g:1 b:1 ownerId:36ASCII = 43 bytes
    const entries   = [...this.pixels.entries()];
    const numChunks = Math.ceil(entries.length / PIXELS_PER_CHUNK) || 1;
    const puts      = {};

    for (let c = 0; c < numChunks; c++) {
      const slice = entries.slice(c * PIXELS_PER_CHUNK, (c + 1) * PIXELS_PER_CHUNK);
      const buf   = new ArrayBuffer(4 + slice.length * 43);
      const view  = new DataView(buf);
      const u8    = new Uint8Array(buf);
      view.setUint32(0, slice.length, true);
      let off = 4;
      for (const [idx, p] of slice) {
        view.setUint32(off, idx, true);
        u8[off + 4] = p.r;
        u8[off + 5] = p.g;
        u8[off + 6] = p.b;
        const id = (p.ownerId || '').padEnd(36, '\0').slice(0, 36);
        for (let j = 0; j < 36; j++) u8[off + 7 + j] = id.charCodeAt(j);
        off += 43;
      }
      puts[`chunk:${c}`] = buf;
    }

    // Delete stale chunks beyond the current count (canvas shrank)
    const existing = await this.state.storage.list({ prefix: 'chunk:' });
    for (const key of existing.keys()) {
      const n = Number(key.replace('chunk:', ''));
      if (n >= numChunks) await this.state.storage.delete(key);
    }

    await this.state.storage.put(puts); // one batched call
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
  // userId is attached directly to the WebSocket (survives hibernation) instead
  // of a plain in-memory Map, which would be wiped on eviction.

  async webSocketMessage(ws, raw) {
    await this.ensureLoaded();

    const attached = ws.deserializeAttachment();
    const userId   = attached?.userId;

    if (typeof raw === 'string') {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'hello') {
        const candidate = msg.userId;
        const uid = (typeof candidate === 'string' && /^[\da-f-]{36}$/.test(candidate))
          ? candidate
          : crypto.randomUUID();

        ws.serializeAttachment({ userId: uid });
        ws.send(JSON.stringify({ type: 'welcome', userId: uid }));
        ws.send(this.buildInit(uid));
        this.broadcastJSON({ type: 'users', count: this.state.getWebSockets().length });
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

      for (const ws2 of this.state.getWebSockets()) {
        const uid2 = ws2.deserializeAttachment()?.userId;
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
      for (const ws2 of this.state.getWebSockets()) {
        try { ws2.send(pkt); } catch {}
      }
    }
  }

  async webSocketClose() {
    // state.getWebSockets() already excludes closed sockets — just broadcast new count
    this.broadcastJSON({ type: 'users', count: this.state.getWebSockets().length });
  }

  async webSocketError() {
    this.broadcastJSON({ type: 'users', count: this.state.getWebSockets().length });
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
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(s); } catch {}
    }
  }
}
