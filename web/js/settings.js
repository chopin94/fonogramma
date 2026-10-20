// Impostazioni dell'app (per dispositivo, salvate in localStorage).
const KEY = 'fonogramma.settings.v1';

export const WF_DETAIL = {
  heart: {
    standard: { fftSize: 4096, hop: 384, rows: 320 },
    alto: { fftSize: 4096, hop: 192, rows: 448 },
    ultra: { fftSize: 8192, hop: 128, rows: 640 },
  },
  lung: {
    standard: { fftSize: 1024, hop: 192, rows: 384 },
    alto: { fftSize: 1024, hop: 96, rows: 512 },
    ultra: { fftSize: 2048, hop: 64, rows: 768 },
  },
};

export const DEFAULTS = {
  theme: 'auto',
  source: 'mic',
  demoId: 'normale',
  deviceId: '',
  inputChannel: 'mix',
  gainDb: 0,
  monitor: false,
  volumeDb: 6,
  denoise: false,
  denoiseStrength: 1.5,
  autoPresetBySite: true,
  presetHeart: 'campana',
  presetLung: 'polmone',
  customPresets: [],
  spanHeart: 5,
  spanLung: 6,
  colormap: 'turbo',
  wfSource: 'filtered',
  wfHeart: { detail: 'alto', fMin: 20, fMax: 800, scale: 'lin' },
  wfLung: { detail: 'alto', fMin: 60, fMax: 2500, scale: 'lin' },
  dbRange: { heart: [-100, -30], lung: [-110, -40] },
  autoLevels: true,
  smoothWaterfall: false,
  showEnvelope: true,
  showRaw: false,
  loopSeconds: 30,
  grabSeconds: 15,
  maxRecSeconds: 180,
  guidedHeartS: 15,
  guidedLungS: 20,
  guidedCountdown: 3,
  lastMode: 'heart',
};

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function load() {
  try { return merge(DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return merge(DEFAULTS, {}); }
}

export const settings = load();
const listeners = new Set();

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
  listeners.forEach((fn) => fn(settings));
}

export function updateSettings(patch) {
  Object.assign(settings, merge(settings, patch));
  saveSettings();
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function wfConfig(mode) {
  const w = mode === 'lung' ? settings.wfLung : settings.wfHeart;
  const d = WF_DETAIL[mode][w.detail] || WF_DETAIL[mode].alto;
  return { ...d, fMin: w.fMin, fMax: w.fMax, scale: w.scale };
}

export function applyTheme() {
  const t = settings.theme;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#0a0f1c' : '#f4f6fb';
}
