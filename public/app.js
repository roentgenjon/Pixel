'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════
const W = 1000, H = 1000;

// ═══════════════════════════════════════════════════════════════════════════════
// Pixel data (client-side mirror)
// ═══════════════════════════════════════════════════════════════════════════════
const offscreen = document.createElement('canvas');
offscreen.width = W; offscreen.height = H;
const offCtx  = offscreen.getContext('2d');
const imgData = offCtx.createImageData(W, H);
const pxData  = imgData.data;         // Uint8ClampedArray – RGBA per pixel
const pxOwner = new Uint8Array(W * H); // 0=empty  1=mine  2=other

function setPixel(idx, r, g, b, isOwn) {
  const i = idx << 2;
  pxData[i]   = r;
  pxData[i+1] = g;
  pxData[i+2] = b;
  pxData[i+3] = 255;
  pxOwner[idx] = isOwn ? 1 : 2;
}

function clearPixel(idx) {
  pxData[(idx << 2) + 3] = 0;
  pxOwner[idx] = 0;
}

// Flush a single pixel from imgData to the offscreen canvas
function flushOne(idx) {
  offCtx.putImageData(imgData, 0, 0, idx % W, (idx / W) | 0, 1, 1);
}

// Flush the entire imgData to the offscreen canvas
function flushAll() {
  offCtx.putImageData(imgData, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WebSocket connection
// ═══════════════════════════════════════════════════════════════════════════════
let myId = localStorage.getItem('pixelId') || null;

const wsUrl = window.PIXEL_WS_URL ||
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
const ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'hello', userId: myId }));
});

ws.addEventListener('message', ({ data }) => {
  if (typeof data === 'string') {
    const m = JSON.parse(data);
    if (m.type === 'welcome') {
      myId = m.userId;
      localStorage.setItem('pixelId', myId);
    } else if (m.type === 'users') {
      document.getElementById('user-count').textContent = `👥 ${m.count}`;
    }
    return;
  }

  const v = new DataView(data);
  const t = v.getUint8(0);

  if (t === 0x00) {
    // Full canvas init
    const n = v.getUint32(1, true);
    for (let i = 0; i < n; i++) {
      const off = 5 + i * 8;
      setPixel(
        v.getUint32(off, true),
        v.getUint8(off + 4), v.getUint8(off + 5), v.getUint8(off + 6),
        v.getUint8(off + 7) === 1
      );
    }
    flushAll();
    scheduleRender();

  } else if (t === 0x01) {
    // Paint broadcast
    const idx   = v.getUint32(1, true);
    const isOwn = v.getUint8(8) === 1;
    setPixel(idx, v.getUint8(5), v.getUint8(6), v.getUint8(7), isOwn);
    flushOne(idx);
    scheduleRender();

  } else if (t === 0x02) {
    // Erase broadcast
    const idx = v.getUint32(1, true);
    clearPixel(idx);
    flushOne(idx);
    scheduleRender();
  }
});

function wsSend(buf) {
  if (ws.readyState === WebSocket.OPEN) ws.send(buf);
}

function sendPaint(idx) {
  const { r, g, b } = picker.rgb();
  const buf = new ArrayBuffer(8);
  const v   = new DataView(buf);
  v.setUint8(0, 0x01);
  v.setUint32(1, idx, true);
  v.setUint8(5, r); v.setUint8(6, g); v.setUint8(7, b);
  wsSend(buf);
}

function sendErase(idx) {
  const buf = new ArrayBuffer(5);
  const v   = new DataView(buf);
  v.setUint8(0, 0x02);
  v.setUint32(1, idx, true);
  wsSend(buf);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main canvas & viewport
// ═══════════════════════════════════════════════════════════════════════════════
const wrap   = document.getElementById('wrap');
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

let vx = 0, vy = 0, zoom = 1;

function fitView() {
  zoom = Math.min(window.innerWidth / W, window.innerHeight / H) * 0.88;
  vx   = (window.innerWidth  - W * zoom) / 2;
  vy   = (window.innerHeight - H * zoom) / 2;
}

function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  scheduleRender();
}
window.addEventListener('resize', resize);
resize();

// ── Render loop ──────────────────────────────────────────────────────────────
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(doRender);
}

function doRender() {
  renderQueued = false;
  const cw = canvas.width, ch = canvas.height;
  const pw = W * zoom,     ph = H * zoom;

  ctx.clearRect(0, 0, cw, ch);

  // Checkerboard background (shows where canvas ends)
  const cs = 16;
  for (let row = 0; row * cs < ph; row++) {
    for (let col = 0; col * cs < pw; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? '#1a1a1a' : '#242424';
      ctx.fillRect(
        vx + col * cs, vy + row * cs,
        Math.min(cs, pw - col * cs), Math.min(cs, ph - row * cs)
      );
    }
  }

  // Pixel data
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, vx, vy, pw, ph);

  // Pixel grid at high zoom
  if (zoom >= 6) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth   = 0.5;

    const c0 = Math.max(0,  Math.ceil(-vx / zoom));
    const c1 = Math.min(W,  Math.ceil((cw - vx) / zoom));
    const r0 = Math.max(0,  Math.ceil(-vy / zoom));
    const r1 = Math.min(H,  Math.ceil((ch - vy) / zoom));

    for (let x = c0; x <= c1; x++) {
      ctx.moveTo(vx + x * zoom, vy + r0 * zoom);
      ctx.lineTo(vx + x * zoom, vy + r1 * zoom);
    }
    for (let y = r0; y <= r1; y++) {
      ctx.moveTo(vx + c0 * zoom, vy + y * zoom);
      ctx.lineTo(vx + c1 * zoom, vy + y * zoom);
    }
    ctx.stroke();
  }

  // Canvas border
  ctx.strokeStyle = '#333';
  ctx.lineWidth   = 1;
  ctx.strokeRect(vx, vy, pw, ph);

  document.getElementById('zoom-label').textContent = `${Math.round(zoom * 100)}%`;
}

// ── Coordinate helpers ───────────────────────────────────────────────────────
function canvasToPx(cx, cy) {
  return { px: Math.floor((cx - vx) / zoom), py: Math.floor((cy - vy) / zoom) };
}

function pxToIndex(px, py) {
  if (px < 0 || py < 0 || px >= W || py >= H) return -1;
  return py * W + px;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool state
// ═══════════════════════════════════════════════════════════════════════════════
let tool      = 'paint'; // 'paint' | 'erase' | 'eye'
let painting  = false;
let panning   = false;
let spaceDown = false;
let panX0 = 0, panY0 = 0, pvx0 = 0, pvy0 = 0;
let lastPx = -1, lastPy = -1;

function setTool(t) {
  tool = t;
  ['paint', 'erase', 'eye'].forEach(n => {
    document.getElementById(`btn-${n}`).classList.toggle('active', n === t);
  });
  updateCursor();
}

function updateCursor() {
  if (panning || spaceDown) wrap.style.cursor = 'grabbing';
  else                      wrap.style.cursor = 'crosshair';
}

// ─── Apply tool at pixel ─────────────────────────────────────────────────────
function applyTool(px, py) {
  const idx = pxToIndex(px, py);
  if (idx < 0) return;

  if (tool === 'paint') {
    if (pxOwner[idx] === 2) return; // don't overwrite others
    sendPaint(idx);
  } else if (tool === 'erase') {
    if (pxOwner[idx] !== 1) return; // only erase own
    sendErase(idx);
  }
}

// ─── Bresenham – fill gaps when dragging fast ────────────────────────────────
function bresenham(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = err << 1;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 <  dx) { err += dx; y0 += sy; }
  }
  return pts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mouse / Pointer events
// ═══════════════════════════════════════════════════════════════════════════════
wrap.addEventListener('mousedown', (e) => {
  // Pan: middle button or Space held
  if (e.button === 1 || spaceDown) {
    panning = true;
    panX0 = e.clientX; panY0 = e.clientY;
    pvx0  = vx;        pvy0  = vy;
    updateCursor();
    e.preventDefault();
    return;
  }

  if (e.button === 0) {
    const { px, py } = canvasToPx(e.clientX, e.clientY);
    const idx = pxToIndex(px, py);

    if (tool === 'eye') {
      // Eyedropper: pick color from any pixel (incl. others')
      if (idx >= 0 && pxOwner[idx] !== 0) {
        const i = idx << 2;
        picker.setFromRGB(pxData[i], pxData[i+1], pxData[i+2]);
      }
      return;
    }

    painting = true;
    lastPx = px; lastPy = py;
    applyTool(px, py);
  }
});

wrap.addEventListener('mousemove', (e) => {
  const { px, py } = canvasToPx(e.clientX, e.clientY);

  if (px >= 0 && py >= 0 && px < W && py < H) {
    document.getElementById('coords').textContent = `x ${px}  y ${py}`;
  } else {
    document.getElementById('coords').textContent = '';
  }

  if (panning) {
    vx = pvx0 + e.clientX - panX0;
    vy = pvy0 + e.clientY - panY0;
    scheduleRender();
    return;
  }

  if (painting && (px !== lastPx || py !== lastPy)) {
    const pts = bresenham(lastPx, lastPy, px, py);
    for (const [x, y] of pts) applyTool(x, y);
    lastPx = px; lastPy = py;
  }
});

wrap.addEventListener('mouseup',    () => { painting = false; panning = false; updateCursor(); });
wrap.addEventListener('mouseleave', () => { painting = false; panning = false; updateCursor(); });

// Right-click = quick erase own pixel
wrap.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const { px, py } = canvasToPx(e.clientX, e.clientY);
  const idx = pxToIndex(px, py);
  if (idx >= 0 && pxOwner[idx] === 1) sendErase(idx);
});

// Scroll zoom
wrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });

function zoomAt(mx, my, factor) {
  const nz = Math.max(0.05, Math.min(64, zoom * factor));
  vx   = mx - (mx - vx) * (nz / zoom);
  vy   = my - (my - vy) * (nz / zoom);
  zoom = nz;
  scheduleRender();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { spaceDown = true; updateCursor(); e.preventDefault(); return; }

  const k = e.key;
  if (k === 'p' || k === 'P') setTool('paint');
  if (k === 'e' || k === 'E') setTool('erase');
  if (k === 'i' || k === 'I') setTool('eye');
  if (k === 'f' || k === 'F') { fitView(); scheduleRender(); }
  if (k === '+' || k === '=') zoomAt(window.innerWidth/2, window.innerHeight/2, 1.5);
  if (k === '-')              zoomAt(window.innerWidth/2, window.innerHeight/2, 1/1.5);
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; updateCursor(); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Toolbar buttons
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('btn-paint').onclick = () => setTool('paint');
document.getElementById('btn-erase').onclick = () => setTool('erase');
document.getElementById('btn-eye').onclick   = () => setTool('eye');
document.getElementById('btn-zi').onclick    = () => zoomAt(window.innerWidth/2, window.innerHeight/2, 1.5);
document.getElementById('btn-zo').onclick    = () => zoomAt(window.innerWidth/2, window.innerHeight/2, 1/1.5);
document.getElementById('btn-fit').onclick   = () => { fitView(); scheduleRender(); };

// ═══════════════════════════════════════════════════════════════════════════════
// Color Picker  (circular hue ring + SV square)
// ═══════════════════════════════════════════════════════════════════════════════
const picker = (() => {
  const pc   = document.getElementById('picker-canvas');
  const pctx = pc.getContext('2d');
  const SZ   = pc.width;           // 214
  const CX   = SZ / 2, CY = SZ / 2;
  const OUTER = SZ / 2 - 3;       // outer ring radius
  const RING  = 24;                // ring thickness
  const INNER = OUTER - RING;      // inner ring radius

  // Inscribed square: side = innerR * √2
  const SQ_SIDE = Math.floor(INNER * Math.SQRT2) - 8;
  const SQ_L    = CX - SQ_SIDE / 2;
  const SQ_T    = CY - SQ_SIDE / 2;

  // Current color in HSV
  let hue = 0, sat = 1, val = 0.85;
  let drag = null; // 'ring' | 'square'

  // ── Draw ────────────────────────────────────────────────────────────────────
  function draw() {
    pctx.clearRect(0, 0, SZ, SZ);

    // Hue ring – 360 pie slices
    for (let i = 0; i < 360; i++) {
      const a0 = (i / 360) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((i + 1) / 360) * Math.PI * 2 - Math.PI / 2;
      pctx.beginPath();
      pctx.moveTo(CX, CY);
      pctx.arc(CX, CY, OUTER, a0, a1);
      pctx.closePath();
      pctx.fillStyle = `hsl(${i},100%,50%)`;
      pctx.fill();
    }

    // Punch out centre to make it a ring
    pctx.save();
    pctx.globalCompositeOperation = 'destination-out';
    pctx.beginPath();
    pctx.arc(CX, CY, INNER, 0, Math.PI * 2);
    pctx.fill();
    pctx.restore();

    // SV square – horizontal: white → pure hue; vertical: transparent → black
    const gH = pctx.createLinearGradient(SQ_L, 0, SQ_L + SQ_SIDE, 0);
    gH.addColorStop(0, '#ffffff');
    gH.addColorStop(1, `hsl(${hue},100%,50%)`);
    pctx.fillStyle = gH;
    pctx.fillRect(SQ_L, SQ_T, SQ_SIDE, SQ_SIDE);

    const gV = pctx.createLinearGradient(0, SQ_T, 0, SQ_T + SQ_SIDE);
    gV.addColorStop(0, 'rgba(0,0,0,0)');
    gV.addColorStop(1, '#000000');
    pctx.fillStyle = gV;
    pctx.fillRect(SQ_L, SQ_T, SQ_SIDE, SQ_SIDE);

    // Ring handle
    const ra = (hue / 360) * Math.PI * 2 - Math.PI / 2;
    const rm = OUTER - RING / 2;
    const hx = CX + Math.cos(ra) * rm;
    const hy = CY + Math.sin(ra) * rm;

    pctx.beginPath();
    pctx.arc(hx, hy, 11, 0, Math.PI * 2);
    pctx.fillStyle = `hsl(${hue},100%,50%)`;
    pctx.fill();
    pctx.strokeStyle = '#fff';
    pctx.lineWidth = 2.5;
    pctx.stroke();

    // SV handle
    const sx = SQ_L + sat * SQ_SIDE;
    const sy = SQ_T + (1 - val) * SQ_SIDE;

    pctx.beginPath();
    pctx.arc(sx, sy, 8, 0, Math.PI * 2);
    pctx.fillStyle = cssColor();
    pctx.fill();
    pctx.strokeStyle = '#fff';
    pctx.lineWidth = 2.5;
    pctx.stroke();
  }

  // ── Color conversion ─────────────────────────────────────────────────────────
  function rgb() {
    const h = hue / 360, s = sat, v = val;
    let r, g, b;
    if (s === 0) { r = g = b = v; }
    else {
      const i  = (h * 6) | 0;
      const f  = h * 6 - i;
      const p  = v * (1 - s);
      const q  = v * (1 - f * s);
      const t  = v * (1 - (1 - f) * s);
      switch (i % 6) {
        case 0: r=v; g=t; b=p; break;
        case 1: r=q; g=v; b=p; break;
        case 2: r=p; g=v; b=t; break;
        case 3: r=p; g=q; b=v; break;
        case 4: r=t; g=p; b=v; break;
        case 5: r=v; g=p; b=q; break;
      }
    }
    return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
  }

  function cssColor() {
    const { r, g, b } = rgb();
    return `rgb(${r},${g},${b})`;
  }

  function setFromRGB(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
    val = max;
    sat = max === 0 ? 0 : d / max;
    if (d === 0) { hue = 0; }
    else if (max === r) { hue = ((g - b) / d % 6) * 60; }
    else if (max === g) { hue = ((b - r) / d + 2) * 60; }
    else               { hue = ((r - g) / d + 4) * 60; }
    if (hue < 0) hue += 360;
    notify();
  }

  function notify() {
    draw();
    const { r, g, b } = rgb();
    document.getElementById('color-swatch').style.background = `rgb(${r},${g},${b})`;
    document.getElementById('hex-input').value =
      '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
  }

  // ── Interaction ──────────────────────────────────────────────────────────────
  function inRing(x, y) {
    const d = Math.hypot(x - CX, y - CY);
    return d >= INNER && d <= OUTER;
  }

  function inSquare(x, y) {
    return x >= SQ_L && x <= SQ_L + SQ_SIDE && y >= SQ_T && y <= SQ_T + SQ_SIDE;
  }

  function getPos(e) {
    const r = pc.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function updateDrag(x, y) {
    if (drag === 'ring') {
      hue = ((Math.atan2(y - CY, x - CX) * 180 / Math.PI) + 90 + 360) % 360;
    } else if (drag === 'square') {
      sat = Math.max(0, Math.min(1, (x - SQ_L) / SQ_SIDE));
      val = Math.max(0, Math.min(1, 1 - (y - SQ_T) / SQ_SIDE));
    }
    notify();
  }

  pc.addEventListener('mousedown', (e) => {
    const { x, y } = getPos(e);
    if      (inRing(x, y))   drag = 'ring';
    else if (inSquare(x, y)) drag = 'square';
    if (drag) updateDrag(x, y);
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    updateDrag(...Object.values(getPos(e)));
  });

  window.addEventListener('mouseup', () => { drag = null; });

  // Hex input
  document.getElementById('hex-input').addEventListener('change', (e) => {
    const m = e.target.value.trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return;
    const n = parseInt(m[1], 16);
    setFromRGB((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  });

  // Init
  notify();

  return { rgb, cssColor, setFromRGB };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════════════════
fitView();
scheduleRender();
