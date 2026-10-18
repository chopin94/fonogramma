// Referto stampabile (Stampa → Salva come PDF) della visita.
import { esc, fmtDate, fmtDateTime, fmtNum, patientName, ageFrom } from '../util.js';
import * as repo from '../store/repo.js';
import { HEART_SITES, LUNG_SITES } from '../sites.js';
import { icon } from '../ui/icons.js';
import { loadRecordingAudio } from '../store/audio.js';
import { analyzeSamples } from '../audio/analyzer.js';
import { renderThumb } from '../ui/charts.js';
import { settings } from '../settings.js';
import { heartSummaryLines, lungSummaryLines, heartFindingText, lungFindingText } from './common.js';

export async function mount(view, [id]) {
  const visit = await repo.getVisit(id);
  if (!visit) { view.innerHTML = `<div class="page"><div class="empty">Visita non trovata.</div></div>`; return; }
  const patient = await repo.getPatient(visit.patientId);
  const recs = await repo.listRecordings({ visitId: id });
  const latest = (siteId) => recs.find((r) => r.site === siteId && r.analysis);
  const v = visit.vitals || {};
  const age = ageFrom(patient && patient.dob);
  const vit = [
    v.paS && v.paD ? `PA ${esc(v.paS)}/${esc(v.paD)} mmHg` : '', v.fc ? `FC ${esc(v.fc)} bpm` : '', v.spo2 ? `SpO₂ ${esc(v.spo2)}%` : '',
    v.fr ? `FR ${esc(v.fr)} atti/min` : '', v.temp ? `T ${esc(v.temp)} °C` : '', v.peso ? `Peso ${esc(v.peso)} kg` : '', v.altezza ? `Altezza ${esc(v.altezza)} cm` : '',
  ].filter(Boolean).join(' · ');

  const heartRows = HEART_SITES.map((s) => {
    const f = heartFindingText((visit.heart || {})[s.id]);
    const r = latest(s.id);
    const a = r ? heartSummaryLines(r.analysis.heart).join('; ') : '';
    return f || a ? `<tr><td><b>${esc(s.full)}</b><br><span style="color:#64748b">${esc(s.where)}</span></td><td>${esc(f) || '—'}</td><td>${esc(a) || '—'}</td></tr>` : '';
  }).join('');
  const lungRows = LUNG_SITES.map((s) => {
    const f = lungFindingText((visit.lung || {})[s.id]);
    const r = latest(s.id);
    const a = r ? lungSummaryLines(r.analysis.lung).join('; ') : '';
    return f || a ? `<tr><td><b>${esc(s.full)}</b></td><td>${esc(f) || '—'}</td><td>${esc(a) || '—'}</td></tr>` : '';
  }).join('');

  view.innerHTML = `<div class="page">
    <div class="row no-print" style="margin-bottom:12px">
      <a class="btn" href="#/visit/${esc(id)}">${icon('chevL', 'sm')} Visita</a>
      <button class="btn primary" data-print>${icon('printer', 'sm')} Stampa / Salva PDF</button>
      <label class="check small"><input type="checkbox" data-thumbs checked> Includi tracciati</label>
      <span class="small muted" data-prog></span>
    </div>
    <div class="report">
      <h1>Referto di auscultazione digitale</h1>
      <table><tbody>
        <tr><th style="width:28%">Paziente</th><td>${esc(patientName(patient))}${patient && patient.code ? ` · ${esc(patient.code)}` : ''}</td></tr>
        <tr><th>Data di nascita / età</th><td>${patient && patient.dob ? `${fmtDate(patient.dob)} (${age} anni)` : '—'} ${patient && patient.sex ? `· ${esc(patient.sex)}` : ''}</td></tr>
        <tr><th>Data della visita</th><td>${fmtDateTime(visit.date)}</td></tr>
        ${visit.reason ? `<tr><th>Motivo</th><td>${esc(visit.reason)}</td></tr>` : ''}
        ${vit ? `<tr><th>Parametri vitali</th><td>${vit}</td></tr>` : ''}
        ${visit.history ? `<tr><th>Anamnesi</th><td>${esc(visit.history)}</td></tr>` : ''}
        ${patient && patient.notes ? `<tr><th>Anamnesi remota</th><td>${esc(patient.notes)}</td></tr>` : ''}
        ${visit.therapy ? `<tr><th>Terapia</th><td>${esc(visit.therapy)}</td></tr>` : ''}
      </tbody></table>
      ${heartRows ? `<h2>Esame obiettivo cardiaco</h2><table><thead><tr><th style="width:24%">Focolaio</th><th>Reperti del medico</th><th style="width:36%">Analisi fonocardiografica automatica</th></tr></thead><tbody>${heartRows}</tbody></table>` : ''}
      ${lungRows ? `<h2>Esame obiettivo del torace</h2><table><thead><tr><th style="width:24%">Punto</th><th>Reperti del medico</th><th style="width:36%">Analisi automatica</th></tr></thead><tbody>${lungRows}</tbody></table>` : ''}
      <div data-thumbsbox></div>
      ${visit.conclusion ? `<h2>Conclusioni</h2><p>${esc(visit.conclusion).replace(/\n/g, '<br>')}</p>` : ''}
      ${visit.plan ? `<h2>Indicazioni</h2><p>${esc(visit.plan).replace(/\n/g, '<br>')}</p>` : ''}
      <p style="margin-top:28px">Firma del medico: ______________________________</p>
      <p class="disclaimer">Registrazioni acquisite con fonendoscopio elettronico e analizzate con Fonogramma. Le analisi automatiche (frequenza, intervalli, toni aggiunti, indici di soffio, crepitii e sibili) sono di supporto e non sostituiscono la valutazione clinica.</p>
    </div>
  </div>`;

  view.querySelector('[data-print]').onclick = () => window.print();
  const box = view.querySelector('[data-thumbsbox]');
  const prog = view.querySelector('[data-prog]');
  view.querySelector('[data-thumbs]').onchange = (e) => box.classList.toggle('no-print', !e.target.checked);

  let alive = true;
  const chosen = [...HEART_SITES, ...LUNG_SITES].map((s) => recs.find((r) => r.site === s.id)).filter(Boolean).slice(0, 10);
  if (chosen.length) {
    box.innerHTML = `<h2>Tracciati (primi 8 s · fonocardiogramma e spettrogramma)</h2><div class="thumbs" data-grid></div>`;
    const grid = box.querySelector('[data-grid]');
    for (let i = 0; i < chosen.length && alive; i++) {
      const r = chosen[i];
      prog.textContent = `Preparazione tracciati ${i + 1}/${chosen.length}…`;
      try {
        const audio = await loadRecordingAudio(r);
        const res = await analyzeSamples(audio.samples, audio.sampleRate, r.kind);
        if (!alive) break;
        const h = res.heart;
        const url = renderThumb({ overview: res.overview, spec: res.spec, markers: r.kind === 'lung' ? null : { s1: h.s1, s2: h.s2, s3: h.s3, s4: h.s4, clicks: h.clicks, snaps: h.snaps }, lutName: settings.colormap });
        grid.insertAdjacentHTML('beforeend', `<figure><img src="${url}" alt=""><figcaption>${esc(r.label)} · ${fmtNum(r.duration, 0)} s</figcaption></figure>`);
      } catch (e) {
        grid.insertAdjacentHTML('beforeend', `<figure><figcaption>${esc(r.label)}: audio non disponibile</figcaption></figure>`);
      }
    }
    prog.textContent = '';
  }
  return () => { alive = false; };
}
