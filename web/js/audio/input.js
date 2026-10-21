// Riconoscimento dell'ingresso audio: da quale microfono arriva il suono (jack, USB,
// Bluetooth, microfono del telefono), a che frequenza e se il sistema lo sta elaborando.
// I nomi degli ingressi cambiano con browser, sistema e lingua: il riconoscimento è
// indicativo e la verifica guidata (picchiettare la membrana) lo conferma.
import { APP_VERSION } from '../version.js';

export const INPUT_TYPES = {
  wired: { name: 'Jack (cavo con microfono)', short: 'Jack' },
  usb: { name: 'USB', short: 'USB' },
  bluetooth: { name: 'Bluetooth', short: 'Bluetooth' },
  builtin: { name: 'Microfono del telefono', short: 'Microfono del telefono' },
  unknown: { name: 'Ingresso non riconosciuto', short: 'Ingresso' },
};

// Come si acquisisce il suono (scelta dell'utente in Impostazioni).
export const INPUT_KINDS = [
  { id: 'stetho', name: 'Fonendo o microfono con filo (jack o USB)' },
  { id: 'phone', name: 'Telefono appoggiato sul torace' },
  { id: 'bt', name: 'Fonendo Bluetooth' },
];

// L'ordine conta: "Bluetooth headset" va riconosciuto prima di "headset", e su Android
// "Headset earpiece" e "Speakerphone" sono il microfono del telefono.
const RULES = [
  ['bluetooth', /bluetooth|hands-?free|\bhfp\b|\bsco\b|\bbt\b|airpods|buds|beats|wh-1000|wf-1000|soundcore|\bbose\b/i],
  ['usb', /\busb\b/i],
  ['builtin', /earpiece|speakerphone|built-?in|internal|intern[oa]|integrat|iphone|ipad|bottom|array|matrice/i],
  ['wired', /wired|headset|cuffi|auricolar|jack|line[ -]?in|ingresso linea|external|estern|headphone|casque|kopfh/i],
];

export function classifyInput(label) {
  for (const [type, re] of RULES) if (re.test(label || '')) return type;
  return 'unknown';
}

export const platform = () => {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
};

export function inspectInput(stream, ctx) {
  const track = stream.getAudioTracks()[0];
  let s = {};
  try { s = track.getSettings() || {}; } catch {}
  return {
    label: track.label || '',
    type: classifyInput(track.label),
    trackRate: s.sampleRate || null,
    ctxRate: ctx.sampleRate,
    channels: s.channelCount || null,
    // true = il browser dichiara l'elaborazione ancora attiva nonostante la richiesta di toglierla
    processing: { echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl },
    latencyMs: Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000) || null,
  };
}

// Dati dell'ingresso salvati con la registrazione.
export function inputRecord(info, kind) {
  if (!info) return null;
  const p = info.processing;
  return {
    type: info.type, kind, rate: info.trackRate || info.ctxRate,
    processing: ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter((k) => p[k] === true),
  };
}

const PROCESS_NAMES = { echoCancellation: 'cancellazione dell\'eco', noiseSuppression: 'riduzione del rumore', autoGainControl: 'controllo automatico del volume' };

export function processingFix() {
  const p = platform();
  if (p === 'ios') return 'Su iPhone apri il Centro di Controllo mentre ascolti: se compare "Modalità microfono", scegli "Standard".';
  if (p === 'android') return 'Se il telefono ha effetti come "Isolamento voce" o "Audio chiaro" (spesso nel pannello rapido durante l\'uso del microfono), disattivali.';
  return 'Disattiva i miglioramenti audio del microfono nelle impostazioni del sistema.';
}

// Avvisi e rimedi per l'ingresso in uso. level: 'bad' (segnale inaffidabile),
// 'warn' (qualità ridotta), 'info' (consiglio).
export function inputAdvice(info, kind) {
  const out = [];
  if (!info) return out;
  const t = info.type;
  if (t === 'bluetooth') {
    if (kind === 'bt') out.push({ level: 'warn', text: 'Il Bluetooth trasmette il suono con banda e qualità ridotte, e il dispositivo può applicare filtri propri: le registrazioni vengono segnate come "qualità limitata".', fix: 'Se il fonendo ha un\'uscita con filo, usa quella.' });
    else out.push({ level: 'bad', text: 'Il suono arriva dal microfono di un dispositivo Bluetooth (cuffie o auricolari), non dal fonendo.', fix: 'Scegli l\'ingresso jack o USB in Regolazioni → Ingresso audio. Se non compare, scollega le cuffie Bluetooth e ascolta con cuffie con filo (su iPhone il Bluetooth prende spesso anche il microfono).' });
  }
  if (info.trackRate && info.trackRate < 16000) out.push({ level: 'bad', text: `Campionamento a ${info.trackRate} Hz (qualità telefonica): toni e soffi vengono tagliati.`, fix: 'Usa un ingresso con filo.' });
  const active = Object.keys(PROCESS_NAMES).filter((k) => info.processing[k] === true);
  if (active.length) out.push({ level: 'warn', text: `Il sistema dichiara attiva: ${active.map((k) => PROCESS_NAMES[k]).join(', ')}. Attenua i toni deboli e i soffi.`, fix: processingFix() });
  if (kind === 'stetho' && t === 'builtin') out.push({ level: 'bad', text: 'Il fonendo non risulta collegato: si sta usando il microfono del telefono.', fix: 'Il cavo deve avere lo spinotto a 4 poli (TRRS, con microfono) o l\'adattatore USB-C deve avere l\'ingresso microfono. Ricollega e riavvia; se ci sono più ingressi, scegli quello giusto in Regolazioni.' });
  if (kind === 'phone' && (t === 'wired' || t === 'usb' || t === 'bluetooth')) out.push({ level: 'warn', text: `È in uso un ingresso esterno (${INPUT_TYPES[t].name}), non il microfono del telefono.`, fix: 'Scollegalo, oppure scegli il microfono del telefono in Regolazioni → Ingresso audio.' });
  if (kind === 'phone' && t !== 'wired' && t !== 'usb' && t !== 'bluetooth') out.push({ level: 'info', text: 'Telefono sul torace: appoggia sulla pelle nuda il bordo inferiore del telefono (vicino alla presa di ricarica, dove c\'è il microfono principale), premi con decisione e resta fermo.', fix: 'Togli la cover se è spessa. Funziona bene per il cuore; per il torace la qualità è inferiore a quella di un fonendo.' });
  if (t === 'unknown') out.push({ level: 'info', text: 'Dal nome non si capisce che tipo di ingresso sia.', fix: 'Fai la verifica guidata: picchiettando la membrana si vede subito se il suono arriva dal fonendo.' });
  return out;
}

export function worstLevel(advice) {
  return advice.some((a) => a.level === 'bad') ? 'bad' : advice.some((a) => a.level === 'warn') ? 'warn' : 'ok';
}

const yesNo = (v) => (v === true ? 'sì' : v === false ? 'no' : 'n.d.');

// Testo da copiare e inviare a chi sviluppa l'app: nessun dato dei pazienti.
export function diagnosticsText(info, { kind, inputs = [], advice = [], check = null } = {}) {
  const L = [
    `Fonogramma ${APP_VERSION} · diagnostica ingresso · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    `Browser: ${navigator.userAgent}`,
    `Uso dichiarato: ${(INPUT_KINDS.find((k) => k.id === kind) || {}).name || kind}`,
  ];
  if (info) {
    L.push(`Ingresso: "${info.label}" → ${INPUT_TYPES[info.type].name}`);
    L.push(`Campionamento: traccia ${info.trackRate || 'n.d.'} Hz, motore ${info.ctxRate} Hz, canali ${info.channels || 'n.d.'}`);
    L.push(`Elaborazioni dichiarate: eco ${yesNo(info.processing.echoCancellation)}, rumore ${yesNo(info.processing.noiseSuppression)}, volume automatico ${yesNo(info.processing.autoGainControl)}`);
    L.push(`Latenza: ${info.latencyMs ?? 'n.d.'} ms`);
  } else L.push('Ingresso: non avviato');
  if (inputs.length) L.push(`Ingressi disponibili: ${inputs.map((d) => `"${d.label || 'senza nome'}" (${INPUT_TYPES[classifyInput(d.label)].short})`).join('; ')}`);
  if (check) L.push(...check);
  if (advice.length) L.push('Avvisi:', ...advice.map((a) => `- [${a.level}] ${a.text}`));
  return L.join('\n');
}
