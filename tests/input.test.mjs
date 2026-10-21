// Riconoscimento del tipo di ingresso dai nomi che danno browser e sistemi (Chrome per
// Android, Safari per iPhone, Windows) e avvisi che ne derivano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput, inputAdvice, worstLevel } from '../web/js/audio/input.js';

test('tipo di ingresso dal nome', () => {
  const cases = {
    'Wired headset': 'wired',
    'Headset earpiece': 'builtin',
    Speakerphone: 'builtin',
    'Bluetooth headset': 'bluetooth',
    'USB audio': 'usb',
    'iPhone Microphone': 'builtin',
    'AirPods Pro': 'bluetooth',
    'Galaxy Buds2 Pro': 'bluetooth',
    'Headset Microphone (Jabra EVOLVE 20)': 'wired',
    'Microphone Array (Intel® Smart Sound Technology)': 'builtin',
    'External Microphone': 'wired',
    'Cuffie con microfono': 'wired',
    'Microfono (Realtek(R) Audio)': 'unknown',
    Default: 'unknown',
    '': 'unknown',
  };
  for (const [label, type] of Object.entries(cases)) assert.equal(classifyInput(label), type, `"${label}"`);
});

const info = (type, extra = {}) => ({
  label: '', type, trackRate: 48000, ctxRate: 48000, channels: 1,
  processing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, ...extra,
});

test('fonendo con filo: nessun avviso se arriva dal jack', () => {
  assert.equal(worstLevel(inputAdvice(info('wired'), 'stetho')), 'ok');
  assert.equal(worstLevel(inputAdvice(info('usb'), 'stetho')), 'ok');
});

test('fonendo dichiarato ma suono dal microfono del telefono o dal Bluetooth', () => {
  assert.equal(worstLevel(inputAdvice(info('builtin'), 'stetho')), 'bad');
  assert.equal(worstLevel(inputAdvice(info('bluetooth'), 'stetho')), 'bad');
});

test('fonendo Bluetooth: qualità limitata ma utilizzabile', () => {
  assert.equal(worstLevel(inputAdvice(info('bluetooth'), 'bt')), 'warn');
  assert.equal(worstLevel(inputAdvice(info('bluetooth', { trackRate: 8000 }), 'bt')), 'bad');
});

test('telefono sul torace: consigli d’appoggio, avviso se c’è un ingresso esterno', () => {
  const a = inputAdvice(info('builtin'), 'phone');
  assert.equal(worstLevel(a), 'ok');
  assert.ok(a.some((x) => x.level === 'info'));
  assert.equal(worstLevel(inputAdvice(info('wired'), 'phone')), 'warn');
});

test('elaborazioni del sistema ancora attive', () => {
  const a = inputAdvice(info('wired', { processing: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }), 'stetho');
  assert.equal(worstLevel(a), 'warn');
  assert.match(a[0].text, /riduzione del rumore/);
});
