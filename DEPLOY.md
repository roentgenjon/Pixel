# Deployment

## Architektur

```
Browser → GitHub Pages (HTML + JS)
             ↕ WebSocket
        Cloudflare Workers + Durable Objects (Pixel-State + Echtzeit-Sync)
```

Der Pixel-State wird im Durable Object höchstens alle 2 Minuten in einem
einzigen gebündelten Schreibvorgang gespeichert (siehe `worker/canvas.js`),
um deutlich unter dem kostenlosen Cloudflare-Limit (1 Mio. Writes/Monat) zu
bleiben. Lokal im Browser wird jede Aktion sofort gerendert (optimistic
update) und zusätzlich in `localStorage` zwischengespeichert, bis der Server
sie bestätigt — ein Reload innerhalb des 2-Minuten-Fensters verliert dadurch
keine ungespeicherten Änderungen.

Es gibt **kein Passwort** mehr — die Canvas ist offen für alle.

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
3. Fertig — `.github/workflows/pages.yml` deployt automatisch bei jedem Push
   auf `main`.
4. Alternativ jederzeit manuell auslösen: **Actions → Deploy to GitHub Pages
   → Run workflow** (`workflow_dispatch`)

Schritt 1 (Settings → Pages → Source) ist eine reine Web-UI-Einstellung ohne
zugehörigen GitHub-API-Endpunkt in meinem Werkzeugsatz — die musst du einmalig
selbst im Browser setzen.

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
