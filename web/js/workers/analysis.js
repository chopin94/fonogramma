// Worker di analisi. Due usi:
//  - live: riceve segmenti decimati dal worker in tempo reale (MessagePort) e
//    restituisce marcatori/metriche; elabora sempre il segmento più recente;
//  - offline: analizza un'intera registrazione (spettrogramma, ciclo medio, eventi).
import { analyzeHeart } from '../dsp/heart.js';
import { analyzeLung } from '../dsp/lung.js';
import { decimateOffline, HEART_BAND, LUNG_BAND } from '../dsp/frontend.js';
import { spectrogram } from '../dsp/stft.js';
import { nextPow2 } from '../dsp/fft.js';
import { assessRecording } from '../dsp/quality.js';

function heartTimes(h) {
  return h.s1.concat(h.s2, h.s3, h.s4);
}

function packHeart(h, startRaw, fsRaw) {
  const abs = (t) => Math.round(startRaw + t * fsRaw);
  return {
    ok: h.ok, reason: h.reason, metrics: h.metrics,
    markers: { s1: h.s1.map(abs), s2: h.s2.map(abs), s3: h.s3.map(abs), s4: h.s4.map(abs), clicks: h.clicks.map(abs), snaps: h.snaps.map(abs) },
    ensemble: h.ensemble, sysProfile: h.sysProfile, diaProfile: h.diaProfile,
    env: h.env, envFs: h.envFs, envStart: startRaw,
  };
}

function packLung(l, startRaw, fsRaw) {
  const abs = (t) => Math.round(startRaw + t * fsRaw);
  return {
    ok: l.ok, reason: l.reason, metrics: l.metrics,
    crackles: l.crackles.map((c) => ({ ...c, at: abs(c.t) })),
    wheezes: l.wheezes.map((w) => ({ ...w, a0: abs(w.t0), a1: abs(w.t1) })),
    breaths: l.breaths.map(abs), breathsT: l.breaths,
    resp: l.resp, respFs: l.respFs, respT0: l.respT0 || 0, respStart: abs(l.respT0 || 0),
  };
}

let latest = null, scheduled = false;
function runLive() {
  scheduled = false;
  const seg = latest;
  latest = null;
  if (!seg) return;
  try {
    const { fsRaw, heart, lung } = seg;
    const h = analyzeHeart(heart.y, heart.fs);
    const out = {
      type: 'analysis', mode: seg.mode, total: seg.total,
      span: [heart.startRaw, heart.startRaw + Math.round((heart.y.length / heart.fs) * fsRaw)],
      heart: packHeart(h, heart.startRaw, fsRaw),
    };
    if (seg.mode === 'lung' && lung) {
      const shift = (heart.startRaw - lung.startRaw) / fsRaw;
      const artifacts = (lung.artifacts || []).map(([a, b]) => [(a - lung.startRaw) / fsRaw, (b - lung.startRaw) / fsRaw]);
      const l = analyzeLung(lung.y, lung.fs, { heartTimes: heartTimes(h).map((t) => t + shift), artifacts });
      out.lung = packLung(l, lung.startRaw, fsRaw);
      out.lungSpan = [lung.startRaw, lung.startRaw + Math.round((lung.y.length / lung.fs) * fsRaw)];
    }
    postMessage(out);
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
}

function overview(x, fs) {
  const b = Math.max(1, Math.round(fs / 1000));
  const nb = Math.ceil(x.length / b);
  const mn = new Float32Array(nb), mx = new Float32Array(nb);
  for (let k = 0; k < nb; k++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = k * b; i < Math.min(x.length, (k + 1) * b); i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    mn[k] = lo; mx[k] = hi;
  }
  return { min: mn, max: mx, bucket: b, bucketS: b / fs };
}

function cycleSpectrogram(spec, h, bins = 200) {
  if (!h.ok || !h.beats.length) return null;
  const rrs = h.beats.map((b) => b.rr).filter(Boolean).sort((a, b) => a - b);
  const rr = rrs.length ? rrs[rrs.length >> 1] : 0.8;
  const pre = 0.1, W = pre + Math.min(2, rr * 1.1);
  const { cols, ncols, rows, t0, dt } = spec;
  const acc = new Float64Array(bins * rows);
  let cnt = 0;
  for (const b of h.beats) {
    const start = b.t - pre;
    const c0 = Math.round((start - t0) / dt), c1 = Math.round((start + W - t0) / dt);
    if (c0 < 0 || c1 >= ncols) continue;
    for (let j = 0; j < bins; j++) {
      const c = Math.round((start + (j / bins) * W - t0) / dt);
      for (let r = 0; r < rows; r++) acc[j * rows + r] += Math.pow(10, cols[c * rows + r] / 10);
    }
    cnt++;
  }
  if (cnt < 2) return null;
  const out = new Float32Array(bins * rows);
  for (let i = 0; i < out.length; i++) out[i] = 10 * Math.log10(acc[i] / cnt + 1e-20);
  return { cols: out, ncols: bins, rows, window: W, pre, s2: (h.metrics.sysMs || 300) / 1000, count: cnt, fMin: spec.fMin, fMax: spec.fMax, scale: spec.scale };
}

// Tracciato, spettrogramma e spettrogramma medio del ciclo del segnale mostrato.
function display(x, fs, kind, h) {
  const lung = kind === 'lung';
  const spec = spectrogram(x, fs, {
    fftSize: nextPow2((lung ? 0.021 : 0.043) * fs),
    hop: Math.round(fs / 250),
    rows: 256,
    fMin: lung ? 50 : 20,
    fMax: lung ? 3000 : 1000,
    scale: 'lin',
    maxCols: 7000,
  });
  return { spec, overview: overview(x, fs), cycleSpec: lung || !h ? null : cycleSpectrogram(spec, h) };
}

function analyzeRecording({ samples, fs, kind, view }) {
  const quality = assessRecording(samples, fs);
  const dh = decimateOffline(samples, fs, HEART_BAND.lo, HEART_BAND.hi, HEART_BAND.fs);
  const h = analyzeHeart(dh.y, dh.fs);
  let l = null;
  if (kind === 'lung') {
    const dl = decimateOffline(samples, fs, LUNG_BAND.lo, LUNG_BAND.hi, LUNG_BAND.fs);
    l = analyzeLung(dl.y, dl.fs, { heartTimes: heartTimes(h), artifacts: quality.artifacts });
  }
  return { heart: h, lung: l, quality, ...display(view || samples, fs, kind, h), duration: samples.length / fs, fs };
}

function transfers(res) {
  const tr = [res.spec.cols.buffer, res.overview.min.buffer, res.overview.max.buffer];
  if (res.cycleSpec) tr.push(res.cycleSpec.cols.buffer);
  return tr;
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'live-port') {
    m.port.onmessage = (ev) => {
      latest = ev.data;
      if (!scheduled) { scheduled = true; setTimeout(runLive, 0); }
    };
    return;
  }
  if (m.type === 'analyze' || m.type === 'view') {
    try {
      const res = m.type === 'analyze' ? analyzeRecording(m) : display(m.samples, m.fs, m.kind, m.heart);
      postMessage({ type: 'analyzed', id: m.id, res }, transfers(res));
    } catch (err) {
      postMessage({ type: 'analyzed', id: m.id, error: String(err && err.message || err) });
    }
  }
};
