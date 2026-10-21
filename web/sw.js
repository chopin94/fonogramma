// Service worker: l'app funziona anche offline.
const VERSION = 'fonogramma-2.0.0';
const ASSETS = [
    './',
    'index.html',
    'manifest.webmanifest',
    'css/app.css',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon.svg',
    'icons/maskable-512.png',
    'js/app.js',
    'js/audio/analyzer.js',
    'js/audio/demo.js',
    'js/audio/engine.js',
    'js/audio/graph.js',
    'js/audio/input.js',
    'js/audio/player.js',
    'js/audio/wav.js',
    'js/audio/worklets/denoise.js',
    'js/audio/worklets/tap.js',
    'js/audio/wsola.js',
    'js/coach.js',
    'js/dsp/biquad.js',
    'js/dsp/fft.js',
    'js/dsp/frontend.js',
    'js/dsp/heart.js',
    'js/dsp/lung.js',
    'js/dsp/peaks.js',
    'js/dsp/quality.js',
    'js/dsp/stft.js',
    'js/presets.js',
    'js/profiles.js',
    'js/settings.js',
    'js/sites.js',
    'js/store/audio.js',
    'js/store/backup.js',
    'js/store/db.js',
    'js/store/repo.js',
    'js/ui/bodymap.js',
    'js/ui/canvas.js',
    'js/ui/charts.js',
    'js/ui/colormaps.js',
    'js/ui/eqeditor.js',
    'js/ui/icons.js',
    'js/ui/scope.js',
    'js/ui/waterfall.js',
    'js/util.js',
    'js/version.js',
    'js/views/common.js',
    'js/views/home.js',
    'js/views/inputcheck.js',
    'js/views/live.js',
    'js/views/onboarding.js',
    'js/views/patient.js',
    'js/views/patients.js',
    'js/views/recording.js',
    'js/views/report.js',
    'js/views/selfrec.js',
    'js/views/settings.js',
    'js/views/visit.js',
    'js/workers/analysis.js',
    'js/workers/live.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((resp) => {
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return resp;
    })),
  );
});
