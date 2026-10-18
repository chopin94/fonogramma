// Avvio dell'app: router, service worker (offline/installazione), sincronizzazione.
import { applyTheme } from './settings.js';
import { startSync, onSync, syncNow } from './store/sync.js';
import { toast, sheet } from './util.js';

const routes = [
  [/^\/?$/, 'home', () => import('./views/home.js')],
  [/^\/live$/, 'live', () => import('./views/live.js')],
  [/^\/patients$/, 'patients', () => import('./views/patients.js')],
  [/^\/patient\/([\w-]+)$/, 'patients', () => import('./views/patient.js')],
  [/^\/visit\/([\w-]+)$/, 'patients', () => import('./views/visit.js')],
  [/^\/rec\/([\w-]+)$/, 'patients', () => import('./views/recording.js')],
  [/^\/report\/([\w-]+)$/, 'patients', () => import('./views/report.js')],
  [/^\/settings$/, 'settings', () => import('./views/settings.js')],
];

let cleanup = null;
let token = 0;

async function route() {
  const my = ++token;
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const found = routes.find(([re]) => re.test(path));
  if (!found) { location.hash = '#/'; return; }
  const [re, nav, loader] = found;
  const params = path.match(re).slice(1);
  if (cleanup) {
    const c = cleanup;
    cleanup = null;
    // la pulizia (es. chiusura dell'audio) non deve mai bloccare la navigazione
    try { await Promise.race([c(), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { console.warn(e); }
  }
  if (my !== token) return;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.scrollTop = 0;
  view.classList.toggle('full', nav === 'live');
  try {
    const mod = await loader();
    if (my !== token) return;
    const c = await mod.mount(view, params, query);
    if (my !== token) { if (c) c(); return; }
    cleanup = c || null;
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="page"><div class="card"><b>Errore</b><p class="small">${String(e && e.message || e)}</p></div></div>`;
  }
}

// Ricarica la vista corrente se è la stessa rotta ma con parametri diversi
window.addEventListener('hashchange', route);

// ---------- stato sincronizzazione nella barra ----------
function bindSyncChip() {
  const chip = document.getElementById('sync-chip');
  onSync((st) => {
    chip.classList.remove('ok', 'off', 'busy');
    let lbl;
    if (st.mode === 'local') {
      chip.classList.add('ok');
      chip.querySelector('.lbl').textContent = 'Sul dispositivo';
      chip.title = 'I dati restano solo su questo dispositivo (backup in Impostazioni)';
      return;
    }
    if (st.syncing) { chip.classList.add('busy'); lbl = 'Sincronizzo…'; }
    else if (st.online === false) { chip.classList.add('off'); lbl = 'Offline'; }
    else if (st.error) { chip.classList.add('off'); lbl = st.pinOk === false ? 'PIN richiesto' : 'Errore sync'; }
    else if (st.online) { chip.classList.add('ok'); lbl = st.pending ? `${st.pending} in coda` : 'Sincronizzato'; }
    else lbl = '…';
    chip.querySelector('.lbl').textContent = lbl;
    chip.title = st.error || 'Sincronizzazione con il server di casa';
  });
  chip.onclick = () => {
    const l = chip.querySelector('.lbl').textContent;
    if (l === 'PIN richiesto' || l === 'Sul dispositivo') location.hash = '#/settings';
    else syncNow();
  };
}

// ---------- service worker e installazione ----------
function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  if (location.port === '8765' && !localStorage.getItem('fonogramma.devsw')) return; // server di sviluppo: niente cache
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return; // prima installazione: nessun ricaricamento
    if (location.hash.startsWith('#/live')) return; // non interrompere un'auscultazione
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const ask = (w) => toast('Nuova versione di Fonogramma disponibile', { timeout: 20000, action: { label: 'Aggiorna', run: () => w.postMessage('skipWaiting') } });
    if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((e) => console.warn('Service worker:', e));
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__installPrompt = e;
  window.dispatchEvent(new Event('installable'));
});

// ---------- avviso al primo avvio ----------
function firstRunNotice() {
  const KEY = 'fonogramma.notice.v1';
  try { if (localStorage.getItem(KEY)) return; } catch { return; }
  sheet({
    title: 'Prima di iniziare',
    body: `<p class="lead">Fonogramma è uno strumento <b>didattico e di supporto</b> all'auscultazione.</p>
      <ul class="small">
        <li>Le analisi automatiche (toni, soffi, crepitii, frequenze) sono <b>indicative</b> e non costituiscono diagnosi.</li>
        <li><b>Non è un dispositivo medico</b> certificato: le decisioni cliniche restano del professionista.</li>
        <li>I dati dei pazienti restano <b>su questo dispositivo</b>, salvo che tu configuri un tuo server di sincronizzazione.</li>
      </ul>`,
    actions: [{ label: 'Ho capito', kind: 'primary', run: () => { try { localStorage.setItem(KEY, '1'); } catch {} } }],
  });
}

applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
bindSyncChip();
registerSW();
startSync();
route();
firstRunNotice();
