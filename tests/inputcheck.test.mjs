// Giudizio della verifica guidata dell'ingresso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../web/js/views/inputcheck.js';

const info = (type) => ({ label: '', type, trackRate: 48000, ctxRate: 48000, processing: {} });
const good = {
  taps: { n: 3, maxDb: 42 },
  air: { floorDb: -70, zeroFrac: 0, humHz: null, humDb: 3 },
  body: { bpm: 72, sqi: 85, snrDb: 30, peakDb: -15, floorDb: -72, lfRatioDb: -2, issues: {} },
};

test('fonendo collegato bene: adatto', () => {
  const r = judge(good, { info: info('wired'), kind: 'stetho' });
  assert.equal(r.level, 'ok');
  assert.match(r.verdict, /adatto/);
});

test('nessun colpo con il microfono del telefono: spiega il cavo a 4 poli', () => {
  const r = judge({ ...good, taps: { n: 0, maxDb: 0 } }, { info: info('builtin'), kind: 'stetho' });
  assert.equal(r.level, 'bad');
  assert.ok(r.findings.some((f) => /TRRS/.test(f.fix || '')));
});

test('silenzi tagliati, ronzio e bassi attenuati: utilizzabile con limiti', () => {
  const r = judge({ ...good, air: { floorDb: -70, zeroFrac: 0.4, humHz: 50, humDb: 22 }, body: { ...good.body, lfRatioDb: -28 } }, { info: info('wired'), kind: 'stetho' });
  assert.equal(r.level, 'warn');
  assert.equal(r.findings.filter((f) => f.level === 'warn').length, 3);
});

test('battito non riconosciuto', () => {
  const r = judge({ ...good, body: { ...good.body, sqi: 10, bpm: null } }, { info: info('usb'), kind: 'stetho' });
  assert.equal(r.level, 'bad');
});
