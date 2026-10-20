// Auscultazione in tempo reale: cuore (focolai) e torace (12 punti), tracciato PCG,
// waterfall ad alto aggiornamento, metriche live, registrazione, "ultimi N secondi",
// esame guidato punto per punto, ascolto in cuffia, regolazioni ed equalizzatore.
import { esc, el, toast, sheet, fmtNum, fmtDur, patientName, downloadBlob, safeName } from '../util.js';
import { settings, updateSettings, wfConfig, WF_DETAIL } from '../settings.js';
import { HEART_SITES, LUNG_SITES, HEART_TIPS, LUNG_TIPS, siteById } from '../sites.js';
import { presetsFor, getPreset, EQ_LIVE_ID } from '../presets.js';
import { LiveEngine, listInputs } from '../audio/engine.js';
import { DEMO_SCENARIOS } from '../audio/demo.js';
import { encodeWav, decodeAny } from '../audio/wav.js';
import { analyzeSamples, summarize } from '../audio/analyzer.js';
import { Scope } from '../ui/scope.js';
import { Waterfall } from '../ui/waterfall.js';
import { drawEnsemble, drawResp } from '../ui/charts.js';
import { bodyMapSvg, bindBodyMap } from '../ui/bodymap.js';
import { COLORMAPS } from '../ui/colormaps.js';
import { icon } from '../ui/icons.js';
import { openEqEditor } from '../ui/eqeditor.js';
import * as repo from '../store/repo.js';
import { isHeartAbnormal, isLungAbnormal } from './common.js';

let fileSource = null;
const n0 = (v) => fmtNum(v, 0);

function errText(e) {
  if (!e) return 'Errore sconosciuto';
  if (e.name === 'NotAllowedError') return 'Permesso al microfono negato: consentilo nelle impostazioni del browser per questo sito.';
  if (e.name === 'NotFoundError') return 'Nessun ingresso audio trovato: collega il fonendoscopio al jack (o usa il simulatore).';
  if (e.name === 'NotReadableError') return 'Il microfono è occupato da un\'altra applicazione.';
  return e.message || String(e);
}

export async function mount(view, params, query) {
  const visit = query.visit ? await repo.getVisit(query.visit) : null;
  const patient = visit ? await repo.getPatient(visit.patientId) : null;
  let mode = query.mode === 'lung' || query.mode === 'heart' ? query.mode : settings.lastMode || 'heart';
  let site = query.site && siteById(query.site) ? query.site : null;
  if (site) mode = HEART_SITES.some((s) => s.id === site) ? 'heart' : 'lung';
  if (!site) site = (mode === 'heart' ? HEART_SITES : LUNG_SITES)[0].id;
  let presetId = initialPreset();
  let bands = getPreset(presetId).bands;
  const engine = new LiveEngine();
  let running = false, starting = false, recording = false, frozen = false;
  let lastHeart = null, lastLung = null, lastPeak = -120, weakSince = 0;
  let wakeLock = null, raf = 0, guided = null, guidedTimer = 0;

  function initialPreset() {
    const s = siteById(site);
    if (settings.autoPresetBySite && s && s.preset) return s.preset;
    return mode === 'lung' ? settings.presetLung : settings.presetHeart;
  }

  view.innerHTML = `<section class="live">
    <div class="live-top">
      <div class="seg" data-modeseg>
        <button data-m="heart">${icon('heart', 'sm')} Cuore</button>
        <button data-m="lung">${icon('lungs', 'sm')} Torace</button>
      </div>
      <button class="site-btn" data-sitebtn></button>
      <span class="grow"></span>
      ${visit ? `<a class="badge accent" href="#/visit/${esc(visit.id)}?tab=${mode === 'lung' ? 'lung' : 'heart'}" data-ctx>${icon('user', 'sm')} ${esc(patientName(patient))}</a>` : `<span class="badge" title="Le registrazioni andranno tra quelle senza paziente">Senza paziente</span>`}
      <button class="icon-btn" data-info title="Guida al punto di auscultazione">${icon('info')}</button>
      <button class="btn sm" data-guided title="Registra tutti i punti in sequenza">${icon('list', 'sm')} <span class="hide-sm">Esame </span>guidato</button>
    </div>
    <div class="live-body">
      <div class="plots">
        <div class="plot"><canvas data-scope></canvas><span class="plot-tag" data-scopetag></span></div>
        <div class="plot"><canvas data-wf></canvas><span class="plot-tag" data-wftag></span></div>
        <div class="overlay-msg" data-overlay></div>
        <div class="guided-banner hidden" data-banner></div>
      </div>
      <aside class="side">
        <div class="metrics" data-metrics></div>
        <div class="side-extra">
          <div class="card flat" style="padding:10px;margin-bottom:8px">
            <div class="row between"><b data-charttitle>Ciclo medio</b><span class="tiny muted" data-chartsub></span></div>
            <canvas class="ens-canvas" data-chart></canvas>
          </div>
          <div class="card flat guide-card" style="padding:10px" data-guide></div>
          <div class="card flat" style="padding:10px;margin-top:8px" data-siterecs></div>
        </div>
      </aside>
    </div>
    <div class="controls">
      <div class="main-btns">
        <button class="btn primary start" data-start></button>
        <button class="btn rec" data-rec></button>
        <button class="btn" data-grab title="Salva gli ultimi secondi già ascoltati">${icon('back', 'sm')} <span data-grablbl></span></button>
      </div>
      <div class="grow">
        <button class="icon-btn" data-monitor title="Ascolto in cuffia">${icon('headphones')}</button>
        <div class="level" title="Livello del segnale in ingresso"><i data-level style="width:0%"></i></div>
        <div class="chips scroll small" data-presets></div>
        <button class="icon-btn" data-freeze title="Congela la schermata">${icon('snow')}</button>
        <button class="icon-btn" data-snap title="Salva immagine">${icon('camera')}</button>
        <button class="icon-btn" data-adjust title="Regolazioni">${icon('sliders')}</button>
      </div>
    </div>
  </section>`;

  const q = (s) => view.querySelector(s);
  const scope = new Scope(q('[data-scope]'), { capacityS: 30 });
  const wf = new Waterfall(q('[data-wf]'));
  wf.onLevels = (lo, hi) => {
    if (settings.autoLevels) settings.dbRange[mode] = [Math.round(lo), Math.round(hi)];
  };

  // ---------- configurazione ----------
  const span = () => (mode === 'lung' ? settings.spanLung : settings.spanHeart);
  // configurazione del worker in tempo reale (modalità, anello "ultimi N s", waterfall)
  function liveConfig() {
    const w = wfConfig(mode);
    return {
      mode, wfSource: settings.wfSource, loopSeconds: Math.max(settings.loopSeconds, settings.grabSeconds + 2),
      wf: { fftSize: w.fftSize, hop: w.hop, rows: w.rows, fMin: w.fMin, fMax: w.fMax, scale: w.scale },
    };
  }
  const respData = (L) => (L ? { resp: L.resp, respFs: L.respFs, respT0: L.respT0, breaths: L.breathsT, crackles: L.crackles, wheezes: L.wheezes } : null);

  function reconfigure() {
    const w = wfConfig(mode);
    scope.span = span();
    scope.showRaw = settings.showRaw;
    scope.showEnv = settings.showEnvelope && mode === 'heart';
    wf.configure({ fs: engine.sampleRate, hop: w.hop, fftSize: w.fftSize, rows: w.rows, span: span(), fMin: w.fMin, fMax: w.fMax, scale: w.scale });
    wf.setColormap(settings.colormap);
    wf.auto = settings.autoLevels;
    wf.smooth = settings.smoothWaterfall;
    if (!settings.autoLevels) wf.setLevels(...settings.dbRange[mode]);
    engine.configure(liveConfig());
    updateTags();
  }

  function updateTags() {
    const w = wfConfig(mode);
    const name = presetId === EQ_LIVE_ID ? 'EQ personalizzato' : getPreset(presetId).name;
    q('[data-scopetag]').textContent = `PCG · ${name}${settings.denoise && mode === 'heart' ? ' · rid. rumore' : ''}`;
    const res = engine.sampleRate / w.fftSize, rate = engine.sampleRate / w.hop;
    q('[data-wftag]').textContent = `${w.fMin}–${w.fMax} Hz · ${fmtNum(res, 1)} Hz/bin · ${n0(rate)} col/s`;
    q('[data-grablbl]').textContent = `Ultimi ${settings.grabSeconds} s`;
  }

  function syncUrl() {
    const p = new URLSearchParams({ mode, site });
    if (visit) p.set('visit', visit.id);
    history.replaceState(null, '', `#/live?${p}`);
  }

  // ---------- intestazione: modalità, punto, preset ----------
  function renderMode() {
    view.querySelectorAll('[data-modeseg] button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    q('[data-charttitle]').textContent = mode === 'heart' ? 'Ciclo cardiaco medio' : 'Ciclo respiratorio';
    const ctx = q('[data-ctx]');
    if (ctx) ctx.href = `#/visit/${visit.id}?tab=${mode}`;
  }

  function renderSiteBtn() {
    const s = siteById(site);
    q('[data-sitebtn]').innerHTML = `${icon('pin', 'sm')}<span>${esc(s ? s.full : 'Punto')}</span><small>${esc(s ? s.piece : '')}</small>${icon('chevD', 'sm')}`;
  }

  function renderPresets() {
    const box = q('[data-presets]');
    box.innerHTML = '';
    for (const p of presetsFor(mode)) {
      const b = el(`<button class="chip ${p.id === presetId ? 'on' : ''}" title="${esc(p.desc || '')}">${esc(p.name)}</button>`);
      b.onclick = () => setPreset(p.id, true);
      box.appendChild(b);
    }
    const eq = el(`<button class="chip" title="Equalizzatore parametrico">EQ…</button>`);
    eq.onclick = openEq;
    box.appendChild(eq);
  }

  function setPreset(id, persist) {
    presetId = id;
    bands = getPreset(id).bands;
    if (engine.running) engine.setBands(bands);
    if (persist) updateSettings(mode === 'lung' ? { presetLung: id } : { presetHeart: id });
    renderPresets();
    updateTags();
  }

  function setSite(id) {
    site = id;
    const s = siteById(id);
    if (settings.autoPresetBySite && s && s.preset) setPreset(s.preset, false);
    renderSiteBtn();
    renderGuide();
    renderSiteRecs();
    syncUrl();
  }

  function setMode(m) {
    if (m === mode || recording) return;
    mode = m;
    updateSettings({ lastMode: m });
    site = (m === 'heart' ? HEART_SITES : LUNG_SITES)[0].id;
    presetId = initialPreset();
    bands = getPreset(presetId).bands;
    lastHeart = lastLung = null;
    scope.reset();
    wf.lung = null;
    if (engine.running) {
      engine.setBands(bands);
      engine.setDenoise(settings.denoise && mode === 'heart', settings.denoiseStrength);
      scope.setRate(engine.sampleRate, Math.round(engine.sampleRate / 1000));
      reconfigure();
    }
    renderMode(); renderSiteBtn(); renderPresets(); renderGuide(); renderSiteRecs(); renderMetrics(); drawChart(); updateTags(); syncUrl();
  }

  // ---------- guida e registrazioni del punto ----------
  function renderGuide() {
    const s = siteById(site);
    const tips = mode === 'heart' ? HEART_TIPS : LUNG_TIPS;
    q('[data-guide]').innerHTML = s ? `<b>${esc(s.full)}</b>
      <div class="small muted">${esc(s.where)}</div>
      <div class="row" style="margin:6px 0"><span class="badge accent">${esc(s.piece)}</span>${s.lobe ? `<span class="badge">${esc(s.lobe)}</span>` : ''}</div>
      ${s.position ? `<div class="small">${esc(s.position)}</div>` : ''}
      ${s.listen ? `<ul class="small">${s.listen.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <details class="small" style="margin-top:6px"><summary class="muted">Consigli di auscultazione</summary><ul>${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : '';
  }

  async function renderSiteRecs() {
    const box = q('[data-siterecs]');
    if (!visit) { box.innerHTML = `<div class="small muted">Auscultazione rapida: le registrazioni restano nell'archivio "senza paziente" e si possono assegnare dopo.</div>`; return; }
    const recs = (await repo.listRecordings({ visitId: visit.id })).filter((r) => r.site === site);
    box.innerHTML = `<b class="small">Registrazioni in questo punto</b>` + (recs.length
      ? `<div class="col" style="gap:4px;margin-top:6px">${recs.map((r) => `<a class="rec-chip" href="#/rec/${esc(r.id)}">${icon('play', 'sm')} ${fmtDur(r.duration)} · ${new Date(r.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</a>`).join('')}</div>`
      : `<div class="small muted">Nessuna ancora.</div>`);
  }

  // ---------- metriche ----------
  const card = (cls, k, v, d) => `<div class="metric ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d || '&nbsp;'}</div></div>`;
  const sqiCard = (sqi) => `<div class="metric"><div class="k">Qualità segnale</div><div class="v">${sqi ?? '—'}<small>/100</small></div><div class="sqi-bar"><i style="width:${sqi || 0}%"></i></div></div>`;

  function renderMetrics() {
    const box = q('[data-metrics]');
    if (mode === 'heart') {
      const m = (lastHeart && lastHeart.metrics) || {};
      const extra = [m.clickCount ? `click ${m.clickCount}` : '', m.snapCount ? `schiocco ${m.snapCount}` : ''].filter(Boolean).join(' · ');
      const mur = m.murmurSys && m.murmurDia ? 'Sisto-diast.' : m.murmurSys ? 'Sistolico' : m.murmurDia ? 'Diastolico' : lastHeart ? 'No' : '—';
      box.innerHTML = [
        card('big', 'Frequenza cardiaca', m.bpm ? `${n0(m.bpm)}<small> bpm</small>` : '—', m.bpm ? `± ${n0(m.bpmStd || 0)} · ${esc(m.rhythm)}` : lastHeart && lastHeart.reason ? esc(lastHeart.reason) : 'avvia l\'ascolto'),
        card(m.rhythm === 'Irregolare' ? 'alert' : '', 'Ritmo', esc(m.rhythm || '—'), m.rrCv !== null && m.rrCv !== undefined ? `variabilità RR ${n0(m.rrCv * 100)}%` : ''),
        card('', 'Sistole / Diastole', m.sysMs ? `${n0(m.sysMs)}<small> / </small>${n0(m.diaMs)}<small> ms</small>` : '—', m.sdRatio ? `rapporto D/S ${fmtNum(m.sdRatio, 2)}` : ''),
        card('', 'Rapporto S1/S2', fmtNum(m.s1s2, 2), m.s1Freq ? `S1 ${n0(m.s1Freq)} Hz · S2 ${n0(m.s2Freq)} Hz` : ''),
        card('', 'Sdoppiamento S2', m.splitMs ? `${n0(m.splitMs)}<small> ms</small>` : lastHeart ? 'no' : '—', m.splitPct ? `${n0(m.splitPct)}% dei battiti` : ''),
        card(m.s3Pct >= 30 || m.s4Pct >= 30 ? 'alert' : '', 'Toni aggiunti', lastHeart ? `S3 ${m.s3Count || 0} · S4 ${m.s4Count || 0}` : '—', extra || (lastHeart ? 'nessun click' : '')),
        card(m.murmurSys || m.murmurDia ? 'alert' : '', 'Soffio', mur, esc([m.murmurSysShape || m.murmurDiaShape, m.murmurIntensity].filter(Boolean).join(' · '))),
        sqiCard(m.sqi),
      ].join('');
    } else {
      const l = (lastLung && lastLung.metrics) || {};
      const h = (lastHeart && lastHeart.metrics) || {};
      box.innerHTML = [
        card('big', 'Frequenza respiratoria', l.rr ? `${n0(l.rr)}<small> atti/min</small>` : '—', l.ieRatio ? `I:E ≈ 1:${fmtNum(l.ieRatio, 1)} (indicativo)` : 'respira profondamente a bocca aperta'),
        card(l.cracklesSignificant ? 'alert' : '', 'Crepitii', lastLung ? `${fmtNum(l.cracklesPerBreath ?? 0, 1)}<small> /respiro</small>` : '—', lastLung ? `fini ${l.cracklesFine} · grossolani ${l.cracklesCoarse}` : ''),
        card(l.wheezes ? 'alert' : '', 'Sibili', lastLung ? `${l.wheezes}` : '—', l.wheezeFreq ? `${n0(l.wheezeFreq)} Hz · ${n0(l.wheezeDurPct)}% del tempo` : ''),
        card(l.rhonchi ? 'alert' : '', 'Ronchi', lastLung ? `${l.rhonchi}` : '—', l.polyphonic ? 'polifonici' : ''),
        card('', 'Murmure', l.intensityDb !== undefined && l.intensityDb !== null ? `${n0(l.intensityDb)}<small> dB</small>` : '—', l.dynamicDb ? `dinamica respiro ${n0(l.dynamicDb)} dB` : ''),
        card('', 'Freq. cardiaca', h.bpm ? `${n0(h.bpm)}<small> bpm</small>` : '—', l.toneHz ? `tono di disturbo ${l.toneHz} Hz` : ''),
        sqiCard(l.sqi),
      ].join('');
    }
  }

  function drawChart() {
    const cv = q('[data-chart]');
    if (!cv.offsetParent) return;
    if (mode === 'heart') {
      drawEnsemble(cv, lastHeart && lastHeart.ensemble);
      q('[data-chartsub]').textContent = lastHeart && lastHeart.ensemble ? 'inviluppo d\'ampiezza, ultimi 8 s' : '';
    } else {
      drawResp(cv, respData(lastLung));
      q('[data-chartsub]').textContent = lastLung ? 'ultimi 10 s · ▲ respiri · | crepitii' : '';
    }
  }

  // ---------- pulsanti ----------
  function renderButtons() {
    const st = q('[data-start]');
    st.innerHTML = running ? `${icon('stop', 'sm')} Ferma` : starting ? 'Avvio…' : `${icon('play', 'sm')} Avvia`;
    st.classList.toggle('primary', !running);
    st.disabled = starting;
    const rb = q('[data-rec]');
    rb.innerHTML = recording ? `${icon('stop', 'sm')} <span data-rectime>0:00</span>` : `${icon('rec', 'sm')} Registra`;
    rb.classList.toggle('recording', recording);
    rb.disabled = !running || !!guided;
    q('[data-grab]').disabled = !running || recording;
    q('[data-monitor]').classList.toggle('on', settings.monitor);
    q('[data-freeze]').classList.toggle('on', frozen);
    q('[data-guided]').disabled = recording;
    renderOverlay();
  }

  function renderOverlay(error) {
    const ov = q('[data-overlay]');
    if (running && !error) { ov.innerHTML = ''; return; }
    const src = settings.source === 'demo' ? `Simulatore: ${esc((DEMO_SCENARIOS.find((d) => d.id === settings.demoId) || {}).name || '')}`
      : settings.source === 'file' && fileSource ? `File: ${esc(fileSource.name)}` : 'Fonendoscopio (ingresso jack / microfono)';
    ov.innerHTML = `<div class="card col" style="text-align:left">
      ${error ? `<div style="color:var(--bad);font-weight:700">${esc(error)}</div>` : ''}
      <b>${icon(mode === 'heart' ? 'heart' : 'lungs')} ${mode === 'heart' ? 'Auscultazione cardiaca' : 'Auscultazione toracica'}</b>
      <div class="small muted">Sorgente: ${src}</div>
      <div class="small">Posiziona ${esc((siteById(site) || {}).piece || 'il fonendoscopio').toLowerCase()} su: <b>${esc((siteById(site) || {}).full || '')}</b></div>
      <div class="row"><button class="btn primary" data-ovstart>${icon('play', 'sm')} Avvia</button><button class="btn" data-ovadj>${icon('sliders', 'sm')} Sorgente</button></div>
    </div>`;
    ov.querySelector('[data-ovstart]').onclick = start;
    ov.querySelector('[data-ovadj]').onclick = openAdjust;
  }

  // ---------- motore ----------
  engine.on('frame', (d) => {
    scope.push(d);
    wf.push(d.cols, d.ncols, d.total);
    if (d.peakDb !== undefined) {
      lastPeak = d.peakDb;
      const lv = q('[data-level]');
      lv.style.width = `${Math.max(0, Math.min(100, ((d.peakDb + 70) / 70) * 100))}%`;
      if (d.peakDb > -1) q('[data-scopetag]').textContent = 'Segnale saturato: riduci il volume d\'ingresso';
      if (d.peakDb < -60 && engine.source === 'mic') {
        if (!weakSince) weakSince = performance.now();
        else if (performance.now() - weakSince > 4000) { weakSince = performance.now() + 20000; toast('Segnale molto debole: controlla il jack del fonendoscopio e il volume d\'ingresso del dispositivo', { type: 'warn' }); }
      } else if (weakSince && weakSince < performance.now()) weakSince = 0;
    }
    if (recording && d.recSeconds !== null) {
      const t = q('[data-rectime]');
      if (t) t.textContent = fmtDur(d.recSeconds);
      if (!guided && d.recSeconds >= settings.maxRecSeconds) stopRecording();
    }
  });
  engine.on('analysis', (a) => {
    if (a.heart) {
      scope.setMarkers(a.heart.markers, a.span[0], a.span[1]);
      wf.markers = scope.markers;
      scope.env = a.heart.env ? { data: a.heart.env, envFs: a.heart.envFs, start: a.heart.envStart } : null;
      lastHeart = a.heart;
    }
    if (mode === 'lung' && a.lung) { lastLung = a.lung; wf.lung = a.lung; scope.lungEvents = a.lung; }
    else { wf.lung = null; scope.lungEvents = null; }
    renderMetrics();
    drawChart();
  });
  engine.on('error', (e) => toast(errText(e), { type: 'error' }));

  async function requestWake() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }

  async function start() {
    if (running || starting) return;
    starting = true;
    renderButtons();
    try {
      const source = settings.source === 'file' && !fileSource ? 'mic' : settings.source;
      await engine.start({
        source, deviceId: settings.deviceId, channel: settings.inputChannel, demoId: settings.demoId, file: fileSource,
        bands, gainDb: settings.gainDb, monitor: settings.monitor, volumeDb: settings.volumeDb,
        denoise: settings.denoise && mode === 'heart', denoiseStrength: settings.denoiseStrength,
        config: liveConfig(),
      });
      running = true;
      scope.setRate(engine.sampleRate, Math.round(engine.sampleRate / 1000));
      scope.reset();
      reconfigure();
      requestWake();
      if (settings.monitor && source === 'mic') toast('Ascolto in cuffia attivo: usa le cuffie per evitare il ritorno (fischio).', { timeout: 3000 });
    } catch (e) {
      running = false;
      if (e && e.name === 'AbortError') return;
      await engine.stop();
      renderOverlay(errText(e));
      toast(errText(e), { type: 'error', timeout: 6000 });
    } finally {
      starting = false;
      renderButtons();
    }
  }

  async function stop() {
    if (recording) await stopRecording();
    await stopGuided(false);
    await engine.stop();
    running = false;
    try { wakeLock && (await wakeLock.release()); } catch {}
    wakeLock = null;
    renderButtons();
  }

  // ---------- registrazione ----------
  async function saveRec(samples, fs, extra = {}) {
    if (!samples || samples.length < fs * 1) { toast('Registrazione troppo breve', { type: 'warn' }); return null; }
    const s = siteById(site);
    const rec = {
      kind: mode, site, label: s ? s.full : 'Registrazione', visitId: visit ? visit.id : null, patientId: patient ? patient.id : null,
      duration: samples.length / fs, fs, preset: presetId, bands, gainDb: settings.gainDb, source: engine.source || settings.source,
      device: engine.inputLabel || '', ...extra,
    };
    const saved = await repo.saveRecording(rec, encodeWav(samples, fs));
    toast(`Salvata: ${rec.label} (${fmtDur(rec.duration)})`, { action: { label: 'Apri', run: () => { location.hash = `#/rec/${saved.id}`; } } });
    renderSiteRecs();
    analyzeSamples(samples, fs, mode).then(async (res) => {
      const cur = await repo.getRecording(saved.id);
      if (!cur) return;
      cur.analysis = summarize(res, mode);
      cur.abnormal = mode === 'lung' ? isLungAbnormal(cur.analysis.lung) : isHeartAbnormal(cur.analysis.heart);
      await repo.saveRecording(cur);
    }).catch((e) => console.warn('Analisi registrazione:', e));
    return saved;
  }

  function startRecording() {
    if (!running || recording) return;
    engine.startRecording();
    recording = true;
    renderButtons();
  }

  async function stopRecording(extra) {
    if (!recording) return null;
    recording = false;
    renderButtons();
    const r = await engine.stopRecording();
    return r ? saveRec(r.samples, r.fs, extra) : null;
  }

  async function grab() {
    if (!running) return;
    const r = await engine.grab(settings.grabSeconds);
    if (r) saveRec(r.samples, r.fs, { grabbed: true });
  }

  // ---------- esame guidato ----------
  function guidedList() { return mode === 'heart' ? HEART_SITES : LUNG_SITES; }

  async function startGuided() {
    if (guided || recording) return;
    if (!running) await start();
    if (!running) return;
    const list = guidedList();
    guided = { i: Math.max(0, list.findIndex((s) => s.id === site)), phase: 'ready', saved: 0, dur: mode === 'heart' ? settings.guidedHeartS : settings.guidedLungS, t0: 0 };
    setSite(list[guided.i].id);
    renderGuided();
    renderButtons();
    guidedTimer = setInterval(guidedTick, 150);
  }

  async function stopGuided(showDone = true) {
    if (!guided) return;
    clearInterval(guidedTimer);
    let saved = guided.saved;
    guided = null;
    // il tratto già registrato del punto corrente viene salvato, non scartato
    if (recording && (await stopRecording({ guided: true, partial: true }))) saved++;
    q('[data-banner]').classList.add('hidden');
    renderButtons();
    if (showDone && saved) toast(`Esame guidato: ${saved} registrazioni salvate`);
  }

  async function guidedNext() {
    const list = guidedList();
    guided.i++;
    if (guided.i >= list.length) { guided.phase = 'done'; renderGuided(); return; }
    setSite(list[guided.i].id);
    guided.phase = 'ready';
    renderGuided();
  }

  async function guidedTick() {
    if (!guided) return;
    const now = performance.now();
    if (guided.phase === 'count') {
      const left = Math.ceil(settings.guidedCountdown - (now - guided.t0) / 1000);
      const c = q('[data-banner] .count');
      if (c) c.textContent = left;
      if (left <= 0) { guided.phase = 'rec'; guided.t0 = now; startRecording(); renderGuided(); }
    } else if (guided.phase === 'rec') {
      const el2 = (now - guided.t0) / 1000;
      const bar = q('[data-banner] .progress i');
      if (bar) bar.style.width = `${Math.min(100, (el2 / guided.dur) * 100)}%`;
      const tt = q('[data-banner] [data-gt]');
      if (tt) tt.textContent = `${Math.max(0, Math.ceil(guided.dur - el2))} s`;
      if (el2 >= guided.dur) {
        guided.phase = 'saving';
        renderGuided();
        const saved = await stopRecording({ guided: true });
        if (!guided) return;
        if (saved) guided.saved++;
        guidedNext();
      }
    }
  }

  function renderGuided() {
    const b = q('[data-banner]');
    if (!guided) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    const list = guidedList();
    const s = list[Math.min(guided.i, list.length - 1)];
    const head = `<div class="row between"><b>Esame guidato · ${Math.min(guided.i + 1, list.length)}/${list.length}</b><button class="icon-btn" data-gx title="Interrompi">${icon('x', 'sm')}</button></div>`;
    if (guided.phase === 'done') {
      b.innerHTML = `${head}<p>Completato: <b>${guided.saved}</b> registrazioni salvate.</p>
        <div class="row">${visit ? `<a class="btn primary" href="#/visit/${esc(visit.id)}?tab=${mode}">Apri la visita</a>` : ''}<button class="btn" data-gclose>Chiudi</button></div>`;
    } else if (guided.phase === 'ready') {
      b.innerHTML = `${head}<div style="margin:6px 0"><b style="font-size:1.1rem">${s.n}. ${esc(s.full)}</b><div class="small">${esc(s.where)}</div>
        <div class="small muted">${esc(s.piece)}${s.position ? ' · ' + esc(s.position) : ''}</div></div>
        <div class="row"><button class="btn primary" data-ggo>${icon('rec', 'sm')} Pronto: registra ${guided.dur} s</button><button class="btn" data-gskip>${icon('skip', 'sm')} Salta</button></div>`;
    } else if (guided.phase === 'count') {
      b.innerHTML = `${head}<div class="row"><div class="count">${settings.guidedCountdown}</div><div><b>${esc(s.full)}</b><div class="small">Tieni ferma la mano…</div></div></div>`;
    } else if (guided.phase === 'rec') {
      b.innerHTML = `${head}<div class="row between" style="margin:6px 0"><b>${icon('rec', 'sm')} ${esc(s.full)}</b><span class="num" data-gt>${guided.dur} s</span></div><div class="progress"><i style="width:0%"></i></div>`;
    } else {
      b.innerHTML = `${head}<div class="small">Salvataggio…</div>`;
    }
    b.querySelector('[data-gx]').onclick = () => stopGuided(true);
    const go = b.querySelector('[data-ggo]');
    if (go) go.onclick = () => { guided.phase = 'count'; guided.t0 = performance.now(); renderGuided(); };
    const sk = b.querySelector('[data-gskip]');
    if (sk) sk.onclick = guidedNext;
    const cl = b.querySelector('[data-gclose]');
    if (cl) cl.onclick = () => stopGuided(false);
  }

  // ---------- selettore del punto ----------
  async function siteStatus() {
    const st = {};
    if (!visit) return st;
    for (const r of await repo.listRecordings({ visitId: visit.id })) {
      if (!r.site) continue;
      const abn = r.abnormal;
      st[r.site] = abn ? 'abn' : st[r.site] || 'done';
    }
    return st;
  }

  async function openSitePicker() {
    const list = guidedList();
    let side = (siteById(site) || {}).view || 'front';
    const status = await siteStatus();
    const body = el(`<div class="col">
      ${mode === 'lung' ? `<div class="seg" data-side><button data-v="front">Anteriore</button><button data-v="back">Posteriore</button></div>` : ''}
      <div data-map style="max-width:340px;margin:0 auto;width:100%"></div>
      <div class="list" data-list></div>
      <details class="small"><summary class="muted">Consigli</summary><ul>${(mode === 'heart' ? HEART_TIPS : LUNG_TIPS).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>
    </div>`);
    const render = () => {
      body.querySelector('[data-map]').innerHTML = bodyMapSvg({ view: side, sites: list, selected: site, status });
      body.querySelectorAll('[data-side] button').forEach((b) => b.classList.toggle('on', b.dataset.v === side));
      body.querySelector('[data-list]').innerHTML = list.filter((s) => mode === 'heart' || s.view === side).map((s) => `
        <div class="list-item" data-site="${s.id}">
          <div class="site-num ${status[s.id] || ''}">${s.n}</div>
          <div class="grow"><b>${esc(s.full)}</b>${s.optional ? ' <span class="badge">facoltativo</span>' : ''}<div class="small muted">${esc(s.where)} · ${esc(s.piece)}</div></div>
          ${s.id === site ? icon('check') : ''}</div>`).join('');
    };
    render();
    const sh = sheet({ title: mode === 'heart' ? 'Focolaio di auscultazione' : 'Punto di auscultazione', body });
    body.querySelectorAll('[data-side] button').forEach((b) => { b.onclick = () => { side = b.dataset.v; render(); }; });
    const pick = (id) => { setSite(id); sh.close(); };
    bindBodyMap(body.querySelector('[data-map]'), pick);
    body.querySelector('[data-list]').onclick = (e) => { const it = e.target.closest('[data-site]'); if (it) pick(it.dataset.site); };
  }

  // ---------- equalizzatore e regolazioni ----------
  function openEq() {
    const ed = openEqEditor({
      bands, fs: engine.sampleRate,
      onChange: (b) => { bands = b; presetId = EQ_LIVE_ID; if (engine.running) engine.setBands(bands); renderPresets(); updateTags(); },
    });
    ed.onSaved((p) => { setPreset(p.id, true); });
  }

  async function openAdjust() {
    const inputs = await listInputs().catch(() => []);
    const w = mode === 'lung' ? settings.wfLung : settings.wfHeart;
    const scen = DEMO_SCENARIOS.filter((d) => d.mode === mode);
    const range = settings.dbRange[mode];
    const body = el(`<div class="col">
      <h4>Sorgente</h4>
      <div class="seg" data-src><button data-v="mic">${icon('mic', 'sm')} Fonendoscopio</button><button data-v="demo">${icon('activity', 'sm')} Simulatore</button><button data-v="file">${icon('file', 'sm')} File</button></div>
      <div data-srcopts></div>
      <h4>Livelli</h4>
      <label class="field"><span>Guadagno d'ingresso: <b data-gv>${settings.gainDb} dB</b></span><input type="range" min="-12" max="40" step="1" value="${settings.gainDb}" data-gain></label>
      <label class="field"><span>Volume cuffie: <b data-vv>${settings.volumeDb} dB</b> (limitatore di protezione sempre attivo)</span><input type="range" min="-20" max="30" step="1" value="${settings.volumeDb}" data-vol></label>
      <label class="check"><input type="checkbox" data-dn ${settings.denoise ? 'checked' : ''}> Riduzione rumore ambientale (solo cuore)</label>
      <div class="chips small" data-dns></div>
      <h4>Waterfall</h4>
      <div class="field"><span>Dettaglio / velocità di aggiornamento</span><div class="seg" data-detail>
        ${Object.keys(WF_DETAIL[mode]).map((k) => `<button data-v="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div></div>
      <div class="form-grid">
        <label class="field"><span>Freq. min (Hz)</span><input type="number" min="0" max="2000" value="${w.fMin}" data-fmin></label>
        <label class="field"><span>Freq. max (Hz)</span><input type="number" min="100" max="12000" value="${w.fMax}" data-fmax></label>
        <label class="field"><span>Scala</span><select data-scale><option value="lin" ${w.scale === 'lin' ? 'selected' : ''}>Lineare</option><option value="log" ${w.scale === 'log' ? 'selected' : ''}>Logaritmica</option></select></label>
        <label class="field"><span>Finestra (s)</span><input type="number" min="2" max="20" step="1" value="${span()}" data-span></label>
      </div>
      <div class="field"><span>Mappa colori</span><div class="chips small" data-cmap></div></div>
      <label class="check"><input type="checkbox" data-auto ${settings.autoLevels ? 'checked' : ''}> Livelli automatici</label>
      <div class="form-grid" data-manual>
        <label class="field"><span>dB min</span><input type="number" step="1" value="${Math.round(range[0])}" data-dbmin></label>
        <label class="field"><span>dB max</span><input type="number" step="1" value="${Math.round(range[1])}" data-dbmax></label>
      </div>
      <label class="check"><input type="checkbox" data-wfraw ${settings.wfSource === 'raw' ? 'checked' : ''}> Waterfall dal segnale grezzo (non filtrato)</label>
      <label class="check"><input type="checkbox" data-smooth ${settings.smoothWaterfall ? 'checked' : ''}> Immagine sfumata</label>
      <h4>Tracciato</h4>
      <label class="check"><input type="checkbox" data-env ${settings.showEnvelope ? 'checked' : ''}> Mostra inviluppo dei toni</label>
      <label class="check"><input type="checkbox" data-raw ${settings.showRaw ? 'checked' : ''}> Mostra anche il segnale grezzo</label>
      <label class="check"><input type="checkbox" data-autop ${settings.autoPresetBySite ? 'checked' : ''}> Filtro consigliato automatico per focolaio</label>
      <button class="btn" data-eq>${icon('sliders', 'sm')} Equalizzatore parametrico…</button>
    </div>`);
    const restartIfRunning = async () => { if (running) { await stop(); await start(); } };
    const renderSrc = () => {
      body.querySelectorAll('[data-src] button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.source));
      const o = body.querySelector('[data-srcopts]');
      if (settings.source === 'mic') {
        o.innerHTML = `<div class="form-grid">
          <label class="field"><span>Ingresso audio</span><select data-dev><option value="">Predefinito di sistema</option>
            ${inputs.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === settings.deviceId ? 'selected' : ''}>${esc(d.label || 'Ingresso ' + d.deviceId.slice(0, 6))}</option>`).join('')}</select></label>
          <label class="field"><span>Canale</span><select data-ch>
            ${[['mix', 'Mono (somma)'], ['L', 'Sinistro'], ['R', 'Destro']].map(([v, l]) => `<option value="${v}" ${settings.inputChannel === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
          <div class="small muted">Elaborazioni del sistema (cancellazione eco, soppressione rumore, controllo automatico del guadagno) disattivate per un segnale fedele.</div>`;
        o.querySelector('[data-dev]').onchange = (e) => { updateSettings({ deviceId: e.target.value }); restartIfRunning(); };
        o.querySelector('[data-ch]').onchange = (e) => { updateSettings({ inputChannel: e.target.value }); restartIfRunning(); };
      } else if (settings.source === 'demo') {
        o.innerHTML = `<label class="field"><span>Scenario simulato</span><select data-demo>${scen.map((d) => `<option value="${d.id}" ${d.id === settings.demoId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>`;
        if (!scen.some((d) => d.id === settings.demoId)) updateSettings({ demoId: scen[0].id });
        o.querySelector('[data-demo]').onchange = (e) => { updateSettings({ demoId: e.target.value }); restartIfRunning(); };
      } else {
        o.innerHTML = `<label class="btn">${icon('file', 'sm')} ${fileSource ? esc(fileSource.name) : 'Scegli file WAV/MP3…'}<input type="file" accept="audio/*,.wav" hidden data-file></label>
          <div class="small muted">Il file viene riprodotto in loop come se fosse il fonendoscopio (utile per vecchie registrazioni o Holter).</div>`;
        o.querySelector('[data-file]').onchange = async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            const d = await decodeAny(await f.arrayBuffer());
            fileSource = { ...d, name: f.name };
            renderSrc();
            restartIfRunning();
          } catch (err) { toast('File audio non leggibile: ' + err.message, { type: 'error' }); }
        };
      }
    };
    renderSrc();
    body.querySelectorAll('[data-src] button').forEach((b) => { b.onclick = () => { updateSettings({ source: b.dataset.v }); renderSrc(); if (b.dataset.v !== 'file' || fileSource) restartIfRunning(); renderOverlay(); }; });
    body.querySelector('[data-gain]').oninput = (e) => { const v = +e.target.value; body.querySelector('[data-gv]').textContent = `${v} dB`; updateSettings({ gainDb: v }); engine.setGain(v); };
    body.querySelector('[data-vol]').oninput = (e) => { const v = +e.target.value; body.querySelector('[data-vv]').textContent = `${v} dB`; updateSettings({ volumeDb: v }); engine.setMonitor(settings.monitor, v); };
    body.querySelector('[data-dn]').onchange = (e) => { updateSettings({ denoise: e.target.checked }); engine.setDenoise(e.target.checked && mode === 'heart', settings.denoiseStrength); updateTags(); };
    const dns = body.querySelector('[data-dns]');
    [['Lieve', 1.0], ['Media', 1.5], ['Forte', 2.2]].forEach(([l, v]) => {
      const c = el(`<button class="chip ${settings.denoiseStrength === v ? 'on' : ''}">${l}</button>`);
      c.onclick = () => { updateSettings({ denoiseStrength: v }); dns.querySelectorAll('.chip').forEach((x) => x.classList.remove('on')); c.classList.add('on'); engine.setDenoise(settings.denoise && mode === 'heart', v); };
      dns.appendChild(c);
    });
    const wkey = mode === 'lung' ? 'wfLung' : 'wfHeart';
    const setW = (patch) => { updateSettings({ [wkey]: patch }); if (running) reconfigure(); else updateTags(); };
    const detail = body.querySelector('[data-detail]');
    const rd = () => detail.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings[wkey].detail));
    rd();
    detail.querySelectorAll('button').forEach((b) => { b.onclick = () => { setW({ detail: b.dataset.v }); rd(); }; });
    body.querySelector('[data-fmin]').onchange = (e) => setW({ fMin: Math.max(0, +e.target.value) });
    body.querySelector('[data-fmax]').onchange = (e) => setW({ fMax: Math.min(engine.sampleRate / 2 - 100, Math.max(settings[wkey].fMin + 50, +e.target.value)) });
    body.querySelector('[data-scale]').onchange = (e) => setW({ scale: e.target.value });
    body.querySelector('[data-span]').onchange = (e) => { const v = Math.max(2, Math.min(20, +e.target.value)); updateSettings(mode === 'lung' ? { spanLung: v } : { spanHeart: v }); if (running) reconfigure(); };
    const cm = body.querySelector('[data-cmap]');
    for (const c of COLORMAPS) {
      const b = el(`<button class="chip ${settings.colormap === c.id ? 'on' : ''}">${c.name}</button>`);
      b.onclick = () => { updateSettings({ colormap: c.id }); wf.setColormap(c.id); cm.querySelectorAll('.chip').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
      cm.appendChild(b);
    }
    const manual = body.querySelector('[data-manual]');
    const showManual = () => manual.classList.toggle('hidden', settings.autoLevels);
    showManual();
    body.querySelector('[data-auto]').onchange = (e) => { updateSettings({ autoLevels: e.target.checked }); wf.auto = e.target.checked; if (e.target.checked) wf.autoLevels(true); showManual(); };
    const setRange = () => {
      const lo = +body.querySelector('[data-dbmin]').value, hi = +body.querySelector('[data-dbmax]').value;
      settings.dbRange[mode] = [lo, Math.max(lo + 10, hi)];
      updateSettings({ dbRange: settings.dbRange });
      wf.setLevels(...settings.dbRange[mode]);
    };
    body.querySelector('[data-dbmin]').onchange = setRange;
    body.querySelector('[data-dbmax]').onchange = setRange;
    body.querySelector('[data-wfraw]').onchange = (e) => { updateSettings({ wfSource: e.target.checked ? 'raw' : 'filtered' }); if (running) reconfigure(); };
    body.querySelector('[data-smooth]').onchange = (e) => { updateSettings({ smoothWaterfall: e.target.checked }); wf.smooth = e.target.checked; };
    body.querySelector('[data-env]').onchange = (e) => { updateSettings({ showEnvelope: e.target.checked }); scope.showEnv = e.target.checked && mode === 'heart'; };
    body.querySelector('[data-raw]').onchange = (e) => { updateSettings({ showRaw: e.target.checked }); scope.showRaw = e.target.checked; };
    body.querySelector('[data-autop]').onchange = (e) => updateSettings({ autoPresetBySite: e.target.checked });
    body.querySelector('[data-eq]').onclick = () => { sh.close(); openEq(); };
    const sh = sheet({ title: 'Regolazioni', body, wide: true });
  }

  function snapshot() {
    const a = q('[data-scope]'), b = q('[data-wf]');
    const c = document.createElement('canvas');
    c.width = Math.max(a.width, b.width);
    c.height = a.height + b.height + 4;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(a, 0, 0);
    ctx.drawImage(b, 0, a.height + 4);
    const s = siteById(site);
    c.toBlob((blob) => downloadBlob(blob, `Fonogramma_${safeName(patient ? patient.lastName : 'rapida')}_${safeName(s ? s.name : site)}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`));
  }

  // ---------- eventi UI ----------
  view.querySelectorAll('[data-modeseg] button').forEach((b) => { b.onclick = () => setMode(b.dataset.m); });
  q('[data-sitebtn]').onclick = openSitePicker;
  q('[data-start]').onclick = () => (running ? stop() : start());
  q('[data-rec]').onclick = () => (recording ? stopRecording() : startRecording());
  q('[data-grab]').onclick = grab;
  q('[data-monitor]').onclick = () => { updateSettings({ monitor: !settings.monitor }); engine.setMonitor(settings.monitor, settings.volumeDb); renderButtons(); };
  q('[data-freeze]').onclick = () => { frozen = !frozen; scope.frozen = wf.frozen = frozen; if (!frozen) { scope.dirty = wf.dirty = true; } renderButtons(); };
  q('[data-snap]').onclick = snapshot;
  q('[data-adjust]').onclick = openAdjust;
  q('[data-guided]').onclick = () => (guided ? stopGuided(true) : startGuided());
  q('[data-info]').onclick = () => {
    const body = el(`<div class="col guide-card"></div>`);
    body.innerHTML = q('[data-guide]').innerHTML + `<div style="margin-top:8px">${q('[data-siterecs]').innerHTML}</div>
      <b class="small" style="margin-top:8px">${mode === 'heart' ? 'Ciclo cardiaco medio' : 'Ciclo respiratorio'}</b><canvas class="ens-canvas" style="height:130px" data-chart2></canvas>`;
    sheet({ title: 'Guida', body });
    requestAnimationFrame(() => {
      const cv = body.querySelector('[data-chart2]');
      if (mode === 'heart') drawEnsemble(cv, lastHeart && lastHeart.ensemble);
      else drawResp(cv, respData(lastLung));
    });
  };

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || document.querySelector('.sheet-wrap')) return;
    if (e.code === 'Space') { e.preventDefault(); running ? stop() : start(); }
    else if (e.key === 'r' || e.key === 'R') recording ? stopRecording() : startRecording();
    else if (e.key === 'g' || e.key === 'G') grab();
    else if (e.key === 'f' || e.key === 'F') q('[data-freeze]').click();
  };
  document.addEventListener('keydown', onKey);

  const ro = new ResizeObserver(() => { scope.resize(); wf.resize(); drawChart(); });
  ro.observe(q('.plots'));
  ro.observe(q('[data-chart]'));
  const loop = () => { scope.draw(); wf.draw(); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);

  const onVis = () => { if (document.visibilityState === 'visible' && running) requestWake(); };
  document.addEventListener('visibilitychange', onVis);

  renderMode(); renderSiteBtn(); renderPresets(); renderGuide(); renderSiteRecs(); renderMetrics(); renderButtons(); updateTags(); syncUrl();
  if (query.autostart === '1') start();

  return async () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    if (guided) { clearInterval(guidedTimer); guided = null; }
    if (recording) { recording = false; const r = await engine.stopRecording(); if (r) await saveRec(r.samples, r.fs); }
    await engine.stop();
    try { wakeLock && (await wakeLock.release()); } catch {}
  };
}
