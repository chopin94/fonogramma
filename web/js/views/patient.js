// Scheda paziente: anagrafica, visite, registrazioni, andamento nel tempo.
import { esc, ageFrom, patientName, fmtDateTime, fmtDate, fmtNum, confirmDialog } from '../util.js';
import * as repo from '../store/repo.js';
import { icon } from '../ui/icons.js';
import { openPatientEditor, createVisitFor, recordingRow } from './common.js';

export async function mount(view, [id]) {
  let patient = await repo.getPatient(id);
  if (!patient) { view.innerHTML = `<div class="page"><div class="empty">Paziente non trovato.</div></div>`; return; }

  async function render() {
    patient = await repo.getPatient(id);
    if (!patient) return;
    const visits = await repo.listVisits(id);
    const recs = await repo.listRecordings({ patientId: id });
    const age = ageFrom(patient.dob);
    const trend = recs.filter((r) => r.analysis && r.analysis.heart && r.analysis.heart.bpm && r.kind !== 'lung').slice(0, 12).reverse();
    view.innerHTML = `<div class="page">
      <div class="page-head">
        <div class="grow"><div class="crumb"><a href="#/patients">${icon('chevL', 'sm')} Archivio</a></div>
          <h1>${esc(patientName(patient))}</h1>
          <div class="meta">${esc([age !== null ? `${age} anni · nato/a il ${fmtDate(patient.dob)}` : '', patient.sex || '', patient.code || ''].filter(Boolean).join(' · '))}</div></div>
        <div class="row">
          <button class="btn primary" data-visit>${icon('plus', 'sm')} Nuova visita</button>
          <button class="btn" data-edit>${icon('edit', 'sm')} Modifica</button>
          <button class="icon-btn" data-del title="Elimina paziente" aria-label="Elimina paziente">${icon('trash')}</button>
        </div>
      </div>
      ${patient.notes ? `<div class="card flat" style="margin-top:10px"><b class="small">Anamnesi</b><div class="small">${esc(patient.notes)}</div></div>` : ''}
      <div class="section-title"><h2>Visite</h2></div>
      <div class="card flat"><div class="list">${visits.map((v) => `<a class="list-item" href="#/visit/${esc(v.id)}">
        <div class="avatar">${icon('clipboard')}</div>
        <div class="grow"><b>${fmtDateTime(v.date)}</b>${v.reason ? ` · ${esc(v.reason)}` : ''}<div class="small muted">${recs.filter((r) => r.visitId === v.id).length} registrazioni${v.conclusion ? ` · ${esc(v.conclusion.slice(0, 80))}` : ''}</div></div>
        <span class="badge ${v.status === 'chiusa' ? 'ok' : 'accent'}">${esc(v.status || 'aperta')}</span>${icon('chevR')}</a>`).join('') || '<div class="empty">Nessuna visita</div>'}</div></div>
      ${trend.length >= 2 ? `<div class="section-title"><h2>Andamento</h2></div><div class="card flat"><div class="table-wrap"><table class="data">
        <thead><tr><th>Data</th><th>Punto</th><th>FC</th><th>Sist./Diast.</th><th>S1/S2</th><th>Soffio</th></tr></thead><tbody>
        ${trend.map((r) => { const h = r.analysis.heart; return `<tr onclick="location.hash='#/rec/${esc(r.id)}'"><td>${fmtDate(r.createdAt)}</td><td>${esc(r.label || '')}</td><td>${fmtNum(h.bpm)}</td><td>${fmtNum(h.sysMs)}/${fmtNum(h.diaMs)}</td><td>${fmtNum(h.s1s2, 2)}</td><td>${h.murmurSys ? 'sist.' : ''}${h.murmurDia ? ' diast.' : ''}</td></tr>`; }).join('')}
        </tbody></table></div></div>` : ''}
      <div class="section-title"><h2>Registrazioni</h2></div>
      <div class="card flat"><div class="list">${recs.map(recordingRow).join('') || '<div class="empty">Nessuna registrazione</div>'}</div></div>
    </div>`;
    view.querySelector('[data-visit]').onclick = () => createVisitFor(id);
    view.querySelector('[data-edit]').onclick = async () => { if (await openPatientEditor(patient)) render(); };
    view.querySelector('[data-del]').onclick = async () => {
      if (await confirmDialog(`Eliminare ${patientName(patient)} con tutte le visite e le registrazioni?`, { danger: true, okText: 'Elimina' })) {
        await repo.deletePatient(id);
        location.hash = '#/patients';
      }
    };
  }
  await render();
  const off = repo.onDataChange(render);
  return () => off();
}
