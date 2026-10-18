// Mappe di colore per spettrogrammi (LUT a 256 voci in formato pixel RGBA little-endian).

const STOPS = {
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#fcffa4'],
  magma: ['#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55064', '#fb8761', '#fec287', '#fcfdbf'],
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  ghiaccio: ['#000000', '#0b1a4a', '#1f4fa0', '#3aa0d8', '#9be3f5', '#ffffff'],
  grigio: ['#000000', '#ffffff'],
};

export const COLORMAPS = [
  { id: 'turbo', name: 'Turbo' },
  { id: 'inferno', name: 'Inferno' },
  { id: 'magma', name: 'Magma' },
  { id: 'viridis', name: 'Viridis' },
  { id: 'ghiaccio', name: 'Ghiaccio' },
  { id: 'grigio', name: 'Grigio' },
];

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function turbo(x) {
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [r, g, b].map((v) => Math.round(255 * Math.max(0, Math.min(1, v))));
}

const cache = new Map();
export function getLut(name) {
  if (cache.has(name)) return cache.get(name);
  const lut = new Uint32Array(256);
  const stops = (STOPS[name] || []).map(hex);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let c;
    if (name === 'turbo' || !stops.length) c = turbo(x);
    else {
      const p = x * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(p)), f = p - k;
      c = [0, 1, 2].map((j) => Math.round(stops[k][j] + (stops[k + 1][j] - stops[k][j]) * f));
    }
    lut[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
  }
  cache.set(name, lut);
  return lut;
}

export function lutCss(name, steps = 8) {
  const lut = getLut(name);
  const cols = [];
  for (let i = 0; i < steps; i++) {
    const v = lut[Math.round((i / (steps - 1)) * 255)];
    cols.push(`rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`);
  }
  return `linear-gradient(90deg, ${cols.join(',')})`;
}
