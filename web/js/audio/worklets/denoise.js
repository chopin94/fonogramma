// Riduzione del rumore di fondo (sottrazione spettrale con stima adattiva del rumore
// per minimi). Pensata per l'ascolto cardiaco: il rumore ambientale stazionario viene
// attenuato, i toni (transitori) restano. Sconsigliata per i polmoni (il murmure
// vescicolare è anch'esso "rumore").
const N = 1024, H = 256, NB = N / 2 + 1;

class MiniFFT {
  constructor(n) {
    this.n = n;
    this.c = new Float64Array(n / 2);
    this.s = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.c[i] = Math.cos((2 * Math.PI * i) / n); this.s[i] = -Math.sin((2 * Math.PI * i) / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1); this.rev[i] = r; }
  }
  run(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) { const j = this.rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * this.c[k] - im[b] * this.s[k], ti = re[b] * this.s[k] + im[b] * this.c[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fft = new MiniFFT(N);
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    this.ana = new Float64Array(N);
    this.ola = new Float64Array(N);
    this.inQ = new Float32Array(H);
    this.outQ = new Float32Array(H);
    this.p = 0;
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.ps = new Float64Array(NB);
    this.noise = new Float64Array(NB).fill(1e9);
    this.gPrev = new Float64Array(NB).fill(1);
    this.alpha = 1.5;
    this.enabled = true;
    this.frames = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
      if (typeof d.strength === 'number') this.alpha = d.strength;
    };
  }

  frame() {
    const { re, im, ana, win, ps, noise, gPrev } = this;
    ana.copyWithin(0, H);
    ana.set(this.inQ, N - H);
    for (let i = 0; i < N; i++) { re[i] = ana[i] * win[i]; im[i] = 0; }
    this.fft.run(re, im);
    this.frames++;
    for (let k = 0; k < NB; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      ps[k] = this.frames < 3 ? p : 0.7 * ps[k] + 0.3 * p;
      noise[k] = ps[k] < noise[k] ? ps[k] : noise[k] * 1.004 + 1e-20;
      let g = 1 - this.alpha * Math.sqrt(noise[k] / (p + 1e-20));
      if (g < 0.12) g = 0.12;
      g = 0.5 * g + 0.5 * gPrev[k];
      gPrev[k] = g;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    // IFFT tramite coniugazione
    for (let i = 0; i < N; i++) im[i] = -im[i];
    this.fft.run(re, im);
    const ola = this.ola;
    ola.copyWithin(0, H);
    ola.fill(0, N - H);
    for (let i = 0; i < N; i++) ola[i] += (re[i] / N) * win[i] * 0.5;
    for (let i = 0; i < H; i++) this.outQ[i] = ola[i];
  }

  process(inputs, outputs) {
    const x = inputs[0] && inputs[0][0];
    const y = outputs[0] && outputs[0][0];
    if (!y) return true;
    if (!x) { y.fill(0); return true; }
    if (!this.enabled) { y.set(x); return true; }
    for (let i = 0; i < x.length; i++) {
      this.inQ[this.p] = x[i];
      y[i] = this.outQ[this.p];
      if (++this.p === H) { this.p = 0; this.frame(); }
    }
    return true;
  }
}

registerProcessor('pcg-denoise', DenoiseProcessor);
