// Pre-elaborazione per l'analisi: filtro passa-banda + decimazione.
import { bandpassSections, SosStream, filtfilt } from './biquad.js';

// Versione a flusso continuo (live): mantiene un buffer circolare del segnale decimato.
// Il campione decimato globale k corrisponde al campione grezzo k*D.
export class Decimator {
  constructor(fs, lo, hi, targetFs, seconds) {
    this.D = Math.max(1, Math.round(fs / targetFs));
    this.fsOut = fs / this.D;
    const hiEff = Math.min(hi, 0.45 * this.fsOut);
    this.filter = new SosStream(bandpassSections(fs, lo, hiEff, 4, 6));
    this.cap = Math.ceil(seconds * this.fsOut);
    this.ring = new Float32Array(this.cap);
    this.wpos = 0;
    this.count = 0;
    this.phase = 0;
    this.tmp = new Float32Array(4096);
  }
  push(x) {
    if (this.tmp.length < x.length) this.tmp = new Float32Array(x.length);
    const y = this.filter.process(x, this.tmp.subarray(0, x.length));
    for (let i = 0; i < y.length; i++) {
      if (this.phase === 0) {
        this.ring[this.wpos] = y[i];
        this.wpos = this.wpos + 1 === this.cap ? 0 : this.wpos + 1;
        this.count++;
      }
      this.phase = this.phase + 1 === this.D ? 0 : this.phase + 1;
    }
  }
  // Ultimi `seconds` di segnale decimato + indice grezzo assoluto del primo campione.
  latest(seconds) {
    const n = Math.min(this.count, this.cap, Math.round(seconds * this.fsOut));
    const out = new Float32Array(n);
    const start = (this.wpos - n + this.cap) % this.cap;
    for (let i = 0; i < n; i++) out[i] = this.ring[(start + i) % this.cap];
    return { y: out, startRaw: (this.count - n) * this.D };
  }
  reset() {
    this.filter.reset();
    this.count = 0;
    this.wpos = 0;
    this.phase = 0;
  }
}

// Versione offline a fase zero (registrazioni).
export function decimateOffline(x, fs, lo, hi, targetFs) {
  const D = Math.max(1, Math.round(fs / targetFs));
  const fsOut = fs / D;
  const hiEff = Math.min(hi, 0.45 * fsOut);
  const y = filtfilt(bandpassSections(fs, lo, hiEff, 4, 6), x, Math.min(x.length - 1, Math.round(fs * 0.25)));
  const out = new Float32Array(Math.floor(y.length / D));
  for (let i = 0; i < out.length; i++) out[i] = y[i * D];
  return { y: out, fs: fsOut, D };
}

export const HEART_BAND = { lo: 25, hi: 400, fs: 2000 };
export const LUNG_BAND = { lo: 100, hi: 2500, fs: 8000 };
