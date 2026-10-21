// Rilevatori di disturbo (voce, sfregamento, ronzio, urti, rumore) sugli scenari del
// simulatore: devono riconoscere i disturbi e non scambiare per disturbo i reperti clinici
// (sibili e ronchi non sono voce, i crepitii non sono sfregamento).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo, DEMO_SCENARIOS } from '../web/js/audio/demo.js';
import { QualityMonitor, assessRecording } from '../web/js/dsp/quality.js';
import { Decimator, decimateOffline, HEART_BAND, LUNG_BAND } from '../web/js/dsp/frontend.js';
import { analyzeHeart } from '../web/js/dsp/heart.js';
import { analyzeLung } from '../web/js/dsp/lung.js';

const FS = 48000;
const SECONDS = 20;
const cache = new Map();
const assess = (id, fs = FS) => {
  const k = `${id}@${fs}`;
  if (!cache.has(k)) cache.set(k, assessRecording(generateDemo(id, fs, SECONDS), fs));
  return cache.get(k);
};

const EXPECTED = { voce: 'voice', sfregamento: 'friction', ronzio: 'hum', urti: 'move' };

test('ogni scenario di disturbo ha un test', () => {
  for (const s of DEMO_SCENARIOS.filter((d) => d.disturbance)) assert.ok(EXPECTED[s.id] || s.id === 'stanza-rumorosa', `manca il test per "${s.id}"`);
});

for (const s of DEMO_SCENARIOS.filter((d) => !d.disturbance)) {
  test(`nessun disturbo inventato: ${s.name}`, () => {
    const q = assess(s.id);
    for (const [k, v] of Object.entries(q.issues)) assert.ok(v < 20, `${k} nel ${v}% delle finestre`);
    assert.ok(q.artifactPct <= 5, `${q.artifactPct}% del tempo escluso`);
  });
}

for (const [id, issue] of Object.entries(EXPECTED)) {
  test(`disturbo riconosciuto: ${id}`, () => {
    const q = assess(id);
    assert.ok(q.issues[issue] >= 40, `${issue} solo nel ${q.issues[issue]}% delle finestre`);
  });
}

test('stanza rumorosa: rumore di fondo alto e qualità del cuore ridotta', () => {
  const noisy = assess('stanza-rumorosa'), clean = assess('normale');
  assert.ok(noisy.floorDb - clean.floorDb > 20, `fondo ${noisy.floorDb} dB contro ${clean.floorDb} dB`);
  const x = generateDemo('stanza-rumorosa', FS, SECONDS);
  const d = decimateOffline(x, FS, HEART_BAND.lo, HEART_BAND.hi, HEART_BAND.fs);
  assert.ok(analyzeHeart(d.y, d.fs).metrics.sqi < 65);
});

test('sfregamento: i tratti esclusi tolgono i falsi crepitii', () => {
  const x = generateDemo('sfregamento', FS, SECONDS);
  const q = assess('sfregamento');
  const dh = decimateOffline(x, FS, HEART_BAND.lo, HEART_BAND.hi, HEART_BAND.fs);
  const h = analyzeHeart(dh.y, dh.fs);
  const dl = decimateOffline(x, FS, LUNG_BAND.lo, LUNG_BAND.hi, LUNG_BAND.fs);
  const heartTimes = h.s1.concat(h.s2, h.s3, h.s4);
  const raw = analyzeLung(dl.y, dl.fs, { heartTimes }).metrics.crackles;
  const clean = analyzeLung(dl.y, dl.fs, { heartTimes, artifacts: q.artifacts }).metrics.crackles;
  assert.ok(clean < raw / 5, `crepitii ${raw} → ${clean}`);
});

test('crepitii veri: nessun tratto escluso, conteggio invariato', () => {
  for (const id of ['crepitii-fini', 'crepitii-grossolani']) assert.equal(assess(id).artifacts.length, 0, id);
});

test('frequenze da telefono e Bluetooth: 16 kHz e 8 kHz', () => {
  for (const fs of [16000, 8000]) {
    assert.ok(assess('ronzio', fs).issues.hum >= 40, `ronzio a ${fs} Hz`);
    assert.ok(assess('voce', fs).issues.voice >= 40, `voce a ${fs} Hz`);
    assert.ok(assess('urti', fs).issues.move >= 40, `urti a ${fs} Hz`);
    for (const id of ['normale', 'sibili', 'ronchi', 'crepitii-fini']) {
      const q = assess(id, fs);
      for (const [k, v] of Object.entries(q.issues)) assert.ok(v < 20, `${id} a ${fs} Hz: ${k} ${v}%`);
    }
  }
  assert.ok(assess('sfregamento', 16000).issues.friction >= 40);
});

test('in tempo reale (blocchi da 512 campioni) i risultati coincidono', () => {
  const x = generateDemo('voce', FS, SECONDS);
  const qm = new QualityMonitor(FS);
  let evals = 0, voice = 0;
  for (let s = 0, next = 2 * FS; s < x.length; s += 512) {
    qm.push(x.subarray(s, s + 512));
    if (s >= next) { next += FS / 2; const q = qm.evaluate(2); evals++; if (q.voice) voice++; }
  }
  assert.ok(voice / evals > 0.5, `voce in ${voice}/${evals} valutazioni`);
});

test('colpi sulla membrana riconosciuti (verifica guidata)', () => {
  const x = new Float32Array(6 * FS);
  for (let i = 0; i < x.length; i++) x[i] = 0.001 * (Math.random() * 2 - 1);
  for (const t of [4.3, 4.9, 5.5]) for (let i = 0; i < 0.03 * FS; i++) x[Math.round(t * FS) + i] += 0.6 * Math.sin(i / 20) * Math.exp(-i / (0.006 * FS));
  const qm = new QualityMonitor(FS);
  qm.push(x);
  const taps = qm.evaluate(2).taps;
  assert.equal(taps.length, 3);
  assert.ok(taps.every((t) => t.db > 30));
});

test('dopo il cambio di modalità gli indici del segnale polmonare restano assoluti', () => {
  const d = new Decimator(FS, LUNG_BAND.lo, LUNG_BAND.hi, LUNG_BAND.fs, 4);
  d.reset(96000);
  d.push(new Float32Array(48000));
  assert.equal(d.latest(1).startRaw, 96000);
});
