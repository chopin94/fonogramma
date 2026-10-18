// Utility statistiche e ricerca picchi (equivalente semplificato di scipy.signal.find_peaks).

export function percentile(arr, p) {
  const n = arr.length;
  if (!n) return 0;
  const step = n > 20000 ? Math.ceil(n / 20000) : 1;
  const tmp = new Float64Array(Math.ceil(n / step));
  for (let i = 0, j = 0; i < n; i += step, j++) tmp[j] = arr[i];
  tmp.sort();
  const idx = Math.min(tmp.length - 1, Math.max(0, Math.round((p / 100) * (tmp.length - 1))));
  return tmp[idx];
}

export function median(arr) {
  return percentile(arr, 50);
}

export function mean(arr) {
  if (!arr.length) return NaN;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

export function mad(arr, med = median(arr)) {
  const d = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) d[i] = Math.abs(arr[i] - med);
  return median(d);
}

// Media mobile centrata, O(n).
export function movingAverage(x, w) {
  const n = x.length, y = new Float32Array(n);
  if (w <= 1) { y.set(x); return y; }
  const h = Math.floor(w / 2);
  let s = 0, cnt = 0;
  for (let i = 0; i < Math.min(n, h); i++) { s += x[i]; cnt++; }
  for (let i = 0; i < n; i++) {
    const add = i + h, rem = i - h - 1;
    if (add < n) { s += x[add]; cnt++; }
    if (rem >= 0) { s -= x[rem]; cnt--; }
    y[i] = s / cnt;
  }
  return y;
}

// Mediana mobile centrata (finestre piccole).
export function movingMedian(x, w) {
  const n = x.length, y = new Float32Array(n);
  const h = Math.floor(w / 2);
  const buf = new Float64Array(2 * h + 1);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
    const len = b - a + 1;
    for (let j = 0; j < len; j++) buf[j] = x[a + j];
    const sub = buf.subarray(0, len);
    sub.sort();
    y[i] = sub[len >> 1];
  }
  return y;
}

// Picchi locali con soglia di altezza, distanza minima e prominenza.
export function findPeaks(x, { height = -Infinity, distance = 1, prominence = 0, wlen = 0 } = {}) {
  const n = x.length;
  let cand = [];
  for (let i = 1; i < n - 1; i++) {
    if (x[i] > x[i - 1] && x[i] >= height) {
      let j = i;
      while (j < n - 1 && x[j + 1] === x[i]) j++;
      if (j < n - 1 && x[j + 1] < x[i]) cand.push((i + j) >> 1);
      i = j;
    }
  }
  if (prominence > 0) {
    const lim = wlen > 0 ? Math.floor(wlen / 2) : n;
    cand = cand.filter((p) => {
      const v = x[p];
      let minL = v, minR = v;
      for (let i = p - 1; i >= Math.max(0, p - lim); i--) { if (x[i] > v) break; if (x[i] < minL) minL = x[i]; }
      for (let i = p + 1; i <= Math.min(n - 1, p + lim); i++) { if (x[i] > v) break; if (x[i] < minR) minR = x[i]; }
      return v - Math.max(minL, minR) >= prominence;
    });
  }
  if (distance > 1 && cand.length > 1) {
    const order = cand.slice().sort((a, b) => x[b] - x[a]);
    const keep = new Uint8Array(n);
    for (const p of order) {
      let ok = true;
      const a = Math.max(0, p - distance + 1), b = Math.min(n - 1, p + distance - 1);
      for (let j = a; j <= b; j++) if (keep[j]) { ok = false; break; }
      if (ok) keep[p] = 1;
    }
    cand = cand.filter((p) => keep[p]);
  }
  return cand;
}

// Raggruppa picchi più vicini di `tol` campioni tenendo il più alto.
export function clusterPeaks(peaks, x, tol) {
  const out = [];
  if (!peaks.length) return out;
  let anchor = peaks[0], best = peaks[0];
  for (let k = 1; k < peaks.length; k++) {
    const p = peaks[k];
    if (p - anchor <= tol) {
      if (x[p] > x[best]) best = p;
    } else {
      out.push(best);
      anchor = p;
      best = p;
    }
  }
  out.push(best);
  return out;
}
