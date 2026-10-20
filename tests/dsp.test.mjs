// Test di regressione degli algoritmi di analisi sui casi del simulatore integrato.
// Eseguire dalla cartella del progetto con:  node --test
// I limiti sono volutamente larghi: servono a scoprire se una modifica rompe il
// riconoscimento (toni, soffi, ritmo, crepitii, sibili), non a fissare i decimali.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo, DEMO_SCENARIOS } from '../web/js/audio/demo.js';
import { decimateOffline, HEART_BAND, LUNG_BAND } from '../web/js/dsp/frontend.js';
import { analyzeHeart } from '../web/js/dsp/heart.js';
import { analyzeLung } from '../web/js/dsp/lung.js';

const FS = 48000;
const SECONDS = 20;

function analyze(id) {
  const x = generateDemo(id, FS, SECONDS);
  const dh = decimateOffline(x, FS, HEART_BAND.lo, HEART_BAND.hi, HEART_BAND.fs);
  const h = analyzeHeart(dh.y, dh.fs);
  const mode = DEMO_SCENARIOS.find((s) => s.id === id).mode;
  if (mode !== 'lung') return { heart: h.metrics, h };
  const dl = decimateOffline(x, FS, LUNG_BAND.lo, LUNG_BAND.hi, LUNG_BAND.fs);
  const l = analyzeLung(dl.y, dl.fs, { heartTimes: h.s1.concat(h.s2, h.s3, h.s4) });
  return { heart: h.metrics, lung: l.metrics };
}

const between = (v, lo, hi, what) => assert.ok(v >= lo && v <= hi, `${what} = ${v}, atteso fra ${lo} e ${hi}`);

const noMurmur = (m) => {
  assert.equal(m.murmurSys, false, 'soffio sistolico inatteso');
  assert.equal(m.murmurDia, false, 'soffio diastolico inatteso');
};

const HEART = {
  normale: (m) => { between(m.bpm, 65, 75, 'FC'); assert.equal(m.rhythm, 'Regolare'); noMurmur(m); assert.ok(m.s3Pct < 30 && m.s4Pct < 30, 'toni aggiunti inattesi'); },
  eiettivo: (m) => { assert.ok(m.murmurSys, 'soffio sistolico non rilevato'); assert.equal(m.murmurSysShape, 'Crescendo-decrescendo (eiettivo)'); assert.equal(m.murmurDia, false); },
  olosistolico: (m) => { assert.ok(m.murmurSys, 'soffio sistolico non rilevato'); assert.equal(m.murmurSysShape, 'Olosistolico (plateau)'); },
  diastolico: (m) => { assert.ok(m.murmurDia, 'soffio diastolico non rilevato'); assert.equal(m.murmurSys, false); },
  s3: (m) => { assert.ok(m.s3Pct >= 30, `S3 nel ${m.s3Pct}% dei cicli`); between(m.bpm, 82, 94, 'FC'); },
  s4: (m) => { assert.ok(m.s4Pct >= 30, `S4 nel ${m.s4Pct}% dei cicli`); between(m.bpm, 58, 70, 'FC'); },
  sdoppiamento: (m) => { assert.ok(m.splitPct > 80, `sdoppiamento nel ${m.splitPct}% dei battiti`); noMurmur(m); },
  fa: (m) => { assert.equal(m.rhythm, 'Irregolare'); },
};

const LUNG = {
  polmone: (l) => { between(l.rr, 13, 19, 'FR'); assert.equal(l.cracklesSignificant, false, 'crepitii inattesi'); assert.equal(l.wheezes, 0); assert.equal(l.rhonchi, 0); },
  'crepitii-fini': (l) => { assert.ok(l.cracklesSignificant, 'crepitii non rilevati'); assert.ok(l.cracklesFine > l.cracklesCoarse, 'dovrebbero prevalere i fini'); },
  'crepitii-grossolani': (l) => { assert.ok(l.cracklesSignificant, 'crepitii non rilevati'); assert.ok(l.cracklesCoarse > 0, 'nessun crepitio grossolano'); },
  sibili: (l) => { assert.ok(l.wheezes > 0, 'sibili non rilevati'); assert.equal(l.rhonchi, 0); },
  ronchi: (l) => { assert.ok(l.rhonchi > 0, 'ronchi non rilevati'); assert.equal(l.wheezes, 0); },
};

test('ogni scenario del simulatore ha un test', () => {
  for (const s of DEMO_SCENARIOS) assert.ok(HEART[s.id] || LUNG[s.id], `manca il test per "${s.id}"`);
});

for (const s of DEMO_SCENARIOS) {
  test(`${s.mode === 'lung' ? 'torace' : 'cuore'}: ${s.name}`, () => {
    const r = analyze(s.id);
    if (s.mode === 'lung') {
      between(r.heart.bpm, 70, 82, 'FC sotto i rumori respiratori');
      LUNG[s.id](r.lung);
    } else {
      assert.ok(r.heart.nBeats >= 10, `solo ${r.heart.nBeats} battiti riconosciuti`);
      HEART[s.id](r.heart);
    }
  });
}

test('segnale troppo breve: nessun risultato e motivo esplicito', () => {
  const h = analyzeHeart(new Float32Array(1000), 2000);
  assert.equal(h.ok, false);
  assert.match(h.reason, /breve/);
});
