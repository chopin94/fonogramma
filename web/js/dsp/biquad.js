// Filtri IIR a sezioni biquadratiche (formule "Audio EQ Cookbook" di R. Bristow-Johnson).
// Gli stessi coefficienti vengono usati in JS (analisi) e in Web Audio (IIRFilterNode),
// così ciò che si ascolta coincide con ciò che si analizza.

export function design(type, f0, fs, q = Math.SQRT1_2, gainDb = 0) {
  const nyq = fs / 2;
  f0 = Math.min(Math.max(f0, 1), nyq * 0.995);
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const Q = Math.max(0.05, q);
  const alpha = sw / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - s; break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - s; break;
    }
    default:
      return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Q delle sezioni di un Butterworth di ordine pari.
export function butterQs(order) {
  const n = Math.max(2, order + (order % 2));
  const qs = [];
  for (let k = 1; k <= n / 2; k++) qs.push(1 / (2 * Math.cos((Math.PI * (2 * k - 1)) / (2 * n))));
  return qs;
}

// Banda dell'equalizzatore -> sezioni. HP/LP usano "slope" in dB/ottava (12/24/36/48).
export function sectionsForBand(band, fs) {
  if (!band || band.enabled === false) return [];
  const f = band.freq;
  switch (band.type) {
    case 'highpass':
    case 'lowpass': {
      const order = Math.max(2, Math.round((band.slope || 24) / 6));
      return butterQs(order).map((q) => design(band.type, f, fs, q));
    }
    case 'peaking':
    case 'lowshelf':
    case 'highshelf':
      if (!band.gain) return [];
      return [design(band.type, f, fs, band.q || (band.type === 'peaking' ? 1 : Math.SQRT1_2), band.gain)];
    case 'notch':
      return [design('notch', f, fs, band.q || 8)];
    case 'bandpass':
      return [design('bandpass', f, fs, band.q || 1)];
    default:
      return [];
  }
}

export function sectionsForBands(bands, fs) {
  const out = [];
  for (const b of bands || []) out.push(...sectionsForBand(b, fs));
  return out;
}

export function bandpassSections(fs, lo, hi, orderHp = 4, orderLp = 4) {
  const s = [];
  if (lo > 0) for (const q of butterQs(orderHp)) s.push(design('highpass', lo, fs, q));
  if (hi > 0 && hi < fs / 2 * 0.99) for (const q of butterQs(orderLp)) s.push(design('lowpass', hi, fs, q));
  return s;
}

// Filtro a flusso continuo (Direct Form II trasposta) con stato persistente.
export class SosStream {
  constructor(sections) {
    this.s = sections;
    this.z = new Float64Array(sections.length * 2);
  }
  process(x, y = new Float32Array(x.length)) {
    if (this.s.length === 0) { if (y !== x) y.set(x); return y; }
    let src = x;
    for (let k = 0; k < this.s.length; k++) {
      const { b0, b1, b2, a1, a2 } = this.s[k];
      let z1 = this.z[2 * k], z2 = this.z[2 * k + 1];
      for (let i = 0; i < src.length; i++) {
        const xi = src[i];
        const yi = b0 * xi + z1;
        z1 = b1 * xi - a1 * yi + z2;
        z2 = b2 * xi - a2 * yi;
        y[i] = yi;
      }
      if (!Number.isFinite(z1) || !Number.isFinite(z2)) { z1 = 0; z2 = 0; }
      this.z[2 * k] = z1; this.z[2 * k + 1] = z2;
      src = y;
    }
    return y;
  }
  reset() { this.z.fill(0); }
}

function runOnce(sections, x) {
  const y = new Float32Array(x.length);
  return new SosStream(sections).process(x, y);
}

// Filtraggio a fase zero (avanti + indietro) con estensione a riflessione dispari.
export function filtfilt(sections, x, padLen = 0) {
  const n = x.length;
  if (n < 4 || sections.length === 0) return Float32Array.from(x);
  const P = Math.min(n - 1, padLen || Math.min(6000, Math.max(64, Math.floor(n / 4))));
  const ext = new Float32Array(n + 2 * P);
  const x0 = x[0], xn = x[n - 1];
  for (let i = 0; i < P; i++) ext[i] = 2 * x0 - x[P - i];
  ext.set(x, P);
  for (let i = 0; i < P; i++) ext[P + n + i] = 2 * xn - x[n - 2 - i];
  let y = runOnce(sections, ext);
  y.reverse();
  y = runOnce(sections, y);
  y.reverse();
  return y.slice(P, P + n);
}

// Risposta in ampiezza (dB) della cascata alle frequenze indicate.
export function responseDb(sections, freqs, fs) {
  const out = new Float32Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const w = (2 * Math.PI * freqs[i]) / fs;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    let mag = 1;
    for (const { b0, b1, b2, a1, a2 } of sections) {
      const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
      const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
      mag *= Math.hypot(nr, ni) / Math.max(1e-12, Math.hypot(dr, di));
    }
    out[i] = 20 * Math.log10(Math.max(mag, 1e-9));
  }
  return out;
}
