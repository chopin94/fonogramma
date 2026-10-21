// Assistente all'auscultazione: dalle misure di qualità del segnale, dall'analisi in
// corso e dall'ingresso sceglie il problema più importante da mostrare e il rimedio.
// Un messaggio compare solo se il problema persiste e resta qualche secondo dopo che è
// sparito, per non far lampeggiare l'indicatore.
import { processingFix } from './audio/input.js';

// Ordine di priorità: i primi rendono il segnale inutilizzabile.
const ORDER = ['muted', 'input', 'silent', 'clip', 'weak', 'move', 'voice', 'friction', 'hum', 'gate', 'poor', 'inputWarn', 'ok'];
const rank = (s) => (s ? ORDER.indexOf(s.key) : ORDER.length);

// Disturbi che rendono inaffidabile un tratto registrato.
export const DISTURBANCES = ['clip', 'move', 'friction', 'voice', 'hum', 'silent', 'weak'];

export const ISSUE_NAMES = { clip: 'saturazione', move: 'urti', friction: 'sfregamento', voice: 'voce', hum: 'ronzio di rete', silent: 'assenza di segnale', weak: 'segnale debolissimo' };

// settled: l'analisi ha dati a sufficienza (qualche secondo dall'avvio) per giudicare
// la chiarezza di battito e respiro.
export function coachState({ quality: q, mode, source, kind, heart, lung, advice = [], muted = false, inputName = '', settled = true }) {
  const mic = source === 'mic';
  const lungMode = mode === 'lung';
  if (mic && muted) return { key: 'muted', level: 'bad', text: 'Ingresso sospeso dal sistema', fix: 'Un’altra app o una chiamata sta usando il microfono: chiudila e riavvia l’ascolto.' };
  const bad = advice.find((a) => a.level === 'bad');
  if (mic && bad) return { key: 'input', level: 'bad', text: bad.text.split(/[:.]/)[0], fix: bad.fix || '' };
  if (!q) return { key: 'ok', level: 'ok', text: inputName || 'In ascolto…', fix: '' };
  if (mic && q.zeroFrac > 0.95) return { key: 'silent', level: 'bad', text: 'Nessun segnale', fix: 'L’ingresso è muto: controlla il collegamento e l’ingresso scelto in Regolazioni.' };
  if (q.clipFrames >= 2) return { key: 'clip', level: 'bad', text: 'Saturazione', fix: 'Il suono è troppo forte e viene tagliato: evita colpi sulla membrana; se capita sempre, abbassa il volume d’ingresso del dispositivo.' };
  if (q.peakDb < -60) return { key: 'weak', level: 'bad', text: 'Segnale debolissimo', fix: 'Controlla il cavo e che l’ingresso scelto sia quello del fonendo.' };
  if (q.moveFrames >= 3) return { key: 'move', level: 'warn', text: 'Urti o movimenti', fix: 'Tieni fermo il fonendo con pressione costante; non far strisciare il tubo su vestiti o lenzuola.' };
  // la voce prima dello sfregamento: le consonanti come la "s" gli somigliano
  if (q.voice) return { key: 'voice', level: 'warn', text: 'Voce', fix: lungMode ? 'Il paziente respiri a bocca aperta senza parlare; silenzio nella stanza.' : 'Silenzio nella stanza; chiedi al paziente di non parlare. La voce può sembrare un soffio.' };
  if (q.frictionFrames >= 6) return { key: 'friction', level: 'warn', text: 'Sfregamento', fix: 'Non far scorrere la membrana sulla pelle. Peli e vestiti fanno rumori simili ai crepitii: appoggia sulla pelle nuda, inumidisci i peli o premi con più decisione.' };
  if (q.humHz) return { key: 'hum', level: 'warn', text: `Ronzio a ${q.humHz} Hz`, fix: 'Stacca il caricatore del telefono e allontana il cavo del fonendo da prese, alimentatori e schermi.' };
  if (mic && q.zeroFrac > 0.05) return { key: 'gate', level: 'warn', text: 'Il telefono taglia i silenzi', fix: `La riduzione del rumore del sistema è attiva e cancella i suoni deboli. ${processingFix()}` };
  if (settled && !lungMode && heart && heart.metrics && heart.metrics.sqi < 50) {
    return { key: 'poor', level: 'warn', text: 'Battito poco chiaro', fix: kind === 'phone' ? 'Premi con decisione il bordo inferiore del telefono sulla pelle nuda e cerca il punto dove il battito è più forte; silenzio nella stanza.' : 'Premi la membrana sulla pelle nuda con decisione, spostala di poco per trovare il punto migliore e riduci il rumore nella stanza.' };
  }
  if (settled && lungMode && lung && lung.metrics && lung.metrics.sqi < 40) return { key: 'poor', level: 'warn', text: 'Respiro poco udibile', fix: 'Il paziente faccia respiri profondi a bocca aperta; appoggia bene la membrana sulla pelle nuda.' };
  const warn = advice.find((a) => a.level === 'warn');
  if (mic && warn) return { key: 'inputWarn', level: 'warn', text: warn.text.split(/[:.]/)[0], fix: warn.fix || '' };
  return { key: 'ok', level: 'ok', text: inputName ? `${inputName} · segnale buono` : 'Segnale buono', fix: '' };
}

export class Coach {
  constructor({ confirm = 2, hold = 3000 } = {}) {
    this.confirm = confirm; // valutazioni consecutive per mostrare un nuovo stato
    this.hold = hold; // ms in cui un problema resta visibile dopo l'ultima comparsa
    this.reset();
  }

  reset() { this.cur = null; this.pending = null; this.pendingN = 0; this.seen = 0; }

  update(state, now) {
    if (this.cur && state.key === this.cur.key) { this.cur = state; this.seen = now; return this.cur; }
    if (this.pending && this.pending.key === state.key) this.pendingN++;
    else { this.pending = state; this.pendingN = 1; }
    const stale = !this.cur || this.cur.key === 'ok' || now - this.seen > this.hold;
    const ready = this.pendingN >= this.confirm || state.level === 'bad' || !this.cur;
    if (ready && (stale || rank(state) < rank(this.cur))) { this.cur = state; this.seen = now; }
    return this.cur;
  }
}

// Riepilogo dei disturbi durante una registrazione (frazione di valutazioni per tipo).
export class Tally {
  constructor() { this.n = 0; this.counts = {}; }
  add(state) {
    this.n++;
    if (DISTURBANCES.includes(state.key)) this.counts[state.key] = (this.counts[state.key] || 0) + 1;
  }
  worst() {
    let key = null, frac = 0;
    for (const [k, c] of Object.entries(this.counts)) if (c / this.n > frac) { key = k; frac = c / this.n; }
    return { key, frac, total: this.n ? Object.values(this.counts).reduce((a, b) => a + b, 0) / this.n : 0 };
  }
}
