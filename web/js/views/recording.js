// Registrazione: tracciato + spettrogramma navigabili, riproduzione in loop (tutto,
// selezione, 1 o 3 cicli cardiaci), rallentatore a intonazione costante, analisi
// completa (battiti, ciclo medio, spettrogramma del ciclo, eventi polmonari), esportazioni.
import { esc, el, toast, sheet, confirmDialog, fmtNum, fmtDur, fmtDateTime, patientName, downloadBlob, safeName } from '../util.js';
import { settings } from '../settings.js';
import { siteName, siteById, HEART_SITES, LUNG_SITES } from '../sites.js';
import { allPresets, getPreset, recordingFilter, REC_FILTER_ID } from '../presets.js';
import * as repo from '../store/repo.js';
import { loadRecordingAudio, loadRecordingBlob } from '../store/audio.js';
import { analyzeSamples, viewSamples, summarize } from '../audio/analyzer.js';
import { LoopPlayer, processSignal } from '../audio/player.js';
import { encodeWav } from '../audio/wav.js';
import { drawWaveView, drawSpecView, buildSpecImage, specLevels, drawEnsemble, drawProfile, drawCycleSpec, drawResp } from '../ui/charts.js';
import { fitCanvas } from '../ui/canvas.js';
import { icon } from '../ui/icons.js';
import { heartSummaryLines, lungSummaryLines, qualityBadge, inputBadges, isHeartAbnormal, isLungAbnormal } from './common.js';

const n0 = (v) => fmtNum(v, 0);

export async function mount(view, [id]) {
  let rec = await repo.getRecording(id);
  if (!rec) { view.innerHTML = `<div class="page"><div class="empty">Registrazione non trovata.</div></div>`; return; }
  const patient = rec.patientId ? await repo.getPatient(rec.patientId) : null;
  // si riascolta e si vede come in auscultazione: stesso filtro e stessa riduzione rumore
  const recFilter = recordingFilter(rec);
  const filters = [recFilter, ...allPresets()];
  const filterById = (id) => filters.find((f) => f.id === id) || getPreset(id);
  view.innerHTML = `<div class="page">
    <div class="row between" style="align-items:flex-start">
      <div class="grow">
        <div class="small muted">${rec.visitId ? `<a href="#/visit/${esc(rec.visitId)}?tab=${rec.kind === 'lung' ? 'lung' : 'heart'}">${icon('chevL', 'sm')} Visita</a> · ` : ''}${esc(patientName(patient))}</div>
        <h1>${icon(rec.kind === 'lung' ? 'lungs' : 'heart')} ${esc(rec.label || siteName(rec.site))}</h1>
        <div class="small muted">${fmtDateTime(rec.createdAt)} · ${fmtDur(rec.duration)} · ${esc(recFilter.name)} · ${esc(rec.device || rec.source || '')} · ${n0(rec.fs)} Hz ${inputBadges(rec)}</div>
      </div>
      <div class="row">
        <button class="btn sm" data-wav title="Scarica l'audio come lo ascolti (filtro scelto; solo la selezione, se c'è)">${icon('download', 'sm')} WAV</button>
        <button class="btn sm" data-more>${icon('list', 'sm')} Altro</button>
      </div>
    </div>
    <div class="rec-plots" style="position:relative;margin-top:10px" data-plots>
      <canvas class="rec-wave" data-wave></canvas>
      <canvas class="rec-spec" data-spec></canvas>
      <canvas data-over style="position:absolute;left:0;top:0;width:100%;pointer-events:none"></canvas>
      <canvas class="rec-mini" data-mini></canvas>
      <div class="overlay-msg" data-loading><div><div class="badge accent">Analisi in corso…</div></div></div>
    </div>
    <div class="transport">
      <button class="btn primary" data-play>${icon('play', 'sm')} Riproduci</button>
      <button class="icon-btn on" data-loop title="Ripeti in loop">${icon('loop')}</button>
      <div class="seg" data-lmode>
        <button data-v="all">Tutto</button><button data-v="sel">Selezione</button><button data-v="c1">1 ciclo</button><button data-v="c3">3 cicli</button>
      </div>
      <div class="seg" data-speed><button data-v="1">1×</button><button data-v="0.75">0,75×</button><button data-v="0.5">0,5×</button></div>
      <select data-preset style="width:auto">${filters.map((p) => `<option value="${esc(p.id)}" ${p.id === REC_FILTER_ID ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <label class="row small" style="gap:6px">${icon('volume', 'sm')}<input type="range" min="-20" max="30" value="${settings.volumeDb}" data-vol style="width:110px"></label>
      <span class="grow"></span>
      <button class="icon-btn" data-zin title="Zoom avanti">${icon('zoomIn')}</button>
      <button class="icon-btn" data-zout title="Zoom indietro">${icon('zoomOut')}</button>
      <button class="icon-btn" data-zfit title="Tutto">${icon('fit')}</button>
    </div>
    <div class="tiny muted">Trascina sul grafico per selezionare un tratto da ripetere · tocca per posizionare il cursore · zoom con due dita o Ctrl+rotella · la barra in basso sposta la vista.</div>
    <div class="grid two" style="margin-top:12px">
      <div class="card col" data-summary><b>Analisi automatica</b><div class="muted small">…</div></div>
      <div class="card col" data-charts></div>
    </div>
    <div class="card" style="margin-top:12px" data-table></div>
    <div class="card col" style="margin-top:12px">
      <b>${icon('edit', 'sm')} Note</b>
      <textarea data-notes placeholder="Annotazioni su questa registrazione…">${esc(rec.notes || '')}</textarea>
    </div>
  </div>`;
  const q = (s) => view.querySelector(s);

  let audio = null, listen = null, res = null, summary = null, specImg = null, duration = rec.duration || 0;
  let vw = [0, Math.min(duration || 10, 10)];
  let selection = null, cursor = 0;
  let loopOn = true, loopMode = 'all', speed = 1, playPreset = REC_FILTER_ID, volumeDb = settings.volumeDb;
  const player = new LoopPlayer();
  let raf = 0, dirtyBase = true;

  // ---------- caricamento e analisi ----------
  try {
    audio = await loadRecordingAudio(rec);
    listen = await processSignal(audio.samples, audio.sampleRate, recFilter);
  } catch (e) {
    q('[data-loading]').innerHTML = `<div class="card"><b>Audio non disponibile</b><div class="small muted">${esc(e.message)}.</div></div>`;
    return;
  }
  duration = audio.samples.length / audio.sampleRate;
  vw = [0, Math.min(duration, rec.kind === 'lung' ? 12 : 8)];

  async function analyze(kind) {
    q('[data-loading]').classList.remove('hidden');
    try {
      res = await analyzeSamples(audio.samples, audio.sampleRate, kind, listen === audio.samples ? null : listen);
    } catch (e) {
      q('[data-loading]').innerHTML = `<div class="card"><b>Analisi non riuscita</b><div class="small muted">${esc(e.message)}</div></div>`;
      return;
    }
    const [lo, hi] = specLevels(res.spec.cols);
    specImg = buildSpecImage(res.spec, settings.colormap, lo, hi);
    q('[data-loading]').classList.add('hidden');
    summary = summarize(res, kind);
    if (JSON.stringify(summary) !== JSON.stringify(rec.analysis || {})) {
      rec.analysis = summary;
      rec.abnormal = kind === 'lung' ? isLungAbnormal(summary.lung) : isHeartAbnormal(summary.heart);
      rec = await repo.saveRecording(rec);
    }
    renderSummary();
    renderCharts();
    renderTable();
    dirtyBase = true;
  }

  const markers = () => {
    const h = res && res.heart;
    return h ? { s1: h.s1, s2: h.s2, s3: h.s3, s4: h.s4, clicks: h.clicks, snaps: h.snaps } : null;
  };

  // ---------- disegno ----------
  function layoutOverlay() {
    const w = q('[data-wave]'), s = q('[data-spec]'), o = q('[data-over]');
    o.style.height = `${w.offsetHeight + s.offsetHeight}px`;
  }

  function drawBase() {
    if (!res) return;
    const lung = rec.kind === 'lung' && res.lung;
    drawWaveView(q('[data-wave]'), res.overview, vw, { markers: markers(), crackles: lung ? res.lung.crackles : null });
    drawSpecView(q('[data-spec]'), specImg, res.spec, vw, { wheezes: lung ? res.lung.wheezes : null });
    drawMini();
  }

  function drawMini() {
    const { W, H, dpr, ctx } = fitCanvas(q('[data-mini]'));
    ctx.fillStyle = '#0b1222';
    ctx.fillRect(0, 0, W, H);
    const ov = res.overview, n = ov.min.length;
    let pk = 1e-6;
    for (let i = 0; i < n; i += 4) pk = Math.max(pk, ov.max[i], -ov.min[i]);
    ctx.fillStyle = 'rgba(56,225,255,0.55)';
    for (let px = 0; px < W; px++) {
      const k0 = Math.floor((px / W) * n), k1 = Math.max(k0 + 1, Math.floor(((px + 1) / W) * n));
      let hi = 0;
      for (let k = k0; k < k1; k++) hi = Math.max(hi, ov.max[k], -ov.min[k]);
      const h = (hi / pk) * (H / 2 - 2);
      ctx.fillRect(px, H / 2 - h, 1, 2 * h);
    }
    ctx.fillStyle = 'rgba(45,212,191,0.22)';
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = dpr;
    const x0 = (vw[0] / duration) * W, x1 = (vw[1] / duration) * W;
    ctx.fillRect(x0, 0, x1 - x0, H);
    ctx.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, H - 1);
  }

  function drawOverlay() {
    const o = q('[data-over]');
    const { W, H, dpr, ctx } = fitCanvas(o);
    ctx.clearRect(0, 0, W, H);
    const x = (t) => ((t - vw[0]) / (vw[1] - vw[0])) * W;
    if (selection) {
      ctx.fillStyle = 'rgba(45,212,191,0.16)';
      ctx.fillRect(x(selection[0]), 0, x(selection[1]) - x(selection[0]), H);
      ctx.strokeStyle = 'rgba(45,212,191,0.95)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(x(selection[0]), 0); ctx.lineTo(x(selection[0]), H); ctx.moveTo(x(selection[1]), 0); ctx.lineTo(x(selection[1]), H); ctx.stroke();
    }
    const pos = player.position();
    if (pos !== null && player.state && loopMode !== 'all' && loopMode !== 'sel') {
      const a = player.state.start, b = a + player.state.dur;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(x(a), 0, x(b) - x(a), H);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeRect(x(a), 1, x(b) - x(a), H - 2);
      ctx.setLineDash([]);
    }
    const t = pos !== null ? pos : cursor;
    ctx.strokeStyle = pos !== null ? '#ffffff' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(x(t), 0); ctx.lineTo(x(t), H); ctx.stroke();
    if (pos !== null && (pos < vw[0] || pos > vw[1]) && !dragging) {
      const w = vw[1] - vw[0];
      vw = [Math.max(0, Math.min(duration - w, pos - w * 0.1)), 0];
      vw[1] = vw[0] + w;
      dirtyBase = true;
    }
  }

  let overKey = '';
  const frame = () => {
    if (dirtyBase) { dirtyBase = false; drawBase(); }
    const o = q('[data-over]');
    const key = JSON.stringify([selection, cursor, vw, player.position(), loopMode, o.clientWidth, o.clientHeight]);
    if (key !== overKey) { overKey = key; drawOverlay(); }
    raf = requestAnimationFrame(frame);
  };

  // ---------- riepilogo, grafici, tabelle ----------
  function renderSummary() {
    const box = q('[data-summary]');
    const h = res.heart && res.heart.metrics;
    const l = res.lung && res.lung.metrics;
    const lines = rec.kind === 'lung' ? lungSummaryLines(summary.lung).concat(heartSummaryLines(summary.heart).slice(0, 1)) : heartSummaryLines(summary.heart);
    const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
    box.innerHTML = `<div class="row between"><b>Analisi automatica</b>${qualityBadge(rec.kind === 'lung' ? l && l.sqi : h && h.sqi)}</div>
      <div class="seg" data-kind><button data-v="heart">${icon('heart', 'sm')} Cuore</button><button data-v="lung">${icon('lungs', 'sm')} Torace</button></div>
      ${lines.length ? `<ul class="small" style="margin:0;padding-left:1.1rem">${lines.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<div class="small muted">${esc((res.heart && res.heart.reason) || 'Nessun reperto significativo rilevato')}</div>`}
      ${rec.kind !== 'lung' && h ? `<dl class="kv">
        ${kv('Battiti analizzati', h.nBeats)}${kv('FC media / da autocorrelazione', `${n0(h.bpm)} / ${n0(h.bpmAuto)} bpm`)}
        ${kv('HRV: SDNN · RMSSD · pNN50', `${n0(h.sdnn)} ms · ${n0(h.rmssd)} ms · ${n0(h.pnn50)}%`)}
        ${kv('Sistole · Diastole', `${n0(h.sysMs)} ± ${n0(h.sysStd)} · ${n0(h.diaMs)} ± ${n0(h.diaStd)} ms`)}
        ${kv('Durata S1 · S2', `${n0(h.s1DurMs)} · ${n0(h.s2DurMs)} ms`)}
        ${kv('Frequenza S1 · S2', `${n0(h.s1Freq)} · ${n0(h.s2Freq)} Hz`)}
        ${kv('Sdoppiamento S2', h.splitMs ? `${n0(h.splitMs)} ms (${n0(h.splitMin)}–${n0(h.splitMax)}) in ${n0(h.splitPct)}%` : 'non rilevato')}
        ${kv('Indice sistolico · diastolico', `${fmtNum(h.sysIdx, 2)} · ${fmtNum(h.diaIdx, 2)}`)}
        ${kv('Rapporto segnale/rumore', `${fmtNum(h.snrDb, 1)} dB`)}
      </dl>` : ''}
      ${rec.kind === 'lung' && l ? `<dl class="kv">
        ${kv('Respiri rilevati', l.breathCount)}${kv('Frequenza respiratoria', `${fmtNum(l.rr, 1)} atti/min`)}
        ${kv('Crepitii', `${l.crackles} (fini ${l.cracklesFine}, grossolani ${l.cracklesCoarse}) · ${fmtNum(l.cracklesPerMin, 0)}/min`)}
        ${kv('Sibili · ronchi', `${l.wheezes} · ${l.rhonchi}`)}${kv('Intensità murmure', `${fmtNum(l.intensityDb, 1)} dB (dinamica ${fmtNum(l.dynamicDb, 1)} dB)`)}
      </dl>` : ''}
      <div class="tiny muted">Analisi automatica indicativa: non sostituisce il giudizio clinico.</div>`;
    box.querySelectorAll('[data-kind] button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === (rec.kind === 'lung' ? 'lung' : 'heart'));
      b.onclick = async () => {
        if (b.dataset.v === rec.kind) return;
        rec.kind = b.dataset.v;
        rec = await repo.saveRecording(rec);
        analyze(rec.kind);
      };
    });
  }

  function renderCharts() {
    const box = q('[data-charts]');
    if (rec.kind === 'lung') {
      box.innerHTML = `<b>Ciclo respiratorio ed eventi</b><canvas class="ens-canvas" style="height:150px" data-resp></canvas>
        <div class="tiny muted">● respiri · tacche gialle crepitii fini, rosse grossolani · barre bianche sibili, arancio ronchi</div>`;
      requestAnimationFrame(() => drawResp(box.querySelector('[data-resp]'), res.lung, { duration }));
      return;
    }
    const h = res.heart;
    box.innerHTML = `<b>Ciclo cardiaco medio</b><canvas class="ens-canvas" style="height:130px" data-ens></canvas>
      <b>Spettrogramma medio del ciclo</b><canvas class="ens-canvas" style="height:150px" data-cyc></canvas>
      <div class="grid two" style="gap:8px">
        <div><div class="tiny muted">Profilo sistolico ${h.metrics.murmurSysShape ? '· ' + esc(h.metrics.murmurSysShape) : ''}</div><canvas class="ens-canvas" style="height:70px" data-ps></canvas></div>
        <div><div class="tiny muted">Profilo diastolico ${h.metrics.murmurDiaShape ? '· ' + esc(h.metrics.murmurDiaShape) : ''}</div><canvas class="ens-canvas" style="height:70px" data-pd></canvas></div>
      </div>`;
    requestAnimationFrame(() => {
      drawEnsemble(box.querySelector('[data-ens]'), h.ensemble);
      drawCycleSpec(box.querySelector('[data-cyc]'), res.cycleSpec, settings.colormap);
      drawProfile(box.querySelector('[data-ps]'), h.sysProfile, { color: '#ffb547', label: 'S1 → S2' });
      drawProfile(box.querySelector('[data-pd]'), h.diaProfile, { color: '#c77dff', label: 'S2 → S1' });
    });
  }

  function renderTable() {
    const box = q('[data-table]');
    if (rec.kind === 'lung') {
      const ev = [
        ...res.lung.crackles.map((c) => ({ t: c.t, t1: c.t, txt: `Crepitio ${c.type}`, det: `2CD ${fmtNum(c.cd2, 1)} ms · IDW ${fmtNum(c.idw, 1)} ms`, ph: c.phase === 'insp' ? 'inspiratorio' : c.phase === 'esp' ? 'espiratorio' : '' })),
        ...res.lung.wheezes.map((w) => ({ t: w.t0, t1: w.t1, txt: w.type === 'ronco' ? 'Ronco' : 'Sibilo', det: `${n0(w.f)} Hz · ${fmtNum(w.dur, 2)} s`, ph: '' })),
      ].sort((a, b) => a.t - b.t);
      box.innerHTML = `<div class="row between"><b>Eventi (${ev.length})</b></div>` + (ev.length ? `<div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr><th>Evento</th><th>Tempo</th><th>Dettagli</th><th>Fase</th></tr></thead><tbody>
        ${ev.map((e, i) => `<tr data-i="${i}"><td>${e.txt}</td><td>${fmtNum(e.t, 2)} s</td><td>${e.det}</td><td>${e.ph}</td></tr>`).join('')}</tbody></table></div>` : `<div class="small muted">Nessun crepitio, sibilo o ronco rilevato.</div>`);
      box.querySelectorAll('tbody tr').forEach((tr) => {
        tr.onclick = () => { const e = ev[+tr.dataset.i]; focusRange(e.t - 0.4, Math.max(e.t1, e.t) + 0.4); mark(tr); };
      });
      return;
    }
    const beats = res.heart.beats;
    box.innerHTML = `<div class="row between"><b>Battiti (${beats.length})</b><button class="btn sm" data-csv>${icon('download', 'sm')} CSV</button></div>` + (beats.length ? `<div class="table-wrap" style="margin-top:8px"><table class="data">
      <thead><tr><th>#</th><th>Tempo</th><th>FC</th><th>Sistole</th><th>Diastole</th><th>S1/S2</th><th>Sdopp.</th><th>Ind. sist.</th><th>Toni aggiunti</th></tr></thead><tbody>
      ${beats.map((b, i) => `<tr data-i="${i}"><td>${i + 1}</td><td>${fmtNum(b.t, 2)} s</td><td>${n0(b.bpm)}</td><td>${n0(b.sys * 1000)}</td><td>${b.dia ? n0(b.dia * 1000) : '—'}</td><td>${fmtNum(b.ratio, 2)}</td><td>${b.split ? n0(b.split) + ' ms' : '—'}</td><td>${fmtNum(b.sysIdx, 2)}</td><td>${esc((b.extras || []).join(', '))}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="small muted">${esc(res.heart.reason || 'Nessun battito riconosciuto')}</div>`);
    box.querySelectorAll('tbody tr').forEach((tr) => {
      tr.onclick = () => {
        const b = beats[+tr.dataset.i];
        const end = b.nextT || b.s2t + 0.45;
        selection = [Math.max(0, b.t - 0.06), Math.min(duration, end - 0.06)];
        setLoopMode('sel');
        focusRange(b.t - 0.4, end + 0.4, false);
        mark(tr);
        if (player.playing) play();
      };
    });
    const csv = box.querySelector('[data-csv]');
    if (csv) csv.onclick = () => {
      const head = 'battito;tempo_s;bpm;sistole_ms;diastole_ms;ampiezza_S1;ampiezza_S2;rapporto_S1S2;durata_S1_ms;durata_S2_ms;sdoppiamento_ms;indice_sistolico;indice_diastolico;toni_aggiunti';
      const rows = beats.map((b, i) => [i + 1, b.t.toFixed(3), b.bpm ? b.bpm.toFixed(1) : '', (b.sys * 1000).toFixed(0), b.dia ? (b.dia * 1000).toFixed(0) : '', b.s1Amp.toFixed(3), b.s2Amp.toFixed(3), b.ratio ? b.ratio.toFixed(2) : '', b.s1Dur.toFixed(0), b.s2Dur.toFixed(0), b.split ? b.split.toFixed(0) : '', b.sysIdx !== null ? b.sysIdx.toFixed(3) : '', b.diaIdx !== null ? b.diaIdx.toFixed(3) : '', (b.extras || []).join(' ')].join(';'));
      downloadBlob(new Blob(['﻿' + [head, ...rows].join('\n')], { type: 'text/csv' }), `${fileBase()}_battiti.csv`);
    };
  }

  const mark = (tr) => { tr.parentElement.querySelectorAll('tr').forEach((x) => x.classList.remove('sel')); tr.classList.add('sel'); };

  function focusRange(a, b, setSel = true) {
    a = Math.max(0, a); b = Math.min(duration, b);
    if (setSel) { selection = [a + 0.0, b]; setLoopMode('sel'); }
    const w = Math.max(1.5, (b - a) * 1.6);
    const c = (a + b) / 2;
    vw = [Math.max(0, c - w / 2), 0];
    vw[1] = Math.min(duration, vw[0] + w);
    cursor = a;
    dirtyBase = true;
  }

  // ---------- riproduzione ----------
  function loopRange() {
    if (loopMode === 'sel' && selection) return selection;
    if ((loopMode === 'c1' || loopMode === 'c3') && res && res.heart.beats.length) {
      const beats = res.heart.beats;
      const t = player.position() ?? cursor;
      let k = beats.findIndex((b) => b.t <= t && (b.nextT || b.s2t + 0.5) > t);
      if (k < 0) k = Math.max(0, beats.findIndex((b) => b.t >= t));
      const n = loopMode === 'c1' ? 1 : 3;
      const last = beats[Math.min(beats.length - 1, k + n - 1)];
      return [Math.max(0, beats[k].t - 0.06), Math.min(duration, (last.nextT || last.s2t + 0.45) - 0.06)];
    }
    return loopOn ? [0, duration] : [cursor, duration];
  }

  // filtro di ascolto: cambia ciò che si sente e anche tracciato e spettrogramma
  let filterToken = 0;
  async function setListenFilter(id) {
    const token = ++filterToken;
    playPreset = id;
    const y = await processSignal(audio.samples, audio.sampleRate, filterById(id));
    if (token !== filterToken) return;
    listen = y;
    restartIfPlaying();
    if (!res) return;
    const v = await viewSamples(listen, audio.sampleRate, rec.kind, res.heart);
    if (token !== filterToken || !res) return;
    Object.assign(res, v);
    const [lo, hi] = specLevels(res.spec.cols);
    specImg = buildSpecImage(res.spec, settings.colormap, lo, hi);
    dirtyBase = true;
    renderCharts();
  }

  async function play() {
    const [a, b] = loopRange();
    q('[data-play]').innerHTML = `${icon('pause', 'sm')} Pausa`;
    try {
      await player.play({
        samples: listen, fs: audio.sampleRate, start: a, end: b, startAt: loopMode === 'all' && cursor > a && cursor < b - 0.2 ? cursor : null,
        loop: loopOn, speed, bands: [], volumeDb, normalize: true,
        onEnd: () => { q('[data-play]').innerHTML = `${icon('play', 'sm')} Riproduci`; },
      });
    } catch (e) { toast('Riproduzione non riuscita: ' + e.message, { type: 'error' }); }
  }
  function stopPlay() {
    const p = player.position();
    if (p !== null) cursor = p;
    player.stop();
    q('[data-play]').innerHTML = `${icon('play', 'sm')} Riproduci`;
  }
  const restartIfPlaying = () => { if (player.playing) play(); };

  function setLoopMode(m) {
    loopMode = m;
    view.querySelectorAll('[data-lmode] button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
  }

  // ---------- interazione col grafico ----------
  let dragging = null;
  const pointers = new Map();
  const tOf = (clientX) => {
    const r = q('[data-wave]').getBoundingClientRect();
    return vw[0] + ((clientX - r.left) / r.width) * (vw[1] - vw[0]);
  };
  function zoom(f, center) {
    const w = Math.max(0.3, Math.min(duration, (vw[1] - vw[0]) * f));
    const c = center ?? (vw[0] + vw[1]) / 2;
    const rel = (c - vw[0]) / (vw[1] - vw[0]);
    let a = c - rel * w;
    a = Math.max(0, Math.min(duration - w, a));
    vw = [a, a + w];
    dirtyBase = true;
  }
  for (const sel of ['[data-wave]', '[data-spec]']) {
    const cv = q(sel);
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, e.clientX);
      if (pointers.size === 2) {
        const xs = [...pointers.values()];
        dragging = { pinch: true, d0: Math.abs(xs[0] - xs[1]) || 1, vw0: vw.slice(), c: tOf((xs[0] + xs[1]) / 2) };
      } else dragging = { x0: e.clientX, t0: tOf(e.clientX), moved: false };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!dragging || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, e.clientX);
      if (dragging.pinch && pointers.size === 2) {
        const xs = [...pointers.values()];
        const d = Math.abs(xs[0] - xs[1]) || 1;
        vw = dragging.vw0.slice();
        zoom(dragging.d0 / d, dragging.c);
        return;
      }
      if (Math.abs(e.clientX - dragging.x0) > 6) dragging.moved = true;
      if (dragging.moved) {
        const t = Math.max(0, Math.min(duration, tOf(e.clientX)));
        selection = [Math.min(dragging.t0, t), Math.max(dragging.t0, t)];
      }
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (!dragging) return;
      if (dragging.pinch) { if (!pointers.size) dragging = null; return; }
      if (!dragging.moved) {
        cursor = Math.max(0, Math.min(duration, dragging.t0));
        if (selection && (cursor < selection[0] || cursor > selection[1])) selection = null;
        if (player.playing && loopMode !== 'sel') play();
      } else if (selection && selection[1] - selection[0] > 0.05) {
        setLoopMode('sel');
        cursor = selection[0];
        restartIfPlaying();
      }
      dragging = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      // rotella semplice = scorre la pagina; Ctrl+rotella (o pinch del trackpad) = zoom; Maiusc+rotella = scorre il tempo
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const w = vw[1] - vw[0];
        const d = ((e.shiftKey ? e.deltaY : e.deltaX) / 600) * w;
        const a = Math.max(0, Math.min(duration - w, vw[0] + d));
        vw = [a, a + w];
        dirtyBase = true;
      } else zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, tOf(e.clientX));
    }, { passive: false });
  }
  const mini = q('[data-mini]');
  const moveMini = (e) => {
    const r = mini.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * duration;
    const w = vw[1] - vw[0];
    const a = Math.max(0, Math.min(duration - w, t - w / 2));
    vw = [a, a + w];
    dirtyBase = true;
  };
  mini.addEventListener('pointerdown', (e) => { mini.setPointerCapture(e.pointerId); moveMini(e); mini.onpointermove = moveMini; });
  mini.addEventListener('pointerup', () => { mini.onpointermove = null; });

  // ---------- comandi ----------
  q('[data-play]').onclick = () => (player.playing ? stopPlay() : play());
  q('[data-loop]').onclick = (e) => { loopOn = !loopOn; e.currentTarget.classList.toggle('on', loopOn); restartIfPlaying(); };
  view.querySelectorAll('[data-lmode] button').forEach((b) => { b.onclick = () => { if (b.dataset.v === 'sel' && !selection) { toast('Trascina sul grafico per selezionare un tratto'); return; } setLoopMode(b.dataset.v); restartIfPlaying(); }; });
  setLoopMode('all');
  const speeds = view.querySelectorAll('[data-speed] button');
  speeds.forEach((b) => {
    b.classList.toggle('on', +b.dataset.v === speed);
    b.onclick = () => { speed = +b.dataset.v; speeds.forEach((x) => x.classList.toggle('on', x === b)); restartIfPlaying(); };
  });
  q('[data-preset]').onchange = (e) => setListenFilter(e.target.value);
  q('[data-vol]').oninput = (e) => { volumeDb = +e.target.value; player.setVolume(volumeDb); };
  q('[data-zin]').onclick = () => zoom(1 / 1.6);
  q('[data-zout]').onclick = () => zoom(1.6);
  q('[data-zfit]').onclick = () => { vw = [0, duration]; dirtyBase = true; };
  q('[data-notes]').onchange = async (e) => { rec.notes = e.target.value; rec = await repo.saveRecording(rec); toast('Note salvate'); };

  const fileBase = () => `Fonogramma_${safeName(patient ? `${patient.lastName}_${patient.firstName}` : 'senza_paziente')}_${safeName(siteById(rec.site) ? siteById(rec.site).name : rec.site)}_${new Date(rec.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  q('[data-wav]').onclick = async () => {
    const [s0, s1] = selection || [0, duration];
    const y = await player.render(listen, audio.sampleRate, Math.round(s0 * audio.sampleRate), Math.round(s1 * audio.sampleRate), [], 1, true);
    downloadBlob(encodeWav(y, audio.sampleRate), `${fileBase()}${playPreset === REC_FILTER_ID ? '' : '_' + safeName(filterById(playPreset).name)}.wav`);
  };

  q('[data-more]').onclick = () => {
    const body = el(`<div class="col">
      <button class="btn" data-a="raw">${icon('download', 'sm')} Esporta l'originale non filtrato (WAV)</button>
      <button class="btn" data-a="assign">${icon('user', 'sm')} Assegna a paziente / visita</button>
      <button class="btn" data-a="site">${icon('pin', 'sm')} Cambia focolaio / punto</button>
      <button class="btn danger" data-a="del">${icon('trash', 'sm')} Elimina registrazione</button>
    </div>`);
    const sh = sheet({ title: 'Azioni', body });
    body.onclick = async (e) => {
      const a = e.target.closest('[data-a]');
      if (!a) return;
      sh.close();
      if (a.dataset.a === 'raw') downloadBlob(await loadRecordingBlob(rec), `${fileBase()}_originale.wav`);
      else if (a.dataset.a === 'assign') assign();
      else if (a.dataset.a === 'site') changeSite();
      else if (a.dataset.a === 'del') {
        if (await confirmDialog('Eliminare definitivamente questa registrazione?', { danger: true, okText: 'Elimina' })) {
          await repo.deleteRecording(rec.id);
          history.back();
        }
      }
    };
  };

  async function assign() {
    const patients = await repo.listPatients();
    const body = el(`<div class="col">
      <label class="field"><span>Paziente</span><select data-p><option value="">— nessuno —</option>${patients.map((p) => `<option value="${esc(p.id)}" ${p.id === rec.patientId ? 'selected' : ''}>${esc(patientName(p))}</option>`).join('')}</select></label>
      <label class="field"><span>Visita</span><select data-v></select></label></div>`);
    const fillVisits = async () => {
      const pid = body.querySelector('[data-p]').value;
      const vs = pid ? await repo.listVisits(pid) : [];
      body.querySelector('[data-v]').innerHTML = `<option value="">— nessuna —</option>` + vs.map((v) => `<option value="${esc(v.id)}" ${v.id === rec.visitId ? 'selected' : ''}>${fmtDateTime(v.date)}${v.reason ? ' · ' + esc(v.reason) : ''}</option>`).join('');
    };
    body.querySelector('[data-p]').onchange = fillVisits;
    await fillVisits();
    sheet({
      title: 'Assegna registrazione', body,
      actions: [{ label: 'Annulla', kind: 'ghost' }, {
        label: 'Salva', kind: 'primary', run: async () => {
          rec.patientId = body.querySelector('[data-p]').value || null;
          rec.visitId = body.querySelector('[data-v]').value || null;
          rec = await repo.saveRecording(rec);
          toast('Registrazione assegnata');
        },
      }],
    });
  }

  function changeSite() {
    const list = rec.kind === 'lung' ? LUNG_SITES : HEART_SITES;
    const body = el(`<div class="list">${list.map((s) => `<div class="list-item" data-s="${s.id}"><div class="site-num">${s.n}</div><div class="grow"><b>${esc(s.full)}</b><div class="small muted">${esc(s.where)}</div></div>${s.id === rec.site ? icon('check') : ''}</div>`).join('')}</div>`);
    const sh = sheet({ title: 'Focolaio / punto', body });
    body.onclick = async (e) => {
      const it = e.target.closest('[data-s]');
      if (!it) return;
      rec.site = it.dataset.s;
      rec.label = siteName(rec.site);
      rec = await repo.saveRecording(rec);
      sh.close();
      view.querySelector('h1').innerHTML = `${icon(rec.kind === 'lung' ? 'lungs' : 'heart')} ${esc(rec.label)}`;
    };
  }

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || document.querySelector('.sheet-wrap')) return;
    if (e.code === 'Space') { e.preventDefault(); player.playing ? stopPlay() : play(); }
  };
  document.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => { layoutOverlay(); dirtyBase = true; });
  ro.observe(q('[data-plots]'));
  layoutOverlay();
  raf = requestAnimationFrame(frame);
  analyze(rec.kind === 'lung' ? 'lung' : 'heart');

  return async () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener('keydown', onKey);
    await player.close();
  };
}
