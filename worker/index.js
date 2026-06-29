/**
 * Cloudflare Workers entry point.
 * Static assets are served from /public via Workers Sites (or R2).
 * WebSocket connections are forwarded to the PixelCanvas Durable Object.
 */

export { PixelCanvas } from './canvas.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket upgrade → Durable Object (single global instance)
    if (request.headers.get('Upgrade') === 'websocket') {
      const id  = env.CANVAS.idFromName('global');
      const obj = env.CANVAS.get(id);
      return obj.fetch(request);
    }

    // Serve static files from KV (wrangler sites) or fall through to DO
    // For simplicity we proxy everything else to the DO which serves HTML/JS
    const id  = env.CANVAS.idFromName('global');
    const obj = env.CANVAS.get(id);
    return obj.fetch(request);
  },
};
