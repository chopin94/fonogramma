// Impostazioni: ingresso audio, registrazione, visualizzazione, preset personali,
// archivio locale con backup e ripristino.
import { esc, toast, confirmDialog, downloadBlob } from '../util.js';
import { settings, updateSettings, applyTheme } from '../settings.js';
import { listInputs } from '../audio/engine.js';
import { INPUT_KINDS, INPUT_TYPES, classifyInput } from '../audio/input.js';
import { COLORMAPS, lutCss } from '../ui/colormaps.js';
import { openEqEditor } from '../ui/eqeditor.js';
import { exportBackup, importBackup } from '../store/backup.js';
import { persist } from '../store/db.js';
import { icon } from '../ui/icons.js';
import { APP_VERSION, SOURCE_URL } from '../version.js';
import { PROFILES } from '../profiles.js';

export async function mount(view) {
  const SECTIONS = [['profilo', 'Profilo'], ['ingresso', 'Ingresso audio'], ['registrazione', 'Registrazione'], ['aspetto', 'Aspetto'], ['preset', 'Preset'], ['archivio', 'Archivio e backup'], ['info', 'Informazioni']];
  view.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Impostazioni</h1><div class="meta">Valgono per questo dispositivo</div></div></div>
    <nav class="chips scroll toc" data-toc>${SECTIONS.map(([id, name]) => `<button class="chip" data-go="${id}">${name}</button>`).join('')}</nav>
    <div class="card col" style="margin-bottom:12px" id="set-profilo">
      <h3>${icon('user')} Chi usa l’app</h3>
      <div class="seg" data-prof>${PROFILES.map((p) => `<button data-v="${p.id}">${p.name}</button>`).join('')}</div>
      <div class="small muted" data-profdesc></div>
    </div>
    <div class="grid two">
      <div class="card col" data-input id="set-ingresso"></div>
      <div class="card col" id="set-registrazione">
        <h3>${icon('rec')} Registrazione</h3>
        <label class="field"><span>Memoria "ultimi secondi" (buffer ad anello): <b data-lv>${settings.loopSeconds} s</b></span><input type="range" min="10" max="120" step="5" value="${settings.loopSeconds}" data-loop></label>
        <label class="field"><span>Pulsante "Ultimi…": salva gli ultimi <b data-gv>${settings.grabSeconds} s</b></span><input type="range" min="5" max="60" step="5" value="${settings.grabSeconds}" data-grab></label>
        <div class="form-grid">
          <label class="field"><span>Durata max registrazione (s)</span><input type="number" min="10" max="900" value="${settings.maxRecSeconds}" data-max></label>
          <label class="field"><span>Esame guidato: cuore (s)</span><input type="number" min="5" max="60" value="${settings.guidedHeartS}" data-gh></label>
          <label class="field"><span>Esame guidato: torace (s)</span><input type="number" min="5" max="60" value="${settings.guidedLungS}" data-gl></label>
          <label class="field"><span>Conto alla rovescia (s)</span><input type="number" min="0" max="10" value="${settings.guidedCountdown}" data-gc></label>
        </div>
        <label class="check"><input type="checkbox" data-gwc ${settings.guidedWaitClean ? 'checked' : ''}> Esame guidato: aspetta un segnale senza disturbi prima di registrare</label>
      </div>
      <div class="card col" id="set-aspetto">
        <h3>${icon('layers')} Aspetto</h3>
        <div class="field"><span>Tema</span><div class="seg" data-theme><button data-v="auto">Automatico</button><button data-v="dark">Scuro</button><button data-v="light">Chiaro</button></div></div>
        <div class="field"><span>Mappa colori del waterfall</span><div class="col" data-cmaps style="gap:6px"></div></div>
      </div>
      <div class="card col" data-presets id="set-preset"></div>
      <div class="card col" data-storage id="set-archivio"></div>
      <div class="card col" id="set-info">
        <h3>${icon('info')} Informazioni</h3>
        <p class="small">Fonogramma ${APP_VERSION} · PWA open source per fonendoscopio con uscita jack: filtri ed equalizzatore, waterfall, riconoscimento S1–S4, metriche, archivio pazienti, referto. Nasce dall'unione dei programmi <i>fonocardiogrammaPCG</i>, <i>cardiogramma v1–v3</i>, <i>Cardiogram94</i> e <i>PCGdroid</i>.</p>
        <p class="small">Codice sorgente: <a href="${SOURCE_URL}" target="_blank" rel="noopener">${SOURCE_URL.replace('https://', '')}</a></p>
        <p class="small muted">Strumento di supporto all'auscultazione: le analisi automatiche sono indicative e non costituiscono diagnosi. Non è un dispositivo medico certificato.</p>
      </div>
    </div>
  </div>`;
  const q = (s) => view.querySelector(s);

  // --- ingresso audio ---
  async function renderInput() {
    const devs = await listInputs().catch(() => []);
    const labels = devs.some((d) => d.label);
    const box = q('[data-input]');
    box.innerHTML = `<h3>${icon('mic')} Ingresso audio</h3>
      <label class="field"><span>Come acquisisci il suono</span><select data-kind>${INPUT_KINDS.map((k) => `<option value="${k.id}" ${k.id === settings.inputKind ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>
      <p class="small" data-kindhelp></p>
      <label class="field"><span>Dispositivo</span><select data-dev><option value="">Predefinito di sistema</option>
        ${devs.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === settings.deviceId ? 'selected' : ''}>${esc(d.label || 'Ingresso audio')}${d.label ? ` · ${INPUT_TYPES[classifyInput(d.label)].short}` : ''}</option>`).join('')}</select></label>
      ${labels ? '' : `<button class="btn sm" data-perm>${icon('mic', 'sm')} Mostra i nomi degli ingressi (richiede il permesso)</button>`}
      <label class="field"><span>Canale</span><select data-ch>${[['mix', 'Mono (somma)'], ['L', 'Sinistro'], ['R', 'Destro']].map(([v, l]) => `<option value="${v}" ${settings.inputChannel === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" data-mon ${settings.monitor ? 'checked' : ''}> Ascolto in cuffia attivo all'avvio</label>
      <div class="row"><a class="btn primary" href="#/live?check=1&autostart=1">${icon('check', 'sm')} Verifica guidata dell’ingresso</a><a class="btn" href="#/live">${icon('stetho', 'sm')} Prova l'ingresso</a></div>
      <div class="tiny muted">La verifica (30 s) controlla che il suono arrivi dal fonendo, misura rumore e ronzio e prova il battito sul torace; ti dice cosa correggere.</div>`;
    const kindHelp = () => {
      box.querySelector('[data-kindhelp]').textContent = {
        stetho: 'Collega il fonendoscopio al jack con un cavo a 4 poli (TRRS, cuffie+microfono); sui telefoni senza jack usa un adattatore USB-C con ingresso microfono. Va bene anche un microfono o una scheda audio USB.',
        phone: 'Il microfono principale del telefono (bordo inferiore) va appoggiato sulla pelle nuda. Adatto soprattutto al cuore.',
        bt: 'Funzionano solo i fonendi che il telefono vede come normale microfono Bluetooth, con qualità ridotta. Quelli che richiedono un’app del produttore non sono accessibili da una pagina web.',
      }[settings.inputKind] || '';
    };
    kindHelp();
    box.querySelector('[data-kind]').onchange = (e) => { updateSettings({ inputKind: e.target.value }); kindHelp(); };
    box.querySelector('[data-dev]').onchange = (e) => updateSettings({ deviceId: e.target.value });
    box.querySelector('[data-ch]').onchange = (e) => updateSettings({ inputChannel: e.target.value });
    box.querySelector('[data-mon]').onchange = (e) => updateSettings({ monitor: e.target.checked });
    const perm = box.querySelector('[data-perm]');
    if (perm) perm.onclick = async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        renderInput();
      } catch (e) { toast('Permesso negato o HTTPS mancante', { type: 'error' }); }
    };
  }
  renderInput();

  // --- indice delle sezioni ---
  q('[data-toc]').onclick = (e) => {
    const b = e.target.closest('[data-go]');
    if (b) view.querySelector(`#set-${b.dataset.go}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // --- profilo ---
  const rprof = () => {
    q('[data-prof]').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.profile));
    q('[data-profdesc]').textContent = (PROFILES.find((p) => p.id === settings.profile) || PROFILES[0]).desc;
  };
  rprof();
  q('[data-prof]').querySelectorAll('button').forEach((b) => { b.onclick = () => { updateSettings({ profile: b.dataset.v }); rprof(); }; });

  // --- registrazione ---
  q('[data-loop]').oninput = (e) => { q('[data-lv]').textContent = `${e.target.value} s`; updateSettings({ loopSeconds: +e.target.value }); };
  q('[data-grab]').oninput = (e) => { q('[data-gv]').textContent = `${e.target.value} s`; updateSettings({ grabSeconds: +e.target.value }); };
  q('[data-max]').onchange = (e) => updateSettings({ maxRecSeconds: Math.max(10, +e.target.value) });
  q('[data-gh]').onchange = (e) => updateSettings({ guidedHeartS: Math.max(5, +e.target.value) });
  q('[data-gl]').onchange = (e) => updateSettings({ guidedLungS: Math.max(5, +e.target.value) });
  q('[data-gc]').onchange = (e) => updateSettings({ guidedCountdown: Math.max(0, +e.target.value) });
  q('[data-gwc]').onchange = (e) => updateSettings({ guidedWaitClean: e.target.checked });

  // --- visualizzazione ---
  const th = q('[data-theme]');
  const rth = () => th.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.theme));
  rth();
  th.querySelectorAll('button').forEach((b) => { b.onclick = () => { updateSettings({ theme: b.dataset.v }); applyTheme(); rth(); }; });
  const cm = q('[data-cmaps]');
  const rcm = () => {
    cm.innerHTML = COLORMAPS.map((c) => `<button class="chip ${settings.colormap === c.id ? 'on' : ''}" data-c="${c.id}" style="display:flex;align-items:center;gap:8px;justify-content:space-between"><span>${c.name}</span><i style="display:inline-block;width:120px;height:10px;border-radius:5px;background:${lutCss(c.id)}"></i></button>`).join('');
    cm.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { updateSettings({ colormap: b.dataset.c }); rcm(); }; });
  };
  rcm();

  // --- preset personali ---
  function renderPresets() {
    const box = q('[data-presets]');
    const list = settings.customPresets || [];
    box.innerHTML = `<h3>${icon('sliders')} Preset di filtro personali</h3>
      ${list.length ? `<div class="list">${list.map((p) => `<div class="list-item"><div class="grow"><b>${esc(p.name)}</b><div class="small muted">${p.bands.filter((b) => b.enabled !== false).length} bande attive</div></div><button class="icon-btn" data-del="${esc(p.id)}">${icon('trash', 'sm')}</button></div>`).join('')}</div>` : '<div class="small muted">Nessun preset personale. Creane uno con l\'equalizzatore (puoi anche importare un preset EQ in JSON).</div>'}
      <button class="btn" data-neweq>${icon('plus', 'sm')} Nuovo preset dall'equalizzatore</button>`;
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog('Eliminare questo preset?', { danger: true, okText: 'Elimina' }))) return;
        updateSettings({ customPresets: list.filter((p) => p.id !== b.dataset.del) });
        renderPresets();
      };
    });
    box.querySelector('[data-neweq]').onclick = () => {
      const ed = openEqEditor({ bands: null, title: 'Nuovo preset' });
      ed.onSaved(() => renderPresets());
    };
  }
  renderPresets();

  // --- archivio locale ---
  async function renderStorage() {
    let est = null;
    try { est = await navigator.storage.estimate(); } catch {}
    let persisted = false;
    try { persisted = await navigator.storage.persisted(); } catch {}
    const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
    const box = q('[data-storage]');
    box.innerHTML = `<h3>${icon('archive')} Archivio su questo dispositivo</h3>
      <div class="small">${est ? `Spazio usato ${mb(est.usage)} su ${mb(est.quota)} disponibili` : 'Stima non disponibile'}</div>
      <div class="small">${persisted ? '<span class="badge ok">Archiviazione persistente attiva</span>' : '<span class="badge warn">Il browser potrebbe liberare spazio</span>'}</div>
      ${persisted ? '' : `<button class="btn sm" data-persist>Chiedi archiviazione persistente</button>`}
      <p class="small">Pazienti, visite e registrazioni restano <b>solo su questo dispositivo</b>: nessun dato viene inviato a server esterni. Esporta ogni tanto un backup (serve anche per spostare i dati su un altro dispositivo): se cancelli i dati del browser o disinstalli l’app, l’archivio va perso.</p>
      <div class="row"><button class="btn" data-export>${icon('download', 'sm')} Esporta backup</button>
        <label class="btn">${icon('refresh', 'sm')} Importa backup<input type="file" accept=".json,application/json" data-import hidden></label></div>
      <div class="tiny muted">Il backup contiene dati sanitari: conservalo in un posto sicuro.</div>`;
    const p = box.querySelector('[data-persist]');
    if (p) p.onclick = async () => { toast((await persist()) ? 'Archiviazione persistente attiva' : 'Il browser non l\'ha concessa (installa l\'app per ottenerla)'); renderStorage(); };
    box.querySelector('[data-export]').onclick = async () => {
      try {
        toast('Preparazione del backup…');
        const { blob } = await exportBackup();
        downloadBlob(blob, `fonogramma-backup-${new Date().toISOString().slice(0, 10)}.json`);
      } catch (e) { toast('Backup non riuscito: ' + e.message, { type: 'error' }); }
    };
    box.querySelector('[data-import]').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const n = await importBackup(f);
        toast(`Importati ${n.added} elementi${n.skipped ? ` (${n.skipped} già aggiornati)` : ''}`);
        renderStorage();
      } catch (err) { toast('Importazione non riuscita: ' + err.message, { type: 'error' }); }
    };
  }
  renderStorage();

}
