// STFT a flusso continuo per il waterfall, con mappatura delle frequenze su righe
// di visualizzazione (scala lineare o logaritmica, max-pooling dei bin per il dettaglio).
import { FFT, hann } from './fft.js';

export function buildRowMap(rows, fMin, fMax, scale, df, nBins) {
  const lo = new Int32Array(rows), hi = new Int32Array(rows), fr = new Float32Array(rows);
  const fmin = Math.max(scale === 'log' ? 10 : 0, fMin);
  const fmax = Math.max(fmin + 10, fMax);
  const edge = (r) => (scale === 'log' ? fmin * Math.pow(fmax / fmin, r / rows) : fmin + ((fmax - fmin) * r) / rows);
  for (let r = 0; r < rows; r++) {
    const fa = edge(r), fb = edge(r + 1);
    const ka = Math.ceil(fa / df), kb = Math.floor(fb / df);
    if (kb >= ka) {
      lo[r] = Math.min(ka, nBins - 1);
      hi[r] = Math.min(kb, nBins - 1);
      fr[r] = -1;
    } else {
      const k = (fa + fb) / 2 / df;
      lo[r] = Math.min(Math.floor(k), nBins - 1);
      hi[r] = Math.min(lo[r] + 1, nBins - 1);
      fr[r] = k - Math.floor(k);
    }
  }
  return { lo, hi, fr, rows };
}

// Converte un vettore di moduli in dB sulle righe di visualizzazione.
export function mapColumn(mag, map, norm, out, offset) {
  const { lo, hi, fr, rows } = map;
  for (let r = 0; r < rows; r++) {
    let v;
    if (fr[r] < 0) {
      v = 0;
      for (let k = lo[r]; k <= hi[r]; k++) if (mag[k] > v) v = mag[k];
    } else {
      v = mag[lo[r]] * (1 - fr[r]) + mag[hi[r]] * fr[r];
    }
    out[offset + r] = 20 * Math.log10(v * norm + 1e-12);
  }
}

export class StftStream {
  constructor({ fs, fftSize = 2048, hop = 256, rows = 256, fMin = 20, fMax = 1000, scale = 'lin' }) {
    this.fs = fs;
    this.n = fftSize;
    this.hop = Math.max(16, Math.round(hop));
    this.rows = rows;
    this.fft = new FFT(fftSize);
    this.win = hann(fftSize);
    let s = 0;
    for (let i = 0; i < fftSize; i++) s += this.win[i];
    this.norm = 2 / s; // 0 dB = sinusoide a fondo scala
    this.hist = new Float32Array(fftSize);
    this.hpos = 0;
    this.since = 0;
    this.filled = 0;
    this.frame = new Float32Array(fftSize);
    this.mag = new Float32Array(fftSize / 2 + 1);
    this.map = buildRowMap(rows, fMin, fMax, scale, fs / fftSize, fftSize / 2 + 1);
  }

  // Inserisce campioni; ritorna le colonne prodotte (dB, righe dal basso verso l'alto).
  push(x) {
    const maxCols = Math.ceil((x.length + this.since) / this.hop) + 1;
    const cols = new Float32Array(maxCols * this.rows);
    let nc = 0;
    const n = this.n;
    let i = 0;
    while (i < x.length) {
      const take = Math.min(this.hop - this.since, x.length - i);
      for (let k = 0; k < take; k++) {
        this.hist[this.hpos] = x[i + k];
        this.hpos = this.hpos + 1 === n ? 0 : this.hpos + 1;
      }
      i += take;
      this.since += take;
      this.filled = Math.min(n, this.filled + take);
      if (this.since >= this.hop) {
        this.since = 0;
        if (this.filled >= n) {
          this.column(cols, nc * this.rows);
          nc++;
        }
      }
    }
    return { cols: nc ? cols.subarray(0, nc * this.rows) : null, n: nc };
  }

  column(out, offset) {
    const n = this.n, f = this.frame;
    for (let j = 0, idx = this.hpos; j < n; j++) {
      f[j] = this.hist[idx];
      idx = idx + 1 === n ? 0 : idx + 1;
    }
    this.fft.magnitude(f, this.win, this.mag);
    mapColumn(this.mag, this.map, this.norm, out, offset);
  }
}

// Spettrogramma completo di un segnale (per l'analisi delle registrazioni).
export function spectrogram(x, fs, { fftSize = 2048, hop = 256, rows = 256, fMin = 20, fMax = 1000, scale = 'lin', maxCols = 6000 } = {}) {
  hop = Math.max(hop, Math.ceil(x.length / maxCols));
  const st = new StftStream({ fs, fftSize, hop, rows, fMin, fMax, scale });
  const ncols = Math.max(0, Math.floor((x.length - fftSize) / hop) + 1);
  const cols = new Float32Array(ncols * rows);
  for (let c = 0; c < ncols; c++) {
    st.fft.magnitude(x, st.win, st.mag, c * hop);
    mapColumn(st.mag, st.map, st.norm, cols, c * rows);
  }
  return { cols, ncols, rows, hop, fftSize, fs, fMin, fMax, scale, t0: fftSize / 2 / fs, dt: hop / fs };
}
