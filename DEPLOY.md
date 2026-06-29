# Deployment

## Architektur

```
Browser → GitHub Pages (HTML + JS)
             ↕ WebSocket
        Cloudflare Workers + Durable Objects (Pixel-State + Echtzeit-Sync)
```

---

## Schritt 1 – Cloudflare Worker deployen (WebSocket-Backend)

```bash
npm install -g wrangler

# Token sicher als Umgebungsvariable setzen (NICHT in den Code schreiben!):
export CLOUDFLARE_API_TOKEN=<dein-token>

wrangler whoami   # prüft Verbindung

wrangler deploy   # deployt den Worker
# → gibt URL aus, z. B.:  https://pixel-canvas.roentgenjon.workers.dev
```

## Schritt 2 – Worker-URL in config.js eintragen

Öffne `public/config.js` und setze die URL aus Schritt 1:

```js
window.PIXEL_WS_URL = 'wss://pixel-canvas.roentgenjon.workers.dev';
```

Commit und push nach `main`.

## Schritt 3 – GitHub Pages aktivieren

1. GitHub → Repository → **Settings → Pages**
2. Source: **GitHub Actions**
3. Fertig — beim nächsten Push auf `main` wird automatisch deployt

Die Seite ist dann erreichbar unter:
`https://roentgenjon.github.io/Pixel/`

---

## Lokale Entwicklung (kein Cloudflare nötig)

```bash
npm install
npm start
# http://localhost:3000
# config.js belassen wie es ist (PIXEL_WS_URL = null → verbindet sich lokal)
```
