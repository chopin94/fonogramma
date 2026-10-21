// Avvio dell'app: router, service worker (offline/installazione), avviso iniziale.
import { applyTheme } from './settings.js';
import { toast } from './util.js';
import { openOnboarding } from './views/onboarding.js';

const routes = [
  [/^\/?$/, 'home', () => import('./views/home.js')],
  [/^\/live$/, 'live', () => import('./views/live.js')],
  [/^\/patients$/, 'patients', () => import('./views/patients.js')],
  [/^\/patient\/([\w-]+)$/, 'patients', () => import('./views/patient.js')],
  [/^\/visit\/([\w-]+)$/, 'patients', () => import('./views/visit.js')],
  [/^\/rec\/([\w-]+)$/, 'patients', () => import('./views/recording.js')],
  [/^\/report\/([\w-]+)$/, 'patients', () => import('./views/report.js')],
  [/^\/settings$/, 'settings', () => import('./views/settings.js')],
  [/^\/autoreg$/, 'home', () => import('./views/selfrec.js')],
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

// ---------- service worker e installazione ----------
function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // in sviluppo (localhost) niente cache, salvo richiesta esplicita
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !localStorage.getItem('fonogramma.devsw')) return;
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
// primo avvio: tre passi (avvertenze e profilo, ingresso, da dove iniziare)
function firstRun() {
  const KEY = 'fonogramma.notice.v1';
  try { if (localStorage.getItem(KEY)) return; } catch { return; }
  openOnboarding({
    onDone: () => {
      try { localStorage.setItem(KEY, '1'); } catch {}
      if (/^#?\/?$/.test(location.hash)) route(); // la Home cambia con il profilo scelto
    },
  });
}

applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
registerSW();
route();
firstRun();
