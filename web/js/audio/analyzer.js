// Client del worker di analisi offline delle registrazioni.
let worker = null, seq = 0;
const pending = new Map();

function ensure() {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/analysis.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type !== 'analyzed') return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(d.res);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Errore di analisi'));
    pending.clear();
    worker = null;
  };
  return worker;
}

export function analyzeSamples(samples, fs, kind) {
  const w = ensure();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: 'analyze', id, samples, fs, kind });
  });
}

const r1 = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

// Riassunto compatto salvato con la registrazione (per visita, referto, confronti).
export function summarize(res, kind) {
  const h = res.heart && res.heart.metrics;
  const out = { duration: r1(res.duration, 1) };
  if (h) {
    out.heart = {
      bpm: r1(h.bpm), bpmStd: r1(h.bpmStd, 1), rhythm: h.rhythm, rrCv: r1(h.rrCv, 3), nBeats: h.nBeats,
      sdnn: r1(h.sdnn), rmssd: r1(h.rmssd), pnn50: r1(h.pnn50),
      sysMs: r1(h.sysMs), diaMs: r1(h.diaMs), sdRatio: r1(h.sdRatio, 2),
      s1s2: r1(h.s1s2, 2), s1Freq: r1(h.s1Freq), s2Freq: r1(h.s2Freq), s1DurMs: r1(h.s1DurMs), s2DurMs: r1(h.s2DurMs),
      splitPct: r1(h.splitPct), splitMs: r1(h.splitMs), splitMin: r1(h.splitMin), splitMax: r1(h.splitMax), splitPattern: h.splitPattern,
      s3Count: h.s3Count, s4Count: h.s4Count, s3Pct: r1(h.s3Pct), s4Pct: r1(h.s4Pct), clickCount: h.clickCount, snapCount: h.snapCount,
      sysIdx: r1(h.sysIdx, 2), diaIdx: r1(h.diaIdx, 2), murmurSys: h.murmurSys, murmurDia: h.murmurDia,
      murmurSysShape: h.murmurSysShape, murmurDiaShape: h.murmurDiaShape, murmurPitchHz: r1(h.murmurPitchHz), murmurIntensity: h.murmurIntensity,
      sqi: h.sqi, snrDb: r1(h.snrDb, 1),
    };
  }
  if (kind === 'lung' && res.lung) {
    const l = res.lung.metrics;
    out.lung = {
      rr: r1(l.rr, 1), ieRatio: r1(l.ieRatio, 1), intensityDb: r1(l.intensityDb, 1), dynamicDb: r1(l.dynamicDb, 1),
      crackles: l.crackles, cracklesFine: l.cracklesFine, cracklesCoarse: l.cracklesCoarse, cracklesPerMin: r1(l.cracklesPerMin),
      cracklesPerBreath: r1(l.cracklesPerBreath, 1), cracklesSignificant: l.cracklesSignificant, cracklesInspPct: r1(l.cracklesInspPct),
      wheezes: l.wheezes, wheezeDurPct: r1(l.wheezeDurPct), wheezeFreq: r1(l.wheezeFreq), rhonchi: l.rhonchi, polyphonic: l.polyphonic,
      toneHz: l.toneHz, sqi: l.sqi,
    };
  }
  return out;
}
