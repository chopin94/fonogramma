// Analisi del fonocardiogramma: segmentazione S1/S2, toni aggiunti (S3, S4, click,
// schiocco), sdoppiamento di S2, intervalli, HRV, indici di soffio e qualità del segnale.
// Algoritmo derivato da fonocardiogrammaPCG (signal_processing.py) e Cardiogram94
// (autocorrelazione), esteso con inviluppo d'ampiezza e analisi del ciclo medio.
// Ingresso: segnale già filtrato 25–400 Hz e decimato (~2 kHz). Tempi restituiti in secondi.
import { findPeaks, percentile, median, mad, mean, std, movingAverage, clusterPeaks } from './peaks.js';
import { spectralCentroid } from './fft.js';
import { bandpassSections, filtfilt } from './biquad.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
let SEG_LP = 100; // passa-basso dell'inviluppo di segmentazione (Hz)
export function _setSegLp(v) { SEG_LP = v; }

function emptyMetrics() {
  return {
    bpm: null, bpmStd: null, bpmAuto: null, acStrength: 0, nBeats: 0,
    rhythm: '—', rrCv: null, ectopics: 0, sdnn: null, rmssd: null, pnn50: null,
    sysMs: null, sysStd: null, diaMs: null, diaStd: null, sdRatio: null,
    s1Amp: null, s2Amp: null, s1s2: null, s1DurMs: null, s2DurMs: null, s1Freq: null, s2Freq: null,
    splitCount: 0, splitPct: 0, splitMs: null, splitMin: null, splitMax: null, splitPattern: null,
    s3Count: 0, s4Count: 0, s3Pct: 0, s4Pct: 0, clickCount: 0, snapCount: 0,
    sysIdx: null, diaIdx: null, floorIdx: null,
    murmurSys: false, murmurDia: false, murmurSysShape: null, murmurDiaShape: null,
    murmurPitchHz: null, murmurIntensity: null, sqi: 0, snrDb: null,
  };
}

// Frequenza cardiaca dominante dall'autocorrelazione dell'inviluppo (100 Hz).
export function autocorrHR(env, envFs) {
  const d = Math.max(1, Math.round(envFs / 100));
  const fs2 = envFs / d;
  const m = Math.floor(env.length / d);
  if (m < fs2 * 1.5) return null;
  const y = new Float32Array(m);
  let mu = 0;
  for (let k = 0; k < m; k++) {
    let s = 0;
    for (let j = 0; j < d; j++) s += env[k * d + j];
    y[k] = s / d;
    mu += y[k];
  }
  mu /= m;
  let r0 = 0;
  for (let k = 0; k < m; k++) { y[k] -= mu; r0 += y[k] * y[k]; }
  if (r0 <= 1e-12) return null;
  r0 /= m;
  const minLag = Math.round(0.3 * fs2);
  const maxLag = Math.min(Math.round(2.0 * fs2), m - Math.round(0.8 * fs2));
  if (maxLag <= minLag + 2) return null;
  const r = new Float32Array(maxLag + 2);
  for (let L = minLag - 1; L <= maxLag + 1; L++) {
    let s = 0;
    for (let k = 0; k + L < m; k++) s += y[k] * y[k + L];
    r[L] = s / (m - L) / r0;
  }
  let best = -1, bestL = -1;
  for (let L = minLag; L <= maxLag; L++) {
    if (r[L] > r[L - 1] && r[L] >= r[L + 1] && r[L] > best) { best = r[L]; bestL = L; }
  }
  if (bestL < 0 || best < 0.1) return null;
  const a = r[bestL - 1], b = r[bestL], c = r[bestL + 1];
  const den = a - 2 * b + c;
  const off = Math.abs(den) > 1e-9 ? (0.5 * (a - c)) / den : 0;
  const lag = (bestL + Math.max(-0.5, Math.min(0.5, off))) / fs2;
  return { bpm: 60 / lag, strength: best };
}

function width50(env, i, maxSamp) {
  const thr = env[i] * 0.5;
  let a = i, b = i;
  while (a > 0 && i - a < maxSamp && env[a] > thr) a--;
  while (b < env.length - 1 && b - i < maxSamp && env[b] > thr) b++;
  return b - a;
}

function localMax(arr, i, rad) {
  let best = arr[i] || 0;
  for (let k = Math.max(0, i - rad); k <= Math.min(arr.length - 1, i + rad); k++) if (arr[k] > best) best = arr[k];
  return best;
}

function windowMean(arr, a, b, exclude, exRad) {
  a = Math.max(0, Math.round(a));
  b = Math.min(arr.length, Math.round(b));
  let s = 0, n = 0;
  for (let k = a; k < b; k++) {
    let skip = false;
    for (const e of exclude) if (Math.abs(k - e) < exRad) { skip = true; break; }
    if (!skip) { s += arr[k]; n++; }
  }
  return n ? s / n : null;
}

function classifyShape(profile, diastolic) {
  const p = Array.from(profile);
  const third = (a, b) => mean(p.slice(a, b));
  const A = diastolic ? third(1, 7) : third(3, 8);
  const B = diastolic ? third(7, 13) : third(8, 12);
  const C = diastolic ? third(13, 19) : third(12, 17);
  const hi = Math.max(A, B, C), lo = Math.min(A, B, C);
  if (diastolic) {
    if (hi === A && A > 1.3 * C) return 'Protodiastolico decrescente';
    if (hi === C && C > 1.3 * A) return 'Presistolico (crescente)';
    if (hi === B) return 'Mesodiastolico (rullio)';
    return 'Olodiastolico';
  }
  if (hi / Math.max(lo, 1e-6) < 1.35) return 'Olosistolico (plateau)';
  if (hi === B) return 'Crescendo-decrescendo (eiettivo)';
  if (hi === A) return 'Decrescendo (protosistolico)';
  return 'Crescendo (telesistolico)';
}

export function analyzeHeart(x, fs) {
  const n = x.length;
  const res = {
    ok: false, kind: 'heart', duration: n / fs, reason: '',
    env: null, envFs: 0, s1: [], s2: [], s3: [], s4: [], clicks: [], snaps: [], beats: [],
    metrics: emptyMetrics(), ensemble: null, sysProfile: null, diaProfile: null,
  };
  if (n / fs < 1.5) { res.reason = 'Segnale troppo breve'; return res; }

  // 1) Inviluppi: energia di Shannon su banda bassa 25–150 Hz (segmentazione, poco
  //    influenzata dai soffi) e ampiezza RMS a banda piena (misure, indici di soffio)
  const xl = filtfilt(bandpassSections(fs, 0, SEG_LP, 2, 4), x, Math.min(n - 1, Math.round(0.2 * fs)));
  const half = new Float32Array(Math.ceil(n / 2));
  for (let i = 0, j = 0; i < n; i += 2, j++) half[j] = Math.abs(xl[i]);
  const ref = percentile(half, 99.5) * 1.2 || 1e-9;
  const se = new Float32Array(n), sq = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = xl[i] / ref;
    if (v > 1) v = 1; else if (v < -1) v = -1;
    const v2 = v * v;
    se[i] = v2 > 1e-10 ? -v2 * Math.log(v2) : 0;
    sq[i] = x[i] * x[i];
  }
  const w20 = Math.max(1, Math.round(0.02 * fs));
  const seS = movingAverage(se, w20);
  const sqS = movingAverage(sq, w20);
  const dEnv = Math.max(1, Math.round(fs / 500));
  const envFs = fs / dEnv;
  const m = Math.floor(n / dEnv);
  const env = new Float32Array(m), envA = new Float32Array(m);
  for (let k = 0; k < m; k++) {
    let s = 0, a = 0;
    for (let j = 0; j < dEnv; j++) { s += seS[k * dEnv + j]; a += sqS[k * dEnv + j]; }
    env[k] = s / dEnv;
    envA[k] = Math.sqrt(a / dEnv);
  }
  const p99 = percentile(env, 99) || 1e-9, p99a = percentile(envA, 99) || 1e-9;
  for (let k = 0; k < m; k++) { env[k] /= p99; envA[k] /= p99a; }
  res.env = envA;
  res.envFs = envFs;

  // 2) Frequenza dominante (autocorrelazione)
  const ac = autocorrHR(env, envFs);
  const met = res.metrics;
  if (ac) { met.bpmAuto = ac.bpm; met.acStrength = ac.strength; }
  const acOk = ac && ac.strength >= 0.3; // periodicità affidabile solo se ben marcata
  const T = acOk ? 60 / ac.bpm : null;

  // 3) Picchi candidati
  const med = median(env), md = mad(env, med);
  const thr = Math.min(0.5, Math.max(0.12, med + 4 * md));
  const raw = findPeaks(env, { height: thr, distance: Math.round(0.05 * envFs), prominence: 0.08 });
  const clustered = clusterPeaks(raw, env, Math.round(0.06 * envFs));
  if (clustered.length < 2) { res.reason = 'Toni cardiaci non riconosciuti'; finalizeQuality(res, envA, ac); return res; }
  const ref75 = percentile(Float32Array.from(clustered.map((i) => env[i])), 75);
  let primary = clustered.filter((i) => env[i] >= 0.3 * ref75);
  if (primary.length < 2) primary = clustered;

  // 4) Accoppiamento S1→S2: la sistole è l'intervallo breve fra due diastoli più lunghe
  const hrEst = acOk ? ac.bpm : null;
  const sysExp = hrEst ? Math.max(0.2, 0.49 - 0.0021 * hrEst) : 0.32;
  const sysMin = 0.15, sysMax = T ? Math.min(0.6, 0.62 * T) : 0.6, diaMax = 2.0;
  const t = primary.map((i) => i / envFs);
  const ampRef = percentile(Float32Array.from(primary.map((i) => env[i])), 75) || 1;
  // periodicità: esiste un picco a ~T prima o dopo? (rende robusto con S3/S4 in diastole)
  const periodic = (i) => T && t.some((tj) => Math.abs(Math.abs(tj - t[i]) - T) < 0.15 * T);
  const pairs = [];
  for (let i = 0; i < t.length - 1; i++) {
    const d = t[i + 1] - t[i];
    if (d < sysMin || d > sysMax) continue;
    const prev = i > 0 ? t[i] - t[i - 1] : null;
    const next = i < t.length - 2 ? t[i + 2] - t[i + 1] : null;
    const okPrev = prev !== null && prev > d && prev <= diaMax;
    const okNext = next !== null && next > d && next <= diaMax;
    const okPer = periodic(i) && periodic(i + 1);
    if (!okPrev && !okNext && !okPer) continue;
    let score = Math.abs(d - sysExp) / sysExp;
    if (!okPrev && !okNext) score += 0.3;
    else if (!(okPrev && okNext)) score += 0.1;
    if (T && !okPer) score += 0.4;
    score += 0.5 * (1 - Math.min(1, Math.min(env[primary[i]], env[primary[i + 1]]) / ampRef));
    pairs.push({ a: i, b: i + 1, score });
  }
  pairs.sort((p, q) => p.score - q.score);
  const used = new Uint8Array(t.length);
  let acc = [];
  for (const p of pairs) {
    if (used[p.a] || used[p.b]) continue;
    used[p.a] = used[p.b] = 1;
    acc.push(p);
  }
  if (!acc.length && primary.length >= 3) {
    // Ripiego (come nel programma originale): alternanza intervallo breve/lungo
    for (let i = 0; i < t.length - 2; i++) {
      const d1 = t[i + 1] - t[i], d2 = t[i + 2] - t[i + 1];
      if (d1 < d2 && d1 >= sysMin && d1 <= sysMax && !used[i] && !used[i + 1]) {
        used[i] = used[i + 1] = 1;
        acc.push({ a: i, b: i + 1 });
      }
    }
  }
  // la durata della sistole è stabile anche nei ritmi irregolari: scarta gli accoppiamenti
  // incoerenti (tipicamente ai bordi della finestra, con S3/S4 scambiati per S1/S2)
  if (acc.length >= 3) {
    const sysMed = median(acc.map((p) => t[p.b] - t[p.a]));
    acc = acc.filter((p) => Math.abs(t[p.b] - t[p.a] - sysMed) <= 0.22 * sysMed + 0.02);
  }
  acc.sort((p, q) => p.a - q.a);
  // bordo finale: un S2 troncato a fine finestra non è affidabile
  acc = acc.filter((p) => t[p.b] < n / fs - 0.12);
  // ritmo regolare: un "S1" che arriva troppo presto dopo l'S2 precedente è un S3
  if (T && acc.length >= 3) {
    const dias = [];
    for (let k = 1; k < acc.length; k++) dias.push(t[acc[k].a] - t[acc[k - 1].b]);
    const diaMed = median(dias);
    acc = acc.filter((p, k) => k === 0 || t[p.a] - t[acc[k - 1].b] >= 0.6 * diaMed);
  }
  const S1 = acc.map((p) => primary[p.a]);
  const S2 = acc.map((p) => primary[p.b]);
  if (!S1.length) { res.reason = 'Sequenza S1/S2 non riconosciuta'; finalizeQuality(res, envA, ac); return res; }

  // 5) Battiti
  const beats = [];
  for (let k = 0; k < S1.length; k++) {
    const s1 = S1[k], s2 = S2[k];
    let nxt = k + 1 < S1.length ? S1[k + 1] : null;
    let rr = nxt !== null ? (nxt - s1) / envFs : null;
    if (rr !== null) {
      const okRR = rr >= 0.27 && rr <= 2.2 && (!T || (rr > 0.5 * T && rr < 1.9 * T)) && (nxt - s2) / envFs >= 0.1;
      if (!okRR) { rr = null; nxt = null; }
    }
    beats.push({ s1, s2, next: nxt, rr, sys: (s2 - s1) / envFs, dia: nxt !== null ? (nxt - s2) / envFs : null });
  }

  // 6) Toni aggiunti
  // vicino a S1 (±60 ms) o nel complesso di S2 (-60/+85 ms, include P2 di uno sdoppiamento ampio)
  const nearAnchor = (i) => S1.some((j) => Math.abs(j - i) < 0.06 * envFs) || S2.some((j) => i - j > -0.06 * envFs && i - j < 0.085 * envFs);
  const extras = raw.filter((i) => !nearAnchor(i) && env[i] >= 0.15);
  for (const c of extras) {
    const b = beats.find((bt) => c > bt.s1 && (bt.next !== null ? c < bt.next : c < bt.s2 + 0.8 * envFs));
    if (!b) continue;
    const tc = c / envFs, ts1 = b.s1 / envFs, ts2 = b.s2 / envFs, tn = b.next !== null ? b.next / envFs : null;
    if (c < b.s2) {
      if (tc - ts1 >= 0.03 && ts2 - tc >= 0.04) {
        res.clicks.push(tc);
        (b.extras ||= []).push(tc - ts1 < 0.1 ? 'click eiettivo' : 'click mesosistolico');
      }
      continue;
    }
    const fromS2 = tc - ts2, toS1 = tn !== null ? tn - tc : null;
    const cent = spectralCentroid(x, fs, (tc - 0.04) * fs, (tc + 0.05) * fs, 20, 400).centroid;
    if (fromS2 >= 0.1 && fromS2 <= 0.25 && (toS1 === null || toS1 > 0.1) && cent < 140) {
      res.s3.push(tc); (b.extras ||= []).push('S3');
    } else if (toS1 !== null && toS1 >= 0.05 && toS1 <= 0.18 && fromS2 > 0.2 && cent < 140) {
      res.s4.push(tc); (b.extras ||= []).push('S4');
    } else if (fromS2 >= 0.085 && fromS2 < 0.12) {
      res.snaps.push(tc); (b.extras ||= []).push('schiocco?');
    }
  }

  // 7) Misure per battito
  const e10 = movingAverage(sq, Math.max(1, Math.round(0.01 * fs)));
  const splitAt = (tS2) => {
    const a = Math.max(0, Math.round((tS2 - 0.04) * fs)), bb = Math.min(n - 1, Math.round((tS2 + 0.09) * fs));
    const seg = e10.subarray(a, bb);
    if (seg.length < 10) return null;
    let mx = 0;
    for (let i = 0; i < seg.length; i++) if (seg[i] > mx) mx = seg[i];
    if (mx <= 0) return null;
    const pk = findPeaks(seg, { height: 0.15 * mx, distance: Math.round(0.015 * fs), prominence: 0.08 * mx });
    if (pk.length < 2) return null;
    pk.sort((p, q) => seg[q] - seg[p]);
    const p1 = pk[0];
    const p2 = pk.slice(1).find((p) => { const dt = Math.abs(p - p1) / fs; return dt >= 0.015 && dt <= 0.08; });
    if (p2 === undefined || seg[p2] < 0.15 * seg[p1]) return null;
    let valley = Infinity;
    for (let i = Math.min(p1, p2); i <= Math.max(p1, p2); i++) if (seg[i] < valley) valley = seg[i];
    if (valley > 0.7 * Math.min(seg[p1], seg[p2])) return null;
    return (Math.abs(p2 - p1) / fs) * 1000;
  };
  const extraIdx = res.s3.concat(res.s4, res.snaps, res.clicks).map((tt) => Math.round(tt * envFs));
  const exRad = Math.round(0.04 * envFs);
  const rad = Math.round(0.02 * envFs);
  for (const b of beats) {
    b.s1Amp = localMax(envA, b.s1, rad);
    b.s2Amp = localMax(envA, b.s2, rad);
    b.ratio = b.s2Amp > 0 ? b.s1Amp / b.s2Amp : null;
    b.s1Dur = (width50(envA, b.s1, Math.round(0.1 * envFs)) / envFs) * 1000;
    b.s2Dur = (width50(envA, b.s2, Math.round(0.1 * envFs)) / envFs) * 1000;
    const ref12 = (b.s1Amp + b.s2Amp) / 2 || 1e-6;
    const sysS = b.s1 + Math.max(0.06, 0.18 * b.sys) * envFs, sysE = b.s2 - Math.max(0.04, 0.1 * b.sys) * envFs;
    const sysM = sysE > sysS ? windowMean(envA, sysS, sysE, extraIdx, exRad) : null;
    b.sysIdx = sysM !== null ? sysM / ref12 : null;
    if (b.dia !== null) {
      const diaS = b.s2 + 0.08 * envFs, diaE = b.next - 0.06 * envFs;
      // massimo fra i tre terzi della diastole: coglie anche i soffi protodiastolici brevi
      let diaM = null;
      if (diaE > diaS) {
        const w = (diaE - diaS) / 3;
        for (let q = 0; q < 3; q++) {
          const v = windowMean(envA, diaS + q * w, diaS + (q + 1) * w, extraIdx, exRad);
          if (v !== null && (diaM === null || v > diaM)) diaM = v;
        }
      }
      b.diaIdx = diaM !== null ? diaM / ref12 : null;
    } else b.diaIdx = null;
    b.split = splitAt(b.s2 / envFs);
  }

  // 8) Riepilogo
  const valid = beats.filter((b) => b.rr !== null);
  const rrs = valid.map((b) => b.rr);
  met.nBeats = beats.length;
  if (rrs.length) {
    const rrMed = median(rrs);
    met.bpm = 60 / rrMed;
    met.bpmStd = rrs.length > 1 ? std(rrs.map((r) => 60 / r)) : 0;
    if (rrs.length >= 3) {
      met.rrCv = std(rrs) / mean(rrs);
      const diffs = [];
      for (let i = 1; i < rrs.length; i++) diffs.push(rrs[i] - rrs[i - 1]);
      met.sdnn = std(rrs) * 1000;
      met.rmssd = Math.sqrt(mean(diffs.map((dd) => dd * dd))) * 1000;
      met.pnn50 = (100 * diffs.filter((dd) => Math.abs(dd) > 0.05).length) / diffs.length;
      let ect = 0;
      for (let i = 0; i < rrs.length - 1; i++) if (rrs[i] < 0.82 * rrMed && rrs[i + 1] > 1.12 * rrMed) ect++;
      met.ectopics = ect;
      if (met.rrCv < 0.1) met.rhythm = 'Regolare';
      else if (ect > 0 && rrs.filter((r) => Math.abs(r - rrMed) / rrMed < 0.1).length >= rrs.length - 2 * ect) met.rhythm = 'Regolare con battiti prematuri';
      else met.rhythm = 'Irregolare';
    }
  } else if (acOk) {
    met.bpm = ac.bpm;
  }
  const sysL = beats.map((b) => b.sys * 1000);
  const diaL = valid.map((b) => b.dia * 1000);
  if (sysL.length) { met.sysMs = median(sysL); met.sysStd = std(sysL); }
  if (diaL.length) { met.diaMs = median(diaL); met.diaStd = std(diaL); }
  if (met.sysMs && met.diaMs) met.sdRatio = met.diaMs / met.sysMs;
  met.s1Amp = median(beats.map((b) => b.s1Amp));
  met.s2Amp = median(beats.map((b) => b.s2Amp));
  met.s1s2 = median(beats.filter((b) => b.ratio).map((b) => b.ratio));
  met.s1DurMs = median(beats.map((b) => b.s1Dur));
  met.s2DurMs = median(beats.map((b) => b.s2Dur));
  const sub = beats.slice(0, 8);
  met.s1Freq = median(sub.map((b) => spectralCentroid(x, fs, (b.s1 / envFs - 0.04) * fs, (b.s1 / envFs + 0.06) * fs, 20, 400).centroid).filter(Number.isFinite)) || null;
  met.s2Freq = median(sub.map((b) => spectralCentroid(x, fs, (b.s2 / envFs - 0.03) * fs, (b.s2 / envFs + 0.05) * fs, 20, 400).centroid).filter(Number.isFinite)) || null;
  const splits = beats.map((b) => b.split).filter((v) => v !== null);
  met.splitCount = splits.length;
  met.splitPct = beats.length ? (100 * splits.length) / beats.length : 0;
  if (splits.length) {
    met.splitMs = median(splits);
    met.splitMin = Math.min(...splits);
    met.splitMax = Math.max(...splits);
    if (splits.length >= 3) {
      if (met.splitPct > 80 && met.splitMax - met.splitMin < 15) met.splitPattern = 'costante, fisso?';
      else if (met.splitPct < 100) met.splitPattern = 'variabile, fisiologico?';
      else met.splitPattern = 'persistente, variabile';
    }
  }
  met.s3Count = res.s3.length;
  met.s4Count = res.s4.length;
  met.s3Pct = beats.length ? (100 * res.s3.length) / beats.length : 0;
  met.s4Pct = beats.length ? (100 * res.s4.length) / beats.length : 0;
  
  met.snapCount = res.snaps.length;

  const sysIdx = beats.map((b) => b.sysIdx).filter((v) => v !== null);
  const diaIdx = beats.map((b) => b.diaIdx).filter((v) => v !== null);
  const floorAmp = percentile(envA, 20);
  const sigAmp = ((met.s1Amp || 0) + (met.s2Amp || 0)) / 2 || 1e-6;
  met.floorIdx = floorAmp / sigAmp;
  if (sysIdx.length) met.sysIdx = median(sysIdx);
  if (diaIdx.length) met.diaIdx = median(diaIdx);
  const sysThr = Math.max(0.15, 2.5 * met.floorIdx), diaThr = Math.max(0.12, 2.5 * met.floorIdx);
  met.murmurSys = sysIdx.length >= 2 && met.sysIdx > sysThr && sysIdx.filter((v) => v > sysThr).length >= 0.6 * sysIdx.length;
  met.murmurDia = diaIdx.length >= 2 && met.diaIdx > diaThr && diaIdx.filter((v) => v > diaThr).length >= 0.6 * diaIdx.length;
  // dentro un soffio sistolico i "click" non sono attendibili
  if (met.murmurSys && res.clicks.length) {
    res.clicks = [];
    for (const b of beats) if (b.extras) b.extras = b.extras.filter((e) => !e.startsWith('click'));
  }

  // Profili medi di sistole e diastole (20 intervalli normalizzati)
  const prof = (getA, getB, list) => {
    const p = new Float32Array(20);
    let cnt = 0;
    for (const b of list) {
      const a = getA(b), e = getB(b);
      if (e - a < 10) continue;
      const ref12 = (b.s1Amp + b.s2Amp) / 2 || 1e-6;
      for (let k = 0; k < 20; k++) {
        const v = windowMean(envA, a + ((e - a) * k) / 20, a + ((e - a) * (k + 1)) / 20, [], 0);
        p[k] += (v || 0) / ref12;
      }
      cnt++;
    }
    if (!cnt) return null;
    for (let k = 0; k < 20; k++) p[k] /= cnt;
    return p;
  };
  res.sysProfile = prof((b) => b.s1, (b) => b.s2, beats);
  res.diaProfile = prof((b) => b.s2, (b) => b.next, valid);
  if (met.murmurSys && res.sysProfile) met.murmurSysShape = classifyShape(res.sysProfile, false);
  if (met.murmurDia && res.diaProfile) met.murmurDiaShape = classifyShape(res.diaProfile, true);
  met.clickCount = res.clicks.length;
  if (met.murmurSys || met.murmurDia) {
    const cents = [];
    for (const b of beats.slice(0, 10)) {
      const a = met.murmurSys ? b.s1 / envFs + 0.07 : b.s2 / envFs + 0.08;
      const e = met.murmurSys ? b.s2 / envFs - 0.05 : (b.next !== null ? b.next / envFs - 0.06 : a + 0.3);
      if (e - a > 0.05) {
        const c = spectralCentroid(x, fs, a * fs, e * fs, 25, 400).centroid;
        if (Number.isFinite(c)) cents.push(c);
      }
    }
    met.murmurPitchHz = cents.length ? median(cents) : null;
    const idx = met.murmurSys ? met.sysIdx : met.diaIdx;
    met.murmurIntensity = idx < 0.3 ? 'lieve' : idx < 0.6 ? 'moderato' : 'intenso';
  }

  // Ciclo medio allineato su S1
  const rrMed = rrs.length ? median(rrs) : T || 0.8;
  const pre = Math.round(0.1 * envFs), post = Math.round(Math.min(2.0, rrMed * 1.1) * envFs);
  const L = pre + post;
  const sum = new Float32Array(L), sum2 = new Float32Array(L);
  const traces = [];
  let cnt = 0;
  for (const b of beats) {
    const st = b.s1 - pre;
    if (st < 0 || st + L > m) continue;
    const tr = envA.slice(st, st + L);
    for (let k = 0; k < L; k++) { sum[k] += tr[k]; sum2[k] += tr[k] * tr[k]; }
    if (traces.length < 12) traces.push(tr);
    cnt++;
  }
  if (cnt) {
    const mu = sum.map((v) => v / cnt);
    const sd = sum2.map((v, k) => Math.sqrt(Math.max(0, v / cnt - mu[k] * mu[k])));
    res.ensemble = { envFs, pre: 0.1, mean: mu, std: sd, traces, count: cnt, s2: (met.sysMs || 300) / 1000, rr: rrMed };
  }

  res.s1 = S1.map((i) => i / envFs);
  res.s2 = S2.map((i) => i / envFs);
  res.beats = beats.map((b) => ({
    t: b.s1 / envFs, s2t: b.s2 / envFs, nextT: b.next !== null ? b.next / envFs : null,
    rr: b.rr, bpm: b.rr ? 60 / b.rr : null, sys: b.sys, dia: b.dia,
    s1Amp: b.s1Amp, s2Amp: b.s2Amp, ratio: b.ratio, s1Dur: b.s1Dur, s2Dur: b.s2Dur,
    split: b.split, sysIdx: b.sysIdx, diaIdx: b.diaIdx, extras: b.extras || [],
  }));
  res.ok = true;
  finalizeQuality(res, envA, ac);
  return res;
}

function finalizeQuality(res, envA, ac) {
  const met = res.metrics;
  const floorAmp = Math.max(percentile(envA, 20), 1e-4);
  const sig = met.s1Amp && met.s2Amp ? (met.s1Amp + met.s2Amp) / 2 : percentile(envA, 99);
  met.snrDb = 20 * Math.log10(sig / floorAmp);
  let sqi = 100 * (0.6 * clamp01((met.snrDb - 6) / 24) + 0.4 * clamp01((ac ? ac.strength : 0) / 0.5));
  if (met.nBeats < 2) sqi = Math.min(sqi, 25);
  met.sqi = Math.round(sqi);
}
