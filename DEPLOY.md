# Cloudflare Workers Deployment

## Vorbereitung

```bash
npm install -g wrangler
wrangler login          # Browser öffnet sich → autorisieren
```

Oder Token direkt (sicherer als in Chat zu schreiben):

```bash
export CLOUDFLARE_API_TOKEN=<dein-token>
wrangler whoami         # prüft ob der Token funktioniert
```

## Deployen

```bash
wrangler deploy
```

## Statische Assets (HTML/JS)

Die Datei `public/index.html` und `public/app.js` müssen separat gehostet werden.
Einfachste Option — Cloudflare Pages:

```bash
# Im Pixel-Ordner:
wrangler pages deploy public --project-name pixel-canvas
```

Dann in `public/app.js` die WebSocket-URL auf deine Worker-Domain ändern:
```js
const ws = new WebSocket('wss://pixel-canvas.<dein-name>.workers.dev');
```

## Lokal testen (Node.js — kein Cloudflare-Account nötig)

```bash
npm install
npm start
# http://localhost:3000
```
