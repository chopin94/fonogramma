// Rallentamento senza cambiare l'intonazione (WSOLA): a 0,5× i toni restano
// alla stessa frequenza, utile per riascoltare sdoppiamenti, click e soffi.
import { hann, nextPow2 } from '../dsp/fft.js';

export function wsola(x, speed, fs) {
  if (Math.abs(speed - 1) < 1e-3) return x;
  const N = nextPow2(0.04 * fs);
  const Hs = N / 2;
  const Ha = Hs * speed;
  const tol = Math.round(0.006 * fs);
  const outLen = Math.ceil(x.length / speed) + N;
  const y = new Float32Array(outLen), wsum = new Float32Array(outLen);
  const w = hann(N);
  const get = (i) => (i >= 0 && i < x.length ? x[i] : 0);
  let prevPos = 0;
  for (let m = 0; m * Hs + N < outLen; m++) {
    const target = Math.round(m * Ha);
    if (target >= x.length) break;
    let pos = target;
    if (m > 0) {
      const nat = prevPos + Hs;
      let best = -Infinity, bestD = 0;
      for (let d = -tol; d <= tol; d += 4) {
        const p = target + d;
        if (p < 0) continue;
        let s = 0;
        for (let i = 0; i < N; i += 8) s += get(nat + i) * get(p + i);
        if (s > best) { best = s; bestD = d; }
      }
      pos = Math.max(0, target + bestD);
    }
    const o = m * Hs;
    for (let i = 0; i < N; i++) { y[o + i] += get(pos + i) * w[i]; wsum[o + i] += w[i]; }
    prevPos = pos;
  }
  const L = Math.min(outLen, Math.round(x.length / speed));
  const out = new Float32Array(L);
  for (let i = 0; i < L; i++) out[i] = wsum[i] > 1e-3 ? y[i] / wsum[i] : 0;
  return out;
}
