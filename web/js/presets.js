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
  { id: 'utente', name: 'Toni puliti', mode: 'heart', desc: '42–247 Hz · HP 24 dB/ott, LP 48 dB/ott: toni cardiaci netti, poco rumore', bands: [HP(42, 24), LP(247, 48)] },
  { id: 'foto', name: 'Brillante', mode: 'any', desc: 'HP 42 Hz · picco +6,9 dB a 3 kHz · LP 9,9 kHz: dettaglio sulle alte frequenze', bands: [HP(42, 24), PK(3086, 6.9, 0.6), LP(9919, 48)] },
  { id: 'grezzo', name: 'Nessun filtro', mode: 'any', desc: 'Segnale grezzo del fonendoscopio', bands: [] },
];

// Schema iniziale a 9 bande dell'equalizzatore
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

// Preset per id, oppure null se non esiste più (EQ dal vivo, preset personale eliminato).
export function findPreset(id) {
  return allPresets().find((p) => p.id === id) || null;
}

export function getPreset(id) {
  return findPreset(id) || BUILTIN_PRESETS[0];
}

export const EQ_LIVE_ID = 'eq-live';

// Elaborazione con cui è stata ascoltata una registrazione: valgono le bande salvate con
// la registrazione, anche se nel frattempo il preset è stato modificato o eliminato.
export const REC_FILTER_ID = 'rec';
export function recordingFilter(rec) {
  const p = findPreset(rec.preset);
  const base = rec.preset === EQ_LIVE_ID ? 'EQ personalizzato' : p ? p.name : 'Filtro della registrazione';
  return {
    id: REC_FILTER_ID,
    name: `Come in auscultazione (${base}${rec.denoise ? ' + rid. rumore' : ''})`,
    bands: Array.isArray(rec.bands) ? rec.bands : getPreset(rec.preset).bands,
    denoise: rec.denoise || 0,
  };
}

export function presetsFor(mode) {
  return allPresets().filter((p) => p.mode === mode || p.mode === 'any' || p.custom);
}

// Converte un preset EQ in JSON: elenco di bande { id, type, freq, gain, q, enabled }
// (per HP/LP il campo "gain" contiene la pendenza in dB/ottava).
export function fromEqJson(list) {
  if (!Array.isArray(list)) throw new Error('Formato non valido');
  return list.map((b) => {
    const t = b.type;
    if (t === 'highpass' || t === 'lowpass') return { id: b.id, type: t, freq: +b.freq, slope: Math.max(12, Math.round((+b.gain || 24) / 12) * 12), enabled: b.enabled !== false };
    return { id: b.id, type: t, freq: +b.freq, gain: +b.gain || 0, q: +b.q || 0.707, enabled: b.enabled !== false };
  });
}
