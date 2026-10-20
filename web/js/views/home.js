// Home: avvio rapido, nuova visita, visite recenti, registrazioni libere.
import { esc, fmtDateTime, patientName, ageFrom } from '../util.js';
import * as repo from '../store/repo.js';
import { icon } from '../ui/icons.js';
import { startNewVisit, recordingRow, avatarHtml } from './common.js';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
}

export async function mount(view) {
  view.innerHTML = `<div class="page">
    ${!window.isSecureContext ? `<div class="card" style="border-color:var(--warn);margin-bottom:12px">
      <h3>${icon('shield')} Connessione non sicura</h3>
      <p class="small">Il microfono e l'installazione dell'app richiedono una connessione sicura: apri l'app dal suo indirizzo <b>https://</b>.</p></div>` : ''}
    <div class="hero">
      <div class="card hero-main">
        <h1>${greeting()}</h1>
        <p class="muted">Collega il fonendoscopio al jack, scegli il focolaio e ascolta. Tracciato, waterfall e analisi in tempo reale.</p>
        <div class="row" style="margin:12px 0 6px">
          <a class="btn primary lg" href="#/live?mode=heart">${icon('heart')} Ausculta cuore</a>
          <a class="btn lg" href="#/live?mode=lung">${icon('lungs')} Ausculta torace</a>
        </div>
        <div class="row" id="install-row"></div>
      </div>
      <div class="card col">
        <h3>${icon('clipboard')} Visita medica</h3>
        <p class="small muted">Anagrafica, parametri vitali, esame guidato dei 4 focolai cardiaci e dei 12 punti toracici, referto stampabile.</p>
        <button class="btn primary" id="new-visit">${icon('plus')} Nuova visita</button>
        <a class="btn" href="#/patients">${icon('archive')} Archivio pazienti</a>
      </div>
    </div>
    <div class="section-title"><h2>Visite recenti</h2></div>
    <div class="card flat" id="recent"><div class="empty">Caricamento…</div></div>
    <div id="free-wrap" class="hidden">
      <div class="section-title"><h2>Registrazioni senza paziente</h2></div>
      <div class="card flat"><div class="list" id="free"></div></div>
    </div>
  </div>`;

  view.querySelector('#new-visit').onclick = () => startNewVisit();
  const inst = view.querySelector('#install-row');
  const showInstall = () => {
    if (!window.__installPrompt) return;
    inst.innerHTML = `<button class="btn sm">${icon('download', 'sm')} Installa l'app su questo dispositivo</button>`;
    inst.firstChild.onclick = async () => {
      const p = window.__installPrompt;
      window.__installPrompt = null;
      p.prompt();
      await p.userChoice;
      inst.innerHTML = '';
    };
  };
  showInstall();
  window.addEventListener('installable', showInstall);

  let alive = true;
  const render = async () => {
    if (!alive) return;
    const visits = await repo.recentVisits(10);
    const patients = new Map((await repo.listPatients()).map((p) => [p.id, p]));
    const allRecs = await repo.listRecordings();
    const rows = [];
    for (const v of visits) {
      const p = patients.get(v.patientId) || null;
      const recs = allRecs.filter((r) => r.visitId === v.id);
      const age = ageFrom(p && p.dob);
      rows.push(`<a class="list-item" href="#/visit/${esc(v.id)}">
        ${avatarHtml(p)}
        <div class="grow"><b>${esc(patientName(p))}</b>${age !== null ? ` <span class="muted small">${age} anni</span>` : ''}
          <div class="small muted">${fmtDateTime(v.date)} · ${recs.length} registrazioni${v.reason ? ` · ${esc(v.reason)}` : ''}</div></div>
        <span class="badge ${v.status === 'chiusa' ? 'ok' : 'accent'}">${esc(v.status || 'aperta')}</span>${icon('chevR')}</a>`);
    }
    if (!alive || !view.querySelector('#recent')) return;
    view.querySelector('#recent').innerHTML = rows.length ? `<div class="list">${rows.join('')}</div>` : `<div class="empty">Nessuna visita ancora. Inizia con <b>Nuova visita</b> oppure con un'auscultazione rapida.</div>`;
    const free = allRecs.filter((r) => !r.patientId);
    view.querySelector('#free-wrap').classList.toggle('hidden', !free.length);
    view.querySelector('#free').innerHTML = free.slice(0, 15).map(recordingRow).join('');
  };
  await render();
  const off = repo.onDataChange(render);
  return () => { alive = false; off(); window.removeEventListener('installable', showInstall); };
}
