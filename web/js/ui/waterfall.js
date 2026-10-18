// Waterfall (spettrogramma a scorrimento) ad alta frequenza di aggiornamento:
// buffer circolare su canvas fuori schermo, una colonna per ogni passo STFT,
// livelli dB automatici, assi di frequenza lineari/logaritmici, eventi sovrapposti.
import { getLut } from './colormaps.js';
import { MARKER_COLORS } from './scope.js';

function niceTicks(fMin, fMax, scale) {
  if (scale === 'log') return [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((f) => f >= fMin && f <= fMax);
  const range = fMax - fMin;
  const steps = [25, 50, 100, 200, 250, 500, 1000, 2000];
  const step = steps.find((s) => range / s <= 7) || 5000;
  const out = [];
  for (let f = Math.ceil(fMin / step) * step; f <= fMax; f += step) out.push(f);
  return out;
}

export class Waterfall {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.ring = document.createElement('canvas');
    this.rctx = this.ring.getContext('2d', { willReadFrequently: false });
    this.cfg = null;
    this.pos = 0;
    this.lut = getLut('turbo');
    this.dbMin = -100;
    this.dbMax = -30;
    this.auto = true;
    this.smooth = false;
    this.total = 0;
    this.frozen = false;
    this.markers = null;
    this.lung = null;
    this.res = new Float32Array(4096);
    this.resN = 0;
    this.lastAuto = 0;
    this.dirty = true;
    this.onLevels = null;
  }

  configure({ fs, hop, fftSize, rows, span, fMin, fMax, scale }) {
    const cols = Math.max(50, Math.round((span * fs) / hop));
    const same = this.cfg && this.cfg.rows === rows && this.cols === cols && this.cfg.fMin === fMin && this.cfg.fMax === fMax && this.cfg.scale === scale && this.cfg.hop === hop && this.cfg.fftSize === fftSize;
    this.cfg = { fs, hop, fftSize, rows, span, fMin, fMax, scale };
    if (same) return;
    this.cols = cols;
    this.ring.width = cols;
    this.ring.height = rows;
    this.rctx.fillStyle = '#000';
    this.rctx.fillRect(0, 0, cols, rows);
    this.pos = 0;
    this.img = null;
    this.dirty = true;
  }

  setColormap(name) { this.lut = getLut(name); }
  setLevels(min, max) { this.dbMin = min; this.dbMax = Math.max(min + 5, max); }

  push(cols, ncols, total) {
    this.total = total;
    if (!cols || !ncols || !this.cfg) return;
    const rows = this.cfg.rows;
    if (cols.length < ncols * rows) return;
    if (!this.img || this.img.width !== ncols) {
      this.img = this.rctx.createImageData(ncols, rows);
      this.u32 = new Uint32Array(this.img.data.buffer);
    }
    const u32 = this.u32, lut = this.lut;
    const k = 255 / (this.dbMax - this.dbMin), lo = this.dbMin;
    for (let c = 0; c < ncols; c++) {
      const off = c * rows;
      for (let r = 0; r < rows; r++) {
        let v = (cols[off + r] - lo) * k;
        v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
        u32[(rows - 1 - r) * ncols + c] = lut[v];
      }
    }
    // campionamento per i livelli automatici
    for (let i = 0; i < 24; i++) {
      const j = (Math.random() * ncols * rows) | 0;
      this.res[this.resN++ % this.res.length] = cols[j];
    }
    const cap = this.cols;
    if (this.pos + ncols <= cap) this.rctx.putImageData(this.img, this.pos, 0);
    else {
      const a = cap - this.pos;
      this.rctx.putImageData(this.img, this.pos, 0, 0, 0, a, rows);
      this.rctx.putImageData(this.img, -a, 0, a, 0, ncols - a, rows);
    }
    this.pos = (this.pos + ncols) % cap;
    this.dirty = true;
    const now = performance.now();
    if (this.auto && now - this.lastAuto > 1000 && this.resN >= 2000) {
      this.lastAuto = now;
      this.autoLevels(false);
    }
  }

  autoLevels(snap = true) {
    const n = Math.min(this.resN, this.res.length);
    if (n < 200) return;
    const s = Float32Array.from(this.res.subarray(0, n)).sort();
    const lo = s[Math.floor(n * 0.25)] - 2;
    const hi = s[Math.floor(n * 0.997)] + 4;
    if (snap) { this.dbMin = lo; this.dbMax = hi; }
    else { this.dbMin = this.dbMin * 0.7 + lo * 0.3; this.dbMax = this.dbMax * 0.7 + hi * 0.3; }
    if (this.dbMax < this.dbMin + 20) this.dbMax = this.dbMin + 20;
    this.onLevels && this.onLevels(this.dbMin, this.dbMax);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, Math.round(this.cv.clientWidth * dpr));
    const h = Math.max(10, Math.round(this.cv.clientHeight * dpr));
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.dpr = dpr;
    this.dirty = true;
  }

  yOfFreq(f, H) {
    const { fMin, fMax, scale } = this.cfg;
    const u = scale === 'log' ? Math.log(f / Math.max(10, fMin)) / Math.log(fMax / Math.max(10, fMin)) : (f - fMin) / (fMax - fMin);
    return H - u * H;
  }

  draw() {
    if (this.frozen || !this.dirty || !this.cfg) return;
    this.dirty = false;
    const { ctx } = this;
    const W = this.cv.width, H = this.cv.height, dpr = this.dpr || 1;
    const { fs, fftSize, span } = this.cfg;
    // allineamento col tracciato: la colonna più recente è centrata N/2 campioni fa
    const lagPx = (fftSize / 2 / fs / span) * W;
    const Wimg = W - lagPx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = this.smooth;
    const cap = this.cols, p = this.pos;
    const wA = ((cap - p) / cap) * Wimg;
    if (cap - p > 0) ctx.drawImage(this.ring, p, 0, cap - p, this.cfg.rows, 0, 0, wA, H);
    if (p > 0) ctx.drawImage(this.ring, 0, 0, p, this.cfg.rows, wA, 0, Wimg - wA, H);

    const xOf = (abs) => W - ((this.total - abs) / fs / span) * W;
    // eventi polmonari
    if (this.lung) {
      for (const w of this.lung.wheezes) {
        const x0 = Math.max(0, xOf(w.a0)), x1 = Math.min(W, xOf(w.a1));
        if (x1 < 0 || x0 > W) continue;
        const y = this.yOfFreq(w.f, H);
        ctx.strokeStyle = w.type === 'ronco' ? '#ff9f1c' : '#ffffff';
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const c of this.lung.crackles) {
        const x = xOf(c.at);
        if (x < 0 || x > W) continue;
        ctx.fillStyle = c.type === 'fine' ? '#ffd166' : '#ff6b6b';
        ctx.beginPath(); ctx.moveTo(x, 10 * dpr); ctx.lineTo(x - 4 * dpr, 2 * dpr); ctx.lineTo(x + 4 * dpr, 2 * dpr); ctx.fill();
      }
    }
    // marcatori dei toni cardiaci (tacche in alto)
    if (this.markers) {
      for (const k of ['s1', 's2', 's3', 's4']) {
        ctx.fillStyle = MARKER_COLORS[k];
        for (const a of this.markers[k] || []) {
          const x = xOf(a);
          if (x < 0 || x > W) continue;
          ctx.fillRect(x - dpr, 0, 2 * dpr, 7 * dpr);
        }
      }
    }
    // asse delle frequenze
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    for (const f of niceTicks(this.cfg.fMin, this.cfg.fMax, this.cfg.scale)) {
      const y = Math.round(this.yOfFreq(f, H)) + 0.5;
      if (y < 8 * dpr || y > H - 4) continue;
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.beginPath(); ctx.moveTo(34 * dpr, y); ctx.lineTo(W, y); ctx.stroke();
      const lab = f >= 1000 ? `${f / 1000}k` : `${f}`;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, y - 7 * dpr, 32 * dpr, 13 * dpr);
      ctx.fillStyle = 'rgba(230,238,255,0.9)';
      ctx.fillText(lab, 3 * dpr, y + 3.5 * dpr);
    }
  }
}
