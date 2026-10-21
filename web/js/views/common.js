// Componenti condivisi fra le viste: anagrafica, nuova visita, descrizione dei reperti.
import { esc, el, sheet, toast, ageFrom, patientName, fmtNum, fmtDateTime, fmtDur } from '../util.js';
import * as repo from '../store/repo.js';
import { icon } from '../ui/icons.js';
import { siteName } from '../sites.js';

// Iniziali del paziente nel cerchio dell'elenco.
export function avatarHtml(p) {
  return `<div class="avatar">${esc(((p && p.lastName) || '?')[0])}${esc(((p && p.firstName) || '')[0] || '')}</div>`;
}

// Ricerca per cognome, nome o codice.
export function patientMatches(p, query) {
  const q = query.trim().toLowerCase();
  return !q || patientName(p).toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q);
}

export function patientForm(p = {}) {
  const f = el(`<form class="col" autocomplete="off">
    <div class="form-grid">
      <label class="field"><span>Cognome *</span><input type="text" name="lastName" required value="${esc(p.lastName)}"></label>
      <label class="field"><span>Nome *</span><input type="text" name="firstName" required value="${esc(p.firstName)}"></label>
    </div>
    <div class="form-grid">
      <label class="field"><span>Data di nascita</span><input type="date" name="dob" value="${esc(p.dob)}"></label>
      <label class="field"><span>Sesso</span><select name="sex">
        ${['', 'M', 'F', 'Altro'].map((s) => `<option value="${s}" ${p.sex === s ? 'selected' : ''}>${s || '—'}</option>`).join('')}
      </select></label>
      <label class="field"><span>Codice / ID</span><input type="text" name="code" value="${esc(p.code)}"></label>
    </div>
    <label class="field"><span>Anamnesi / note (patologie note, terapie, soffi pregressi)</span><textarea name="notes">${esc(p.notes)}</textarea></label>
  </form>`);
  f.onsubmit = (e) => e.preventDefault();
  return {
    el: f,
    values() {
      const d = Object.fromEntries(new FormData(f).entries());
      for (const k of Object.keys(d)) d[k] = String(d[k]).trim();
      return d;
    },
  };
}

export function openPatientEditor(p = null) {
  return new Promise((resolve) => {
    const form = patientForm(p || {});
    let done = false;
    sheet({
      title: p ? 'Modifica paziente' : 'Nuovo paziente',
      body: form.el,
      actions: [
        { label: 'Annulla', kind: 'ghost' },
        {
          label: 'Salva', kind: 'primary',
          run: async () => {
            const v = form.values();
            if (!v.lastName || !v.firstName) { toast('Inserisci nome e cognome', { type: 'warn' }); return false; }
            const saved = await repo.savePatient({ ...(p || {}), ...v });
            done = true;
            resolve(saved);
          },
        },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    setTimeout(() => form.el.querySelector('input')?.focus(), 250);
  });
}

export async function createVisitFor(patientId) {
  const v = await repo.saveVisit({ patientId, date: Date.now() });
  location.hash = `#/visit/${v.id}`;
}

// Sceglie (o crea) un paziente e apre una nuova visita.
export async function startNewVisit() {
  const patients = await repo.listPatients();
  const body = el(`<div class="col">
    <button class="btn primary block" data-new>${icon('plus')} Nuovo paziente</button>
    <input type="search" placeholder="Cerca paziente…" data-q>
    <div class="list" data-list></div>
  </div>`);
  const list = body.querySelector('[data-list]');
  const render = (q = '') => {
    const items = patients.filter((p) => patientMatches(p, q));
    list.innerHTML = items.length ? items.slice(0, 50).map((p) => `<div class="list-item" data-id="${esc(p.id)}">
        ${avatarHtml(p)}
        <div class="grow"><b>${esc(patientName(p))}</b><div class="small muted">${ageFrom(p.dob) !== null ? `${ageFrom(p.dob)} anni · ` : ''}${esc(p.sex || '')} ${esc(p.code || '')}</div></div>
        ${icon('chevR')}</div>`).join('') : `<div class="empty">Nessun paziente in archivio</div>`;
  };
  render();
  const sh = sheet({ title: 'Nuova visita', body });
  body.querySelector('[data-q]').oninput = (e) => render(e.target.value);
  list.onclick = (e) => {
    const it = e.target.closest('[data-id]');
    if (!it) return;
    sh.close();
    createVisitFor(it.dataset.id);
  };
  body.querySelector('[data-new]').onclick = async () => {
    sh.close();
    const p = await openPatientEditor();
    if (p) createVisitFor(p.id);
  };
}

// ---------- Descrizione testuale delle analisi automatiche ----------
const n0 = (v) => fmtNum(v, 0);

export function heartSummaryLines(h) {
  if (!h) return [];
  const out = [];
  if (h.bpm) out.push(`FC ${n0(h.bpm)} bpm · ritmo ${String(h.rhythm || '—').toLowerCase()}`);
  if (h.sysMs && h.diaMs) out.push(`Sistole ${n0(h.sysMs)} ms · diastole ${n0(h.diaMs)} ms`);
  if (h.s1s2) out.push(`Rapporto S1/S2 ${fmtNum(h.s1s2, 2)}`);
  if (h.splitPct > 30 && h.splitMs) out.push(`Sdoppiamento S2 ${n0(h.splitMs)} ms nel ${n0(h.splitPct)}% dei battiti${h.splitPattern ? ` (${h.splitPattern})` : ''}`);
  if (h.s3Pct >= 30) out.push(`Possibile S3 (${n0(h.s3Pct)}% dei cicli)`);
  if (h.s4Pct >= 30) out.push(`Possibile S4 (${n0(h.s4Pct)}% dei cicli)`);
  if (h.clickCount >= 3) out.push(`Click sistolici (${h.clickCount})`);
  if (h.snapCount >= 3) out.push(`Tono protodiastolico precoce (schiocco?) (${h.snapCount})`);
  if (h.murmurSys) out.push(`Sospetto soffio sistolico ${h.murmurIntensity || ''}${h.murmurSysShape ? ` · ${h.murmurSysShape}` : ''}${h.murmurPitchHz ? ` · ~${n0(h.murmurPitchHz)} Hz` : ''}`);
  if (h.murmurDia) out.push(`Sospetto soffio diastolico${h.murmurDiaShape ? ` · ${h.murmurDiaShape}` : ''}`);
  return out;
}

export function lungSummaryLines(l) {
  if (!l) return [];
  const out = [];
  if (l.rr) out.push(`FR ${fmtNum(l.rr, 0)} atti/min${l.ieRatio ? ` · I:E ≈ 1:${fmtNum(l.ieRatio, 1)}` : ''}`);
  if (l.cracklesSignificant) out.push(`Crepitii: ${fmtNum(l.cracklesPerBreath, 1)}/respiro (fini ${l.cracklesFine}, grossolani ${l.cracklesCoarse})${l.cracklesInspPct !== null ? ` · ${n0(l.cracklesInspPct)}% inspiratori` : ''}`);
  if (l.wheezes) out.push(`Sibili: ${l.wheezes} (${n0(l.wheezeFreq)} Hz, ${n0(l.wheezeDurPct)}% del tempo)${l.polyphonic ? ' · polifonici' : ''}`);
  if (l.rhonchi) out.push(`Ronchi: ${l.rhonchi}`);
  if (l.toneHz) out.push(`Interferenza tonale a ${l.toneHz} Hz (rete elettrica/ambiente?)`);
  return out;
}

export function isHeartAbnormal(h) {
  return !!h && (h.murmurSys || h.murmurDia || h.s3Pct >= 30 || h.s4Pct >= 30 || h.rhythm === 'Irregolare');
}
export function isLungAbnormal(l) {
  return !!l && (l.cracklesSignificant || l.wheezes > 0 || l.rhonchi > 0);
}

// Avvisi sull'ingresso con cui è stata fatta una registrazione.
export function inputBadges(rec) {
  const i = rec.input;
  if (!i) return '';
  const out = [];
  if (i.type === 'bluetooth') out.push('<span class="badge warn" title="Il Bluetooth riduce banda e qualità">Qualità limitata · Bluetooth</span>');
  else if (i.rate && i.rate < 16000) out.push(`<span class="badge warn">Qualità limitata · ${i.rate} Hz</span>`);
  if (i.processing && i.processing.length) out.push('<span class="badge warn" title="Il sistema dichiarava attive elaborazioni del microfono (riduzione rumore, volume automatico o eco)">Elaborata dal sistema</span>');
  if (i.type === 'builtin') out.push('<span class="badge">Microfono del telefono</span>');
  return out.join(' ');
}

export function qualityBadge(sqi) {
  if (sqi === null || sqi === undefined) return '';
  const cls = sqi >= 70 ? 'ok' : sqi >= 40 ? 'warn' : 'bad';
  const lab = sqi >= 70 ? 'buona' : sqi >= 40 ? 'discreta' : 'scarsa';
  return `<span class="badge ${cls}" title="Qualità del segnale (SQI)">Qualità ${lab} · ${sqi}</span>`;
}

export function recordingRow(r) {
  const a = r.analysis || {};
  const sum = r.kind === 'lung' ? lungSummaryLines(a.lung)[0] || heartSummaryLines(a.heart)[0] : heartSummaryLines(a.heart)[0];
  const abn = r.kind === 'lung' ? isLungAbnormal(a.lung) : isHeartAbnormal(a.heart);
  return `<a class="list-item" href="#/rec/${esc(r.id)}">
    <div class="avatar" style="background:${r.kind === 'lung' ? 'color-mix(in srgb, var(--s2) 25%, var(--card2))' : 'color-mix(in srgb, var(--s1) 25%, var(--card2))'}">${icon(r.kind === 'lung' ? 'lungs' : 'heart')}</div>
    <div class="grow"><b>${esc(r.label || siteName(r.site))}</b> ${abn ? '<span class="badge warn">da rivedere</span>' : ''}
      <div class="small muted">${fmtDateTime(r.createdAt)} · ${fmtDur(r.duration)}${sum ? ` · ${esc(sum)}` : ''}</div></div>
    ${icon('chevR')}</a>`;
}

// Precompila i reperti della visita dai risultati automatici (il medico conferma).
const SHAPE_MAP = {
  'Crescendo-decrescendo (eiettivo)': 'crescendo-decrescendo', 'Olosistolico (plateau)': 'olosistolico',
  'Decrescendo (protosistolico)': 'decrescendo', 'Crescendo (telesistolico)': 'crescendo',
  'Protodiastolico decrescente': 'decrescendo', 'Mesodiastolico (rullio)': 'mesodiastolico',
  'Presistolico (crescente)': 'presistolico', 'Olodiastolico': 'decrescendo',
};

export function heartFindingsFromAuto(h) {
  const f = {};
  if (!h) return f;
  const extra = [];
  if (h.s3Pct >= 30) extra.push('S3');
  if (h.s4Pct >= 30) extra.push('S4');
  if (h.clickCount >= 3) extra.push('click');
  if (h.snapCount >= 3) extra.push("schiocco d'apertura");
  f.extra = extra;
  if (h.splitPct > 50) f.s2 = h.splitPattern && h.splitPattern.startsWith('costante') ? 'sdoppiamento fisso' : 'sdoppiamento fisiologico';
  if (h.murmurSys || h.murmurDia) {
    f.murmur = h.murmurSys && h.murmurDia ? 'sisto-diastolico' : h.murmurSys ? 'sistolico' : 'diastolico';
    const shape = h.murmurSys ? h.murmurSysShape : h.murmurDiaShape;
    if (shape && SHAPE_MAP[shape]) f.shape = SHAPE_MAP[shape];
    if (h.murmurPitchHz) f.pitch = h.murmurPitchHz < 150 ? 'bassa' : h.murmurPitchHz > 280 ? 'alta' : 'media';
  } else f.murmur = 'assente';
  return f;
}

export function lungFindingsFromAuto(l) {
  const f = {};
  if (!l) return f;
  f.crackles = l.cracklesSignificant ? (l.cracklesCoarse > l.cracklesFine ? 'grossolani' : 'fini') : 'assenti';
  if (l.cracklesSignificant && l.cracklesInspPct !== null) f.cracklesPhase = l.cracklesInspPct > 66 ? 'inspiratori' : l.cracklesInspPct < 33 ? 'espiratori' : 'inspiro-espiratori';
  const adv = [];
  if (l.wheezes > 0) adv.push('sibili');
  if (l.rhonchi > 0) adv.push('ronchi');
  f.adv = adv;
  return f;
}

export function heartFindingAbnormal(f) {
  if (!f) return false;
  return (f.murmur && f.murmur !== 'assente') || (f.extra && f.extra.length) || (f.s1 && f.s1 !== 'normale') || (f.s2 && f.s2 !== 'normale' && f.s2 !== 'sdoppiamento fisiologico');
}

export function lungFindingAbnormal(f) {
  if (!f) return false;
  return (f.mv && f.mv !== 'normale') || (f.crackles && f.crackles !== 'assenti') || (f.adv && f.adv.length);
}

export function heartFindingText(f) {
  if (!f) return '';
  const p = [];
  if (f.s1) p.push(`S1 ${f.s1}`);
  if (f.s2) p.push(`S2 ${f.s2}`);
  if (f.extra && f.extra.length) p.push(f.extra.join(', '));
  if (f.murmur === 'assente') p.push('nessun soffio');
  else if (f.murmur) p.push(`soffio ${f.murmur}${f.grade ? ` ${f.grade}` : ''}${f.shape ? `, ${f.shape}` : ''}${f.pitch ? `, tonalità ${f.pitch}` : ''}${f.quality ? `, ${f.quality}` : ''}${f.radiation && f.radiation.length ? `, irradiato a ${f.radiation.join(', ')}` : ''}`);
  if (f.notes) p.push(f.notes);
  return p.join('; ');
}

export function lungFindingText(f) {
  if (!f) return '';
  const p = [];
  if (f.mv) p.push(`MV ${f.mv}`);
  if (f.crackles && f.crackles !== 'assenti') p.push(`crepitii ${f.crackles}${f.cracklesPhase ? ` ${f.cracklesPhase}` : ''}`);
  else if (f.crackles) p.push('no crepitii');
  if (f.adv && f.adv.length) p.push(f.adv.join(', '));
  if (f.notes) p.push(f.notes);
  return p.join('; ');
}
