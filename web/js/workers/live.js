// Worker in tempo reale: riceve i blocchi audio dall'AudioWorklet, produce i dati per
// tracciato (min/max per ms) e waterfall (colonne STFT), mantiene il registratore ad anello
// ("ultimi N secondi") e le registrazioni, e invia segmenti decimati al worker di analisi.
import { StftStream } from '../dsp/stft.js';
import { Decimator, HEART_BAND, LUNG_BAND } from '../dsp/frontend.js';

let fs = 48000;
let cfg = { mode: 'heart', wfSource: 'filtered', loopSeconds: 30, wf: { fftSize: 4096, hop: 256, rows: 384, fMin: 20, fMax: 800, scale: 'lin' } };
let stft = null, stftKey = '';
let heartFE = null, lungFE = null;
let analysisPort = null;
let total = 0;
let loop = null, loopPos = 0, loopFilled = 0;
let rec = null;
let lastSeg = 0, lastLungSeg = 0;
let bucket = 48, bCount = 0, bMin = Infinity, bMax = -Infinity, bRMin = Infinity, bRMax = -Infinity;
let levelPeak = 0, levelSq = 0, levelN = 0;

function setupStft() {
  const w = cfg.wf;
  const key = JSON.stringify(w);
  if (key === stftKey && stft) return;
  stftKey = key;
  stft = new StftStream({ fs, ...w });
}

function setupLoop() {
  const cap = Math.round(Math.max(5, cfg.loopSeconds) * fs);
  if (loop && loop.length === cap) return;
  loop = new Float32Array(cap);
  loopPos = 0;
  loopFilled = 0;
}

function configure(c) {
  cfg = { ...cfg, ...c, wf: { ...cfg.wf, ...(c.wf || {}) } };
  setupStft();
  setupLoop();
}

function lastSamples(seconds) {
  const n = Math.min(loopFilled, Math.round(seconds * fs));
  const out = new Float32Array(n);
  let start = (loopPos - n + loop.length) % loop.length;
  for (let i = 0; i < n; i++) { out[i] = loop[start]; start = start + 1 === loop.length ? 0 : start + 1; }
  return out;
}

function onAudio(e) {
  const { raw, fil } = e.data;
  const n = raw.length;
  // anello "ultimi N secondi" + registrazione
  for (let i = 0; i < n; i++) {
    loop[loopPos] = raw[i];
    loopPos = loopPos + 1 === loop.length ? 0 : loopPos + 1;
  }
  loopFilled = Math.min(loop.length, loopFilled + n);
  if (rec) { rec.chunks.push(raw.slice()); rec.n += n; }

  // min/max per millisecondo (tracciato filtrato e grezzo)
  const nbMax = Math.ceil((bCount + n) / bucket) + 1;
  const mmMin = new Float32Array(nbMax), mmMax = new Float32Array(nbMax);
  const rwMin = new Float32Array(nbMax), rwMax = new Float32Array(nbMax);
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const v = fil[i], r = raw[i];
    if (v < bMin) bMin = v;
    if (v > bMax) bMax = v;
    if (r < bRMin) bRMin = r;
    if (r > bRMax) bRMax = r;
    const a = r < 0 ? -r : r;
    if (a > levelPeak) levelPeak = a;
    levelSq += r * r;
    levelN++;
    if (++bCount === bucket) {
      mmMin[nb] = bMin; mmMax[nb] = bMax; rwMin[nb] = bRMin; rwMax[nb] = bRMax; nb++;
      bCount = 0; bMin = Infinity; bMax = -Infinity; bRMin = Infinity; bRMax = -Infinity;
    }
  }

  const { cols, n: ncols } = stft.push(cfg.wfSource === 'raw' ? raw : fil);
  heartFE.push(raw);
  if (cfg.mode === 'lung') lungFE.push(raw);
  total += n;

  const msg = {
    type: 'frame', total, nb, mmMin, mmMax, rwMin, rwMax, ncols, cols, rows: stft.rows,
    recSeconds: rec ? rec.n / fs : null,
  };
  const tr = [mmMin.buffer, mmMax.buffer, rwMin.buffer, rwMax.buffer];
  if (cols) tr.push(cols.buffer);
  if (levelN >= fs * 0.1) {
    msg.peakDb = 20 * Math.log10(levelPeak + 1e-9);
    msg.rmsDb = 10 * Math.log10(levelSq / levelN + 1e-18);
    levelPeak = 0; levelSq = 0; levelN = 0;
  }
  postMessage(msg, tr);

  if (analysisPort && total - lastSeg >= 0.5 * fs) {
    lastSeg = total;
    const h = heartFE.latest(8);
    const seg = { fsRaw: fs, mode: cfg.mode, total, heart: { y: h.y, fs: heartFE.fsOut, startRaw: h.startRaw } };
    const trs = [h.y.buffer];
    if (cfg.mode === 'lung' && total - lastLungSeg >= 1.0 * fs) {
      lastLungSeg = total;
      const l = lungFE.latest(10);
      seg.lung = { y: l.y, fs: lungFE.fsOut, startRaw: l.startRaw };
      trs.push(l.y.buffer);
    }
    analysisPort.postMessage(seg, trs);
  }
}

onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      fs = m.fs;
      bucket = Math.max(1, Math.round(fs / 1000));
      heartFE = new Decimator(fs, HEART_BAND.lo, HEART_BAND.hi, HEART_BAND.fs, 12);
      lungFE = new Decimator(fs, LUNG_BAND.lo, LUNG_BAND.hi, LUNG_BAND.fs, 12);
      configure(m.config || {});
      m.audioPort.onmessage = onAudio;
      analysisPort = m.analysisPort || null;
      postMessage({ type: 'ready', bucket });
      break;
    case 'config': {
      const prevMode = cfg.mode;
      configure(m.config);
      if (cfg.mode !== prevMode && cfg.mode === 'lung') lungFE.reset();
      break;
    }
    case 'rec-start':
      rec = { chunks: [], n: 0, startTotal: total };
      break;
    case 'rec-stop': {
      if (!rec) { postMessage({ type: 'recording', reqId: m.reqId, samples: null }); break; }
      const out = new Float32Array(rec.n);
      let o = 0;
      for (const c of rec.chunks) { out.set(c, o); o += c.length; }
      rec = null;
      postMessage({ type: 'recording', reqId: m.reqId, samples: out, fs }, [out.buffer]);
      break;
    }
    case 'grab': {
      const out = lastSamples(m.seconds);
      postMessage({ type: 'grab', reqId: m.reqId, samples: out, fs }, [out.buffer]);
      break;
    }
  }
};
