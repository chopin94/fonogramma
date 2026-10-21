// Verifica guidata dell'ingresso (circa 30 s), in tre passi:
//  1. colpi sulla membrana: il suono arriva davvero dal fonendo (e non da un altro microfono)?
//  2. fonendo fermo in aria: rumore di fondo, ronzio di rete, silenzi tagliati dal sistema;
//  3. fonendo sul torace: battito riconoscibile, bassi presenti, isolamento dai rumori.
// Alla fine un giudizio con i rimedi, ricordato per ogni ingresso.
import { esc, el, sheet, toast } from '../util.js';
import { settings, updateSettings } from '../settings.js';
import { icon } from '../ui/icons.js';
import { INPUT_TYPES, inputAdvice, processingFix, worstLevel } from '../audio/input.js';
import { percentile } from '../dsp/peaks.js';
import { ISSUE_NAMES } from '../coach.js';

const TAP_DB = 30; // un colpo sulla membrana collegata è molto più forte del rumore di fondo
const MAX_CHECKS = 8;

export const checkKey = (info) => (info ? `${info.type}|${info.label}` : '');
export const lastCheck = (info) => (info && (settings.inputChecks || {})[checkKey(info)]) || null;

const STEPS = {
  tap: { title: 'Colpi sulla membrana', seconds: 12 },
  air: { title: 'Fonendo fermo in aria', seconds: 5 },
  body: { title: 'Fonendo sul torace', seconds: 12 },
};

function instructions(step, kind) {
  const phone = kind === 'phone';
  if (step === 'tap') return phone ? 'Picchietta 3 volte con un dito accanto al microfono del telefono (bordo inferiore, vicino alla presa di ricarica).' : 'Tieni il fonendo in mano, non appoggiato, e picchietta 3 volte la membrana con un dito.';
  if (step === 'air') return phone ? 'Tieni il telefono fermo in mano, lontano dal corpo, in silenzio.' : 'Ora tienilo fermo in aria, senza toccare la membrana, in silenzio.';
  return phone ? 'Appoggia il bordo inferiore del telefono sulla pelle nuda sopra il cuore (a sinistra dello sterno) e resta fermo. Respira normalmente.' : 'Appoggia la membrana sulla pelle nuda sopra il cuore (a sinistra dello sterno, 4°–5° spazio intercostale) e resta fermo. Respira normalmente. Va bene anche su di te.';
}

// Giudizio a partire dalle misure dei tre passi.
export function judge(m, { info, kind }) {
  const f = [];
  const t = info ? info.type : 'unknown';
  if (m.taps) {
    if (m.taps.n >= 2 && m.taps.maxDb >= TAP_DB) f.push({ level: 'ok', text: kind === 'phone' ? 'Il microfono del telefono riceve il suono.' : 'Il suono arriva dal fonendo.' });
    else if (m.taps.n >= 1) f.push({ level: 'warn', text: `Colpi deboli (+${m.taps.maxDb} dB): il suono potrebbe arrivare da un altro microfono.`, fix: 'Picchietta più deciso; se resta debole controlla l’ingresso scelto in Regolazioni.' });
    else {
      const fix = t === 'bluetooth' && kind !== 'bt' ? 'Il telefono sta usando il microfono delle cuffie Bluetooth: scegli l’ingresso jack/USB o scollega le cuffie.'
        : t === 'builtin' && kind !== 'phone' ? 'Il telefono usa il suo microfono: serve un cavo a 4 poli (TRRS) o un adattatore USB-C con ingresso microfono.'
          : 'Controlla il cavo e l’ingresso scelto in Regolazioni → Ingresso audio.';
      f.push({ level: 'bad', text: 'Nessun colpo ricevuto: il suono non arriva dal fonendo.', fix });
    }
  }
  if (m.air) {
    if (m.air.zeroFrac > 0.95) f.push({ level: 'bad', text: 'Ingresso muto: nessun segnale.', fix: 'Controlla il collegamento e l’ingresso scelto.' });
    else if (m.air.zeroFrac > 0.05) f.push({ level: 'warn', text: 'Il telefono taglia i silenzi: la sua riduzione del rumore è attiva e cancella i suoni deboli.', fix: processingFix() });
    if (m.air.humHz) f.push({ level: 'warn', text: `Ronzio a ${m.air.humHz} Hz anche a fonendo fermo.`, fix: 'Stacca il caricatore e allontana il cavo da prese, alimentatori e schermi.' });
    if (m.air.floorDb > -35) f.push({ level: 'warn', text: `Rumore di fondo alto (${m.air.floorDb} dB) a fonendo fermo.`, fix: 'Cerca una stanza più silenziosa (ventilatori, condizionatori, voci) e controlla il cavo.' });
  }
  if (m.body) {
    const b = m.body;
    if (b.sqi >= 60 && b.bpm) f.push({ level: 'ok', text: `Battito chiaro: ${Math.round(b.bpm)} bpm, qualità ${b.sqi}/100.` });
    else if (b.sqi >= 30) f.push({ level: 'warn', text: `Battito poco chiaro (qualità ${b.sqi}/100).`, fix: 'Premi con decisione sulla pelle nuda, sposta di poco per trovare il punto migliore e riduci il rumore nella stanza.' });
    else f.push({ level: 'bad', text: 'Battito non riconosciuto.', fix: kind === 'phone' ? 'Il microfono del telefono va appoggiato con forza sulla pelle nuda; prova anche a togliere la cover.' : 'Appoggia bene la membrana sulla pelle nuda sopra il cuore; controlla che il suono arrivi dal fonendo (passo 1).' });
    if (b.lfRatioDb !== null && b.lfRatioDb < -20) f.push({ level: 'warn', text: `Bassi molto attenuati (${b.lfRatioDb} dB): S3, S4 e rullio si sentono poco.`, fix: 'È tipico del microfono del telefono e di alcuni adattatori; con un fonendo collegato via jack o USB va meglio.' });
    if (m.air && m.air.floorDb > -55 && b.floorDb > m.air.floorDb - 3) f.push({ level: 'warn', text: 'Il rumore della stanza entra anche con il fonendo appoggiato.', fix: 'Premi di più la membrana sulla pelle (deve aderire tutta) o riduci il rumore nella stanza.' });
    for (const [k, v] of Object.entries(b.issues || {})) if (v >= 0.3) f.push({ level: 'warn', text: `Durante la prova sul torace: ${ISSUE_NAMES[k]}.` });
  }
  for (const a of inputAdvice(info, kind)) if (a.level !== 'info') f.push(a);
  const worst = worstLevel(f);
  const verdict = worst === 'bad' ? 'Ingresso non adatto: correggi i problemi e ripeti la verifica'
    : worst === 'warn' ? 'Ingresso utilizzabile, con qualche limite' : 'Ingresso adatto all’auscultazione';
  return { level: worst, verdict, findings: f };
}

// Righe per la diagnostica da copiare.
export function checkLines(c) {
  if (!c) return [];
  const m = c.metrics || {};
  return [
    `Verifica guidata (${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')}): ${c.verdict}`,
    m.taps ? `- colpi: ${m.taps.n}, max +${m.taps.maxDb} dB` : '- colpi: non provati',
    m.air ? `- in aria: fondo ${m.air.floorDb} dB, silenzi tagliati ${Math.round(m.air.zeroFrac * 100)}%, ronzio ${m.air.humHz || 'no'} (${m.air.humDb} dB)` : '',
    m.body ? `- sul torace: FC ${m.body.bpm ? Math.round(m.body.bpm) : '—'}, qualità ${m.body.sqi}, SNR ${m.body.snrDb ?? '—'} dB, picco ${m.body.peakDb} dB, fondo ${m.body.floorDb} dB, bassi ${m.body.lfRatioDb} dB` : '',
  ].filter(Boolean);
}

// ctx: { source, info, kind, subscribe(fn) → annulla, heart() → ultima analisi cardiaca }
export function openInputCheck(ctx) {
  const steps = ctx.source === 'mic' ? ['tap', 'air', 'body'] : ['air', 'body'];
  const m = {};
  let i = 0, t0 = 0, samples = [], taps = new Map(), timer = 0, unsub = null, done = false;
  const body = el(`<div class="col check-flow"></div>`);
  const sh = sheet({ title: 'Verifica dell’ingresso', body, onClose: () => { done = true; clearInterval(timer); unsub && unsub(); } });

  function render() {
    const step = steps[i], S = STEPS[step];
    body.innerHTML = `
      <div class="row between"><span class="badge accent">Passo ${i + 1} di ${steps.length}</span><span class="tiny muted">${esc(S.title)}</span></div>
      <p class="lead">${esc(instructions(step, ctx.kind))}</p>
      ${step === 'tap' ? `<div class="tap-dots" data-taps>${[0, 1, 2].map(() => '<i></i>').join('')}</div>` : ''}
      <div class="progress"><i data-prog style="width:0%"></i></div>
      <div class="small muted" data-live>In ascolto…</div>
      <div class="row"><button class="btn" data-skip>${step === 'tap' ? 'Salta' : 'Avanti'}</button></div>`;
    body.querySelector('[data-skip]').onclick = next;
    t0 = performance.now();
    samples = [];
  }

  function onQuality(q) {
    if (done) return;
    samples.push(q);
    const live = body.querySelector('[data-live]');
    if (live) live.textContent = `Livello ${Math.round(q.peakDb)} dB · fondo ${Math.round(q.floorDb)} dB`;
    if (steps[i] === 'tap') {
      for (const tp of q.taps || []) {
        if (tp.db < 25 || [...taps.keys()].some((f) => Math.abs(f - tp.frame) < 15)) continue;
        taps.set(tp.frame, tp.db);
      }
      const strong = [...taps.values()].filter((d) => d >= TAP_DB).length;
      body.querySelectorAll('[data-taps] i').forEach((d, k) => d.classList.toggle('on', k < taps.size));
      if (strong >= 3) setTimeout(next, 400);
    }
  }

  function tick() {
    if (done) return;
    const S = STEPS[steps[i]];
    const el2 = (performance.now() - t0) / 1000;
    const p = body.querySelector('[data-prog]');
    if (p) p.style.width = `${Math.min(100, (el2 / S.seconds) * 100)}%`;
    if (el2 >= S.seconds) next();
  }

  function collect(step) {
    const tail = samples.slice(-Math.max(2, Math.floor(samples.length * 0.7))); // le ultime misure: il passaggio è già fatto
    const med = (k) => (tail.length ? Math.round(percentile(tail.map((s) => s[k] ?? -120), 50)) : null);
    if (step === 'tap') {
      const v = [...taps.values()];
      m.taps = { n: v.filter((d) => d >= 25).length, maxDb: v.length ? Math.max(...v) : 0 };
    } else if (step === 'air') {
      const hum = tail.filter((s) => s.humHz);
      m.air = {
        floorDb: med('floorDb'), zeroFrac: tail.length ? Math.max(...tail.map((s) => s.zeroFrac)) : 0,
        humHz: hum.length > tail.length / 2 ? hum[0].humHz : null, humDb: med('humDb'),
      };
    } else {
      const h = ctx.heart();
      const issues = {};
      for (const k of ['voice', 'friction', 'move']) {
        const n = tail.filter((s) => (k === 'voice' ? s.voice : k === 'friction' ? s.frictionFrames >= 6 : s.moveFrames >= 3)).length;
        if (tail.length) issues[k] = n / tail.length;
      }
      m.body = {
        bpm: h && h.metrics ? h.metrics.bpm : null, sqi: h && h.metrics ? h.metrics.sqi || 0 : 0,
        snrDb: h && h.metrics && h.metrics.snrDb !== null ? Math.round(h.metrics.snrDb) : null,
        peakDb: med('peakDb'), floorDb: med('floorDb'), lfRatioDb: med('lfRatioDb'), issues,
      };
    }
  }

  function next() {
    if (done) return;
    collect(steps[i]);
    i++;
    if (i < steps.length) render();
    else finish();
  }

  function finish() {
    clearInterval(timer);
    unsub && unsub();
    unsub = null;
    const r = judge(m, ctx);
    if (ctx.info) {
      const all = { ...(settings.inputChecks || {}) };
      all[checkKey(ctx.info)] = { at: Date.now(), level: r.level, verdict: r.verdict, metrics: m };
      const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
      for (const k of keys.slice(MAX_CHECKS)) delete all[k];
      updateSettings({ inputChecks: all });
    }
    body.innerHTML = `
      <div class="advice ${r.level}"><b>${esc(r.verdict)}</b>${ctx.info ? `<div class="small">${esc(INPUT_TYPES[ctx.info.type].name)} · ${esc(ctx.info.label || '')}</div>` : '<div class="small">Prova sul simulatore o su un file: il giudizio riguarda solo il segnale.</div>'}</div>
      <div class="col" style="gap:8px">${r.findings.map((x) => `<div class="advice ${x.level}"><b>${esc(x.text)}</b>${x.fix ? `<div class="small">${esc(x.fix)}</div>` : ''}</div>`).join('')}</div>
      <div class="row"><button class="btn primary" data-close>Fatto</button><button class="btn" data-again>${icon('refresh', 'sm')} Ripeti</button><button class="btn" data-copy>${icon('file', 'sm')} Copia diagnostica</button></div>`;
    body.querySelector('[data-close]').onclick = () => sh.close();
    body.querySelector('[data-again]').onclick = () => { sh.close(); setTimeout(() => openInputCheck(ctx), 250); };
    body.querySelector('[data-copy]').onclick = async () => {
      try { await navigator.clipboard.writeText(ctx.diagnostics()); toast('Diagnostica copiata: incollala in un messaggio'); } catch { toast('Copia non riuscita: usa "Copia diagnostica" nella scheda Ingresso audio', { type: 'warn' }); }
    };
    ctx.onDone && ctx.onDone(r);
  }

  render();
  unsub = ctx.subscribe(onQuality);
  timer = setInterval(tick, 200);
}
