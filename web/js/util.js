// Utility DOM, formattazione, toast e finestre di dialogo.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function fmtNum(v, digits = 0, fallback = '—') {
  if (v === null || v === undefined || !Number.isFinite(v)) return fallback;
  return v.toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDur(s) {
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d)) return null;
  const n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--;
  return a;
}

export function patientName(p) {
  if (!p) return 'Senza paziente';
  return `${p.lastName || ''} ${p.firstName || ''}`.trim() || 'Paziente senza nome';
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function safeName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
}

// ---- Toast ----
export function toast(msg, { type = 'info', action = null, timeout = 3500 } = {}) {
  const root = document.getElementById('toasts');
  const t = el(`<div class="toast ${type}" role="status"><span>${esc(msg)}</span></div>`);
  if (action) {
    const b = el(`<button class="toast-btn">${esc(action.label)}</button>`);
    b.onclick = () => { action.run(); t.remove(); };
    t.appendChild(b);
  }
  root.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, timeout);
}

// ---- Pannello modale (bottom sheet su mobile, dialog su desktop) ----
export function sheet({ title = '', body, actions = [], wide = false, onClose } = {}) {
  const root = document.getElementById('sheet-root');
  const wrap = el(`<div class="sheet-wrap"><div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="sheet-head"><h3>${esc(title)}</h3><button class="icon-btn sheet-x" aria-label="Chiudi">✕</button></div>
      <div class="sheet-body"></div><div class="sheet-actions"></div></div></div>`);
  const bodyEl = wrap.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const close = () => {
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 220);
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.sheet-x').onclick = close;
  const act = wrap.querySelector('.sheet-actions');
  if (!actions.length) act.remove();
  for (const a of actions) {
    const b = el(`<button class="btn ${a.kind || ''}">${esc(a.label)}</button>`);
    b.onclick = async () => { const r = a.run ? await a.run() : true; if (r !== false) close(); };
    act.appendChild(b);
  }
  root.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  return { close, el: wrap, body: bodyEl };
}

export function confirmDialog(message, { title = 'Conferma', okText = 'Conferma', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    sheet({
      title,
      body: `<p class="lead">${esc(message)}</p>`,
      actions: [
        { label: 'Annulla', kind: 'ghost', run: () => { done = true; resolve(false); } },
        { label: okText, kind: danger ? 'danger' : 'primary', run: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

// Selettore a "chip" (gruppo di opzioni): ritorna l'elemento; onChange(valore)
export function chipGroup(options, value, onChange, { multi = false, small = false } = {}) {
  const g = el(`<div class="chips ${small ? 'small' : ''}" role="group"></div>`);
  const vals = new Set(multi ? value || [] : [value]);
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    const b = el(`<button type="button" class="chip ${vals.has(opt.value) ? 'on' : ''}">${esc(opt.label)}</button>`);
    b.onclick = () => {
      if (multi) {
        vals.has(opt.value) ? vals.delete(opt.value) : vals.add(opt.value);
        b.classList.toggle('on');
        onChange(Array.from(vals));
      } else {
        const was = b.classList.contains('on');
        g.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
        if (!was) b.classList.add('on');
        onChange(was ? '' : opt.value);
      }
    };
    g.appendChild(b);
  }
  return g;
}
