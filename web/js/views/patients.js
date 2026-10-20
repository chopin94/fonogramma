// Archivio pazienti con ricerca.
import { esc, ageFrom, patientName, fmtDate } from '../util.js';
import * as repo from '../store/repo.js';
import { icon } from '../ui/icons.js';
import { openPatientEditor, recordingRow, avatarHtml, patientMatches } from './common.js';

export async function mount(view) {
  view.innerHTML = `<div class="page">
    <div class="row between"><h1>Archivio pazienti</h1><button class="btn primary" data-new>${icon('plus', 'sm')} Nuovo paziente</button></div>
    <input type="search" placeholder="Cerca per cognome, nome o codice…" data-q style="margin:8px 0 12px">
    <div class="card flat"><div class="list" data-list></div></div>
    <div data-free></div>
  </div>`;
  const q = (s) => view.querySelector(s);
  let patients = [];
  const meta = new Map();

  async function load() {
    patients = await repo.listPatients();
    meta.clear();
    for (const v of await repo.recentVisits(Infinity)) { // dalla più recente
      const m = meta.get(v.patientId);
      if (m) m.n++;
      else meta.set(v.patientId, { n: 1, last: v.date });
    }
    render();
    const free = await repo.listRecordings({ free: true });
    if (!q('[data-free]')) return;
    q('[data-free]').innerHTML = free.length ? `<div class="section-title"><h2>Registrazioni senza paziente</h2></div><div class="card flat"><div class="list">${free.map(recordingRow).join('')}</div></div>` : '';
  }

  function render() {
    if (!q('[data-q]')) return;
    const list = patients.filter((p) => patientMatches(p, q('[data-q]').value));
    q('[data-list]').innerHTML = list.length ? list.map((p) => {
      const m = meta.get(p.id) || {};
      const age = ageFrom(p.dob);
      return `<a class="list-item" href="#/patient/${esc(p.id)}">
        ${avatarHtml(p)}
        <div class="grow"><b>${esc(patientName(p))}</b>
          <div class="small muted">${esc([age !== null ? `${age} anni` : '', p.sex, p.code, `${m.n || 0} visite`, m.last ? `ultima ${fmtDate(m.last)}` : ''].filter(Boolean).join(' · '))}</div></div>
        ${icon('chevR')}</a>`;
    }).join('') : `<div class="empty">${patients.length ? 'Nessun risultato' : 'Archivio vuoto: aggiungi il primo paziente.'}</div>`;
  }

  q('[data-q]').oninput = render;
  q('[data-new]').onclick = async () => {
    const p = await openPatientEditor();
    if (p) location.hash = `#/patient/${p.id}`;
  };
  await load();
  const off = repo.onDataChange(load);
  return () => off();
}
