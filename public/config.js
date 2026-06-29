// WebSocket backend URL.
// Local dev: leave as null → connects to same host (Node.js server).
// Production: set to your Cloudflare Worker URL after running `wrangler deploy`.
window.PIXEL_WS_URL = null;
// Example: window.PIXEL_WS_URL = 'wss://pixel-canvas.roentgenjon.workers.dev';

// Set to true to show a password dialog before connecting.
// Must match the PIXEL_PASSWORD env variable set on the server.
window.PIXEL_REQUIRES_PASSWORD = false;
