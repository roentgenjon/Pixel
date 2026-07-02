/**
 * PixelCanvas Durable Object
 *
 * Pixel state is kept in memory (sparse Map) and persisted to MongoDB Atlas.
 * Every paint/erase is written immediately — no write-limit like DO storage.
 * On startup/wake, pixels are reloaded from MongoDB.
 *
 * Binary WS protocol (unchanged):
 *   Init  0x00 + count(4LE) + n×8 [index:4LE r g b isOwn]
 *   Paint 0x01 + index(4LE) + r + g + b + isOwn
 *   Erase 0x02 + index(4LE)
 */

import { MongoClient } from 'mongodb';

const WIDTH  = 1000;
const HEIGHT = 1000;
const TOTAL  = WIDTH * HEIGHT;

export class PixelCanvas {
  constructor(state, env) {
    this.state  = state;
    this.env    = env;
    this.pixels = new Map();   // pixelIndex → {r, g, b, ownerId}
    this.loaded = false;
    this._mongo = null;
    this._coll  = null;
  }

  // Lazy MongoDB connection — recreated after DO hibernation
  async _db() {
    if (!this._coll) {
      this._mongo = new MongoClient(this.env.MONGODB_URI);
      await this._mongo.connect();
      this._coll = this._mongo.db('pixelcanvas').collection('pixels');
    }
    return this._coll;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const coll = await this._db();
    const docs = await coll.find({}).toArray();
    for (const { _id, r, g, b, ownerId } of docs) {
      this.pixels.set(_id, { r, g, b, ownerId });
    }
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

      const coll = await this._db();
      await coll.replaceOne(
        { _id: idx },
        { _id: idx, r, g, b, ownerId: userId },
        { upsert: true }
      );

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

      const coll = await this._db();
      await coll.deleteOne({ _id: idx });

      const pkt = this.buildErase(idx);
      for (const ws2 of this.state.getWebSockets()) {
        try { ws2.send(pkt); } catch {}
      }
    }
  }

  async webSocketClose() {
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
