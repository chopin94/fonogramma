// Analisi dell'auscultazione toracica: frequenza respiratoria, fasi, crepitii
// (fini/grossolani, operatore di Teager-Kaiser + morfologia 2CD), sibili e ronchi
// (tracce tonali nello spettrogramma), intensità del murmure vescicolare.
// Ingresso: segnale filtrato 100–2500 Hz e decimato (~8 kHz). Tempi in secondi.
import { getFFT, hann } from './fft.js';
import { findPeaks, median, movingAverage, movingMedian, percentile, mean, std, clamp01, autocorrPeak } from './peaks.js';

const odd = (v) => (v % 2 ? v : v + 1);

function emptyMetrics() {
  return {
    rr: null, rrStrength: 0, breathCount: 0, ieRatio: null, intensityDb: null, dynamicDb: null,
    crackles: 0, cracklesFine: 0, cracklesCoarse: 0, cracklesPerMin: 0, cracklesPerBreath: null, cracklesSignificant: false, cracklesInspPct: null,
    wheezes: 0, wheezeDurPct: 0, wheezeFreq: null, rhonchi: 0, polyphonic: false, toneHz: null, sqi: 0,
  };
}

// artifacts: tratti disturbati (sfregamento, urti, saturazione) in secondi dall'inizio di
// y: i crepitii che cadono lì non si contano e le frequenze si riferiscono al tempo pulito.
export function analyzeLung(y, fs, { heartTimes = [], artifacts = [] } = {}) {
  const n = y.length, dur = n / fs;
  const res = {
    ok: false, kind: 'lung', duration: dur, reason: '',
    crackles: [], wheezes: [], breaths: [], troughs: [], resp: null, respFs: 0, metrics: emptyMetrics(),
  };
  if (dur < 2) { res.reason = 'Segnale troppo breve'; return res; }
  const met = res.metrics;

  // 1) Spettrogramma di analisi (32 ms, passo 8 ms)
  const N = fs > 6000 ? 256 : 128;
  const H = Math.max(8, Math.round(0.008 * fs));
  const fft = getFFT(N), win = hann(N);
  let wsum = 0;
  for (let i = 0; i < N; i++) wsum += win[i];
  const norm = 2 / wsum, nb = N / 2 + 1, df = fs / N, fr = fs / H;
  const F = Math.max(0, Math.floor((n - N) / H) + 1);
  if (F < 20) { res.reason = 'Segnale troppo breve'; return res; }
  const spec = new Float32Array(F * nb);
  const band = new Float32Array(F);
  const mag = new Float32Array(nb);
  const kA = Math.ceil(200 / df), kB = Math.min(nb - 1, Math.floor(1000 / df));
  for (let f = 0; f < F; f++) {
    fft.magnitude(y, win, mag, f * H);
    let p = 0;
    for (let k = 0; k < nb; k++) {
      const a = mag[k] * norm;
      spec[f * nb + k] = 20 * Math.log10(a + 1e-9);
      if (k >= kA && k <= kB) p += a * a;
    }
    band[f] = 10 * Math.log10(p / (kB - kA + 1) + 1e-18);
  }
  const tOff = N / 2 / fs;

  // 2) Inviluppo respiratorio (mediana mobile elimina i toni cardiaci)
  const resp = movingAverage(movingMedian(band, odd(Math.round(0.3 * fr))), Math.round(0.4 * fr));
  res.resp = resp;
  res.respFs = fr;
  res.respT0 = tOff;
  const p5 = percentile(resp, 5), p95 = percentile(resp, 95);
  met.dynamicDb = p95 - p5;
  met.intensityDb = percentile(band, 90);

  const pk = findPeaks(resp, { distance: Math.round(1.2 * fr), prominence: Math.max(1.5, 0.25 * met.dynamicDb) });
  res.breaths = pk.map((i) => i / fr + tOff);
  const troughs = [];
  for (let i = 0; i < pk.length - 1; i++) {
    let best = pk[i];
    for (let k = pk[i]; k <= pk[i + 1]; k++) if (resp[k] < resp[best]) best = k;
    troughs.push(best);
  }
  res.troughs = troughs.map((i) => i / fr + tOff);
  met.breathCount = pk.length;
  if (pk.length >= 2) {
    const diffs = [];
    for (let i = 1; i < pk.length; i++) diffs.push((pk[i] - pk[i - 1]) / fr);
    met.rr = 60 / median(diffs);
    met.rrStrength = clamp01(1 - std(diffs) / Math.max(mean(diffs), 1e-6));
  } else {
    const ac = respAutocorr(resp, fr);
    if (ac) { met.rr = ac.rr; met.rrStrength = ac.strength; }
  }
  // Rapporto I:E indicativo: fase "rumorosa" (sopra la metà) = inspirazione
  if (troughs.length >= 2) {
    const ratios = [];
    for (let i = 0; i < troughs.length - 1; i++) {
      const a = troughs[i], b = troughs[i + 1];
      let top = -Infinity, bot = Infinity;
      for (let k = a; k <= b; k++) { top = Math.max(top, resp[k]); bot = Math.min(bot, resp[k]); }
      const mid = (top + bot) / 2;
      let above = 0;
      for (let k = a; k <= b; k++) if (resp[k] > mid) above++;
      const below = b - a + 1 - above;
      if (above > 0) ratios.push(below / above);
    }
    if (ratios.length) met.ieRatio = median(ratios);
  }

  // 3) Sibili e ronchi: picchi tonali stabili ≥ 100 ms
  const kLo = Math.max(2, Math.ceil(100 / df)), kHi = Math.min(nb - 2, Math.floor(2000 / df));
  const segLen = kHi - kLo + 1;
  const segBuf = new Float32Array(segLen);
  const active = [];
  const tracks = [];
  const minFrames = Math.ceil(0.1 * fr);
  const closeTrack = (tr) => { if (tr.last - tr.start + 1 >= minFrames) tracks.push(tr); };
  for (let f = 0; f < F; f++) {
    const off = f * nb;
    for (let k = 0; k < segLen; k++) segBuf[k] = spec[off + kLo + k];
    const base = movingMedian(segBuf, 11);
    const fmed = median(segBuf);
    const cands = [];
    for (let k = kLo + 1; k < kHi; k++) {
      const v = spec[off + k];
      if (v > spec[off + k - 1] && v >= spec[off + k + 1] && v - base[k - kLo] >= 10 && v >= fmed + 12) cands.push(k);
    }
    cands.sort((a, b) => spec[off + b] - spec[off + a]);
    const peaks = cands.slice(0, 3);
    const usedPk = new Set();
    for (const tr of active) {
      if (tr.last < f - 2) continue;
      let best = -1;
      for (const k of peaks) if (!usedPk.has(k) && Math.abs(k - tr.lastK) <= 2 && (best < 0 || spec[off + k] > spec[off + best])) best = k;
      if (best >= 0) {
        usedPk.add(best);
        tr.last = f; tr.lastK = best; tr.ks.push(best);
      }
    }
    for (const k of peaks) if (!usedPk.has(k)) active.push({ start: f, last: f, lastK: k, ks: [k] });
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].last < f - 2) { closeTrack(active[i]); active.splice(i, 1); }
    }
  }
  active.forEach(closeTrack);
  const events = [];
  for (const tr of tracks) {
    const fHz = mean(tr.ks) * df;
    const dur = (tr.last - tr.start + 1) / fr;
    const kStd = std(tr.ks);
    const t0 = tr.start / fr + tOff, t1 = (tr.last + 1) / fr + tOff;
    if (dur > 3 && kStd < 1) {
      met.toneHz = Math.round(fHz);
      continue; // tono stazionario: interferenza (rete elettrica, ambiente)
    }
    events.push({ t0, t1, f: fHz, dur, type: fHz < 300 ? 'ronco' : 'sibilo' });
  }
  // scarta le armoniche (f ≈ k·f0 sovrapposte nel tempo a un evento più grave)
  const isHarm = (e) => events.some((g) => g !== e && g.f < e.f && Math.min(e.t1, g.t1) - Math.max(e.t0, g.t0) > 0.5 * e.dur &&
    Math.abs(e.f / g.f - Math.round(e.f / g.f)) < 0.08 * Math.round(e.f / g.f) && Math.round(e.f / g.f) >= 2);
  const fund = events.filter((e) => !isHarm(e)).sort((a, b) => a.t0 - b.t0);
  res.wheezes = fund;
  const wh = fund.filter((e) => e.type === 'sibilo');
  met.wheezes = wh.length;
  met.rhonchi = fund.length - wh.length;
  const covered = new Uint8Array(F);
  for (const e of fund) {
    for (let f = Math.max(0, Math.floor((e.t0 - tOff) * fr)); f < Math.min(F, Math.ceil((e.t1 - tOff) * fr)); f++) covered[f] = 1;
  }
  met.wheezeDurPct = (100 * covered.reduce((a, b) => a + b, 0)) / F;
  met.wheezeFreq = wh.length ? median(wh.map((e) => e.f)) : null;
  met.polyphonic = fund.some((a, i) => fund.some((b, j) => j !== i && b.t0 < a.t1 && a.t0 < b.t1 && Math.abs(a.f - b.f) > 60));

  // 4) Crepitii: transitori esplosivi brevi rispetto al fondo locale (mediana dell'RMS
  //    su ±100 ms) + morfologia dell'onda (IDW, 2CD) per distinguere fini/grossolani
  const fl = Math.max(16, Math.round(0.02 * fs));
  const nf = Math.floor(n / fl);
  const frms = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    let e = 0;
    for (let i = f * fl; i < (f + 1) * fl; i++) e += y[i] * y[i];
    frms[f] = Math.sqrt(e / fl);
  }
  const bgF = movingMedian(frms, 11);
  // fondo locale: mediana ±100 ms, ma segue anche le rampe del respiro (min dei frame vicini)
  const bgAt = (i) => {
    const f = Math.min(nf - 1, Math.floor(i / fl));
    const nb2 = Math.min(frms[Math.max(0, f - 1)], frms[Math.min(nf - 1, f + 1)]);
    return Math.max(bgF[f], nb2) || 1e-9;
  };
  const absY = new Float32Array(n);
  for (let i = 0; i < n; i++) absY[i] = Math.abs(y[i]);
  const a2 = movingAverage(absY, Math.max(4, Math.round(0.001 * fs)));
  const globalFloor = Math.max(0.5 * median(frms), 0.25 * percentile(frms, 90));
  const maxD = 0.025 * fs, refr = Math.round(0.006 * fs);
  for (let i = 0; i < n; i++) {
    const bg = Math.max(bgAt(i), globalFloor);
    if (a2[i] <= 2.0 * bg) continue;
    let e = i;
    while (e < n - 1 && a2[e] > 1.2 * Math.max(bgAt(e), globalFloor)) e++;
    let s0 = i;
    while (s0 > 0 && a2[s0 - 1] > 1.2 * bg && i - s0 < maxD) s0--;
    if (e - s0 <= maxD) {
      let pkI = s0;
      for (let k = s0; k <= e; k++) if (absY[k] > absY[pkI]) pkI = k;
      const tp = pkI / fs;
      if (absY[pkI] >= 3.5 * bg && !heartTimes.some((h) => tp - h > -0.06 && tp - h < 0.13) && !artifacts.some(([a, b]) => tp >= a && tp <= b)) {
        const c = crackleShape(y, fs, pkI);
        if (c) res.crackles.push({ t: pkI / fs, ...c });
      }
    }
    i = e + refr;
  }
  // fase indicativa: inspirazione = fase "rumorosa" (inviluppo sopra la metà della dinamica)
  const midResp = (p5 + p95) / 2;
  const phaseOf = (tt) => {
    if (met.dynamicDb < 4) return null;
    const fi = Math.round((tt - tOff) * fr);
    if (fi < 0 || fi >= resp.length) return null;
    return resp[fi] >= midResp ? 'insp' : 'esp';
  };
  for (const c of res.crackles) c.phase = phaseOf(c.t);
  met.crackles = res.crackles.length;
  met.cracklesFine = res.crackles.filter((c) => c.type === 'fine').length;
  met.cracklesCoarse = met.crackles - met.cracklesFine;
  const artS = artifacts.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, dur) - Math.max(a, 0)), 0);
  const cleanDur = Math.max(0.25 * dur, dur - artS);
  met.cracklesPerMin = (met.crackles / cleanDur) * 60;
  const nBreaths = met.rr ? Math.max(1, (cleanDur * met.rr) / 60) : null;
  met.cracklesPerBreath = nBreaths ? met.crackles / nBreaths : null;
  met.cracklesSignificant = nBreaths ? met.cracklesPerBreath >= 3 : met.cracklesPerMin >= 40;
  const withPh = res.crackles.filter((c) => c.phase);
  met.cracklesInspPct = withPh.length ? (100 * withPh.filter((c) => c.phase === 'insp').length) / withPh.length : null;

  met.sqi = Math.round(100 * (0.7 * clamp01((met.dynamicDb - 2) / 10) + 0.3 * clamp01(met.breathCount / 3)));
  res.ok = true;
  return res;
}

function crackleShape(y, fs, at) {
  const n = y.length;
  const r = Math.round(0.003 * fs);
  let p = at;
  for (let k = Math.max(0, at - r); k <= Math.min(n - 1, at + r); k++) if (Math.abs(y[k]) > Math.abs(y[p])) p = k;
  const sgn = Math.sign(y[p]);
  if (!sgn) return null;
  let z0 = p;
  while (z0 > 0 && Math.sign(y[z0 - 1]) === sgn && p - z0 < 0.01 * fs) z0--;
  const zc = [];
  let s = sgn;
  for (let k = z0 + 1; k < Math.min(n, z0 + 0.03 * fs) && zc.length < 4; k++) {
    const sk = Math.sign(y[k]);
    if (sk && sk !== s) { zc.push(k); s = sk; }
  }
  if (zc.length < 2) return null;
  // IDW = prima semionda; 2CD stimato dai primi due semiperiodi (i più ampi, meno disturbati)
  const idw = ((zc[0] - z0) / fs) * 1000;
  const cd2 = ((zc[1] - z0) / fs) * 1000 * 2;
  if (cd2 > 25 || cd2 < 1) return null;
  return { idw, cd2, amp: Math.abs(y[p]), type: cd2 < 10 ? 'fine' : 'grossolano' };
}

function respAutocorr(resp, fr) {
  const pk = autocorrPeak(resp, Math.round(1.5 * fr), Math.min(Math.round(10 * fr), Math.floor(resp.length * 0.6)));
  if (!pk || pk.strength < 0.2) return null;
  return { rr: (60 * fr) / pk.lag, strength: pk.strength };
}
