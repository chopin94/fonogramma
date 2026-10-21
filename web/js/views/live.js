// Auscultazione in tempo reale: cuore (focolai) e torace (12 punti), tracciato PCG,
// waterfall ad alto aggiornamento, metriche live, registrazione, "ultimi N secondi",
// esame guidato punto per punto, ascolto in cuffia, regolazioni ed equalizzatore.
import { esc, el, toast, sheet, fmtNum, fmtDur, patientName, downloadBlob, safeName } from '../util.js';
import { settings, updateSettings, wfConfig, WF_DETAIL } from '../settings.js';
import { HEART_SITES, LUNG_SITES, HEART_TIPS, LUNG_TIPS, siteById } from '../sites.js';
import { presetsFor, getPreset, EQ_LIVE_ID } from '../presets.js';
import { LiveEngine, listInputs } from '../audio/engine.js';
import { INPUT_TYPES, INPUT_KINDS, inputAdvice, inputRecord, worstLevel, diagnosticsText, probeChannels, lastChannelProbe } from '../audio/input.js';
import { Coach, Tally, coachState, ISSUE_NAMES } from '../coach.js';
import { openInputCheck, lastCheck, checkLines } from './inputcheck.js';
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
  let lastHeart = null, lastLung = null;
  let wakeLock = null, raf = 0, guided = null, guidedTimer = 0;
  let inputInfo = null, advice = [], inputMuted = false;
  // assistente: stato mostrato, ultime misure di qualità, disturbi durante la registrazione
  const coach = new Coach();
  let coachCur = null, lastQuality = null, recTally = null, lastRecTally = null, coachSince = 0;
  const qualityListeners = new Set();
  let pendingCheck = query.check === '1'; // aperta dalle Impostazioni: verifica appena parte l'ascolto

  function initialPreset() {
    const s = siteById(site);
    if (settings.autoPresetBySite && s && s.preset) return s.preset;
    return mode === 'lung' ? settings.presetLung : settings.presetHeart;
  }

  view.innerHTML = `<section class="live">
    <header class="live-top">
      <div class="seg" data-modeseg>
        <button data-m="heart" title="Cuore">${icon('heart', 'sm')}<span class="lbl-xs">Cuore</span></button>
        <button data-m="lung" title="Torace">${icon('lungs', 'sm')}<span class="lbl-xs">Torace</span></button>
      </div>
      <button class="site-btn" data-sitebtn title="Scegli il punto di auscultazione"></button>
      <span class="grow"></span>
      ${visit ? `<a class="ctx-chip" href="#/visit/${esc(visit.id)}?tab=${mode === 'lung' ? 'lung' : 'heart'}" data-ctx title="Torna alla visita">${icon('user', 'sm')}<span>${esc(patientName(patient))}</span></a>`
        : `<span class="ctx-chip free" title="Le registrazioni andranno tra quelle senza paziente">${icon('user', 'sm')}<span>Senza paziente</span></span>`}
      <button class="btn sm hide-sm" data-guided title="Registra tutti i punti in sequenza">${icon('list', 'sm')} Esame guidato</button>
      <button class="icon-btn" data-more title="Altre funzioni" aria-label="Altre funzioni">${icon('more')}</button>
    </header>
    <div class="live-body">
      <div class="plots ${mode}" data-plots>
        <div class="plot"><canvas data-scope></canvas><button class="q-pill hidden" data-qpill></button><span class="plot-tag hidden" data-frozen>${icon('snow', 'sm')} Congelato</span><div class="coach-line hidden" data-coachline></div></div>
        <div class="plot"><canvas data-wf></canvas><span class="plot-tag bottom" data-wftag></span></div>
        <div class="overlay-msg" data-overlay></div>
        <div class="guided-banner hidden" data-banner></div>
      </div>
      <aside class="side">
        <div class="keys" data-keys title="Tutte le misure"></div>
        <div class="side-more">
          <details class="disclose" data-detailsbox ${settings.liveDetails ? 'open' : ''}><summary>Tutte le misure</summary><div class="metrics" data-metrics></div></details>
          <div class="panel">
            <div class="panel-head"><b data-charttitle></b><span class="tiny muted" data-chartsub></span></div>
            <canvas class="ens-canvas" data-chart></canvas>
          </div>
          <details class="disclose panel guide-card" ${settings.profile === 'medico' ? '' : 'open'}><summary>Guida al punto</summary><div data-guide></div></details>
          <div class="panel" data-siterecs></div>
        </div>
      </aside>
    </div>
    <footer class="controls">
      <button class="btn primary start" data-start></button>
      <button class="rec-btn" data-rec></button>
      <button class="btn" data-grab title="Salva gli ultimi secondi già ascoltati">${icon('back', 'sm')}<span data-grablbl></span></button>
      <span class="ctl-sep hide-sm"></span>
      <button class="select-btn" data-filter title="Filtro e riduzione del rumore"><span class="tiny muted lbl">Filtro</span><b data-filterlbl></b>${icon('chevD', 'sm')}</button>
      <span class="grow"></span>
      <div class="level" title="Livello del segnale in ingresso"><i data-level style="width:0%"></i></div>
      <button class="btn ghost hide-sm" data-monitor title="Ascolto in cuffia">${icon('headphones', 'sm')} Cuffie</button>
      <button class="btn ghost hide-sm" data-adjust title="Sorgente, livelli e visualizzazione">${icon('sliders', 'sm')} Regolazioni</button>
    </footer>
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
    q('[data-filterlbl]').textContent = `${name}${settings.denoise && mode === 'heart' ? ' · RR' : ''}`;
    q('[data-filter]').title = `Filtro: ${name}${settings.denoise && mode === 'heart' ? ' con riduzione del rumore' : ''}`;
    q('[data-wftag]').textContent = `${w.fMin}–${w.fMax} Hz`;
    q('[data-grablbl]').innerHTML = `<span class="lbl"> Ultimi </span>${settings.grabSeconds} s`;
  }

  function syncUrl() {
    const p = new URLSearchParams({ mode, site });
    if (visit) p.set('visit', visit.id);
    history.replaceState(null, '', `#/live?${p}`);
  }

  // ---------- intestazione: modalità, punto, preset ----------
  function renderMode() {
    view.querySelectorAll('[data-modeseg] button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    q('[data-plots]').classList.toggle('lung', mode === 'lung');
    q('[data-charttitle]').textContent = mode === 'heart' ? 'Ciclo cardiaco medio' : 'Ciclo respiratorio';
    const ctx = q('[data-ctx]');
    if (ctx) ctx.href = `#/visit/${visit.id}?tab=${mode}`;
  }

  function renderSiteBtn() {
    const s = siteById(site);
    q('[data-sitebtn]').innerHTML = `<span class="site-n">${s ? s.n : '·'}</span><span class="site-name"><span class="long">${esc(s ? s.full : 'Punto')}</span><span class="short">${esc(s ? s.name : 'Punto')}</span></span><small class="hide-sm">${esc(s ? s.piece : '')}</small>${icon('chevD', 'sm')}`;
  }

  // filtro e riduzione del rumore: un'unica scheda, il pulsante mostra il filtro in uso
  function openFilterSheet() {
    const body = el(`<div class="col">
      <div data-list></div>
      <label class="check"><input type="checkbox" data-autop ${settings.autoPresetBySite ? 'checked' : ''}> Scegli da solo il filtro consigliato per ogni punto</label>
      <div class="advice ${mode === 'heart' ? 'info' : ''}">
        <label class="check"><input type="checkbox" data-dn ${settings.denoise ? 'checked' : ''} ${mode === 'heart' ? '' : 'disabled'}> <b>Riduzione del rumore della stanza</b></label>
        <div class="small muted">${mode === 'heart' ? 'Attenua il rumore costante (ventole, condizionatori); i toni restano. Si sente e si salva così.' : 'Non disponibile per il torace: il murmure vescicolare verrebbe tolto insieme al rumore.'}</div>
        <div class="chips small" data-dns></div>
      </div>
      <button class="btn" data-eq>${icon('sliders', 'sm')} Equalizzatore parametrico…</button>
    </div>`);
    const list = body.querySelector('[data-list]');
    const renderList = () => {
      list.innerHTML = presetsFor(mode).map((p) => `<label class="choice ${p.id === presetId ? 'on' : ''}"><input type="radio" name="flt" value="${esc(p.id)}" ${p.id === presetId ? 'checked' : ''}><span><b>${esc(p.name)}</b><span class="small muted">${esc(p.desc || '')}</span></span></label>`).join('')
        + (presetId === EQ_LIVE_ID ? '<div class="choice on"><span><b>EQ personalizzato</b><span class="small muted">Impostato con l’equalizzatore</span></span></div>' : '');
    };
    renderList();
    list.onchange = (e) => { setPreset(e.target.value, true); renderList(); };
    body.querySelector('[data-autop]').onchange = (e) => updateSettings({ autoPresetBySite: e.target.checked });
    const dns = body.querySelector('[data-dns]');
    const renderDn = () => {
      dns.innerHTML = '';
      if (!settings.denoise || mode !== 'heart') return;
      [['Lieve', 1.0], ['Media', 1.5], ['Forte', 2.2]].forEach(([l, v]) => {
        const c = el(`<button class="chip ${settings.denoiseStrength === v ? 'on' : ''}">${l}</button>`);
        c.onclick = () => { updateSettings({ denoiseStrength: v }); engine.setDenoise(true, v); renderDn(); };
        dns.appendChild(c);
      });
    };
    renderDn();
    body.querySelector('[data-dn]').onchange = (e) => { updateSettings({ denoise: e.target.checked }); engine.setDenoise(e.target.checked && mode === 'heart', settings.denoiseStrength); updateTags(); renderDn(); };
    const sh = sheet({ title: 'Filtro', body });
    body.querySelector('[data-eq]').onclick = () => { sh.close(); openEq(); };
  }

  // altre funzioni, raccolte in un menu per lasciare libera la barra dei comandi
  function openMore() {
    const item = (k, ic, title, sub, state = '') => `<button class="menu-item" data-k="${k}">${icon(ic)}<span class="grow"><b>${title}</b>${sub ? `<span class="small muted">${sub}</span>` : ''}</span>${state}</button>`;
    const on = (v) => `<span class="state badge ${v ? 'accent' : ''}">${v ? 'Attivo' : 'Spento'}</span>`;
    const body = el(`<div class="menu-list">
      ${item('guided', 'list', guided ? 'Interrompi l’esame guidato' : 'Esame guidato', 'Registra tutti i punti in sequenza')}
      ${item('monitor', 'headphones', 'Ascolto in cuffia', 'Con limitatore di protezione', on(settings.monitor))}
      ${item('freeze', 'snow', 'Congela la schermata', 'Tasto F', on(frozen))}
      ${item('snap', 'camera', 'Salva immagine', 'Tracciato e waterfall in PNG')}
      ${item('guide', 'info', 'Guida al punto', 'Dove appoggiare, cosa ascoltare, misure e ciclo medio')}
      ${item('input', 'mic', 'Ingresso audio e verifica', 'Tipo di ingresso, diagnostica, verifica guidata')}
      ${item('adjust', 'sliders', 'Regolazioni', 'Sorgente, livelli e visualizzazione')}
    </div>`);
    const sh = sheet({ title: 'Altro', body });
    body.onclick = (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      sh.close();
      ({
        guided: () => (guided ? stopGuided(true) : startGuided()), monitor: toggleMonitor, freeze: toggleFreeze, snap: snapshot,
        guide: openGuide, input: openInputSheet, adjust: openAdjust,
      })[b.dataset.k]();
    };
  }

  function toggleMonitor() { updateSettings({ monitor: !settings.monitor }); engine.setMonitor(settings.monitor, settings.volumeDb); renderButtons(); }
  function toggleFreeze() { frozen = !frozen; scope.frozen = wf.frozen = frozen; if (!frozen) { scope.dirty = wf.dirty = true; } renderButtons(); }

  // misure, ciclo medio e guida al punto in una scheda (sul telefono la colonna laterale non c'è)
  function openGuide() {
    const body = el(`<div class="col guide-card">
      <div class="metrics">${q('[data-metrics]').innerHTML}</div>
      <div><div class="panel-head"><b>${mode === 'heart' ? 'Ciclo cardiaco medio' : 'Ciclo respiratorio'}</b></div><canvas class="ens-canvas" style="height:130px" data-chart2></canvas></div>
      <div class="panel">${q('[data-guide]').innerHTML}</div>
      <div class="panel">${q('[data-siterecs]').innerHTML}</div>
    </div>`);
    sheet({ title: (siteById(site) || {}).full || 'Guida', body });
    requestAnimationFrame(() => {
      const cv = body.querySelector('[data-chart2]');
      if (mode === 'heart') drawEnsemble(cv, lastHeart && lastHeart.ensemble);
      else drawResp(cv, respData(lastLung));
    });
  }

  function setPreset(id, persist) {
    presetId = id;
    bands = getPreset(id).bands;
    if (engine.running) engine.setBands(bands);
    if (persist) updateSettings(mode === 'lung' ? { presetLung: id } : { presetHeart: id });
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
    coachSince = performance.now();
    scope.reset();
    wf.lung = null;
    if (engine.running) {
      engine.setBands(bands);
      engine.setDenoise(settings.denoise && mode === 'heart', settings.denoiseStrength);
      scope.setRate(engine.sampleRate, Math.round(engine.sampleRate / 1000));
      reconfigure();
    }
    renderMode(); renderSiteBtn(); renderGuide(); renderSiteRecs(); renderMetrics(); drawChart(); updateTags(); syncUrl();
  }

  // ---------- guida e registrazioni del punto ----------
  function renderGuide() {
    const s = siteById(site);
    const tips = mode === 'heart' ? HEART_TIPS : LUNG_TIPS;
    q('[data-guide]').innerHTML = s ? `<div class="small muted">${esc(s.where)}</div>
      <div class="row" style="margin:6px 0"><span class="badge accent">${esc(s.piece)}</span>${s.lobe ? `<span class="badge">${esc(s.lobe)}</span>` : ''}</div>
      ${s.position ? `<div class="small">${esc(s.position)}</div>` : ''}
      ${s.listen ? `<ul class="small">${s.listen.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <details class="small" style="margin-top:6px" ${settings.profile === 'studente' ? 'open' : ''}><summary class="muted">Consigli di auscultazione</summary><ul>${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : '';
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
  // tre valori chiave sempre visibili; le altre misure in "Tutte le misure"
  const key = (cls, k, v, d) => `<div class="key ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d || '&nbsp;'}</div></div>`;
  const card = (cls, k, v, d) => `<div class="metric ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d || ''}</div></div>`;

  function renderMetrics() {
    const keys = q('[data-keys]'), box = q('[data-metrics]');
    if (mode === 'heart') {
      const m = (lastHeart && lastHeart.metrics) || {};
      const extra = [m.clickCount ? `click ${m.clickCount}` : '', m.snapCount ? `schiocco ${m.snapCount}` : ''].filter(Boolean).join(' · ');
      const mur = m.murmurSys && m.murmurDia ? 'Sisto-diast.' : m.murmurSys ? 'Sistolico' : m.murmurDia ? 'Diastolico' : lastHeart ? 'No' : '—';
      keys.innerHTML = [
        key('main', 'Freq. cardiaca', m.bpm ? `${n0(m.bpm)}<small>bpm</small>` : '—', m.bpm ? `± ${n0(m.bpmStd || 0)} bpm` : lastHeart && lastHeart.reason ? esc(lastHeart.reason) : running ? 'in ascolto…' : 'avvia l’ascolto'),
        key(m.rhythm === 'Irregolare' ? 'alert' : '', 'Ritmo', esc(m.rhythm || '—'), m.rrCv !== null && m.rrCv !== undefined ? `variabilità ${n0(m.rrCv * 100)}%` : ''),
        key(m.murmurSys || m.murmurDia ? 'alert' : '', 'Soffio', mur, esc(m.murmurSysShape || m.murmurDiaShape || m.murmurIntensity || '')),
      ].join('');
      box.innerHTML = [
        card('', 'Sistole / Diastole', m.sysMs ? `${n0(m.sysMs)}<small> / </small>${n0(m.diaMs)}<small> ms</small>` : '—', m.sdRatio ? `rapporto D/S ${fmtNum(m.sdRatio, 2)}` : ''),
        card('', 'Rapporto S1/S2', fmtNum(m.s1s2, 2), m.s1Freq ? `S1 ${n0(m.s1Freq)} Hz · S2 ${n0(m.s2Freq)} Hz` : ''),
        card('', 'Sdoppiamento S2', m.splitMs ? `${n0(m.splitMs)}<small> ms</small>` : lastHeart ? 'no' : '—', m.splitPct ? `${n0(m.splitPct)}% dei battiti` : ''),
        card(m.s3Pct >= 30 || m.s4Pct >= 30 ? 'alert' : '', 'Toni aggiunti', lastHeart ? (m.s3Count || m.s4Count ? `S3 ${m.s3Count || 0} · S4 ${m.s4Count || 0}` : 'nessuno') : '—', extra),
        card('', 'Soffio: forma', esc(m.murmurSysShape || m.murmurDiaShape || '—'), esc([m.murmurIntensity, m.murmurPitchHz ? `~${n0(m.murmurPitchHz)} Hz` : ''].filter(Boolean).join(' · '))),
        card('', 'Qualità del segnale', m.sqi !== undefined ? `${m.sqi}<small>/100</small>` : '—', m.snrDb ? `rapporto segnale/rumore ${n0(m.snrDb)} dB` : ''),
      ].join('');
    } else {
      const l = (lastLung && lastLung.metrics) || {};
      const h = (lastHeart && lastHeart.metrics) || {};
      keys.innerHTML = [
        key('main', 'Freq. respiratoria', l.rr ? `${n0(l.rr)}<small>atti/min</small>` : '—', l.rr ? `I:E ≈ 1:${fmtNum(l.ieRatio, 1)}` : running ? 'respiri profondi a bocca aperta' : 'avvia l’ascolto'),
        // finché la frequenza respiratoria non è nota si mostra il conteggio, non "0 per respiro"
        key(l.cracklesSignificant ? 'alert' : '', 'Crepitii', !lastLung ? '—' : l.cracklesPerBreath !== null && l.cracklesPerBreath !== undefined ? `${fmtNum(l.cracklesPerBreath, 1)}<small>/resp.</small>` : `${l.crackles}<small>in 10 s</small>`, lastLung ? `fini ${l.cracklesFine} · grossolani ${l.cracklesCoarse}` : ''),
        key(l.wheezes || l.rhonchi ? 'alert' : '', 'Sibili · ronchi', lastLung ? `${l.wheezes} · ${l.rhonchi}` : '—', l.wheezeFreq ? `${n0(l.wheezeFreq)} Hz` : l.polyphonic ? 'polifonici' : ''),
      ].join('');
      box.innerHTML = [
        card('', 'Murmure', l.intensityDb !== undefined && l.intensityDb !== null ? `${n0(l.intensityDb)}<small> dB</small>` : '—', l.dynamicDb ? `dinamica respiro ${n0(l.dynamicDb)} dB` : ''),
        card('', 'Sibili: durata', l.wheezes ? `${n0(l.wheezeDurPct)}<small>% del tempo</small>` : '—', ''),
        card('', 'Frequenza cardiaca', h.bpm ? `${n0(h.bpm)}<small> bpm</small>` : '—', l.toneHz ? `tono di disturbo ${l.toneHz} Hz` : ''),
        card('', 'Qualità del segnale', l.sqi !== undefined ? `${l.sqi}<small>/100</small>` : '—', ''),
      ].join('');
    }
  }

  function drawChart() {
    const cv = q('[data-chart]');
    if (!cv.offsetParent) return;
    if (mode === 'heart') {
      drawEnsemble(cv, lastHeart && lastHeart.ensemble);
      q('[data-chartsub]').textContent = lastHeart && lastHeart.ensemble ? 'ultimi 8 s' : '';
    } else {
      drawResp(cv, respData(lastLung));
      q('[data-chartsub]').textContent = lastLung ? 'ultimi 10 s' : '';
    }
  }

  // ---------- pulsanti ----------
  function renderButtons() {
    const st = q('[data-start]');
    st.innerHTML = running ? `${icon('stop', 'sm')}<span class="lbl">Ferma</span>` : starting ? '<span class="lbl">Avvio…</span>' : `${icon('play', 'sm')}<span class="lbl">Avvia</span>`;
    st.title = running ? 'Ferma l’ascolto (barra spaziatrice)' : 'Avvia l’ascolto (barra spaziatrice)';
    st.classList.toggle('primary', !running);
    st.disabled = starting;
    const rb = q('[data-rec]');
    rb.innerHTML = recording ? '<span class="dot"></span><span data-rectime>0:00</span>' : '<span class="dot"></span>Registra';
    rb.title = 'Registra (tasto R)';
    rb.classList.toggle('recording', recording);
    rb.disabled = !running || !!guided;
    q('[data-grab]').disabled = !running || recording;
    q('[data-monitor]').classList.toggle('on', settings.monitor);
    q('[data-frozen]').classList.toggle('hidden', !frozen);
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

  // ---------- ingresso: tipo, avvisi, diagnostica ----------
  const sourceName = () => (engine.source === 'mic' ? INPUT_TYPES[inputInfo ? inputInfo.type : 'unknown'].short : engine.source === 'demo' ? 'Simulatore' : 'File audio');
  const stateNow = (quality) => coachState({
    quality, mode, source: engine.source, kind: settings.inputKind, heart: lastHeart, lung: lastLung, advice, muted: inputMuted, inputName: sourceName(),
    settled: performance.now() - coachSince > (mode === 'lung' ? 12000 : 6000),
  });

  function updateCoach(quality) {
    lastQuality = quality;
    const st = stateNow(quality);
    coachCur = coach.update(st, performance.now());
    if (recording && recTally) recTally.add(st);
    renderPill();
    for (const fn of qualityListeners) fn(quality, st);
  }

  function renderPill() {
    const pill = q('[data-qpill]');
    if (!running) { pill.classList.add('hidden'); q('[data-coachline]').classList.add('hidden'); return; }
    const c = coachCur || stateNow(null);
    pill.className = `q-pill ${c.level}`;
    pill.title = c.fix || 'Ingresso e qualità del segnale';
    pill.innerHTML = `<i></i><span>${esc(c.text)}</span>`;
    // studenti e pazienti vedono subito anche il rimedio
    const line = q('[data-coachline]');
    const show = settings.profile !== 'medico' && c.level !== 'ok' && c.fix;
    line.classList.toggle('hidden', !show);
    if (show && line.textContent !== c.fix) line.textContent = c.fix;
  }

  async function diagnostics() {
    const inputs = await listInputs().catch(() => []);
    const live = running && engine.source === 'mic' ? inputInfo : null;
    return diagnosticsText(live, { kind: settings.inputKind, inputs, advice, check: checkLines(lastCheck(live)) });
  }

  async function openCheck() {
    if (!running) { await start(); if (!running) return; }
    openInputCheck({
      source: engine.source, info: engine.source === 'mic' ? inputInfo : null, kind: settings.inputKind,
      subscribe: (fn) => { qualityListeners.add(fn); return () => qualityListeners.delete(fn); },
      heart: () => lastHeart, diagnostics, onDone: () => renderPill(),
    });
  }

  async function openInputSheet() {
    const kindName = (INPUT_KINDS.find((k) => k.id === settings.inputKind) || INPUT_KINDS[0]).name;
    const live = running && engine.source === 'mic' && inputInfo;
    const i = inputInfo;
    const state = (v) => (v === true ? 'attiva' : v === false ? 'spenta' : 'n.d.');
    const now = running ? coachCur || stateNow(lastQuality) : null;
    const chk = lastCheck(live ? inputInfo : null);
    const lq = lastQuality;
    const body = el(`<div class="col">
      ${now ? `<div class="advice ${now.level === 'ok' ? 'ok' : now.level}"><b>Ora: ${esc(now.text)}</b>${now.fix ? `<div class="small">${esc(now.fix)}</div>` : ''}
        ${lq ? `<div class="tiny muted">Picco ${n0(lq.peakDb)} dB · rumore di fondo ${n0(lq.floorDb)} dB${lq.humDb > 6 ? ` · righe a 50/60 Hz +${lq.humDb} dB` : ''}</div>` : ''}</div>` : ''}
      ${live ? `<dl class="kv">
        <dt>Ingresso</dt><dd>${esc(INPUT_TYPES[i.type].name)}<div class="tiny muted">${esc(i.label || 'senza nome')}</div></dd>
        <dt>Uso dichiarato</dt><dd>${esc(kindName)}</dd>
        <dt>Campionamento</dt><dd>${i.trackRate ? `${n0(i.trackRate)} Hz` : 'n.d.'} (motore ${n0(i.ctxRate)} Hz)</dd>
        <dt>Eco · rumore · volume automatico</dt><dd>${state(i.processing.echoCancellation)} · ${state(i.processing.noiseSuppression)} · ${state(i.processing.autoGainControl)}</dd>
        ${i.latencyMs ? `<dt>Ritardo dell’ascolto</dt><dd>${i.latencyMs} ms</dd>` : ''}
      </dl>` : `<div class="small muted">${running ? 'La sorgente è il simulatore o un file: niente da verificare.' : 'Avvia l’ascolto con il fonendoscopio per vedere i dati dell’ingresso.'}</div>`}
      ${advice.length ? `<div class="col" style="gap:8px">${advice.map((a) => `<div class="advice ${a.level}"><b>${esc(a.text)}</b>${a.fix ? `<div class="small">${esc(a.fix)}</div>` : ''}</div>`).join('')}</div>` : live ? '<div class="advice ok"><b>Nessun problema riconosciuto.</b></div>' : ''}
      ${live ? `<div class="small">${chk ? `Ultima verifica guidata (${new Date(chk.at).toLocaleDateString('it-IT')}): <b>${esc(chk.verdict)}</b>` : 'Questo ingresso non è ancora stato verificato.'}</div>` : ''}
      <div class="tiny muted">L’uso dichiarato si cambia in Impostazioni → Ingresso audio.</div>
      <div class="row">
        <button class="btn primary" data-check>${icon('check', 'sm')} Verifica guidata (30 s)</button>
        <button class="btn" data-adj>${icon('sliders', 'sm')} Cambia ingresso</button>
        <button class="btn" data-copy>${icon('file', 'sm')} Copia diagnostica</button>
      </div>
      <div class="col" style="gap:6px">
        <button class="btn sm" data-chan>${icon('mic', 'sm')} Controlla il doppio microfono (2 s)</button>
        <div class="small" data-chanres>${lastChannelProbe ? esc(lastChannelProbe.verdict.text) : 'Verifica se il telefono dà al browser due microfoni separati. Durante la prova parla normalmente vicino al telefono.'}</div>
      </div>
      <div class="tiny muted">La diagnostica contiene il modello del browser e i nomi degli ingressi audio (possono includere il nome di un dispositivo), nessun dato dei pazienti.</div>
    </div>`);
    const sh = sheet({ title: 'Ingresso audio', body });
    body.querySelector('[data-adj]').onclick = () => { sh.close(); openAdjust(); };
    body.querySelector('[data-check]').onclick = () => { sh.close(); openCheck(); };
    body.querySelector('[data-chan]').onclick = async (e) => {
      const btn = e.currentTarget, res = body.querySelector('[data-chanres]');
      btn.disabled = true;
      res.textContent = 'Parla normalmente vicino al telefono…';
      const was = running && engine.source === 'mic';
      try {
        if (was) await stop(); // un solo uso del microfono alla volta
        const p = await probeChannels(settings.deviceId);
        res.textContent = `${p.verdict.text} Ora è inclusa nella diagnostica.`;
      } catch (err) { res.textContent = `Prova non riuscita: ${err.message || err.name}`; }
      if (was) await start();
      btn.disabled = false;
    };
    body.querySelector('[data-copy]').onclick = async () => {
      const txt = await diagnostics();
      try {
        await navigator.clipboard.writeText(txt);
        toast('Diagnostica copiata: incollala in un messaggio');
      } catch {
        const ta = el(`<textarea readonly style="min-height:180px">${esc(txt)}</textarea>`);
        body.appendChild(ta);
        ta.select();
        toast('Copia il testo selezionato');
      }
    };
  }

  function checkInput() {
    inputMuted = false;
    inputInfo = engine.source === 'mic' ? engine.input : null;
    advice = inputInfo ? inputAdvice(inputInfo, settings.inputKind) : [];
    renderPill();
    const worst = worstLevel(advice);
    if (pendingCheck) { pendingCheck = false; openCheck(); return; }
    if (worst !== 'ok') toast(advice.find((a) => a.level === worst).text, { type: worst === 'bad' ? 'error' : 'warn', timeout: 8000, action: { label: 'Dettagli', run: openInputSheet } });
    else if (inputInfo && !lastCheck(inputInfo)) toast('Ingresso nuovo: in 30 secondi puoi verificare che funzioni bene.', { timeout: 8000, action: { label: 'Verifica', run: openCheck } });
  }

  // ---------- motore ----------
  engine.on('frame', (d) => {
    scope.push(d);
    wf.push(d.cols, d.ncols, d.total);
    if (d.peakDb !== undefined) {
      const lv = q('[data-level]');
      lv.style.width = `${Math.max(0, Math.min(100, ((d.peakDb + 70) / 70) * 100))}%`;
    }
    if (d.quality) updateCoach(d.quality);
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
    // l'analisi polmonare arriva un ciclo sì e uno no: si tiene l'ultima ricevuta
    if (mode === 'lung') { if (a.lung) { lastLung = a.lung; wf.lung = a.lung; scope.lungEvents = a.lung; } }
    else { wf.lung = null; scope.lungEvents = null; }
    renderMetrics();
    drawChart();
  });
  engine.on('error', (e) => toast(errText(e), { type: 'error' }));
  engine.on('inputlost', async () => {
    toast('Ingresso audio scollegato: ricollega il fonendo e riavvia l’ascolto.', { type: 'error', timeout: 8000 });
    await stop();
  });
  engine.on('inputmute', (m) => { inputMuted = m; coachCur = null; renderPill(); });
  engine.on('devicechange', () => {
    if (!running) return;
    toast('Gli ingressi audio sono cambiati (cavo o cuffie Bluetooth): controlla che il suono arrivi ancora dal fonendo.', {
      type: 'warn', timeout: 8000, action: { label: 'Riavvia', run: async () => { await stop(); await start(); } },
    });
  });

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
      coach.reset();
      coachCur = lastQuality = null;
      coachSince = performance.now();
      scope.setRate(engine.sampleRate, Math.round(engine.sampleRate / 1000));
      scope.reset();
      reconfigure();
      checkInput();
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
    renderPill();
  }

  // ---------- registrazione ----------
  async function saveRec(samples, fs, extra = {}) {
    if (!samples || samples.length < fs * 1) { toast('Registrazione troppo breve', { type: 'warn' }); return null; }
    const s = siteById(site);
    const rec = {
      kind: mode, site, label: s ? s.full : 'Registrazione', visitId: visit ? visit.id : null, patientId: patient ? patient.id : null,
      duration: samples.length / fs, fs, preset: presetId, bands, gainDb: settings.gainDb, source: engine.source || settings.source,
      denoise: settings.denoise && mode === 'heart' ? settings.denoiseStrength : 0,
      device: engine.inputLabel || '', input: engine.source === 'mic' ? inputRecord(inputInfo, settings.inputKind) : null, ...extra,
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
    recTally = new Tally();
    engine.startRecording();
    recording = true;
    renderButtons();
  }

  async function stopRecording(extra) {
    if (!recording) return null;
    recording = false;
    lastRecTally = recTally;
    recTally = null;
    renderButtons();
    const r = await engine.stopRecording();
    const saved = r ? await saveRec(r.samples, r.fs, extra) : null;
    const w = lastRecTally && lastRecTally.worst();
    if (saved && w && w.total > 0.3 && !(extra && extra.guided)) {
      toast(`Registrazione disturbata: ${ISSUE_NAMES[w.key]} nel ${Math.round(w.frac * 100)}% del tempo`, { type: 'warn', timeout: 6000, action: { label: 'Apri', run: () => { location.hash = `#/rec/${saved.id}`; } } });
    }
    return saved;
  }

  async function grab() {
    if (!running) return;
    const r = await engine.grab(settings.grabSeconds);
    if (r) saveRec(r.samples, r.fs, { grabbed: true });
  }

  // ---------- esame guidato ----------
  // fasi: ready → count → (wait: segnale non pulito) → rec → saving → (review: tratto disturbato) → ready…
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
      if (left <= 0) {
        if (settings.guidedWaitClean && coachCur && coachCur.level !== 'ok') { guided.phase = 'wait'; renderGuided(); }
        else { guided.phase = 'rec'; guided.t0 = now; startRecording(); renderGuided(); }
      }
    } else if (guided.phase === 'wait') {
      if (!coachCur || coachCur.level === 'ok') { guided.phase = 'rec'; guided.t0 = now; startRecording(); renderGuided(); }
      else {
        const t = q('[data-banner] [data-gwait]');
        if (t && t.dataset.k !== coachCur.key) { t.dataset.k = coachCur.key; t.innerHTML = `<b>${esc(coachCur.text)}</b><div class="small">${esc(coachCur.fix)}</div>`; }
      }
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
        const w = lastRecTally && lastRecTally.worst();
        if (saved && w && w.total > 0.3) { guided.phase = 'review'; guided.review = { rec: saved, w }; renderGuided(); return; }
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
    } else if (guided.phase === 'wait') {
      b.innerHTML = `${head}<div class="small muted" style="margin-top:6px">In attesa di un segnale pulito per registrare ${esc(s.full)}…</div>
        <div class="advice warn" data-gwait style="margin:6px 0"></div>
        <div class="row"><button class="btn" data-gforce>${icon('rec', 'sm')} Registra comunque</button></div>`;
    } else if (guided.phase === 'review') {
      const w = guided.review.w;
      b.innerHTML = `${head}<div class="advice warn" style="margin:6px 0"><b>Tratto disturbato: ${esc(ISSUE_NAMES[w.key] || 'disturbi')} nel ${Math.round(w.frac * 100)}% del tempo</b><div class="small">I risultati di questo punto potrebbero non essere attendibili.</div></div>
        <div class="row"><button class="btn primary" data-gredo>${icon('refresh', 'sm')} Scarta e ripeti</button><button class="btn" data-gkeep>Tieni e prosegui</button></div>`;
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
    const force = b.querySelector('[data-gforce]');
    if (force) force.onclick = () => { guided.phase = 'rec'; guided.t0 = performance.now(); startRecording(); renderGuided(); };
    const redo = b.querySelector('[data-gredo]');
    if (redo) redo.onclick = async () => {
      await repo.deleteRecording(guided.review.rec.id);
      guided.saved--;
      guided.phase = 'ready';
      renderSiteRecs();
      renderGuided();
    };
    const keep = b.querySelector('[data-gkeep]');
    if (keep) keep.onclick = guidedNext;
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
      onChange: (b) => { bands = b; presetId = EQ_LIVE_ID; if (engine.running) engine.setBands(bands); updateTags(); },
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
      <label class="field"><span>Guadagno dell’ascolto: <b data-gv>${settings.gainDb} dB</b></span><input type="range" min="-12" max="40" step="1" value="${settings.gainDb}" data-gain></label>
      <label class="field"><span>Volume cuffie: <b data-vv>${settings.volumeDb} dB</b> · limitatore di protezione sempre attivo</span><input type="range" min="-20" max="30" step="1" value="${settings.volumeDb}" data-vol></label>
      <details class="disclose"><summary>Visualizzazione avanzata</summary><div class="col">
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
      </div></details>
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
    sheet({ title: 'Regolazioni', body, wide: true });
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
  q('[data-monitor]').onclick = toggleMonitor;
  q('[data-adjust]').onclick = openAdjust;
  q('[data-filter]').onclick = openFilterSheet;
  q('[data-more]').onclick = openMore;
  q('[data-qpill]').onclick = openInputSheet;
  q('[data-guided]').onclick = () => (guided ? stopGuided(true) : startGuided());
  // sul telefono le misure stanno in una scheda: si apre toccando i valori chiave
  q('[data-keys]').onclick = () => { if (!q('.side-more').offsetParent) openGuide(); };
  q('[data-detailsbox]').ontoggle = (e) => updateSettings({ liveDetails: e.target.open });

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || document.querySelector('.sheet-wrap')) return;
    if (e.code === 'Space') { e.preventDefault(); running ? stop() : start(); }
    else if (e.key === 'r' || e.key === 'R') recording ? stopRecording() : startRecording();
    else if (e.key === 'g' || e.key === 'G') grab();
    else if (e.key === 'f' || e.key === 'F') toggleFreeze();
  };
  document.addEventListener('keydown', onKey);

  const ro = new ResizeObserver(() => { scope.resize(); wf.resize(); drawChart(); });
  ro.observe(q('.plots'));
  ro.observe(q('[data-chart]'));
  const loop = () => { scope.draw(); wf.draw(); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);

  const onVis = () => { if (document.visibilityState === 'visible' && running) requestWake(); };
  document.addEventListener('visibilitychange', onVis);

  renderMode(); renderSiteBtn(); renderGuide(); renderSiteRecs(); renderMetrics(); renderButtons(); updateTags(); syncUrl();
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
