// Home: diversa per profilo. Medico e studente: auscultazione, visita da riprendere,
// stato dell'ingresso, visite recenti e registrazioni libere; paziente: registrazione
// guidata per il medico.
import { esc, fmtDate, fmtDateTime, patientName, ageFrom } from '../util.js';
import { settings, updateSettings } from '../settings.js';
import { HEART_SITES, LUNG_SITES } from '../sites.js';
import * as repo from '../store/repo.js';
import { icon } from '../ui/icons.js';
import { startNewVisit, recordingRow, avatarHtml } from './common.js';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
}

// punti esaminati di una visita (con almeno una registrazione)
function progress(recs) {
  const done = new Set(recs.map((r) => r.site));
  const heart = HEART_SITES.filter((s) => !s.optional);
  return { heart: heart.filter((s) => done.has(s.id)).length, heartN: heart.length, lung: LUNG_SITES.filter((s) => done.has(s.id)).length, lungN: LUNG_SITES.length };
}

export async function mount(view) {
  const patientMode = settings.profile === 'paziente';
  view.innerHTML = `<div class="page">
    ${!window.isSecureContext ? `<div class="advice warn" style="margin-bottom:12px">
      <b>${icon('shield', 'sm')} Connessione non sicura</b>
      <div class="small">Il microfono e l'installazione dell'app richiedono una connessione sicura: apri l'app dal suo indirizzo <b>https://</b>.</div></div>` : ''}
    ${patientMode ? `<div class="card hero-main" style="margin-bottom:12px">
      <h1>Registrazione per il medico</h1>
      <p class="muted">Ti guido punto per punto: dove appoggiare il fonendo, quando registrare e come mandare le registrazioni al medico.</p>
      <div class="row" style="margin:12px 0 6px"><a class="btn primary lg" href="#/autoreg">${icon('stetho')} Inizia la registrazione</a><a class="btn lg" href="#/live?check=1&autostart=1">${icon('check')} Verifica il fonendo</a></div>
    </div>` : ''}
    <div class="hero" ${patientMode ? 'style="grid-template-columns:1fr"' : ''}>
      <div class="card hero-main col">
        <div><h1>${greeting()}</h1>
        <p class="muted" style="margin:0">${patientMode ? 'Puoi anche ascoltare liberamente, senza registrare per il medico.' : 'Scegli cosa auscultare: il filtro giusto per ogni punto si imposta da solo.'}</p></div>
        <div class="row">
          <a class="btn primary lg" href="#/live?mode=heart">${icon('heart')} Ausculta cuore</a>
          <a class="btn lg" href="#/live?mode=lung">${icon('lungs')} Ausculta torace</a>
        </div>
        <div class="row small" data-inputstate></div>
        <div class="row" id="install-row"></div>
      </div>
      <div class="card col ${patientMode ? 'hidden' : ''}" data-visitcard></div>
    </div>
    ${settings.profile === 'studente' ? `<div class="card col" style="margin-top:12px">
      <h3>${icon('activity')} Allenati con il simulatore</h3>
      <p class="small muted" style="margin:0">Soffi, galoppi, sdoppiamenti, crepitii, sibili e anche i disturbi (voce, sfregamento, ronzio): ascoltali e guarda come li riconosce l'analisi.</p>
      <div class="row"><button class="btn" data-sim="heart">${icon('heart', 'sm')} Casi cardiaci</button><button class="btn" data-sim="lung">${icon('lungs', 'sm')} Casi toracici</button></div>
    </div>` : ''}
    <div class="section-title"><h2>Visite recenti</h2>${patientMode ? '' : `<a class="btn sm ghost" href="#/patients">${icon('archive', 'sm')} Archivio</a>`}</div>
    <div class="card flat" id="recent"><div class="empty">Caricamento…</div></div>
    <div id="free-wrap" class="hidden">
      <div class="section-title"><h2>Registrazioni senza paziente</h2></div>
      <div class="card flat"><div class="list" id="free"></div></div>
    </div>
  </div>`;

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
  view.querySelectorAll('[data-sim]').forEach((b) => {
    b.onclick = () => { updateSettings({ source: 'demo' }); location.hash = `#/live?mode=${b.dataset.sim}&autostart=1`; };
  });

  // stato dell'ingresso: ultima verifica guidata fatta su questo dispositivo
  const checks = Object.values(settings.inputChecks || {}).sort((a, b) => b.at - a.at);
  const last = checks[0];
  view.querySelector('[data-inputstate]').innerHTML = settings.source !== 'mic'
    ? `<span class="badge">${icon('activity', 'sm')} Sorgente: ${settings.source === 'demo' ? 'simulatore' : 'file'}</span><a href="#/live?mode=heart">cambia in Regolazioni</a>`
    : last ? `<span class="badge ${last.level === 'ok' ? 'ok' : last.level === 'bad' ? 'bad' : 'warn'}">${icon('mic', 'sm')} ${esc(last.verdict)}</span><span class="muted">verificato il ${fmtDate(last.at)}</span><a href="#/live?check=1&autostart=1">ripeti</a>`
      : `<span class="badge warn">${icon('mic', 'sm')} Ingresso non ancora verificato</span><a href="#/live?check=1&autostart=1">Verifica (30 s)</a>`;

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
    // visita da riprendere: l'ultima ancora aperta
    const open = visits.find((v) => v.status !== 'chiusa');
    const card = view.querySelector('[data-visitcard]');
    if (open) {
      const p = patients.get(open.patientId) || null;
      const pr = progress(allRecs.filter((r) => r.visitId === open.id));
      card.innerHTML = `<h3>${icon('clipboard')} Visita in corso</h3>
        <div class="row" style="gap:10px">${avatarHtml(p)}<div class="grow"><b>${esc(patientName(p))}</b><div class="small muted">${fmtDateTime(open.date)}${open.reason ? ` · ${esc(open.reason)}` : ''}</div></div></div>
        <div class="row small"><span class="badge ${pr.heart === pr.heartN ? 'ok' : ''}">${icon('heart', 'sm')} Cuore ${pr.heart}/${pr.heartN}</span><span class="badge ${pr.lung === pr.lungN ? 'ok' : ''}">${icon('lungs', 'sm')} Torace ${pr.lung}/${pr.lungN}</span></div>
        <div class="row"><a class="btn primary" href="#/visit/${esc(open.id)}?tab=${pr.heart < pr.heartN ? 'heart' : 'lung'}">${icon('play', 'sm')} Riprendi</a><button class="btn" data-newvisit>${icon('plus', 'sm')} Nuova visita</button></div>`;
    } else {
      card.innerHTML = `<h3>${icon('clipboard')} Visita medica</h3>
        <p class="small muted" style="margin:0">Anagrafica, parametri vitali, esame guidato dei focolai cardiaci e dei punti toracici, referto stampabile.</p>
        <div class="row"><button class="btn primary" data-newvisit>${icon('plus', 'sm')} Nuova visita</button><a class="btn" href="#/patients">${icon('archive', 'sm')} Archivio pazienti</a></div>`;
    }
    card.querySelector('[data-newvisit]').onclick = () => startNewVisit();
    view.querySelector('#recent').innerHTML = rows.length ? `<div class="list">${rows.join('')}</div>` : `<div class="empty">Nessuna visita ancora. Inizia con <b>Nuova visita</b> oppure con un'auscultazione rapida.</div>`;
    const free = allRecs.filter((r) => !r.patientId);
    view.querySelector('#free-wrap').classList.toggle('hidden', !free.length);
    view.querySelector('#free').innerHTML = free.slice(0, 15).map(recordingRow).join('');
  };
  await render();
  const off = repo.onDataChange(render);
  return () => { alive = false; off(); window.removeEventListener('installable', showInstall); };
}
