// Assistente all'auscultazione: priorità dei messaggi e stabilità dell'indicatore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coach, Tally, coachState } from '../web/js/coach.js';

const clean = { peakDb: -12, rmsDb: -30, floorDb: -58, zeroFrac: 0, clipFrames: 0, moveFrames: 0, frictionFrames: 0, humHz: null, voice: false };
const st = (patch = {}, extra = {}) => coachState({ quality: { ...clean, ...patch }, mode: 'heart', source: 'mic', kind: 'stetho', heart: { metrics: { sqi: 90 } }, ...extra });

test('segnale pulito: verde', () => {
  assert.equal(st().key, 'ok');
  assert.equal(st().level, 'ok');
});

test('priorità: saturazione prima di urti, voce prima di sfregamento e ronzio', () => {
  assert.equal(st({ clipFrames: 5, moveFrames: 10 }).key, 'clip');
  assert.equal(st({ moveFrames: 5, voice: true }).key, 'move');
  assert.equal(st({ voice: true, frictionFrames: 20 }).key, 'voice');
  assert.equal(st({ frictionFrames: 20, humHz: 50 }).key, 'friction');
  assert.equal(st({ humHz: 60 }).text, 'Ronzio a 60 Hz');
});

test('silenzi tagliati e assenza di segnale solo per il microfono', () => {
  assert.equal(st({ zeroFrac: 0.3 }).key, 'gate');
  assert.equal(st({ zeroFrac: 1 }).key, 'silent');
  assert.equal(st({ zeroFrac: 0.3 }, { source: 'file' }).key, 'ok');
});

test('ingresso sbagliato prima di tutto, anche senza misure', () => {
  const advice = [{ level: 'bad', text: 'Il suono arriva dal microfono di un dispositivo Bluetooth (cuffie o auricolari), non dal fonendo.', fix: 'x' }];
  assert.equal(coachState({ quality: null, mode: 'heart', source: 'mic', advice }).key, 'input');
});

test('battito poco chiaro solo dopo qualche secondo', () => {
  assert.equal(st({}, { heart: { metrics: { sqi: 20 } }, settled: false }).key, 'ok');
  assert.equal(st({}, { heart: { metrics: { sqi: 20 } } }).key, 'poor');
});

test('l’indicatore non lampeggia', () => {
  const c = new Coach({ confirm: 2, hold: 3000 });
  const ok = st(), fr = st({ frictionFrames: 20 });
  assert.equal(c.update(ok, 0).key, 'ok');
  assert.equal(c.update(fr, 500).key, 'ok'); // una sola valutazione non basta
  assert.equal(c.update(fr, 1000).key, 'friction');
  assert.equal(c.update(ok, 1500).key, 'friction'); // resta qualche secondo
  assert.equal(c.update(ok, 2000).key, 'friction');
  assert.equal(c.update(ok, 4500).key, 'ok');
  assert.equal(c.update(st({ clipFrames: 3 }), 5000).key, 'clip'); // i problemi gravi subito
});

test('riepilogo dei disturbi di una registrazione', () => {
  const t = new Tally();
  for (let i = 0; i < 6; i++) t.add(st());
  for (let i = 0; i < 4; i++) t.add(st({ frictionFrames: 20 }));
  const w = t.worst();
  assert.equal(w.key, 'friction');
  assert.equal(w.frac, 0.4);
});
