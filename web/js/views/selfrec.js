// Registrazione a casa per il medico (profilo "Paziente"): procedura passo passo.
// Per ogni punto: dove appoggiare il fonendo, attesa di un segnale pulito,
// registrazione automatica, controllo dei disturbi. Alla fine il file da mandare al
// medico, che lo apre in Fonogramma da Impostazioni → Importa backup.
import { esc, toast, downloadBlob, safeName } from '../util.js';
import { settings, updateSettings } from '../settings.js';
import { HEART_SITES, LUNG_SITES } from '../sites.js';
import { getPreset } from '../presets.js';
import { LiveEngine } from '../audio/engine.js';
import { INPUT_TYPES, inputAdvice, inputRecord } from '../audio/input.js';
import { encodeWav } from '../audio/wav.js';
import { analyzeSamples, summarize } from '../audio/analyzer.js';
import { Coach, Tally, coachState, ISSUE_NAMES } from '../coach.js';
import { Scope } from '../ui/scope.js';
import { bodyMapSvg } from '../ui/bodymap.js';
import { icon } from '../ui/icons.js';
import * as repo from '../store/repo.js';
import { exportBackup } from '../store/backup.js';
import { isHeartAbnormal, isLungAbnormal } from './common.js';
import { openInputCheck, lastCheck } from './inputcheck.js';

const CLEAN_MS = 1500; // segnale pulito per almeno 1,5 s prima di registrare

export async function mount(view) {
  const plan = { name: settings.selfName || '', what: settings.selfWhat || 'heart', helper: !!settings.selfHelper };
  const engine = new LiveEngine();
  const coach = new Coach();
  let running = false, coachCur = null, lastHeart = null, lastLung = null, since = 0;
  let list = [], idx = 0, phase = 'idle', t0 = 0, cleanSince = 0, tally = null, timer = 0, raf = 0, scope = null;
  const done = []; // { site, rec, issue }
  let patient = null, visit = null, alive = true;
  const listeners = new Set();

  const kindOf = (s) => (HEART_SITES.includes(s) ? 'heart' : 'lung');
  const durOf = (s) => (kindOf(s) === 'heart' ? settings.guidedHeartS : settings.guidedLungS);

  function buildList() {
    const heart = HEART_SITES.filter((s) => !s.optional);
    const lung = LUNG_SITES.filter((s) => plan.helper || s.view === 'front');
    return plan.what === 'heart' ? heart : plan.what === 'lung' ? lung : heart.concat(lung);
  }

  // ---------- audio e assistente ----------
  engine.on('frame', (d) => {
    if (scope) scope.push(d);
    if (!d.quality) return;
    const s = list[idx];
    const st = coachState({
      quality: d.quality, mode: s ? kindOf(s) : 'heart', source: engine.source, kind: settings.inputKind,
      heart: lastHeart, lung: lastLung, advice: engine.input ? inputAdvice(engine.input, settings.inputKind) : [],
      inputName: engine.source === 'mic' ? INPUT_TYPES[engine.input ? engine.input.type : 'unknown'].short : 'Simulatore',
      settled: performance.now() - since > (s && kindOf(s) === 'lung' ? 12000 : 6000),
    });
    coachCur = coach.update(st, performance.now());
    if (phase === 'rec' && tally) tally.add(st);
    for (const fn of listeners) fn(d.quality, st);
    renderLight();
  });
  engine.on('analysis', (a) => {
    if (a.heart) { lastHeart = a.heart; if (scope) scope.setMarkers(a.heart.markers, a.span[0], a.span[1]); }
    if (a.lung) lastLung = a.lung;
  });
  engine.on('inputlost', () => { toast('Fonendo scollegato: le registrazioni fatte finora sono salvate.', { type: 'error', timeout: 7000 }); finish(); });
  engine.on('error', (e) => toast(e.message || String(e), { type: 'error' }));

  async function startAudio(site) {
    if (running) return true;
    try {
      const src = settings.source === 'demo' ? 'demo' : 'mic';
      await engine.start({
        source: src, deviceId: settings.deviceId, channel: settings.inputChannel, demoId: settings.demoId,
        bands: getPreset(site ? site.preset : 'membrana').bands, gainDb: settings.gainDb, monitor: false,
        config: { mode: site ? kindOf(site) : 'heart', loopSeconds: 10 },
      });
      running = true;
      since = performance.now();
      coach.reset();
      coachCur = null;
      return true;
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Serve il permesso al microfono: consentilo nelle impostazioni del browser.' : e.message || String(e), { type: 'error', timeout: 7000 });
      return false;
    }
  }
  async function stopAudio() { running = false; await engine.stop(); }

  function setSite(s) {
    if (!running) return;
    engine.setBands(getPreset(s.preset).bands);
    engine.configure({ mode: kindOf(s) });
    since = performance.now();
    lastHeart = lastLung = null;
    coach.reset();
    coachCur = null;
  }

  // ---------- schermate ----------
  function render() {
    cancelAnimationFrame(raf);
    clearInterval(timer);
    scope = null;
    if (phase === 'end') return renderEnd();
    if (!list.length) return renderIntro();
    renderPoint();
  }

  function renderIntro() {
    const chk = lastCheck(engine.input);
    view.innerHTML = `<div class="page selfrec">
      <h1>${icon('stetho')} Registrazione per il medico</h1>
      <p class="lead">Ti guido punto per punto: ti mostro dove appoggiare il fonendo, aspetto che il suono sia pulito e registro da solo. Alla fine prepari il file da mandare al medico.</p>
      <div class="card col">
        <label class="field"><span>Nome e cognome (così il medico sa di chi sono le registrazioni)</span><input type="text" data-name value="${esc(plan.name)}" placeholder="es. Mario Rossi" autocomplete="name"></label>
        <div class="field"><span>Cosa ti ha chiesto di registrare il medico?</span>
          <div class="seg" data-what><button data-v="heart">${icon('heart', 'sm')} Cuore</button><button data-v="lung">${icon('lungs', 'sm')} Respiro</button><button data-v="both">Entrambi</button></div></div>
        <label class="check" data-helperbox><input type="checkbox" data-helper ${plan.helper ? 'checked' : ''}> C’è qualcuno che mi aiuta (registra anche i punti sulla schiena)</label>
        <div class="small muted" data-count></div>
      </div>
      <div class="card col">
        <b>${icon('check', 'sm')} Prima volta con questo fonendo?</b>
        <p class="small">${chk ? `Ultima verifica: <b>${esc(chk.verdict)}</b>.` : 'Fai la verifica (30 secondi): controlla che il suono arrivi dal fonendo e che non ci siano disturbi.'}</p>
        <button class="btn" data-check>${icon('check', 'sm')} Verifica il fonendo</button>
      </div>
      <div class="card col small">
        <b>Prima di iniziare</b>
        <ul>
          <li>Stanza silenziosa: spegni TV, radio e ventilatori; stacca il caricatore del telefono.</li>
          <li>Pelle nuda: il fonendo non va appoggiato sui vestiti.</li>
          <li>Tieni fermo il fonendo con una pressione costante e non parlare mentre registra.</li>
        </ul>
      </div>
      <button class="btn primary lg" data-go>${icon('play', 'sm')} Inizia</button>
    </div>`;
    const q = (s) => view.querySelector(s);
    const sync = () => {
      view.querySelectorAll('[data-what] button').forEach((b) => b.classList.toggle('on', b.dataset.v === plan.what));
      q('[data-helperbox]').classList.toggle('hidden', plan.what === 'heart');
      const n = buildList().length;
      q('[data-count]').textContent = `${n} punti, circa ${Math.ceil((n * 35) / 60)} minuti.`;
    };
    sync();
    q('[data-name]').oninput = (e) => { plan.name = e.target.value.trim(); updateSettings({ selfName: plan.name }); };
    view.querySelectorAll('[data-what] button').forEach((b) => { b.onclick = () => { plan.what = b.dataset.v; updateSettings({ selfWhat: plan.what }); sync(); }; });
    q('[data-helper]').onchange = (e) => { plan.helper = e.target.checked; updateSettings({ selfHelper: plan.helper }); sync(); };
    q('[data-check]').onclick = async () => {
      if (!(await startAudio(null))) return;
      openInputCheck({
        source: engine.source, info: engine.source === 'mic' ? engine.input : null, kind: settings.inputKind,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        heart: () => lastHeart, diagnostics: async () => '', onDone: () => { if (alive && !list.length) renderIntro(); },
      });
    };
    q('[data-go]').onclick = async () => {
      list = buildList();
      idx = 0;
      phase = 'idle';
      if (!(await startAudio(list[0]))) { list = []; return; }
      setSite(list[0]);
      render();
    };
  }

  function renderPoint() {
    const s = list[idx];
    const lung = kindOf(s) === 'lung';
    view.innerHTML = `<div class="page selfrec">
      <div class="row between"><span class="badge accent">Punto ${idx + 1} di ${list.length}</span><button class="btn sm ghost" data-stop>${icon('x', 'sm')} Interrompi</button></div>
      <div class="selfrec-dots">${list.map((x, k) => `<i class="${k < idx ? (done.find((d) => d.site === x) ? 'ok' : 'skip') : k === idx ? 'cur' : ''}"></i>`).join('')}</div>
      <div class="selfrec-grid">
        <div class="selfrec-map">${bodyMapSvg({ view: s.view || 'front', sites: [s], selected: s.id })}</div>
        <div class="col">
          <h2 style="margin:0">${icon(lung ? 'lungs' : 'heart', 'sm')} ${esc(s.full)}</h2>
          <p class="lead">${esc(s.simple)}</p>
          <div class="small muted">Destra e sinistra sono le tue.${s.view === 'back' ? ' Questo punto lo registra chi ti aiuta.' : ''}</div>
          <div class="advice info small">${lung ? 'Mentre registra: respira profondamente con la bocca aperta, senza parlare.' : 'Mentre registra: respira normalmente e non parlare.'}</div>
        </div>
      </div>
      <div class="selfrec-light" data-light></div>
      <div class="plot selfrec-trace"><canvas data-trace></canvas></div>
      <div class="selfrec-action" data-action></div>
    </div>`;
    const q = (sel) => view.querySelector(sel);
    q('[data-stop]').onclick = finish;
    scope = new Scope(q('[data-trace]'), { capacityS: 10 });
    scope.span = 5;
    scope.showEnv = !lung;
    scope.setRate(engine.sampleRate, Math.round(engine.sampleRate / 1000));
    const loop = () => { if (scope) { scope.draw(); raf = requestAnimationFrame(loop); } };
    raf = requestAnimationFrame(loop);
    renderAction();
    renderLight();
    timer = setInterval(tick, 150);
  }

  function renderLight() {
    const box = view.querySelector('[data-light]');
    if (!box) return;
    const c = coachCur || { level: 'ok', text: 'In ascolto…', fix: '' };
    const key = `${c.key}|${c.level}|${c.text}`;
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    box.className = `selfrec-light ${c.level}`;
    box.innerHTML = `<i></i><div><b>${esc(c.level === 'ok' ? 'Suono pulito' : c.text)}</b>${c.fix ? `<div class="small">${esc(c.fix)}</div>` : ''}</div>`;
  }

  function renderAction() {
    const box = view.querySelector('[data-action]');
    const s = list[idx];
    if (phase === 'idle') {
      box.innerHTML = `<div class="row"><button class="btn primary lg" data-ready>${icon('rec', 'sm')} Sono pronto: registra</button><button class="btn" data-skip>Salta questo punto</button></div>
        <div class="tiny muted">Appoggia il fonendo sul punto indicato, poi premi il pulsante: la registrazione parte appena il suono è pulito e dura ${durOf(s)} secondi.</div>`;
      box.querySelector('[data-ready]').onclick = () => { phase = 'wait'; cleanSince = 0; renderAction(); };
      box.querySelector('[data-skip]').onclick = next;
    } else if (phase === 'wait') {
      box.innerHTML = `<div class="small"><b>Tieni fermo il fonendo…</b> la registrazione parte appena il suono è pulito.</div>
        <div class="row"><button class="btn" data-force>Registra comunque</button><button class="btn ghost" data-back>Annulla</button></div>`;
      box.querySelector('[data-force]').onclick = startRec;
      box.querySelector('[data-back]').onclick = () => { phase = 'idle'; renderAction(); };
    } else if (phase === 'rec') {
      box.innerHTML = `<div class="row between"><b>${icon('rec', 'sm')} Registrazione in corso: resta fermo</b><span class="num" data-left>${durOf(s)} s</span></div><div class="progress"><i data-prog style="width:0%"></i></div>`;
    } else if (phase === 'saving') {
      box.innerHTML = '<div class="small">Salvataggio…</div>';
    } else if (phase === 'review') {
      const d = done[done.length - 1];
      box.innerHTML = `<div class="advice warn"><b>Registrazione disturbata: ${esc(ISSUE_NAMES[d.issue.key] || 'disturbi')} per buona parte del tempo.</b><div class="small">Conviene ripeterla: ${esc(coachHint(d.issue.key))}</div></div>
        <div class="row"><button class="btn primary" data-redo>${icon('refresh', 'sm')} Ripeti questo punto</button><button class="btn" data-keep>Va bene così</button></div>`;
      box.querySelector('[data-redo]').onclick = async () => {
        const d2 = done.pop();
        await repo.deleteRecording(d2.rec.id);
        phase = 'idle';
        renderAction();
      };
      box.querySelector('[data-keep]').onclick = next;
    }
  }

  const coachHint = (key) => ({
    voice: 'nessuno deve parlare durante la registrazione.',
    friction: 'tieni il fonendo fermo sulla pelle nuda, senza strisciare.',
    move: 'tieni fermi il fonendo e il tubo.',
    hum: 'stacca il caricatore del telefono.',
    clip: 'evita colpi sul fonendo.',
  }[key] || 'cerca un posto silenzioso e tieni fermo il fonendo.');

  function tick() {
    const now = performance.now();
    if (phase === 'wait') {
      if (coachCur && coachCur.level === 'ok') { if (!cleanSince) cleanSince = now; if (now - cleanSince >= CLEAN_MS) startRec(); } else cleanSince = 0;
    } else if (phase === 'rec') {
      const dur = durOf(list[idx]), el2 = (now - t0) / 1000;
      const p = view.querySelector('[data-prog]'), l = view.querySelector('[data-left]');
      if (p) p.style.width = `${Math.min(100, (el2 / dur) * 100)}%`;
      if (l) l.textContent = `${Math.max(0, Math.ceil(dur - el2))} s`;
      if (el2 >= dur) stopRec();
    }
  }

  function startRec() {
    if (phase === 'rec') return;
    tally = new Tally();
    engine.startRecording();
    phase = 'rec';
    t0 = performance.now();
    renderAction();
  }

  async function stopRec() {
    phase = 'saving';
    renderAction();
    const r = await engine.stopRecording();
    if (!alive) return;
    if (!r || !r.samples || r.samples.length < r.fs) { toast('Registrazione non riuscita', { type: 'warn' }); phase = 'idle'; renderAction(); return; }
    const s = list[idx], kind = kindOf(s);
    await ensureVisit();
    const rec = await repo.saveRecording({
      kind, site: s.id, label: s.full, visitId: visit ? visit.id : null, patientId: patient ? patient.id : null,
      duration: r.samples.length / r.fs, fs: r.fs, preset: s.preset, bands: getPreset(s.preset).bands, gainDb: settings.gainDb,
      source: engine.source, device: engine.inputLabel || '', input: engine.source === 'mic' ? inputRecord(engine.input, settings.inputKind) : null,
      denoise: 0, selfRecorded: true,
    }, encodeWav(r.samples, r.fs));
    analyzeSamples(r.samples, r.fs, kind).then(async (res) => {
      const cur = await repo.getRecording(rec.id);
      if (!cur) return;
      cur.analysis = summarize(res, kind);
      cur.abnormal = kind === 'lung' ? isLungAbnormal(cur.analysis.lung) : isHeartAbnormal(cur.analysis.heart);
      await repo.saveRecording(cur);
    }).catch((e) => console.warn('Analisi registrazione:', e));
    const w = tally.worst();
    done.push({ site: s, rec, issue: w });
    if (w.total > 0.3) { phase = 'review'; renderAction(); return; }
    toast(`${s.full}: fatto`, { timeout: 1500 });
    next();
  }

  async function ensureVisit() {
    if (visit) return;
    if (plan.name) {
      const parts = plan.name.split(/\s+/);
      const lastName = parts.length > 1 ? parts.pop() : '';
      const firstName = parts.join(' ');
      patient = (await repo.listPatients()).find((p) => `${p.firstName} ${p.lastName}`.trim().toLowerCase() === plan.name.toLowerCase())
        || (await repo.savePatient({ firstName, lastName }));
    }
    if (patient) visit = await repo.saveVisit({ patientId: patient.id, reason: 'Registrazione a domicilio' });
  }

  function next() {
    idx++;
    phase = 'idle';
    if (idx >= list.length) { finish(); return; }
    setSite(list[idx]);
    render();
  }

  async function finish() {
    phase = 'end';
    await stopAudio();
    render();
  }

  function renderEnd() {
    const ids = done.map((d) => d.rec.id);
    view.innerHTML = `<div class="page selfrec">
      <h1>${icon('check')} ${ids.length ? 'Registrazioni completate' : 'Nessuna registrazione'}</h1>
      ${ids.length ? `<div class="card flat"><div class="list">${done.map((d) => `<a class="list-item" href="#/rec/${esc(d.rec.id)}"><span class="badge ${d.issue.total > 0.3 ? 'warn' : 'ok'}">${d.issue.total > 0.3 ? 'disturbata' : 'ok'}</span><div class="grow"><b>${esc(d.site.full)}</b></div>${icon('chevR')}</a>`).join('')}</div></div>
      <div class="card col">
        <b>${icon('download', 'sm')} Manda le registrazioni al medico</b>
        <p class="small">Prepara un file con le registrazioni${plan.name ? ' e il tuo nome' : ''}; mandalo al medico con WhatsApp, email o come preferisci. Il medico lo apre con Fonogramma (Impostazioni → Importa backup).</p>
        <div class="row"><button class="btn primary lg" data-share>${icon('download', 'sm')} Invia al medico</button></div>
        <div class="tiny muted">Il file contiene dati sanitari: mandalo solo al tuo medico.</div>
      </div>` : ''}
      <div class="row"><button class="btn" data-again>${icon('refresh', 'sm')} Nuova registrazione</button><a class="btn ghost" href="#/">Home</a></div>
    </div>`;
    const sh = view.querySelector('[data-share]');
    if (sh) sh.onclick = () => share(ids);
    view.querySelector('[data-again]').onclick = () => { list = []; idx = 0; done.length = 0; visit = null; patient = null; phase = 'idle'; render(); };
  }

  async function share(ids) {
    const { blob } = await exportBackup({ recordingIds: ids });
    const base = `Fonogramma_${safeName(plan.name || 'registrazioni')}_${new Date().toISOString().slice(0, 10)}`;
    // alcuni browser condividono solo certi tipi di file: si prova JSON, poi testo, poi si scarica
    for (const [ext, type] of [['json', 'application/json'], ['txt', 'text/plain']]) {
      const file = new File([blob], `${base}.${ext}`, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Registrazioni Fonogramma', text: 'Registrazioni per il medico: si aprono con Fonogramma → Impostazioni → Importa backup.' }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
    }
    downloadBlob(blob, `${base}.json`);
    toast('File salvato nei download: allegalo a un messaggio per il medico.', { timeout: 6000 });
  }

  render();
  return async () => {
    alive = false;
    cancelAnimationFrame(raf);
    clearInterval(timer);
    if (phase === 'rec') await engine.stopRecording();
    await engine.stop();
  };
}
