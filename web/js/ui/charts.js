// Grafici statici: ciclo cardiaco medio, profili, inviluppo respiratorio,
// vista completa di una registrazione (tracciato + spettrogramma) con selezione e cursore.
import { getLut } from './colormaps.js';
import { MARKER_COLORS, MARKER_LABELS, fitCanvas, roundRect, systoles, freqTicks, drawFreqAxis } from './canvas.js';

function placeholder(ctx, W, H, dpr, msg) {
  ctx.fillStyle = 'rgba(200,210,235,0.55)';
  ctx.font = `${12 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(msg, W / 2, H / 2 + 4 * dpr);
}

function badge(ctx, x, y, text, color, dpr) {
  ctx.font = `700 ${10.5 * dpr}px system-ui, sans-serif`;
  const tw = ctx.measureText(text).width + 8 * dpr;
  ctx.fillStyle = color;
  roundRect(ctx, x - tw / 2, y, tw, 14 * dpr, 4 * dpr);
  ctx.fill();
  ctx.fillStyle = '#0a0f1c';
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y + 10.5 * dpr);
}

// Ciclo cardiaco medio (allineato su S1) con banda ±DS e battiti singoli.
export function drawEnsemble(cv, ens) {
  const { W, H, dpr, ctx } = fitCanvas(cv);
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, W, H);
  if (!ens) return placeholder(ctx, W, H, dpr, 'In attesa di battiti riconosciuti…');
  const L = ens.mean.length, total = L / ens.envFs;
  const x = (t) => ((t + ens.pre) / total) * W;
  let ymax = 1e-6;
  for (let k = 0; k < L; k++) ymax = Math.max(ymax, ens.mean[k] + ens.std[k]);
  ymax *= 1.1;
  const top = 20 * dpr, bot = H - 14 * dpr;
  const y = (v) => bot - (v / ymax) * (bot - top);
  ctx.fillStyle = 'rgba(255,214,102,0.10)';
  ctx.fillRect(x(0), top, x(ens.s2) - x(0), bot - top);
  ctx.strokeStyle = 'rgba(160,175,210,0.18)';
  ctx.lineWidth = 1;
  for (const tr of ens.traces) {
    ctx.beginPath();
    for (let k = 0; k < tr.length; k++) { const xx = (k / L) * W; k ? ctx.lineTo(xx, y(tr[k])) : ctx.moveTo(xx, y(tr[k])); }
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(45,212,191,0.18)';
  ctx.beginPath();
  for (let k = 0; k < L; k++) ctx.lineTo((k / L) * W, y(ens.mean[k] + ens.std[k]));
  for (let k = L - 1; k >= 0; k--) ctx.lineTo((k / L) * W, y(Math.max(0, ens.mean[k] - ens.std[k])));
  ctx.fill();
  ctx.strokeStyle = '#2dd4bf';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  for (let k = 0; k < L; k++) { const xx = (k / L) * W; k ? ctx.lineTo(xx, y(ens.mean[k])) : ctx.moveTo(xx, y(ens.mean[k])); }
  ctx.stroke();
  ctx.fillStyle = 'rgba(200,210,235,0.6)';
  ctx.font = `${9.5 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  for (let t = 0; t <= total - ens.pre; t += 0.2) ctx.fillText(`${Math.round(t * 1000)}`, x(t), H - 3 * dpr);
  badge(ctx, x(0), 3 * dpr, 'S1', MARKER_COLORS.s1, dpr);
  badge(ctx, x(ens.s2), 3 * dpr, 'S2', MARKER_COLORS.s2, dpr);
  if (ens.rr && x(ens.rr) < W - 10) badge(ctx, x(ens.rr), 3 * dpr, 'S1', MARKER_COLORS.s1, dpr);
  ctx.textAlign = 'left';
  ctx.fillText(`${ens.count} battiti`, 4 * dpr, H - 3 * dpr);
}

// Profilo medio (20 intervalli) di sistole o diastole.
export function drawProfile(cv, prof, { color = '#ffb547', label = '' } = {}) {
  const { W, H, dpr, ctx } = fitCanvas(cv);
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, W, H);
  if (!prof) return placeholder(ctx, W, H, dpr, 'Profilo non disponibile');
  const n = prof.length;
  const mx = Math.max(0.3, ...prof);
  const bw = W / n;
  for (let k = 0; k < n; k++) {
    const h = (prof[k] / mx) * (H - 18 * dpr);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35 + 0.65 * (prof[k] / mx);
    ctx.fillRect(k * bw + 1, H - 14 * dpr - h, bw - 2, h);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(200,210,235,0.7)';
  ctx.font = `${10 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(label, 4 * dpr, H - 3 * dpr);
}

// Inviluppo respiratorio con respiri, crepitii e sibili.
export function drawResp(cv, lung, { duration = null, offset = 0 } = {}) {
  const { W, H, dpr, ctx } = fitCanvas(cv);
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, W, H);
  if (!lung || !lung.resp || lung.resp.length < 4) return placeholder(ctx, W, H, dpr, 'In attesa del ciclo respiratorio…');
  const r = lung.resp, fr = lung.respFs, t0 = lung.respT0 || 0;
  const dur = duration || r.length / fr + t0;
  const x = (t) => ((t - offset) / dur) * W;
  let lo = Infinity, hi = -Infinity;
  for (const v of r) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(6, hi - lo);
  const y = (v) => H - 16 * dpr - ((v - lo) / span) * (H - 34 * dpr);
  ctx.strokeStyle = '#4cc9f0';
  ctx.lineWidth = 1.6 * dpr;
  ctx.beginPath();
  for (let k = 0; k < r.length; k++) { const xx = x(t0 + k / fr); k ? ctx.lineTo(xx, y(r[k])) : ctx.moveTo(xx, y(r[k])); }
  ctx.stroke();
  for (const b of lung.breaths || []) {
    const bt = typeof b === 'number' ? b : b.t;
    ctx.fillStyle = 'rgba(76,201,240,0.9)';
    ctx.beginPath(); ctx.arc(x(bt), 10 * dpr, 3 * dpr, 0, 7); ctx.fill();
  }
  for (const w of lung.wheezes || []) {
    ctx.fillStyle = w.type === 'ronco' ? 'rgba(255,159,28,0.5)' : 'rgba(255,255,255,0.45)';
    ctx.fillRect(x(w.t0), H - 12 * dpr, Math.max(2, x(w.t1) - x(w.t0)), 5 * dpr);
  }
  for (const c of lung.crackles || []) {
    ctx.fillStyle = c.type === 'fine' ? '#ffd166' : '#ff6b6b';
    ctx.fillRect(x(c.t) - dpr / 2, H - 22 * dpr, Math.max(1, dpr), 9 * dpr);
  }
}

// ---------- Vista registrazione ----------
export function specLevels(cols) {
  const n = cols.length;
  if (!n) return [-100, -30];
  const m = Math.min(20000, n);
  const s = new Float32Array(m);
  for (let i = 0; i < m; i++) s[i] = cols[Math.floor((i / m) * n)];
  s.sort();
  const lo = s[Math.floor(m * 0.3)] - 2, hi = s[Math.floor(m * 0.997)] + 3;
  return [lo, Math.max(lo + 20, hi)];
}

export function buildSpecImage(spec, lutName, dbMin, dbMax) {
  const { cols, ncols, rows } = spec;
  const c = document.createElement('canvas');
  c.width = Math.max(1, ncols);
  c.height = rows;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, rows);
  const u32 = new Uint32Array(img.data.buffer);
  const lut = getLut(lutName);
  const k = 255 / (dbMax - dbMin);
  for (let col = 0; col < ncols; col++) {
    for (let r = 0; r < rows; r++) {
      let v = (cols[col * rows + r] - dbMin) * k;
      v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
      u32[(rows - 1 - r) * ncols + col] = lut[v];
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function drawWaveView(cv, ov, view, o = {}) {
  const { W, H, dpr, ctx } = fitCanvas(cv);
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, W, H);
  const [a, b] = view;
  const bs = ov.bucketS;
  const n = ov.min.length;
  let peak = 1e-6;
  const i0 = Math.max(0, Math.floor(a / bs)), i1 = Math.min(n, Math.ceil(b / bs));
  for (let i = i0; i < i1; i++) peak = Math.max(peak, Math.abs(ov.min[i]), Math.abs(ov.max[i]));
  const yk = (H / 2 - 8 * dpr) / (peak * 1.05);
  const tSpan = b - a;
  // sistole
  if (o.markers && o.markers.s1) {
    ctx.fillStyle = 'rgba(255,214,102,0.08)';
    for (const [s, e] of systoles(o.markers.s1, o.markers.s2, 0.7)) {
      if (e < a || s > b) continue;
      ctx.fillRect(((s - a) / tSpan) * W, 0, ((e - s) / tSpan) * W, H);
    }
  }
  ctx.strokeStyle = '#38e1ff';
  ctx.lineWidth = Math.max(1, dpr * 0.9);
  ctx.beginPath();
  for (let px = 0; px < W; px++) {
    const t0 = a + (px / W) * tSpan, t1 = a + ((px + 1) / W) * tSpan;
    const k0 = Math.max(0, Math.floor(t0 / bs)), k1 = Math.min(n, Math.max(k0 + 1, Math.ceil(t1 / bs)));
    let lo = Infinity, hi = -Infinity;
    for (let k = k0; k < k1; k++) { if (ov.min[k] < lo) lo = ov.min[k]; if (ov.max[k] > hi) hi = ov.max[k]; }
    if (lo === Infinity) continue;
    ctx.moveTo(px + 0.5, H / 2 - hi * yk);
    ctx.lineTo(px + 0.5, Math.max(H / 2 - lo * yk, H / 2 - hi * yk + 1));
  }
  ctx.stroke();
  if (o.markers) {
    for (const k of Object.keys(MARKER_LABELS)) {
      for (const t of o.markers[k] || []) {
        if (t < a || t > b) continue;
        const xx = ((t - a) / tSpan) * W;
        ctx.strokeStyle = MARKER_COLORS[k];
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([3 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(xx, 18 * dpr); ctx.lineTo(xx, H); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        if (tSpan < 25) badge(ctx, xx, 2 * dpr, MARKER_LABELS[k], MARKER_COLORS[k], dpr);
      }
    }
  }
  if (o.crackles) {
    for (const c of o.crackles) {
      if (c.t < a || c.t > b) continue;
      ctx.fillStyle = c.type === 'fine' ? '#ffd166' : '#ff6b6b';
      ctx.fillRect(((c.t - a) / tSpan) * W - dpr, H - 12 * dpr, 2 * dpr, 10 * dpr);
    }
  }
  // asse del tempo
  ctx.fillStyle = 'rgba(200,210,235,0.6)';
  ctx.font = `${10 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30].find((s) => tSpan / s <= 10) || 60;
  for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
    const xx = ((t - a) / tSpan) * W;
    ctx.fillRect(xx, H - 4 * dpr, 1, 4 * dpr);
    ctx.fillText(step < 1 ? t.toFixed(1) : `${Math.round(t)} s`, xx, H - 6 * dpr);
  }
}

export function drawSpecView(cv, img, spec, view, o = {}) {
  const { W, H, dpr, ctx } = fitCanvas(cv);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const [a, b] = view;
  const c0 = (a - spec.t0) / spec.dt, c1 = (b - spec.t0) / spec.dt;
  const sx = Math.max(0, c0), ex = Math.min(spec.ncols, c1);
  if (ex > sx) {
    const dx0 = ((sx - c0) / (c1 - c0)) * W, dx1 = ((ex - c0) / (c1 - c0)) * W;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, sx, 0, ex - sx, spec.rows, dx0, 0, dx1 - dx0, H);
  }
  const fy = (f) => H - ((f - spec.fMin) / (spec.fMax - spec.fMin)) * H;
  if (o.wheezes) {
    for (const w of o.wheezes) {
      if (w.t1 < a || w.t0 > b) continue;
      ctx.strokeStyle = w.type === 'ronco' ? '#ff9f1c' : '#ffffff';
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      const yy = fy(w.f);
      ctx.beginPath(); ctx.moveTo(((w.t0 - a) / (b - a)) * W, yy); ctx.lineTo(((w.t1 - a) / (b - a)) * W, yy); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  drawFreqAxis(ctx, freqTicks(spec.fMin, spec.fMax), fy, W, H, dpr);
}

// Spettrogramma medio del ciclo (sincronizzato su S1).
export function drawCycleSpec(cv, cyc, lutName) {
  const { W, H, dpr, ctx } = fitCanvas(cv);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!cyc) return placeholder(ctx, W, H, dpr, 'Servono almeno 2 cicli riconosciuti');
  const [lo, hi] = specLevels(cyc.cols);
  const img = buildSpecImage(cyc, lutName, lo, hi);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, W, H);
  const x = (t) => ((t + cyc.pre) / cyc.window) * W;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  for (const t of [0, cyc.s2]) { ctx.beginPath(); ctx.moveTo(x(t), 16 * dpr); ctx.lineTo(x(t), H); ctx.stroke(); }
  ctx.setLineDash([]);
  badge(ctx, x(0), 2 * dpr, 'S1', MARKER_COLORS.s1, dpr);
  badge(ctx, x(cyc.s2), 2 * dpr, 'S2', MARKER_COLORS.s2, dpr);
  const fy = (f) => H - ((f - cyc.fMin) / (cyc.fMax - cyc.fMin)) * H;
  drawFreqAxis(ctx, freqTicks(cyc.fMin, cyc.fMax), fy, W, H, dpr, { grid: false });
}

// Immagine riassuntiva (PNG) per il referto.
export function renderThumb({ overview, spec, markers, lutName = 'turbo', width = 900 }) {
  const c = document.createElement('canvas');
  c.style.width = `${width}px`;
  c.style.height = '260px';
  c.style.position = 'fixed';
  c.style.left = '-9999px';
  document.body.appendChild(c);
  const w1 = document.createElement('canvas');
  w1.style.cssText = `width:${width}px;height:100px;position:fixed;left:-9999px`;
  const s1 = document.createElement('canvas');
  s1.style.cssText = `width:${width}px;height:160px;position:fixed;left:-9999px`;
  document.body.append(w1, s1);
  const dur = overview.min.length * overview.bucketS;
  const view = [0, Math.min(dur, 8)];
  drawWaveView(w1, overview, view, { markers });
  const [lo, hi] = specLevels(spec.cols);
  drawSpecView(s1, buildSpecImage(spec, lutName, lo, hi), spec, view, {});
  c.width = w1.width;
  c.height = w1.height + s1.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(w1, 0, 0);
  ctx.drawImage(s1, 0, w1.height);
  const url = c.toDataURL('image/png');
  c.remove(); w1.remove(); s1.remove();
  return url;
}
