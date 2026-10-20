// Utility comuni per i grafici su canvas: dimensionamento ad alta densità, colori ed
// etichette dei toni cardiaci, asse delle frequenze, intervalli sistolici.

export const MARKER_COLORS = { s1: '#ff5d7a', s2: '#4cc9f0', s3: '#ffb547', s4: '#c77dff', clicks: '#9ef01a', snaps: '#f72585' };
export const MARKER_LABELS = { s1: 'S1', s2: 'S2', s3: 'S3', s4: 'S4', clicks: 'C', snaps: 'OS' };

// Adatta la risoluzione del canvas alla dimensione a schermo (densità massima 2×).
export function fitCanvas(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(10, Math.round(cv.clientWidth * dpr));
  const H = Math.max(10, Math.round(cv.clientHeight * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  return { W, H, dpr, ctx: cv.getContext('2d') };
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

// Coppie [S1, S2] che delimitano ogni sistole (S2 entro maxGap dopo S1).
export function systoles(s1, s2, maxGap) {
  const out = [];
  for (const a of s1) {
    const b = s2.find((v) => v > a && v - a < maxGap);
    if (b !== undefined) out.push([a, b]);
  }
  return out;
}

export function freqTicks(fMin, fMax, scale = 'lin') {
  if (scale === 'log') return [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((f) => f >= fMin && f <= fMax);
  const step = [25, 50, 100, 200, 250, 500, 1000, 2000].find((s) => (fMax - fMin) / s <= 7) || 5000;
  const out = [];
  for (let f = Math.ceil(fMin / step) * step; f <= fMax; f += step) out.push(f);
  return out;
}

// Etichette dell'asse delle frequenze (a sinistra) con linee guida facoltative.
export function drawFreqAxis(ctx, ticks, yOf, W, H, dpr, { grid = true } = {}) {
  ctx.font = `${10 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
  for (const f of ticks) {
    const y = Math.round(yOf(f)) + 0.5;
    if (y < 8 * dpr || y > H - 4) continue;
    if (grid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.beginPath(); ctx.moveTo(34 * dpr, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, y - 7 * dpr, 32 * dpr, 13 * dpr);
    ctx.fillStyle = 'rgba(230,238,255,0.9)';
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 3 * dpr, y + 3.5 * dpr);
  }
}
