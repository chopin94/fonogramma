// Preset di filtro ("modalità" come negli stetoscopi elettronici) e utility EQ.
import { settings } from './settings.js';

const HP = (freq, slope = 24) => ({ type: 'highpass', freq, slope, enabled: true });
const LP = (freq, slope = 24) => ({ type: 'lowpass', freq, slope, enabled: true });
const PK = (freq, gain, q = 1) => ({ type: 'peaking', freq, gain, q, enabled: true });
const LS = (freq, gain, q = 0.707) => ({ type: 'lowshelf', freq, gain, q, enabled: true });

export const BUILTIN_PRESETS = [
  { id: 'campana', name: 'Campana', mode: 'heart', desc: '20–400 Hz · toni bassi: S3, S4, rullio mitralico', bands: [HP(20), LS(120, 3), LP(400, 48)] },
  { id: 'membrana', name: 'Membrana', mode: 'heart', desc: '80–1000 Hz · S1/S2, sdoppiamenti, soffi', bands: [HP(80), PK(300, 3, 0.8), LP(1000)] },
  { id: 'esteso', name: 'Esteso', mode: 'heart', desc: '20–2000 Hz · ascolto completo', bands: [HP(20), LP(2000)] },
  { id: 'polmone', name: 'Polmone', mode: 'lung', desc: '100–2500 Hz · murmure, crepitii, sibili', bands: [HP(100), LP(2500)] },
  { id: 'utente', name: 'Il tuo preset', mode: 'heart', desc: 'HP 42 Hz 24 dB/ott · LP 247 Hz 48 dB/ott (dal programma Python)', bands: [HP(42, 24), LP(247, 48)] },
  { id: 'foto', name: 'Preset "foto"', mode: 'any', desc: 'HP 42 Hz · picco +6,9 dB a 3086 Hz · LP 9919 Hz (versione originale)', bands: [HP(42, 24), PK(3086, 6.9, 0.6), LP(9919, 48)] },
  { id: 'grezzo', name: 'Nessun filtro', mode: 'any', desc: 'Segnale grezzo del fonendoscopio', bands: [] },
];

// Schema a 9 bande dell'equalizzatore (come nel programma Python)
export const EQ_TEMPLATE = [
  { id: 'HP', type: 'highpass', freq: 42, slope: 24, enabled: true },
  { id: 'L', type: 'lowshelf', freq: 36, gain: -15, q: 0.707, enabled: false },
  { id: '1', type: 'peaking', freq: 903, gain: 15, q: 0.3, enabled: false },
  { id: '2', type: 'peaking', freq: 66, gain: -6.5, q: 0.1, enabled: false },
  { id: '3', type: 'peaking', freq: 20, gain: -6.3, q: 1.9, enabled: false },
  { id: '4', type: 'peaking', freq: 3086, gain: 6.9, q: 0.6, enabled: true },
  { id: '5', type: 'peaking', freq: 7663, gain: -15, q: 2.0, enabled: false },
  { id: 'H', type: 'highshelf', freq: 10810, gain: -15, q: 0.707, enabled: false },
  { id: 'LP', type: 'lowpass', freq: 247, slope: 48, enabled: true },
];

export function allPresets() {
  return BUILTIN_PRESETS.concat((settings.customPresets || []).map((p) => ({ ...p, custom: true })));
}

export function getPreset(id) {
  return allPresets().find((p) => p.id === id) || BUILTIN_PRESETS[0];
}

export function presetsFor(mode) {
  return allPresets().filter((p) => p.mode === mode || p.mode === 'any' || p.custom);
}

// Converte il formato di eq_preset.json del programma Python
// (per HP/LP il campo "gain" contiene la pendenza in dB/ottava).
export function fromPythonEq(list) {
  if (!Array.isArray(list)) throw new Error('Formato non valido');
  return list.map((b) => {
    const t = b.type;
    if (t === 'highpass' || t === 'lowpass') return { id: b.id, type: t, freq: +b.freq, slope: Math.max(12, Math.round((+b.gain || 24) / 12) * 12), enabled: b.enabled !== false };
    return { id: b.id, type: t, freq: +b.freq, gain: +b.gain || 0, q: +b.q || 0.707, enabled: b.enabled !== false };
  });
}

export function bandLabel(b) {
  const f = b.freq >= 1000 ? `${(b.freq / 1000).toFixed(b.freq >= 10000 ? 0 : 1)} kHz` : `${Math.round(b.freq)} Hz`;
  if (b.type === 'highpass') return `Passa-alto ${f} · ${b.slope} dB/ott`;
  if (b.type === 'lowpass') return `Passa-basso ${f} · ${b.slope} dB/ott`;
  const g = `${b.gain > 0 ? '+' : ''}${(+b.gain).toFixed(1)} dB`;
  if (b.type === 'lowshelf') return `Shelf basso ${f} ${g}`;
  if (b.type === 'highshelf') return `Shelf alto ${f} ${g}`;
  if (b.type === 'notch') return `Notch ${f}`;
  return `Picco ${f} ${g} Q ${(+b.q).toFixed(2)}`;
}
