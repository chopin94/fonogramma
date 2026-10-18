// Sincronizzazione con il server di casa (Docker): invio delle modifiche locali,
// caricamento dell'audio, ricezione delle modifiche fatte da altri dispositivi.
// Senza server (es. GitHub Pages) l'app passa da sola in modalità "solo dispositivo".
import * as db from './db.js';
import { settings } from '../settings.js';
import { emitChange, setSyncHook } from './repo.js';
import { debounce } from '../util.js';

const KINDS = ['patients', 'visits', 'recordings'];
const MODE_KEY = 'fonogramma.mode';
const savedMode = (() => { try { return localStorage.getItem(MODE_KEY); } catch { return null; } })();
const state = { mode: savedMode === 'local' || savedMode === 'server' ? savedMode : null, online: null, syncing: false, lastSync: 0, error: null, pinRequired: false, pinOk: true, pending: 0 };
const listeners = new Set();

export function syncState() { return { ...state }; }
export const isLocalMode = () => state.mode === 'local';

function setMode(m) {
  state.mode = m;
  try { localStorage.setItem(MODE_KEY, m); } catch {}
}
export function onSync(fn) { listeners.add(fn); fn(syncState()); return () => listeners.delete(fn); }
const emit = () => listeners.forEach((fn) => fn(syncState()));

function headers(extra = {}) {
  const h = { ...extra };
  if (settings.pin) h['X-Access-Pin'] = settings.pin;
  return h;
}

async function api(path, opts = {}) {
  const r = await fetch(`api/${path}`, { cache: 'no-store', ...opts, headers: headers(opts.headers) });
  if (r.status === 401) { state.pinOk = false; throw new Error('PIN di accesso non valido'); }
  if (!r.ok) throw new Error(`Server: errore ${r.status}`);
  return r;
}

function strip(doc) {
  const { dirty, audioSynced, ...rest } = doc;
  return rest;
}

async function countPending() {
  let n = 0;
  for (const k of KINDS) n += (await db.all(k)).filter((d) => d.dirty || (k === 'recordings' && d.hasAudio && !d.audioSynced && !d.deleted)).length;
  return n;
}

export async function checkServer() {
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    // risposta senza API (404 o pagina statica): nessun server, solo archivio locale
    const json = (r.headers.get('content-type') || '').includes('json');
    if (r.status === 404 || (r.ok && !json)) { setMode('local'); state.online = null; return null; }
    if (!r.ok) throw new Error();
    const j = await r.json();
    setMode('server');
    state.online = true;
    state.pinRequired = !!j.pinRequired;
    return j;
  } catch {
    state.online = false;
    return null;
  } finally { emit(); }
}

export async function testPin() {
  try { await api('auth'); state.pinOk = true; return true; } catch { return false; } finally { emit(); }
}

export async function syncNow() {
  if (state.syncing || state.mode === 'local') return;
  state.syncing = true;
  emit();
  try {
    const h = await checkServer();
    if (!h) throw new Error('Server non raggiungibile');
    if (h.pinRequired && !settings.pin) { state.pinOk = false; throw new Error('Inserisci il PIN del server in Impostazioni'); }

    // 1) invio documenti modificati
    const dirty = [];
    for (const k of KINDS) for (const d of await db.all(k)) if (d.dirty) dirty.push({ kind: k, id: d.id, updatedAt: d.updatedAt, deleted: !!d.deleted, data: strip(d) });
    for (let i = 0; i < dirty.length; i += 200) {
      const chunk = dirty.slice(i, i + 200);
      const r = await api('sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docs: chunk }) });
      const j = await r.json();
      for (const a of j.accepted || []) {
        const cur = await db.get(a.kind, a.id);
        if (cur && cur.updatedAt === a.updatedAt) { cur.dirty = 0; await db.put(a.kind, cur); }
      }
    }
    state.pinOk = true;

    // 2) audio non ancora caricato
    for (const r of await db.all('recordings')) {
      if (r.deleted || !r.hasAudio || r.audioSynced) continue;
      const blob = await db.get('blobs', r.id);
      if (!blob) continue;
      await api(`audio/${r.id}`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: blob });
      const cur = await db.get('recordings', r.id);
      if (cur) { cur.audioSynced = 1; await db.put('recordings', cur); }
    }

    // 3) ricezione modifiche dagli altri dispositivi
    let since = (await db.kvGet('pullSeq')) || 0;
    let changed = false;
    for (let guard = 0; guard < 100; guard++) {
      const r = await api(`sync?since=${since}`);
      const j = await r.json();
      for (const d of j.docs) {
        if (!KINDS.includes(d.kind)) continue;
        const local = await db.get(d.kind, d.id);
        if (local && local.updatedAt >= d.updatedAt) continue;
        const doc = { ...d.data, id: d.id, updatedAt: d.updatedAt, deleted: d.deleted ? 1 : 0, dirty: 0 };
        if (d.kind === 'recordings') {
          doc.audioSynced = 1;
          doc.hasAudio = 1;
          if (d.deleted) await db.del('blobs', d.id);
        }
        await db.put(d.kind, doc);
        changed = true;
      }
      since = j.seq;
      await db.kvSet('pullSeq', since);
      if (!j.more) break;
    }
    state.lastSync = Date.now();
    state.error = null;
    state.online = true;
    if (changed) emitChange('sync');
  } catch (e) {
    state.error = e.message;
  } finally {
    state.pending = await countPending().catch(() => 0);
    state.syncing = false;
    emit();
  }
}

// Scarica l'audio di una registrazione creata su un altro dispositivo.
export async function fetchAudio(id) {
  if (state.mode === 'local') throw new Error('Audio non presente su questo dispositivo');
  const r = await api(`audio/${id}`);
  const blob = await r.blob();
  await db.put('blobs', blob, id);
  return blob;
}

export async function downloadBackup() {
  const r = await api('backup');
  return r.blob();
}

const scheduled = debounce(syncNow, 1500);
export async function startSync() {
  if (state.mode === 'local') { emit(); return; } // già noto: nessuna richiesta inutile
  await checkServer();
  if (state.mode === 'local') return;
  setSyncHook(() => { scheduled(); countPending().then((n) => { state.pending = n; emit(); }); });
  syncNow();
  setInterval(syncNow, 30000);
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
}
