// Equalizzatore parametrico a 9 bande (come nel programma Python) con curva di
// risposta trascinabile, import di eq_preset.json e salvataggio di preset personali.
import { el, esc, sheet, toast, uuid } from '../util.js';
import { sectionsForBands, responseDb } from '../dsp/biquad.js';
import { EQ_TEMPLATE, fromPythonEq } from '../presets.js';
import { settings, saveSettings } from '../settings.js';
import { fitCanvas } from './charts.js';

const TYPES = [
  ['highpass', 'Passa-alto'], ['lowshelf', 'Shelf basso'], ['peaking', 'Picco'], ['highshelf', 'Shelf alto'], ['lowpass', 'Passa-basso'], ['notch', 'Notch'],
];
const F_MIN = 15, F_MAX = 20000;

export function openEqEditor({ bands, fs = 48000, onChange, title = 'Equalizzatore parametrico' }) {
  let eq = (bands && bands.length ? bands : EQ_TEMPLATE).map((b, i) => ({ id: b.id || String(i + 1), q: 0.707, gain: 0, slope: 24, enabled: true, ...b }));
  const body = el(`<div class="col">
    <canvas style="width:100%;height:220px;border-radius:12px;background:#070b14;touch-action:none" data-graph></canvas>
    <div class="small muted">Trascina i punti sul grafico (orizzontale = frequenza, verticale = guadagno). Le modifiche si sentono subito.</div>
    <div class="col" data-rows></div>
    <div class="row">
      <button class="btn sm" data-tpl>Schema a 9 bande</button>
      <label class="btn sm">Importa eq_preset.json<input type="file" accept=".json,application/json" hidden data-imp></label>
      <span class="grow"></span>
      <input type="text" placeholder="Nome preset" data-name style="max-width:180px">
      <button class="btn sm primary" data-save>Salva preset</button>
    </div>
  </div>`);
  const cv = body.querySelector('[data-graph]');
  const rowsEl = body.querySelector('[data-rows]');
  const nyq = fs / 2;
  const fx = (f, W) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W;
  const xf = (x, W) => F_MIN * Math.pow(F_MAX / F_MIN, x / W);
  const gy = (g, H) => H / 2 - (g / 30) * (H / 2 - 10);
  const yg = (y, H) => ((H / 2 - y) / (H / 2 - 10)) * 30;

  const emit = () => onChange && onChange(eq.map((b) => ({ ...b })));

  function draw() {
    const { W, H, dpr, ctx } = fitCanvas(cv);
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${10 * dpr}px system-ui`;
    ctx.fillStyle = 'rgba(200,210,235,.6)';
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = fx(f, W);
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      ctx.fillRect(x, 0, 1, H);
      ctx.fillStyle = 'rgba(200,210,235,.6)';
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, H - 4 * dpr);
    }
    for (const g of [-24, -12, 0, 12, 24]) {
      const y = gy(g, H);
      ctx.fillStyle = g === 0 ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.07)';
      ctx.fillRect(0, y, W, 1);
      ctx.fillStyle = 'rgba(200,210,235,.6)';
      ctx.fillText(`${g} dB`, 3, y - 3);
    }
    const freqs = new Float32Array(300);
    for (let i = 0; i < 300; i++) freqs[i] = Math.min(nyq * 0.995, F_MIN * Math.pow(F_MAX / F_MIN, i / 299));
    const resp = responseDb(sectionsForBands(eq, fs), freqs, fs);
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    for (let i = 0; i < 300; i++) { const x = fx(freqs[i], W), y = gy(Math.max(-30, Math.min(30, resp[i])), H); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    eq.forEach((b, i) => {
      if (!b.enabled) return;
      const x = fx(b.freq, W);
      const g = b.type === 'highpass' || b.type === 'lowpass' || b.type === 'notch' ? -3 : b.gain;
      const y = gy(g, H);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#2dd4bf';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.arc(x, y, 7 * dpr, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#0a0f1c';
      ctx.textAlign = 'center';
      ctx.fillText(b.id, x, y + 3.5 * dpr);
      ctx.textAlign = 'left';
    });
  }

  function renderRows() {
    rowsEl.innerHTML = '';
    eq.forEach((b, i) => {
      const isPass = b.type === 'highpass' || b.type === 'lowpass';
      const r = el(`<div class="row" style="gap:6px;padding:6px 0;border-bottom:1px solid var(--line)">
        <label class="check" style="min-width:52px"><input type="checkbox" ${b.enabled ? 'checked' : ''} data-k="enabled"> <b>${esc(b.id)}</b></label>
        <select data-k="type" style="width:auto">${TYPES.map(([v, l]) => `<option value="${v}" ${b.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="field" style="width:96px"><span>Hz</span><input type="number" min="10" max="${Math.floor(nyq)}" step="1" value="${Math.round(b.freq)}" data-k="freq"></label>
        ${isPass
          ? `<label class="field" style="width:110px"><span>Pendenza</span><select data-k="slope">${[12, 24, 36, 48].map((s) => `<option value="${s}" ${+b.slope === s ? 'selected' : ''}>${s} dB/ott</option>`).join('')}</select></label>`
          : `<label class="field" style="width:84px"><span>dB</span><input type="number" step="0.5" min="-30" max="30" value="${b.gain}" data-k="gain"></label>
             <label class="field" style="width:76px"><span>Q</span><input type="number" step="0.05" min="0.05" max="20" value="${b.q}" data-k="q"></label>`}
      </div>`);
      r.addEventListener('change', (e) => {
        const k = e.target.dataset.k;
        if (!k) return;
        if (k === 'enabled') b.enabled = e.target.checked;
        else if (k === 'type') { b.type = e.target.value; renderRows(); }
        else b[k] = parseFloat(e.target.value);
        draw();
        emit();
      });
      rowsEl.appendChild(r);
    });
  }

  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    const rect = cv.getBoundingClientRect();
    const W = rect.width, H = rect.height, x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 22;
    eq.forEach((b, i) => {
      if (!b.enabled) return;
      const g = b.type === 'highpass' || b.type === 'lowpass' || b.type === 'notch' ? -3 : b.gain;
      const d = Math.hypot(fx(b.freq, W) - x, gy(g, H) - y);
      if (d < bd) { bd = d; best = i; }
    });
    if (best !== null) { drag = best; cv.setPointerCapture(e.pointerId); }
  });
  cv.addEventListener('pointermove', (e) => {
    if (drag === null) return;
    const rect = cv.getBoundingClientRect();
    const b = eq[drag];
    b.freq = Math.round(Math.max(10, Math.min(nyq * 0.95, xf(e.clientX - rect.left, rect.width))));
    if (!['highpass', 'lowpass', 'notch'].includes(b.type)) b.gain = Math.round(Math.max(-30, Math.min(30, yg(e.clientY - rect.top, rect.height))) * 2) / 2;
    draw();
  });
  const end = () => { if (drag !== null) { drag = null; renderRows(); emit(); } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);

  body.querySelector('[data-tpl]').onclick = () => { eq = EQ_TEMPLATE.map((b) => ({ ...b })); renderRows(); draw(); emit(); };
  body.querySelector('[data-imp]').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      eq = fromPythonEq(JSON.parse(await f.text()));
      renderRows(); draw(); emit();
      toast('Preset del programma Python importato');
    } catch (err) { toast('File non valido: ' + err.message, { type: 'error' }); }
  };
  body.querySelector('[data-save]').onclick = () => {
    const name = body.querySelector('[data-name]').value.trim();
    if (!name) { toast('Dai un nome al preset', { type: 'warn' }); return; }
    const p = { id: `custom-${uuid().slice(0, 8)}`, name, mode: 'any', desc: 'Preset personale', bands: eq.map((b) => ({ ...b })) };
    settings.customPresets = [...(settings.customPresets || []), p];
    saveSettings();
    toast(`Preset "${name}" salvato`);
    onSaved && onSaved(p);
  };
  let onSaved = null;
  const sh = sheet({ title, body, wide: true });
  requestAnimationFrame(() => { renderRows(); draw(); });
  return { close: sh.close, onSaved: (fn) => { onSaved = fn; } };
}
