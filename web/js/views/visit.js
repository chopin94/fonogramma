// Visita medica: anamnesi e parametri, esame cardiaco per focolaio, esame toracico
// per punto, confronto fra focolai e simmetria dx/sx, conclusioni.
import { esc, el, toast, confirmDialog, fmtNum, fmtDateTime, fmtDur, patientName, ageFrom, debounce, chipGroup } from '../util.js';
import * as repo from '../store/repo.js';
import { HEART_SITES, LUNG_SITES, LUNG_PAIRS, siteById } from '../sites.js';
import { bodyMapSvg, bindBodyMap } from '../ui/bodymap.js';
import { icon } from '../ui/icons.js';
import {
  heartSummaryLines, lungSummaryLines, heartFindingsFromAuto, lungFindingsFromAuto, heartFindingAbnormal, lungFindingAbnormal,
  heartFindingText, lungFindingText, isHeartAbnormal, isLungAbnormal, qualityBadge, openPatientEditor,
} from './common.js';

const HEART_FIELDS = [
  { k: 's1', label: 'S1', opts: ['normale', 'aumentato', 'ridotto', 'variabile'] },
  { k: 's2', label: 'S2', opts: ['normale', 'aumentato', 'ridotto', 'sdoppiamento fisiologico', 'sdoppiamento fisso', 'sdoppiamento paradosso'] },
  { k: 'extra', label: 'Toni aggiunti', opts: ['S3', 'S4', 'click', "schiocco d'apertura", 'sfregamento'], multi: true },
  { k: 'murmur', label: 'Soffio', opts: ['assente', 'sistolico', 'diastolico', 'sisto-diastolico', 'continuo'] },
  { k: 'grade', label: 'Intensità (Levine)', opts: ['1/6', '2/6', '3/6', '4/6', '5/6', '6/6'], when: (f) => f.murmur && f.murmur !== 'assente' },
  { k: 'shape', label: 'Forma', opts: ['crescendo-decrescendo', 'olosistolico', 'decrescendo', 'crescendo', 'mesodiastolico', 'presistolico'], when: (f) => f.murmur && f.murmur !== 'assente' },
  { k: 'pitch', label: 'Tonalità', opts: ['bassa', 'media', 'alta'], when: (f) => f.murmur && f.murmur !== 'assente' },
  { k: 'quality', label: 'Timbro', opts: ['aspro', 'soffiante', 'musicale', 'rullante'], when: (f) => f.murmur && f.murmur !== 'assente' },
  { k: 'radiation', label: 'Irradiazione', opts: ['carotidi', 'ascella', 'dorso', 'margine sternale', 'punta'], multi: true, when: (f) => f.murmur && f.murmur !== 'assente' },
];

const LUNG_FIELDS = [
  { k: 'mv', label: 'Murmure vescicolare', opts: ['normale', 'ridotto', 'assente', 'aspro', 'respiro bronchiale'] },
  { k: 'crackles', label: 'Crepitii', opts: ['assenti', 'fini', 'grossolani'] },
  { k: 'cracklesPhase', label: 'Fase dei crepitii', opts: ['inspiratori', 'espiratori', 'inspiro-espiratori'], when: (f) => f.crackles && f.crackles !== 'assenti' },
  { k: 'adv', label: 'Altri rumori', opts: ['sibili', 'ronchi', 'sfregamento pleurico', 'stridore'], multi: true },
];

export async function mount(view, [id], query) {
  let visit = await repo.getVisit(id);
  if (!visit) { view.innerHTML = `<div class="page"><div class="empty">Visita non trovata.</div></div>`; return; }
  let patient = await repo.getPatient(visit.patientId);
  let tab = query.tab || 'anamnesi';
  let lungSide = 'front';
  let recs = [];

  const save = debounce(async () => { visit = await repo.saveVisit(visit); }, 600);

  view.innerHTML = `<div class="page">
    <div class="row between" style="align-items:flex-start">
      <div class="grow" data-head></div>
      <div class="row">
        <a class="btn" href="#/report/${esc(visit.id)}">${icon('printer', 'sm')} Referto</a>
        <button class="btn" data-status></button>
        <button class="icon-btn" data-del title="Elimina visita">${icon('trash')}</button>
      </div>
    </div>
    <div class="tabs" data-tabs>
      <button data-t="anamnesi">${icon('clipboard', 'sm')} Anamnesi</button>
      <button data-t="heart">${icon('heart', 'sm')} Cuore</button>
      <button data-t="lung">${icon('lungs', 'sm')} Torace</button>
      <button data-t="conclusioni">${icon('flag', 'sm')} Conclusioni</button>
    </div>
    <div data-body></div>
  </div>`;
  const q = (s) => view.querySelector(s);

  function renderHead() {
    const age = ageFrom(patient && patient.dob);
    q('[data-head]').innerHTML = `<div class="small muted"><a href="#/patient/${esc(visit.patientId)}">${icon('chevL', 'sm')} Scheda paziente</a></div>
      <h1>${esc(patientName(patient))}</h1>
      <div class="small muted">${age !== null ? `${age} anni · ` : ''}${esc((patient && patient.sex) || '')} · visita del ${fmtDateTime(visit.date)}</div>`;
    q('[data-status]').innerHTML = visit.status === 'chiusa' ? `${icon('refresh', 'sm')} Riapri` : `${icon('check', 'sm')} Chiudi visita`;
  }

  // ---------- reperti ----------
  function findingsEditor(fields, value, onChange) {
    const box = el(`<div></div>`);
    const render = () => {
      box.innerHTML = '';
      for (const f of fields) {
        if (f.when && !f.when(value)) continue;
        const row = el(`<div class="finding"><span>${esc(f.label)}</span></div>`);
        row.appendChild(chipGroup(f.opts, value[f.k], (v) => {
          value[f.k] = v;
          onChange(value);
          if (f.k === 'murmur' || f.k === 'crackles') render();
        }, { multi: !!f.multi, small: true }));
        box.appendChild(row);
      }
      const notes = el(`<div class="finding"><span>Note</span><input type="text" value="${esc(value.notes || '')}" placeholder="Annotazioni…"></div>`);
      notes.querySelector('input').oninput = (e) => { value.notes = e.target.value; onChange(value); };
      box.appendChild(notes);
    };
    render();
    box.rerender = render;
    return box;
  }

  const recsAt = (siteId) => recs.filter((r) => r.site === siteId);
  const lastAnalysis = (siteId) => {
    const r = recsAt(siteId).find((x) => x.analysis);
    return r ? r.analysis : null;
  };

  function siteStatus(kind) {
    const st = {};
    for (const s of kind === 'heart' ? HEART_SITES : LUNG_SITES) {
      const f = (visit[kind] || {})[s.id];
      const a = lastAnalysis(s.id);
      const abn = kind === 'heart' ? heartFindingAbnormal(f) || (a && isHeartAbnormal(a.heart)) : lungFindingAbnormal(f) || (a && isLungAbnormal(a.lung));
      if (abn) st[s.id] = 'abn';
      else if (recsAt(s.id).length || (f && Object.keys(f).length)) st[s.id] = 'done';
    }
    return st;
  }

  function siteCard(s, kind) {
    const fieldsDef = kind === 'heart' ? HEART_FIELDS : LUNG_FIELDS;
    visit[kind] = visit[kind] || {};
    const value = visit[kind][s.id] || {};
    const status = siteStatus(kind)[s.id] || '';
    const a = lastAnalysis(s.id);
    const lines = a ? (kind === 'heart' ? heartSummaryLines(a.heart) : lungSummaryLines(a.lung)) : [];
    const sqi = a ? (kind === 'heart' ? a.heart && a.heart.sqi : a.lung && a.lung.sqi) : null;
    const c = el(`<div class="card site-card" id="site-${s.id}">
      <div class="head"><div class="site-num ${status}">${s.n}</div>
        <div class="grow"><b>${esc(s.full)}</b>${s.optional ? ' <span class="badge">facoltativo</span>' : ''}<div class="small muted">${esc(s.where)} · ${esc(s.piece)}</div></div>
        <a class="btn sm primary" href="#/live?mode=${kind}&site=${s.id}&visit=${esc(visit.id)}">${icon('stetho', 'sm')} Ausculta</a></div>
      <div class="row" style="gap:6px">${recsAt(s.id).map((r) => `<a class="rec-chip" href="#/rec/${esc(r.id)}">${icon('play', 'sm')} ${fmtDur(r.duration)}${r.abnormal ? ' ⚠' : ''}</a>`).join('') || '<span class="small muted">Nessuna registrazione</span>'}</div>
      ${a ? `<div class="auto-box"><div class="row between"><b class="small">${icon('wand', 'sm')} Analisi automatica</b>${qualityBadge(sqi)}</div>
        ${lines.length ? `<ul class="small" style="margin:4px 0 0;padding-left:1.1rem">${lines.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="small muted">Nessun reperto anomalo rilevato</div>'}
        <button class="btn sm" style="margin-top:6px" data-auto>${icon('wand', 'sm')} Compila i reperti dall'analisi</button></div>` : ''}
    </div>`);
    const ed = findingsEditor(fieldsDef, value, (v) => { visit[kind][s.id] = v; save(); updateNum(); });
    c.appendChild(ed);
    const updateNum = () => {
      const st = siteStatus(kind)[s.id] || '';
      c.querySelector('.site-num').className = `site-num ${st}`;
    };
    const ab = c.querySelector('[data-auto]');
    if (ab) ab.onclick = () => {
      const auto = kind === 'heart' ? heartFindingsFromAuto(a.heart) : lungFindingsFromAuto(a.lung);
      Object.assign(value, auto);
      visit[kind][s.id] = value;
      ed.rerender();
      save();
      updateNum();
      toast('Reperti precompilati: verifica e correggi se necessario');
    };
    return c;
  }

  // ---------- confronti ----------
  function heartComparison() {
    const rows = HEART_SITES.map((s) => ({ s, h: (lastAnalysis(s.id) || {}).heart })).filter((r) => r.h);
    if (rows.length < 2) return '';
    const maxSys = rows.reduce((m, r) => (r.h.murmurSys && (!m || r.h.sysIdx > m.h.sysIdx) ? r : m), null);
    const maxDia = rows.reduce((m, r) => (r.h.murmurDia && (!m || r.h.diaIdx > m.h.diaIdx) ? r : m), null);
    return `<div class="card" style="margin-top:12px"><b>${icon('layers', 'sm')} Confronto fra focolai</b>
      <div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr><th>Focolaio</th><th>FC</th><th>S1/S2</th><th>Sdopp. S2</th><th>S3/S4</th><th>Ind. sist.</th><th>Ind. diast.</th><th>Qualità</th></tr></thead><tbody>
      ${rows.map(({ s, h }) => `<tr><td>${s.n}. ${esc(s.name)}</td><td>${fmtNum(h.bpm)}</td><td>${fmtNum(h.s1s2, 2)}</td><td>${h.splitMs ? `${fmtNum(h.splitMs)} ms (${fmtNum(h.splitPct)}%)` : '—'}</td><td>${h.s3Count || 0}/${h.s4Count || 0}</td><td>${fmtNum(h.sysIdx, 2)}${h.murmurSys ? ' ⚠' : ''}</td><td>${fmtNum(h.diaIdx, 2)}${h.murmurDia ? ' ⚠' : ''}</td><td>${h.sqi ?? '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <ul class="small" style="margin:8px 0 0;padding-left:1.1rem">
        <li>Normalmente S1 prevale alla punta e al tricuspidale (S1/S2 &gt; 1), S2 alla base (aortico, polmonare: S1/S2 &lt; 1).</li>
        ${maxSys ? `<li><b>Punto di massima intensità del soffio sistolico: ${esc(maxSys.s.full)}</b>${maxSys.h.murmurSysShape ? ` (${esc(maxSys.h.murmurSysShape)})` : ''}.</li>` : ''}
        ${maxDia ? `<li><b>Punto di massima intensità del soffio diastolico: ${esc(maxDia.s.full)}</b>.</li>` : ''}
      </ul></div>`;
  }

  function lungComparison() {
    const out = [];
    for (const [dx, sx] of LUNG_PAIRS) {
      const a = (lastAnalysis(dx) || {}).lung, b = (lastAnalysis(sx) || {}).lung;
      if (!a || !b) continue;
      const diff = (a.intensityDb ?? 0) - (b.intensityDb ?? 0);
      out.push({ dx: siteById(dx), sx: siteById(sx), a, b, diff });
    }
    if (!out.length) return '';
    return `<div class="card" style="margin-top:12px"><b>${icon('layers', 'sm')} Simmetria destra / sinistra</b>
      <div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr><th>Livello</th><th>Murmure dx − sx</th><th>Crepitii/resp. dx · sx</th><th>Sibili dx · sx</th></tr></thead><tbody>
      ${out.map((r) => `<tr><td>${esc(r.dx.name.replace(' dx', ''))}</td><td>${r.diff > 0 ? '+' : ''}${fmtNum(r.diff, 1)} dB${Math.abs(r.diff) >= 6 ? ` ⚠ ridotto a ${r.diff > 0 ? 'sinistra' : 'destra'}` : ''}</td><td>${fmtNum(r.a.cracklesPerBreath, 1)} · ${fmtNum(r.b.cracklesPerBreath, 1)}</td><td>${r.a.wheezes || 0} · ${r.b.wheezes || 0}</td></tr>`).join('')}
      </tbody></table></div><div class="tiny muted" style="margin-top:6px">Confronto valido se registrato con lo stesso guadagno e lo stesso appoggio. Differenze ≥ 6 dB suggeriscono un murmure ridotto dal lato più debole.</div></div>`;
  }

  // ---------- schede ----------
  function renderAnamnesi(body) {
    const v = visit.vitals || (visit.vitals = {});
    body.innerHTML = `<div class="grid two">
      <div class="card col">
        <b>Motivo e anamnesi</b>
        <label class="field"><span>Motivo della visita</span><input type="text" data-f="reason" value="${esc(visit.reason)}"></label>
        <label class="field"><span>Sintomi / anamnesi recente</span><textarea data-f="history">${esc(visit.history)}</textarea></label>
        <label class="field"><span>Terapia in atto</span><textarea data-f="therapy" style="min-height:60px">${esc(visit.therapy)}</textarea></label>
        <div class="small muted">Anamnesi remota del paziente: ${esc((patient && patient.notes) || '—')} <a href="#" data-editp>modifica</a></div>
      </div>
      <div class="card col">
        <b>Parametri vitali</b>
        <div class="form-grid">
          <label class="field"><span>PA sistolica (mmHg)</span><input type="number" data-v="paS" value="${esc(v.paS)}"></label>
          <label class="field"><span>PA diastolica (mmHg)</span><input type="number" data-v="paD" value="${esc(v.paD)}"></label>
          <label class="field"><span>FC (bpm)</span><input type="number" data-v="fc" value="${esc(v.fc)}"></label>
          <label class="field"><span>SpO₂ (%)</span><input type="number" data-v="spo2" value="${esc(v.spo2)}"></label>
          <label class="field"><span>FR (atti/min)</span><input type="number" data-v="fr" value="${esc(v.fr)}"></label>
          <label class="field"><span>Temperatura (°C)</span><input type="number" step="0.1" data-v="temp" value="${esc(v.temp)}"></label>
          <label class="field"><span>Peso (kg)</span><input type="number" step="0.1" data-v="peso" value="${esc(v.peso)}"></label>
          <label class="field"><span>Altezza (cm)</span><input type="number" data-v="altezza" value="${esc(v.altezza)}"></label>
        </div>
        <div class="small muted" data-bmi></div>
      </div>
    </div>
    <div class="grid two" style="margin-top:12px">
      <a class="action-tile" href="#/visit/${esc(visit.id)}?tab=heart">${icon('heart')}<div><b>Esame cardiaco</b><span class="small muted">4 focolai + punto di Erb</span></div></a>
      <a class="action-tile" href="#/visit/${esc(visit.id)}?tab=lung">${icon('lungs')}<div><b>Esame toracico</b><span class="small muted">12 punti, anteriori e posteriori</span></div></a>
    </div>`;
    const bmi = () => {
      const p = parseFloat(v.peso), h = parseFloat(v.altezza) / 100;
      body.querySelector('[data-bmi]').textContent = p && h ? `BMI ${fmtNum(p / (h * h), 1)}` : '';
    };
    bmi();
    body.querySelectorAll('[data-f]').forEach((i) => { i.oninput = () => { visit[i.dataset.f] = i.value; save(); }; });
    body.querySelectorAll('[data-v]').forEach((i) => { i.oninput = () => { v[i.dataset.v] = i.value; bmi(); save(); }; });
    body.querySelector('[data-editp]').onclick = async (e) => {
      e.preventDefault();
      const p = await openPatientEditor(patient);
      if (p) { patient = p; renderHead(); renderTab(); }
    };
  }

  function renderHeart(body) {
    body.innerHTML = `<div class="map-layout">
      <div class="sticky col">
        <div class="card" style="padding:8px" data-map></div>
        <a class="btn primary block" href="#/live?mode=heart&site=${HEART_SITES[0].id}&visit=${esc(visit.id)}">${icon('list', 'sm')} Esame guidato dei focolai</a>
        <div class="tiny muted">Tocca un focolaio per andare alla sua scheda. Verde = esaminato, giallo = reperto da rivedere.</div>
      </div>
      <div class="col" data-cards></div>
    </div><div data-cmp></div>`;
    body.querySelector('[data-map]').innerHTML = bodyMapSvg({ view: 'front', sites: HEART_SITES, status: siteStatus('heart') });
    bindBodyMap(body.querySelector('[data-map]'), (sid) => document.getElementById(`site-${sid}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    const cards = body.querySelector('[data-cards]');
    for (const s of HEART_SITES) cards.appendChild(siteCard(s, 'heart'));
    body.querySelector('[data-cmp]').innerHTML = heartComparison();
  }

  function renderLung(body) {
    body.innerHTML = `<div class="map-layout">
      <div class="sticky col">
        <div class="card" style="padding:8px">
          <div class="seg" data-side style="margin-bottom:6px"><button data-v="front">Anteriore</button><button data-v="back">Posteriore</button></div>
          <div data-map></div>
        </div>
        <a class="btn primary block" href="#/live?mode=lung&site=${LUNG_SITES[0].id}&visit=${esc(visit.id)}">${icon('list', 'sm')} Esame guidato del torace</a>
      </div>
      <div class="col" data-cards></div>
    </div><div data-cmp></div>`;
    const drawMap = () => {
      body.querySelector('[data-map]').innerHTML = bodyMapSvg({ view: lungSide, sites: LUNG_SITES, status: siteStatus('lung') });
      body.querySelectorAll('[data-side] button').forEach((b) => b.classList.toggle('on', b.dataset.v === lungSide));
    };
    drawMap();
    body.querySelectorAll('[data-side] button').forEach((b) => { b.onclick = () => { lungSide = b.dataset.v; drawMap(); }; });
    bindBodyMap(body.querySelector('[data-map]'), (sid) => document.getElementById(`site-${sid}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    const cards = body.querySelector('[data-cards]');
    for (const s of LUNG_SITES) cards.appendChild(siteCard(s, 'lung'));
    body.querySelector('[data-cmp]').innerHTML = lungComparison();
  }

  function renderConclusioni(body) {
    const hLines = HEART_SITES.map((s) => ({ s, t: heartFindingText((visit.heart || {})[s.id]) })).filter((x) => x.t);
    const lLines = LUNG_SITES.map((s) => ({ s, t: lungFindingText((visit.lung || {})[s.id]) })).filter((x) => x.t);
    body.innerHTML = `<div class="grid two">
      <div class="card col"><b>${icon('heart', 'sm')} Reperti cardiaci</b>
        ${hLines.length ? `<ul class="small" style="margin:0;padding-left:1.1rem">${hLines.map((x) => `<li><b>${esc(x.s.name)}:</b> ${esc(x.t)}</li>`).join('')}</ul>` : '<div class="small muted">Nessun reperto inserito.</div>'}
        <b style="margin-top:8px">${icon('lungs', 'sm')} Reperti toracici</b>
        ${lLines.length ? `<ul class="small" style="margin:0;padding-left:1.1rem">${lLines.map((x) => `<li><b>${esc(x.s.name)}:</b> ${esc(x.t)}</li>`).join('')}</ul>` : '<div class="small muted">Nessun reperto inserito.</div>'}
      </div>
      <div class="card col">
        <label class="field"><span>Conclusioni / ipotesi diagnostiche</span><textarea data-f="conclusion" style="min-height:140px">${esc(visit.conclusion)}</textarea></label>
        <label class="field"><span>Indicazioni / approfondimenti</span><textarea data-f="plan">${esc(visit.plan)}</textarea></label>
        <a class="btn primary" href="#/report/${esc(visit.id)}">${icon('printer', 'sm')} Apri il referto stampabile</a>
      </div></div>`;
    body.querySelectorAll('[data-f]').forEach((i) => { i.oninput = () => { visit[i.dataset.f] = i.value; save(); }; });
  }

  async function renderTab() {
    recs = await repo.listRecordings({ visitId: visit.id });
    view.querySelectorAll('[data-tabs] button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    const body = q('[data-body]');
    if (tab === 'heart') renderHeart(body);
    else if (tab === 'lung') renderLung(body);
    else if (tab === 'conclusioni') renderConclusioni(body);
    else renderAnamnesi(body);
  }

  view.querySelectorAll('[data-tabs] button').forEach((b) => {
    b.onclick = () => { tab = b.dataset.t; history.replaceState(null, '', `#/visit/${visit.id}?tab=${tab}`); renderTab(); };
  });
  q('[data-status]').onclick = async () => {
    visit.status = visit.status === 'chiusa' ? 'aperta' : 'chiusa';
    visit = await repo.saveVisit(visit);
    renderHead();
    toast(visit.status === 'chiusa' ? 'Visita chiusa' : 'Visita riaperta');
  };
  q('[data-del]').onclick = async () => {
    if (await confirmDialog('Eliminare la visita e tutte le sue registrazioni?', { danger: true, okText: 'Elimina' })) {
      await repo.deleteVisit(visit.id);
      location.hash = `#/patient/${visit.patientId}`;
    }
  };

  renderHead();
  await renderTab();
  const off = repo.onDataChange(async (kind) => {
    if (kind === 'recordings' || kind === 'sync') {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      const fresh = await repo.getVisit(visit.id);
      if (fresh) visit = fresh;
      const y = view.parentElement ? view.scrollTop : 0;
      await renderTab();
      view.scrollTop = y;
    }
  });
  return () => { off(); };
}
