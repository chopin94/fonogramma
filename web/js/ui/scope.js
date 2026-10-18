// Tracciato PCG in tempo reale: min/max per millisecondo, marcatori S1–S4,
// evidenziazione della sistole, inviluppo, scala verticale automatica.
const COL = { s1: '#ff5d7a', s2: '#4cc9f0', s3: '#ffb547', s4: '#c77dff', clicks: '#9ef01a', snaps: '#f72585' };
const LABEL = { s1: 'S1', s2: 'S2', s3: 'S3', s4: 'S4', clicks: 'C', snaps: 'OS' };

export class Scope {
  constructor(canvas, { capacityS = 30 } = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.capacityS = capacityS;
    this.fs = 48000;
    this.bucket = 48;
    this.span = 5;
    this.total = 0;
    this.count = 0;
    this.alloc();
    this.markers = { s1: [], s2: [], s3: [], s4: [], clicks: [], snaps: [] };
    this.env = null;
    this.half = 0.05;
    this.showRaw = false;
    this.showEnv = true;
    this.frozen = false;
    this.lungEvents = null;
    this.dirty = true;
  }

  alloc() {
    this.cap = Math.round(this.capacityS * 1000);
    this.mn = new Float32Array(this.cap);
    this.mx = new Float32Array(this.cap);
    this.rmn = new Float32Array(this.cap);
    this.rmx = new Float32Array(this.cap);
    this.count = 0;
  }

  setRate(fs, bucket) { this.fs = fs; this.bucket = bucket; this.alloc(); this.total = 0; }

  reset() {
    this.count = 0;
    this.total = 0;
    for (const k in this.markers) this.markers[k] = [];
    this.env = null;
    this.lungEvents = null;
    this.dirty = true;
  }

  push(d) {
    for (let k = 0; k < d.nb; k++) {
      const i = this.count % this.cap;
      this.mn[i] = d.mmMin[k]; this.mx[i] = d.mmMax[k];
      this.rmn[i] = d.rwMin[k]; this.rmx[i] = d.rwMax[k];
      this.count++;
    }
    this.total = d.total;
    this.dirty = true;
  }

  // Sostituisce i marcatori nell'intervallo analizzato [a, b] (campioni assoluti)
  setMarkers(markers, a, b) {
    for (const k of Object.keys(this.markers)) {
      const keep = this.markers[k].filter((v) => v < a || v > b);
      const add = (markers[k] || []).filter((v) => v >= a && v <= b);
      const minKeep = this.total - this.capacityS * this.fs;
      this.markers[k] = keep.concat(add).filter((v) => v > minKeep).sort((x, y) => x - y);
    }
    this.dirty = true;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, Math.round(this.cv.clientWidth * dpr));
    const h = Math.max(10, Math.round(this.cv.clientHeight * dpr));
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.dpr = dpr;
    this.dirty = true;
  }

  xOf(abs, W) {
    return W - ((this.total - abs) / this.fs / this.span) * W;
  }

  draw() {
    if (this.frozen || !this.dirty) return;
    this.dirty = false;
    const { ctx } = this;
    const W = this.cv.width, H = this.cv.height, dpr = this.dpr || 1;
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, W, H);

    // griglia: secondi e decimi
    ctx.lineWidth = 1;
    const pxS = W / this.span;
    const tNow = this.total / this.fs;
    const base = Math.floor(tNow * 5);
    for (let k = 0; k <= this.span * 5 + 1; k++) {
      const idx = base - k;
      const x = W - ((tNow - idx / 5) / this.span) * W;
      if (x < 0) break;
      const major = ((idx % 5) + 5) % 5 === 0;
      ctx.strokeStyle = major ? 'rgba(120,150,200,0.22)' : 'rgba(120,150,200,0.08)';
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(120,150,200,0.18)';
    ctx.beginPath(); ctx.moveTo(0, H / 2 + 0.5); ctx.lineTo(W, H / 2 + 0.5); ctx.stroke();

    const nVis = Math.round(this.span * 1000);
    const end = this.count;
    const start = end - nVis;
    const bpp = nVis / W;
    // scala automatica (picco robusto degli ultimi secondi visibili)
    let peak = 1e-6;
    for (let b = Math.max(start, end - nVis, end - this.cap); b < end; b += 3) {
      const i = ((b % this.cap) + this.cap) % this.cap;
      const v = Math.max(Math.abs(this.mn[i]), Math.abs(this.mx[i]));
      if (v > peak) peak = v;
    }
    const target = peak * 1.15;
    this.half = target > this.half ? this.half * 0.6 + target * 0.4 : this.half * 0.97 + target * 0.03;
    const yk = (H / 2 - 6 * dpr) / Math.max(this.half, 1e-6);
    const yOf = (v) => H / 2 - v * yk;

    // sistole evidenziata (S1 → S2 successivo)
    const s1 = this.markers.s1, s2 = this.markers.s2;
    ctx.fillStyle = 'rgba(255, 214, 102, 0.07)';
    for (const a of s1) {
      const b = s2.find((v) => v > a && v - a < 0.7 * this.fs);
      if (b === undefined) continue;
      const x0 = this.xOf(a, W), x1 = this.xOf(b, W);
      if (x1 < 0 || x0 > W) continue;
      ctx.fillRect(x0, 0, x1 - x0, H);
    }

    const trace = (mn, mx, color, lw) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let px = 0; px < W; px++) {
        const b0 = Math.floor(start + px * bpp);
        const b1 = Math.max(b0 + 1, Math.floor(start + (px + 1) * bpp));
        if (b1 <= end - this.cap || b0 < 0) continue;
        let lo = Infinity, hi = -Infinity;
        for (let b = Math.max(b0, 0); b < Math.min(b1, end); b++) {
          const i = b % this.cap;
          if (mn[i] < lo) lo = mn[i];
          if (mx[i] > hi) hi = mx[i];
        }
        if (lo === Infinity) continue;
        const y0 = yOf(hi), y1 = yOf(lo);
        ctx.moveTo(px + 0.5, y0);
        ctx.lineTo(px + 0.5, Math.max(y1, y0 + 1));
      }
      ctx.stroke();
    };
    if (this.showRaw) trace(this.rmn, this.rmx, 'rgba(160,170,190,0.35)', 1);
    trace(this.mn, this.mx, '#38e1ff', Math.max(1, dpr * 0.9));

    // inviluppo dell'analisi
    if (this.showEnv && this.env) {
      const { data, envFs, start: es } = this.env;
      ctx.strokeStyle = 'rgba(255, 214, 102, 0.75)';
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      let first = true;
      const step = Math.max(1, Math.floor(data.length / W));
      for (let k = 0; k < data.length; k += step) {
        const x = this.xOf(es + (k / envFs) * this.fs, W);
        if (x < 0) continue;
        const y = H - 4 * dpr - Math.min(1.2, data[k]) * (H * 0.42);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // eventi polmonari (crepitii) sul tracciato
    if (this.lungEvents) {
      ctx.fillStyle = '#ffd166';
      for (const c of this.lungEvents.crackles) {
        const x = this.xOf(c.at, W);
        if (x < 0 || x > W) continue;
        ctx.fillRect(x - dpr, H - 14 * dpr, 2 * dpr, 10 * dpr);
      }
    }

    // marcatori dei toni (le etichette che si sovrapporrebbero vengono omesse)
    ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const all = [];
    for (const k of Object.keys(this.markers)) {
      for (const a of this.markers[k]) {
        const x = this.xOf(a, W);
        if (x >= -10 && x <= W + 10) all.push({ x, k });
      }
    }
    all.sort((p, q) => p.x - q.x);
    let lastRight = -Infinity;
    for (const { x, k } of all) {
      const col = COL[k];
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(x, 18 * dpr); ctx.lineTo(x, H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const lab = LABEL[k];
      const tw = ctx.measureText(lab).width + 8 * dpr;
      if (x - tw / 2 < lastRight + 2 * dpr) continue;
      lastRight = x + tw / 2;
      ctx.fillStyle = col;
      roundRect(ctx, x - tw / 2, 2 * dpr, tw, 15 * dpr, 4 * dpr);
      ctx.fill();
      ctx.fillStyle = '#0a0f1c';
      ctx.fillText(lab, x, 13.5 * dpr);
    }
    // etichette dei secondi
    ctx.fillStyle = 'rgba(180,195,225,0.6)';
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    for (let s = 1; s <= this.span; s++) ctx.fillText(`-${s} s`, W - s * pxS - 3 * dpr, H - 4 * dpr);
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const MARKER_COLORS = COL;
