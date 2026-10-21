// Simulatore di suoni cardiaci e polmonari: serve per provare l'app senza fonendoscopio,
// per didattica e per verificare gli algoritmi.
import { bandpassSections, SosStream } from '../dsp/biquad.js';

export const DEMO_SCENARIOS = [
  { id: 'normale', mode: 'heart', name: 'Cuore normale (70 bpm)' },
  { id: 'eiettivo', mode: 'heart', name: 'Soffio sistolico eiettivo (tipo stenosi aortica)' },
  { id: 'olosistolico', mode: 'heart', name: 'Soffio olosistolico (tipo insufficienza mitralica)' },
  { id: 'diastolico', mode: 'heart', name: 'Soffio diastolico decrescente (tipo insuff. aortica)' },
  { id: 's3', mode: 'heart', name: 'Galoppo protodiastolico (S3)' },
  { id: 's4', mode: 'heart', name: 'Galoppo presistolico (S4)' },
  { id: 'sdoppiamento', mode: 'heart', name: 'Sdoppiamento ampio di S2' },
  { id: 'fa', mode: 'heart', name: 'Ritmo irregolarmente irregolare' },
  { id: 'polmone', mode: 'lung', name: 'Murmure vescicolare normale' },
  { id: 'crepitii-fini', mode: 'lung', name: 'Crepitii fini teleinspiratori' },
  { id: 'crepitii-grossolani', mode: 'lung', name: 'Crepitii grossolani' },
  { id: 'sibili', mode: 'lung', name: 'Sibili espiratori' },
  { id: 'ronchi', mode: 'lung', name: 'Ronchi' },
  // disturbi tipici dell'auscultazione, per provare l'assistente e i rilevatori
  { id: 'voce', mode: 'heart', name: 'Disturbo: voce durante l’ascolto', disturbance: true },
  { id: 'sfregamento', mode: 'lung', name: 'Disturbo: sfregamento della membrana', disturbance: true },
  { id: 'ronzio', mode: 'heart', name: 'Disturbo: ronzio a 50 Hz (caricatore)', disturbance: true },
  { id: 'urti', mode: 'heart', name: 'Disturbo: urti e movimenti del fonendo', disturbance: true },
  { id: 'stanza-rumorosa', mode: 'heart', name: 'Disturbo: stanza rumorosa, appoggio scarso', disturbance: true },
];

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise(n, rand) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (rand() + rand() + rand() - 1.5) * 1.15;
  return x;
}

// Rumore filtrato normalizzato a RMS unitario.
function filtered(n, fs, lo, hi, rand, oHp = 2, oLp = 4) {
  const y = new SosStream(bandpassSections(fs, lo, hi, oHp, oLp)).process(noise(n, rand));
  let e = 0;
  for (let i = 0; i < n; i++) e += y[i] * y[i];
  const g = 1 / Math.sqrt(e / n || 1);
  for (let i = 0; i < n; i++) y[i] *= g;
  return y;
}

function burst(out, fs, t0, comps, attack = 0.004) {
  const start = Math.round(t0 * fs);
  const len = Math.round(0.2 * fs);
  for (let i = 0; i < len; i++) {
    const k = start + i;
    if (k < 0 || k >= out.length) continue;
    const tt = i / fs;
    const on = tt < attack ? Math.sin((Math.PI / 2) * (tt / attack)) ** 2 : 1;
    let v = 0;
    for (const c of comps) v += c.a * Math.sin(2 * Math.PI * c.f * tt + (c.p || 0)) * Math.exp(-tt / c.tau);
    out[k] += v * on;
  }
}

const S1 = [{ f: 45, a: 0.9, tau: 0.03 }, { f: 85, a: 0.6, tau: 0.022 }, { f: 140, a: 0.25, tau: 0.012 }];
const T1 = [{ f: 60, a: 0.45, tau: 0.02 }, { f: 120, a: 0.2, tau: 0.01 }];
const A2 = [{ f: 65, a: 0.7, tau: 0.018 }, { f: 110, a: 0.45, tau: 0.012 }, { f: 180, a: 0.15, tau: 0.008 }];
const P2 = [{ f: 60, a: 0.4, tau: 0.015 }, { f: 100, a: 0.25, tau: 0.01 }];
const S3 = [{ f: 30, a: 0.4, tau: 0.04 }, { f: 45, a: 0.18, tau: 0.03 }];
const S4 = [{ f: 28, a: 0.32, tau: 0.035 }, { f: 40, a: 0.12, tau: 0.025 }];

function heartTrack(out, fs, opts, rand) {
  const n = out.length, dur = n / fs;
  const hr = opts.hr || 70;
  const beats = [];
  let t = 0.3;
  while (t < dur - 0.2) {
    let rr = 60 / hr;
    if (opts.irregular) rr *= 0.65 + rand() * 0.7;
    else rr *= 1 + 0.04 * Math.sin((2 * Math.PI * t) / 4) + (rand() - 0.5) * 0.02;
    const sys = Math.max(0.2, 0.49 - 0.0021 * (60 / rr));
    beats.push({ t, rr, sys });
    t += rr;
  }
  const amp = opts.amp || 1;
  for (const b of beats) {
    const resp = Math.max(0, Math.sin((2 * Math.PI * b.t) / 4));
    const split = opts.wideSplit ? 0.035 + 0.035 * resp : 0.012 + 0.025 * resp;
    burst(out, fs, b.t, S1.map((c) => ({ ...c, a: c.a * amp })));
    burst(out, fs, b.t + 0.02, T1.map((c) => ({ ...c, a: c.a * amp })));
    burst(out, fs, b.t + b.sys, A2.map((c) => ({ ...c, a: c.a * amp })));
    burst(out, fs, b.t + b.sys + split, P2.map((c) => ({ ...c, a: c.a * amp * (opts.wideSplit ? 1.2 : 1) })));
    if (opts.s3) burst(out, fs, b.t + b.sys + 0.15, S3.map((c) => ({ ...c, a: c.a * amp })), 0.01);
    if (opts.s4) burst(out, fs, b.t + b.rr - 0.11, S4.map((c) => ({ ...c, a: c.a * amp })), 0.01);
  }
  if (opts.murmur) {
    const m = opts.murmur;
    const src = filtered(n, fs, m.lo, m.hi, rand, 2, 4);
    for (const b of beats) {
      let a0, a1;
      if (m.phase === 'sys') { a0 = b.t + (m.shape === 'plateau' ? 0.03 : 0.06); a1 = b.t + b.sys - (m.shape === 'plateau' ? 0.0 : 0.04); }
      else { a0 = b.t + b.sys + 0.02; a1 = b.t + b.sys + 0.02 + (b.rr - b.sys) * 0.6; }
      const i0 = Math.round(a0 * fs), i1 = Math.min(n, Math.round(a1 * fs));
      for (let i = Math.max(0, i0); i < i1; i++) {
        const u = (i - i0) / Math.max(1, i1 - i0);
        let e;
        if (m.shape === 'diamond') e = Math.sin(Math.PI * u) ** 1.5;
        else if (m.shape === 'plateau') e = Math.min(1, u * 15, (1 - u) * 15);
        else e = (1 - u) ** 1.5 * Math.min(1, u * 30);
        out[i] += src[i] * m.amp * e * amp;
      }
    }
  }
  return beats;
}

function crackle(out, fs, t0, f, tau, a) {
  const start = Math.round(t0 * fs), len = Math.round(6 * tau * fs);
  for (let i = 0; i < len && start + i < out.length; i++) {
    const tt = i / fs;
    out[start + i] += a * Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt / tau);
  }
}

function lungTrack(out, fs, opts, rand) {
  const n = out.length, dur = n / fs;
  const T = 60 / (opts.rr || 16), ti = T * 0.37;
  const ves = filtered(n, fs, 120, 700, rand, 2, 4);
  for (let i = 0; i < n; i++) {
    const tt = (i / fs) % T;
    let a;
    if (tt < ti) a = 0.16 * Math.sin((Math.PI * tt) / ti) ** 0.6;
    else { const v = (tt - ti) / (T - ti); a = v < 0.4 ? 0.05 * (1 - v / 0.4) : 0; }
    out[i] += ves[i] * a;
  }
  for (let c = 0; c * T < dur; c++) {
    const b0 = c * T;
    if (opts.fine) {
      const k = 10 + Math.floor(rand() * 6);
      for (let j = 0; j < k; j++) crackle(out, fs, b0 + ti * (0.5 + 0.5 * rand()), 500 + rand() * 400, 0.0008 + rand() * 0.0006, (0.4 + rand() * 0.4) * (rand() < 0.5 ? -1 : 1));
    }
    if (opts.coarse) {
      const k = 4 + Math.floor(rand() * 4);
      for (let j = 0; j < k; j++) {
        const early = rand() < 0.65 ? b0 + ti * 0.4 * rand() : b0 + ti + (T - ti) * 0.3 * rand();
        crackle(out, fs, early, 120 + rand() * 70, 0.004 + rand() * 0.002, (0.4 + rand() * 0.3) * (rand() < 0.5 ? -1 : 1));
      }
    }
    if (opts.wheeze || opts.rhonchi) {
      const t0 = b0 + ti + (T - ti) * 0.05, t1 = b0 + ti + (T - ti) * (opts.rhonchi ? 0.6 : 0.75);
      const i0 = Math.round(t0 * fs), i1 = Math.min(n, Math.round(t1 * fs));
      let ph = 0, ph2 = 0;
      for (let i = i0; i < i1; i++) {
        const u = (i - i0) / (i1 - i0);
        const f0 = opts.rhonchi ? 160 : 420 + 60 * u;
        ph += (2 * Math.PI * f0) / fs;
        ph2 += (2 * Math.PI * f0 * 2) / fs;
        const env = Math.min(1, u * 12, (1 - u) * 12) * (opts.rhonchi ? 0.8 + 0.2 * Math.sin(2 * Math.PI * 18 * (i / fs)) : 1);
        out[i] += (opts.rhonchi ? 0.12 : 0.1) * env * (Math.sin(ph) + 0.3 * Math.sin(ph2));
      }
    }
  }
}

// Voce: frasi di sillabe armoniche (f0 110–170 Hz con intonazione) con formanti vocaliche
// e qualche fricativa, separate da pause.
const VOWELS = [[700, 1200, 2500], [400, 2000, 2600], [300, 800, 2300], [500, 1500, 2500]];
function voiceTrack(out, fs, rand, amp) {
  const n = out.length, dur = n / fs;
  const fric = filtered(n, fs, 3000, Math.min(7000, 0.45 * fs), rand, 4, 4);
  let t = 0.6;
  while (t < dur) {
    const phraseEnd = Math.min(dur, t + 1.5 + rand() * 1.5);
    const f0b = 110 + rand() * 60;
    while (t < phraseEnd) {
      const sd = 0.12 + rand() * 0.18;
      const F = VOWELS[Math.floor(rand() * VOWELS.length)];
      const i0 = Math.round(t * fs), i1 = Math.min(n, Math.round((t + sd) * fs));
      let ph = rand() * 6.28;
      for (let i = i0; i < i1; i++) {
        const u = (i - i0) / (i1 - i0);
        const f0 = f0b * (1 + 0.12 * Math.sin(Math.PI * u) - 0.05 * u);
        ph += (2 * Math.PI * f0) / fs;
        let v = 0;
        for (let k = 1; k * f0 < 3500; k++) {
          const fk = k * f0;
          const a = 0.6 / k + Math.exp(-0.5 * ((fk - F[0]) / 90) ** 2) + 0.6 * Math.exp(-0.5 * ((fk - F[1]) / 120) ** 2) + 0.3 * Math.exp(-0.5 * ((fk - F[2]) / 160) ** 2);
          v += a * Math.sin(k * ph);
        }
        const env = Math.min(1, u * 8, (1 - u) * 8);
        out[i] += amp * 0.25 * v * env;
      }
      if (rand() < 0.3) { // fricativa ("s") all'inizio della sillaba
        const j0 = Math.max(0, i0 - Math.round(0.06 * fs));
        for (let i = j0; i < i0; i++) out[i] += amp * 0.3 * fric[i] * Math.sin((Math.PI * (i - j0)) / (i0 - j0));
      }
      t += sd + 0.05 + rand() * 0.1;
    }
    t = phraseEnd + 1 + rand();
  }
}

// Sfregamento della membrana su pelle, peli o vestiti: episodi di fruscio a banda larga
// con tanti piccoli impulsi.
function frictionTrack(out, fs, rand, amp) {
  const n = out.length, dur = n / fs;
  const nb = filtered(n, fs, 400, Math.min(8000, 0.45 * fs), rand, 2, 2);
  const env = new Float32Array(n);
  let t = 1;
  while (t < dur) {
    const t1 = Math.min(dur, t + 1.5 + rand() * 1.5);
    const i0 = Math.round(t * fs), i1 = Math.round(t1 * fs);
    for (let i = i0; i < i1; i++) env[i] += 0.25 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 1.3 * i) / fs));
    for (let te = t; te < t1; te += -Math.log(1 - rand()) / 25) {
      const s = Math.round(te * fs), a = 0.6 + rand();
      for (let i = 0; i < 0.012 * fs && s + i < n; i++) env[s + i] += a * Math.exp(-i / (0.002 * fs));
    }
    t = t1 + 1 + rand();
  }
  for (let i = 0; i < n; i++) out[i] += amp * nb[i] * env[i];
}

// Ronzio di rete (caricatore, cavo vicino a un alimentatore): 50 Hz e armoniche dispari.
function humTrack(out, fs, amp) {
  for (let i = 0; i < out.length; i++) {
    const w = (2 * Math.PI * 50 * i) / fs;
    out[i] += amp * (Math.sin(w) + 0.5 * Math.sin(3 * w) + 0.3 * Math.sin(5 * w));
  }
}

// Urti: il fonendo che si sposta o batte, onde lente e ampie ogni pochi secondi.
function bumpTrack(out, fs, rand, amp) {
  const n = out.length, dur = n / fs;
  for (let t = 1.5; t < dur - 0.3; t += 2.5 + rand() * 1.5) {
    const len = 0.08 + rand() * 0.07, s = Math.round(t * fs), a = amp * (0.8 + 0.4 * rand()) * (rand() < 0.5 ? -1 : 1);
    for (let i = 0; i < len * fs && s + i < n; i++) out[s + i] += a * Math.sin((Math.PI * i) / (len * fs));
  }
}

export function generateDemo(id, fs, seconds = 30) {
  const n = Math.round(seconds * fs);
  const out = new Float32Array(n);
  const rand = rng(1234 + id.length * 97);
  const bg = filtered(n, fs, 20, 3000, rand, 2, 2);
  for (let i = 0; i < n; i++) out[i] = bg[i] * 0.006;
  const lung = DEMO_SCENARIOS.find((s) => s.id === id)?.mode === 'lung';
  if (lung) {
    heartTrack(out, fs, { hr: 76, amp: 0.25 }, rand);
    lungTrack(out, fs, {
      fine: id === 'crepitii-fini', coarse: id === 'crepitii-grossolani', wheeze: id === 'sibili', rhonchi: id === 'ronchi',
    }, rand);
  } else {
    const o = { hr: 70 };
    if (id === 'eiettivo') o.murmur = { phase: 'sys', shape: 'diamond', lo: 110, hi: 450, amp: 0.3 };
    if (id === 'olosistolico') o.murmur = { phase: 'sys', shape: 'plateau', lo: 120, hi: 500, amp: 0.18 };
    if (id === 'diastolico') o.murmur = { phase: 'dia', shape: 'decr', lo: 150, hi: 500, amp: 0.2 };
    if (id === 's3') { o.s3 = true; o.hr = 88; }
    if (id === 's4') { o.s4 = true; o.hr = 64; }
    if (id === 'sdoppiamento') o.wideSplit = true;
    if (id === 'fa') { o.irregular = true; o.hr = 92; }
    if (id === 'stanza-rumorosa') o.amp = 0.3;
    heartTrack(out, fs, o, rand);
  }
  if (id === 'voce') voiceTrack(out, fs, rand, 0.5);
  if (id === 'sfregamento') frictionTrack(out, fs, rand, 0.2);
  if (id === 'ronzio') humTrack(out, fs, 0.12);
  if (id === 'urti') bumpTrack(out, fs, rand, 5);
  if (id === 'stanza-rumorosa') { const amb = filtered(out.length, fs, 80, 2500, rand, 2, 2); for (let i = 0; i < out.length; i++) out[i] += 0.12 * amb[i]; }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? 0.25 / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}
