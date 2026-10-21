// Qualità del segnale: livello, saturazione, rumore di fondo, ronzio di rete (50/60 Hz),
// urti, sfregamento della membrana, voce e "silenzi tagliati" dalla riduzione rumore
// del sistema. Riceve il segnale grezzo a blocchi (worker in tempo reale, oppure tutta
// una registrazione) e indica anche i tratti disturbati da escludere dall'analisi.
// Le soglie sono prudenti: meglio un disturbo non segnalato che un reperto scambiato
// per disturbo (sibili e ronchi non devono sembrare voce, i crepitii non sfregamento).
import { SosStream, bandpassSections, design, butterQs } from './biquad.js';
import { getFFT, hann } from './fft.js';
import { percentile } from './peaks.js';

const FRAME_S = 0.01; // statistiche su frame da 10 ms
const HISTORY_S = 8; // storia per i livelli di riferimento
const LOW_FS = 4000; // segnale ridotto per ronzio, urti e voce
const LOW_KEEP_S = 4;
const HUM_N = 8192; // ~0,5 Hz di risoluzione a 4 kHz
const db = (p) => 10 * Math.log10(p + 1e-20);

function lowpassSections(fs, f, order) {
  return butterQs(order).map((q) => design('lowpass', f, fs, q));
}
function highpassSections(fs, f, order) {
  return butterQs(order).map((q) => design('highpass', f, fs, q));
}

export class QualityMonitor {
  constructor(fs) {
    this.fs = fs;
    this.frameLen = Math.max(1, Math.round(fs * FRAME_S));
    this.cap = Math.round(HISTORY_S / FRAME_S);
    this.p = new Float32Array(this.cap); // potenza media del frame
    this.pk = new Float32Array(this.cap); // picco del frame
    this.hf = new Float32Array(this.cap); // potenza 2,5–6 kHz (sfregamento)
    this.lf = new Float32Array(this.cap); // potenza sotto 20 Hz (urti, movimento)
    this.lb = new Float32Array(this.cap); // potenza 3–1800 Hz (per la forma dello spettro)
    this.nFrames = 0;
    this.hasHf = fs >= 14000;
    this.hfFilter = this.hasHf ? new SosStream(bandpassSections(fs, 2500, 6000, 4, 4)) : null;
    this.D = Math.max(1, Math.round(fs / LOW_FS));
    this.lowFs = fs / this.D;
    this.lowFilter = new SosStream(bandpassSections(fs, 3, 0.45 * this.lowFs, 2, 6));
    this.moveFilter = new SosStream(lowpassSections(this.lowFs, 20, 2));
    this.lowCap = Math.round(LOW_KEEP_S * this.lowFs);
    this.low = new Float32Array(this.lowCap);
    this.lowCount = 0;
    this.phase = 0;
    this.acc = { sq: 0, pk: 0, hf: 0, lf: 0, lb: 0, lfN: 0, n: 0 };
    this.win = null;
    this.tmp = new Float32Array(0);
    this.tmpHf = new Float32Array(0);
  }

  push(x) {
    const n = x.length;
    if (this.tmp.length < n) { this.tmp = new Float32Array(n); this.tmpHf = new Float32Array(n); }
    const lo = this.lowFilter.process(x, this.tmp.subarray(0, n));
    const hf = this.hfFilter ? this.hfFilter.process(x, this.tmpHf.subarray(0, n)) : null;
    // campioni ridotti del blocco e loro componente sotto 20 Hz
    const nLow = Math.floor((n + this.phase + this.D - 1) / this.D);
    const lowBlock = new Float32Array(nLow);
    let k = 0;
    for (let i = (this.D - this.phase) % this.D; i < n; i += this.D) lowBlock[k++] = lo[i];
    const lowUsed = lowBlock.subarray(0, k);
    const mv = this.moveFilter.process(lowUsed, new Float32Array(k));
    for (let j = 0; j < k; j++) { this.low[this.lowCount % this.lowCap] = lowUsed[j]; this.lowCount++; }
    const a = this.acc;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      a.sq += v * v;
      const av = v < 0 ? -v : v;
      if (av > a.pk) a.pk = av;
      if (hf) a.hf += hf[i] * hf[i];
      if (this.phase === 0) { const w = mv[m], u = lowUsed[m++]; a.lf += w * w; a.lb += u * u; a.lfN++; }
      this.phase = this.phase + 1 === this.D ? 0 : this.phase + 1;
      if (++a.n === this.frameLen) {
        const f = this.nFrames % this.cap;
        this.p[f] = a.sq / a.n;
        this.pk[f] = a.pk;
        this.hf[f] = a.hf / a.n;
        this.lf[f] = a.lfN ? a.lf / a.lfN : 0;
        this.lb[f] = a.lfN ? a.lb / a.lfN : 0;
        this.nFrames++;
        a.sq = a.pk = a.hf = a.lf = a.lb = 0; a.lfN = a.n = 0;
      }
    }
  }

  // Ultimi `seconds` del segnale ridotto (4 kHz, 3–1800 Hz).
  lowLatest(seconds) {
    const n = Math.min(this.lowCount, this.lowCap, Math.round(seconds * this.lowFs));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.low[(this.lowCount - n + i) % this.lowCap];
    return out;
  }

  frames(count) {
    const n = Math.min(count, this.nFrames, this.cap);
    const take = (arr) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = arr[(this.nFrames - n + i) % this.cap]; return o; };
    return { n, first: this.nFrames - n, p: take(this.p), pk: take(this.pk), hf: take(this.hf), lf: take(this.lf), lb: take(this.lb) };
  }

  // Misure sugli ultimi `seconds` (con riferimenti calcolati sugli ultimi 8 s).
  evaluate(seconds = 2) {
    const W = this.frames(Math.round(seconds / FRAME_S));
    if (W.n < 20) return null;
    const H = this.frames(this.cap);
    let pkMax = 0, pSum = 0, zero = 0, clip = 0;
    for (let i = 0; i < W.n; i++) {
      pkMax = Math.max(pkMax, W.pk[i]);
      pSum += W.p[i];
      if (W.p[i] < 1e-9) zero++;
      if (W.pk[i] >= 0.985) clip++;
    }
    const out = {
      peakDb: 20 * Math.log10(pkMax + 1e-10), rmsDb: db(pSum / W.n), floorDb: db(percentile(W.p, 10)),
      zeroFrac: zero / W.n, clipFrames: clip, moveFrames: 0, frictionFrames: null, taps: [],
      humHz: null, humDb: 0, lfRatioDb: null, voice: false, voicedFrac: 0, voiceSegs: 0,
      artifacts: [],
    };
    // colpi netti (verifica guidata: picchiettare la membrana), come indice di frame
    // assoluto e dB sopra il picco tipico; chi li usa scarta i doppioni tra finestre
    const pkRef = percentile(H.pk, 50) + 1e-9;
    for (let i = 0, last = -99; i < W.n; i++) {
      const d = 20 * Math.log10(W.pk[i] / pkRef + 1e-12);
      if (d > 25 && i - last > 15) { out.taps.push({ frame: W.first + i, db: Math.round(d) }); last = i; }
    }
    const bad = new Uint8Array(W.n);
    for (let i = 0; i < W.n; i++) if (W.pk[i] >= 0.985) bad[i] = 1;
    // urti: almeno 40 ms dominati dall'energia sotto 20 Hz (i toni cardiaci stanno sopra e
    // lasciano al più un frame di coda) e ben oltre i livelli abituali (un impulso apicale
    // periodico alza il riferimento, un urto occasionale no)
    if (H.n >= 300) {
      const ref = percentile(H.lf, 90);
      const cand = (i) => W.lf[i] > 0.5 * W.lb[i] && W.lf[i] > 8 * ref && W.lf[i] > 1e-7;
      for (let i = 0; i < W.n; i++) {
        if (!cand(i)) continue;
        let j = i;
        while (j + 1 < W.n && cand(j + 1)) j++;
        if (j - i + 1 >= 4) for (let k = i; k <= j; k++) { out.moveFrames++; bad[k] = 1; }
        i = j;
      }
    }
    // sfregamento: frame con molta energia 2,5–6 kHz, sia rispetto alla storia sia
    // rispetto al frame stesso (i crepitii hanno quasi tutta l'energia sotto 2 kHz)
    if (this.hasHf && H.n >= 100) {
      const ref = percentile(H.hf, 50), floor = percentile(H.p, 20);
      const hits = [];
      for (let i = 0; i < W.n; i++) if (W.hf[i] > 30 * ref && W.hf[i] > 0.1 * W.p[i] && W.p[i] > 10 * floor) hits.push(i);
      out.frictionFrames = hits.length;
      // lo sfregamento continua anche tra un impulso e l'altro: se è evidente si esclude
      // l'episodio (impulsi a meno di 0,3 s l'uno dall'altro), altrimenti solo i frame colpiti
      if (hits.length >= 6) {
        for (let k = 0; k < hits.length; k++) {
          const a = k > 0 && hits[k] - hits[k - 1] <= 30 ? hits[k - 1] : hits[k] - 10;
          const b = k + 1 < hits.length && hits[k + 1] - hits[k] <= 30 ? hits[k] : hits[k] + 10;
          for (let i = Math.max(0, a); i <= Math.min(W.n - 1, b); i++) bad[i] = 1;
        }
      } else for (const i of hits) bad[i] = 1;
    }
    // tratti da escludere dall'analisi, in campioni grezzi assoluti
    for (let i = 0; i < W.n; i++) {
      if (!bad[i]) continue;
      let j = i;
      while (j + 1 < W.n && (bad[j + 1] || (j + 2 < W.n && bad[j + 2]) || (j + 3 < W.n && bad[j + 3]))) j++;
      out.artifacts.push([(W.first + Math.max(0, i - 3)) * this.frameLen, (W.first + j + 4) * this.frameLen]);
      i = j;
    }
    const low = this.lowLatest(seconds);
    if (low.length >= 0.75 * seconds * this.lowFs) {
      Object.assign(out, this.spectral(low));
      Object.assign(out, this.voiceOf(low));
    }
    return out;
  }

  // Ronzio di rete (righe strette a 50/60 Hz e armoniche) e rapporto bassi/medi.
  spectral(x) {
    const N = HUM_N, fft = getFFT(N);
    if (!this.win || this.win.length !== Math.min(N, x.length)) this.win = hann(Math.min(N, x.length));
    const win = this.win;
    const re = new Float64Array(N), im = new Float64Array(N);
    const off = Math.max(0, x.length - N);
    for (let i = 0; i < win.length; i++) re[i] = x[off + i] * win[i];
    fft.transform(re, im);
    const df = this.lowFs / N;
    const P = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) P[k] = re[k] * re[k] + im[k] * im[k];
    const band = (f0, f1) => { let s = 0; for (let k = Math.ceil(f0 / df); k <= Math.floor(f1 / df); k++) s += P[k]; return s; };
    const total = band(20, 400) + 1e-30;
    let humHz = null, humDb = 0;
    for (const base of [50, 60]) {
      let best = 0;
      for (const h of [1, 2, 3]) {
        const kc = Math.round((base * h) / df);
        let line = 0;
        for (let k = kc - 2; k <= kc + 2; k++) line = Math.max(line, P[k]);
        const side = [];
        for (let k = kc - 14; k <= kc + 14; k++) if (Math.abs(k - kc) > 4) side.push(P[k]);
        const prom = db(line) - db(percentile(side, 50));
        if (line > 1e-3 * total && prom > best) best = prom;
      }
      if (best > humDb) { humDb = best; if (best > 15) humHz = base; }
    }
    return { humHz, humDb: Math.round(humDb), lfRatioDb: Math.round(db(band(20, 60)) - db(band(60, 200))) };
  }

  // Voce: tratti armonici (f0 80–400 Hz) brevi e ripetuti, come le sillabe. Sibili e
  // ronchi sono armonici ma lunghi e legati al respiro, i toni cardiaci troppo brevi.
  voiceOf(x) {
    const fs = this.lowFs;
    const y = new SosStream(highpassSections(fs, 150, 4)).process(x);
    const W = Math.round(0.04 * fs), hop = Math.round(0.02 * fs);
    const minLag = Math.floor(fs / 400), maxLag = Math.ceil(fs / 80);
    const skip = Math.round(0.05 * fs); // assestamento del filtro
    const e = [];
    for (let s = skip; s + W + maxLag <= y.length; s += hop) {
      let en = 0;
      for (let i = 0; i < W; i++) en += y[s + i] * y[s + i];
      e.push(en);
    }
    if (e.length < 10) return {};
    const quiet = percentile(e, 20);
    // periodicità (autocorrelazione normalizzata) solo dei frame abbastanza forti
    const voiced = e.map((en, j) => {
      if (!(en > 10 * quiet && en > 1e-10)) return false;
      const s = skip + j * hop;
      for (let L = minLag; L <= maxLag; L++) {
        let c = 0, e1 = 0, e2 = 0;
        for (let i = 0; i < W; i++) { const u = y[s + i], v = y[s + i + L]; c += u * v; e1 += u * u; e2 += v * v; }
        if (c / Math.sqrt(e1 * e2 + 1e-30) > 0.6) return true;
      }
      return false;
    });
    let segs = 0, longest = 0, run = 0, nv = 0;
    const hopS = hop / fs;
    for (let i = 0; i <= voiced.length; i++) {
      if (i < voiced.length && voiced[i]) { run++; nv++; continue; }
      const d = run * hopS;
      if (d >= 0.08 && d <= 0.6) segs++;
      longest = Math.max(longest, d);
      run = 0;
    }
    const frac = nv / voiced.length;
    return { voice: segs >= 3 && longest < 1 && frac >= 0.15, voicedFrac: Math.round(frac * 100) / 100, voiceSegs: segs };
  }
}

// Valutazione di un'intera registrazione: quanto spesso compare ogni disturbo e quali
// tratti escludere dall'analisi (in secondi).
export function assessRecording(x, fs) {
  const qm = new QualityMonitor(fs);
  const step = Math.round(fs * 1);
  const counts = { clip: 0, move: 0, friction: 0, hum: 0, voice: 0 };
  const intervals = [];
  let windows = 0, floor = [], peak = -120;
  for (let s = 0; s < x.length; s += step) {
    qm.push(x.subarray(s, Math.min(x.length, s + step)));
    if (s + step < 2 * fs) continue; // servono almeno 2 s, poi una valutazione al secondo
    const q = qm.evaluate(2);
    if (!q) continue;
    windows++;
    if (q.clipFrames >= 2) counts.clip++;
    if (q.moveFrames >= 3) counts.move++;
    if (q.frictionFrames >= 6 && !q.voice) counts.friction++; // le fricative della voce non sono sfregamento
    if (q.humHz) counts.hum++;
    if (q.voice) counts.voice++;
    floor.push(q.floorDb);
    peak = Math.max(peak, q.peakDb);
    for (const [a, b] of q.artifacts) intervals.push([a / fs, b / fs]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push(iv.slice());
  }
  const dur = x.length / fs;
  const artS = merged.reduce((s, [a, b]) => s + Math.min(b, dur) - a, 0);
  const pct = (c) => (windows ? Math.round((100 * c) / windows) : 0);
  return {
    artifacts: merged, artifactPct: dur ? Math.round((100 * artS) / dur) : 0,
    issues: { clip: pct(counts.clip), move: pct(counts.move), friction: pct(counts.friction), hum: pct(counts.hum), voice: pct(counts.voice) },
    floorDb: floor.length ? Math.round(percentile(floor, 50)) : null, peakDb: Math.round(peak),
  };
}
