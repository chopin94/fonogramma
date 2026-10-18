// Mappa del torace (vista anteriore/posteriore) con focolai e punti di auscultazione.
import { esc } from '../util.js';

const BODY = 'M150 28C136 28 129 34 127 46C101 54 64 56 46 74C36 86 33 108 38 138L50 228C55 288 58 330 60 372H240C242 330 245 288 250 228L262 138C267 108 264 86 254 74C236 56 199 54 173 46C171 34 164 28 150 28Z';

function ribs(back) {
  const ys = [76, 100, 124, 148, 172, 196, 220];
  let d = '';
  for (const y of ys) {
    if (back) {
      d += `M146 ${y}C126 ${y - 4} 96 ${y + 2} 66 ${y + 16}M154 ${y}C174 ${y - 4} 204 ${y + 2} 234 ${y + 16}`;
    } else {
      d += `M142 ${y}C120 ${y - 6} 90 ${y - 2} 62 ${y + 12}M158 ${y}C180 ${y - 6} 210 ${y - 2} 238 ${y + 12}`;
    }
  }
  return d;
}

function frontDecor() {
  return `
    <path class="bm-rib" d="${ribs(false)}"/>
    <path class="bm-heart" d="M141 108C128 118 126 146 134 166C144 190 178 202 204 190C214 182 210 156 196 134C184 116 160 102 141 108Z"/>
    <path class="bm-line" d="M146 72C122 64 92 63 64 72M154 72C178 64 208 63 236 72"/>
    <path class="bm-sternum" d="M143 70H157L158 96L156 222L150 236L144 222L142 96Z"/>
    <path class="bm-guide" d="M104 70V232M196 70V232"/>
    <text class="bm-side" x="18" y="58">DX</text><text class="bm-side" x="262" y="58">SX</text>
    <text class="bm-cap" x="150" y="364">Vista anteriore</text>`;
}

function backDecor() {
  return `
    <path class="bm-rib" d="${ribs(true)}"/>
    <path class="bm-scap" d="M78 84C96 78 124 80 132 86C128 112 120 140 108 168C96 150 82 120 78 84Z"/>
    <path class="bm-scap" d="M222 84C204 78 176 80 168 86C172 112 180 140 192 168C204 150 218 120 222 84Z"/>
    <path class="bm-spine" d="M150 40V300"/>
    <text class="bm-side" x="18" y="58">SX</text><text class="bm-side" x="262" y="58">DX</text>
    <text class="bm-cap" x="150" y="364">Vista posteriore</text>`;
}

// status: mappa id → 'done' | 'abn' | 'warn'
export function bodyMapSvg({ view = 'front', sites = [], selected = null, status = {}, compact = false } = {}) {
  const dots = sites
    .filter((s) => s.view === view)
    .map((s) => {
      const st = status[s.id] || '';
      const sel = s.id === selected ? 'sel' : '';
      return `<g class="bm-site ${st} ${sel} ${s.optional ? 'opt' : ''}" data-site="${esc(s.id)}" tabindex="0" role="button" aria-label="${esc(s.full)}">
        ${sel ? `<circle class="bm-pulse" cx="${s.x}" cy="${s.y}" r="13"/>` : ''}
        <circle class="bm-dot" cx="${s.x}" cy="${s.y}" r="${compact ? 10 : 12}"/>
        <text class="bm-num" x="${s.x}" y="${s.y + 4}">${s.n}</text>
      </g>`;
    })
    .join('');
  return `<svg class="bodymap" viewBox="0 0 300 380" role="img" aria-label="Mappa del torace">
    <path class="bm-body" d="${BODY}"/>
    ${view === 'back' ? backDecor() : frontDecor()}
    ${dots}
  </svg>`;
}

export function bindBodyMap(container, onPick) {
  container.addEventListener('click', (e) => {
    const g = e.target.closest('[data-site]');
    if (g) onPick(g.dataset.site);
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target.closest('[data-site]');
    if (g) { e.preventDefault(); onPick(g.dataset.site); }
  });
}
