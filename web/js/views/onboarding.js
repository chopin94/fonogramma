// Primo avvio in tre passi: avvertenze e profilo, come si acquisisce il suono, primo
// passo consigliato (verifica dell'ingresso, simulatore o registrazione per il medico).
import { esc, el, sheet } from '../util.js';
import { settings, updateSettings } from '../settings.js';
import { PROFILES } from '../profiles.js';
import { INPUT_KINDS } from '../audio/input.js';
import { icon } from '../ui/icons.js';

const KIND_HELP = {
  stetho: 'Cavo a 4 poli (TRRS) nel jack, o adattatore USB-C con ingresso microfono. Va bene anche un microfono USB.',
  phone: 'Il bordo inferiore del telefono, dove c’è il microfono, appoggiato sulla pelle nuda. Adatto soprattutto al cuore.',
  bt: 'Solo se il telefono lo vede come normale microfono Bluetooth; la qualità è ridotta.',
};

export function openOnboarding({ onDone } = {}) {
  let step = 0;
  const body = el('<div class="col onboarding"></div>');
  const sh = sheet({ title: 'Benvenuto in Fonogramma', body, onClose: () => onDone && onDone() });

  const dots = () => `<div class="steps">${[0, 1, 2].map((i) => `<i class="${i === step ? 'cur' : i < step ? 'done' : ''}"></i>`).join('')}<span class="tiny muted">Passo ${step + 1} di 3</span></div>`;
  const choices = (name, list, value, help = {}) => list.map((x) => `<label class="choice ${x.id === value ? 'on' : ''}"><input type="radio" name="${name}" value="${x.id}" ${x.id === value ? 'checked' : ''}><span><b>${esc(x.name)}</b><span class="small muted">${esc(help[x.id] || x.desc || '')}</span></span></label>`).join('');

  function render() {
    if (step === 0) {
      body.innerHTML = `${dots()}
        <p class="lead" style="margin:0">Strumento <b>didattico e di supporto</b> all'auscultazione con fonendoscopio collegato al telefono o al computer.</p>
        <ul class="small" style="margin:0;padding-left:1.1rem">
          <li>Le analisi automatiche sono <b>indicative</b> e non sono una diagnosi.</li>
          <li><b>Non è un dispositivo medico</b> certificato: le decisioni cliniche restano del professionista.</li>
          <li>I dati restano <b>solo su questo dispositivo</b>; fai ogni tanto un backup da Impostazioni.</li>
        </ul>
        <b>Chi usa l'app?</b>
        <div data-list>${choices('prof', PROFILES, settings.profile)}</div>`;
    } else if (step === 1) {
      body.innerHTML = `${dots()}
        <b>Come acquisisci il suono?</b>
        <div data-list>${choices('kind', INPUT_KINDS, settings.inputKind, KIND_HELP)}</div>
        <div class="tiny muted">Per ascoltare usa cuffie con filo: quelle Bluetooth ritardano il suono e su alcuni telefoni prendono il posto del microfono.</div>`;
    } else {
      const patient = settings.profile === 'paziente';
      body.innerHTML = `${dots()}
        <b>Da dove vuoi iniziare?</b>
        <div class="menu-list">
          ${patient ? `<button class="menu-item" data-go="#/autoreg">${icon('stetho')}<span class="grow"><b>Registrazione per il medico</b><span class="small muted">Ti guido punto per punto</span></span>${icon('chevR')}</button>` : ''}
          <button class="menu-item" data-go="#/live?check=1&autostart=1">${icon('check')}<span class="grow"><b>Verifica il fonendo (30 s)</b><span class="small muted">Controlla che il suono arrivi bene e senza disturbi</span></span>${icon('chevR')}</button>
          <button class="menu-item" data-go="#/live?mode=heart&autostart=1" data-demo>${icon('activity')}<span class="grow"><b>Prova con il simulatore</b><span class="small muted">Suoni cardiaci e polmonari di esempio, senza fonendo</span></span>${icon('chevR')}</button>
          <button class="menu-item" data-go="#/">${icon('home')}<span class="grow"><b>Vai alla Home</b></span>${icon('chevR')}</button>
        </div>`;
    }
    body.insertAdjacentHTML('beforeend', `<div class="row" style="justify-content:space-between;margin-top:6px">
      ${step > 0 ? `<button class="btn ghost" data-back>${icon('chevL', 'sm')} Indietro</button>` : '<span></span>'}
      ${step < 2 ? `<button class="btn primary" data-next>Avanti ${icon('chevR', 'sm')}</button>` : ''}</div>`);
    const list = body.querySelector('[data-list]');
    if (list) list.onchange = (e) => {
      updateSettings(step === 0 ? { profile: e.target.value } : { inputKind: e.target.value });
      list.querySelectorAll('.choice').forEach((c) => c.classList.toggle('on', c.querySelector('input').checked));
    };
    const next = body.querySelector('[data-next]');
    if (next) next.onclick = () => { step++; render(); };
    const back = body.querySelector('[data-back]');
    if (back) back.onclick = () => { step--; render(); };
    body.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = () => {
        if (b.hasAttribute('data-demo')) updateSettings({ source: 'demo' });
        sh.close();
        if (location.hash === b.dataset.go) dispatchEvent(new HashChangeEvent('hashchange'));
        else location.hash = b.dataset.go;
      };
    });
  }
  render();
  return sh;
}
