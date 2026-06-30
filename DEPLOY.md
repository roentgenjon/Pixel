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

Commit und push auf den aktuellen Branch (`claude/pixel-canvas-collab-eb7vqi`,
oder `main` sobald der Branch gemerged ist).

## Schritt 3 – GitHub Pages aktivieren

1. GitHub → Repository → **Settings → Pages**
2. Source: **GitHub Actions**
3. Fertig — `.github/workflows/pages.yml` deployt automatisch bei jedem Push
   auf `main` **oder** auf `claude/pixel-canvas-collab-eb7vqi`. So funktioniert
   der Deploy schon jetzt, ohne dass der Branch vorher nach `main` gemerged
   werden muss. Sobald ein `main`-Branch existiert und der Code dorthin
   gemerged ist, kann der Feature-Branch wieder aus dem Workflow-Trigger
   entfernt werden.
4. Alternativ jederzeit manuell auslösen: **Actions → Deploy to GitHub Pages
   → Run workflow** (`workflow_dispatch`)

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
