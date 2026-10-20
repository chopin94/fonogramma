// FFT radix-2 iterativa (in-place) e finestre di analisi.

export class FFT {
  constructor(n) {
    if (n < 2 || (n & (n - 1))) throw new Error('La dimensione FFT deve essere una potenza di 2');
    this.n = n;
    const half = n >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
      this.rev[i] = r;
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  // Trasformata diretta in-place su (re, im).
  transform(re, im) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cs[k] - im[b] * sn[k];
          const ti = re[b] * sn[k] + im[b] * cs[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // Modulo dello spettro (n/2+1 bin) di un frame reale finestrato.
  magnitude(frame, win, out, offset = 0) {
    const n = this.n, re = this.re, im = this.im;
    const len = Math.min(frame.length - offset, n);
    for (let i = 0; i < n; i++) {
      re[i] = i < len ? frame[offset + i] * (win ? win[i] : 1) : 0;
      im[i] = 0;
    }
    this.transform(re, im);
    const m = (n >> 1) + 1;
    for (let k = 0; k < m; k++) out[k] = Math.hypot(re[k], im[k]);
    return out;
  }
}

const fftCache = new Map();
export function getFFT(n) {
  let f = fftCache.get(n);
  if (!f) { f = new FFT(n); fftCache.set(n, f); }
  return f;
}

export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function nextPow2(x) {
  let n = 1;
  while (n < x) n <<= 1;
  return n;
}

// Centroide spettrale (Hz) e frequenza di picco di un segmento, limitati a [fLo, fHi].
export function spectralCentroid(x, fs, start, end, fLo = 20, fHi = 1000) {
  start = Math.max(0, Math.floor(start));
  end = Math.min(x.length, Math.floor(end));
  const len = end - start;
  if (len < 16) return { centroid: NaN, peak: NaN };
  const n = Math.min(4096, nextPow2(Math.max(256, len)));
  const fft = getFFT(n);
  const seg = new Float32Array(n);
  const w = hann(len);
  for (let i = 0; i < len && i < n; i++) seg[i] = x[start + i] * w[i];
  const mag = new Float32Array((n >> 1) + 1);
  fft.magnitude(seg, null, mag);
  const df = fs / n;
  let num = 0, den = 0, best = 0, bestK = 0;
  const k0 = Math.max(1, Math.ceil(fLo / df)), k1 = Math.min(mag.length - 1, Math.floor(fHi / df));
  for (let k = k0; k <= k1; k++) {
    const p = mag[k] * mag[k];
    num += p * k * df;
    den += p;
    if (p > best) { best = p; bestK = k; }
  }
  return { centroid: den > 0 ? num / den : NaN, peak: bestK * df };
}
