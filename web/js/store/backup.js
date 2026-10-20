// Backup dell'archivio locale in un unico file JSON (pazienti, visite, registrazioni e
// audio WAV in base64) e ripristino: serve a conservare i dati e a spostarli fra dispositivi.
import * as db from './db.js';
import { emitChange } from './repo.js';

const FORMAT = 'fonogramma-backup';
const KINDS = ['patients', 'visits', 'recordings'];

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type = 'audio/wav') {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type });
}

// Il file viene composto a pezzi per non creare un'unica stringa enorme.
export async function exportBackup() {
  const parts = [`{"format":"${FORMAT}","version":1,"exportedAt":${Date.now()}`];
  for (const k of KINDS) {
    const docs = (await db.all(k)).filter((d) => !d.deleted).map(({ dirty, audioSynced, ...rest }) => rest); // campi della vecchia sincronizzazione
    parts.push(`,${JSON.stringify(k)}:${JSON.stringify(docs)}`);
  }
  parts.push(',"audio":{');
  let first = true, n = 0;
  for (const r of await db.all('recordings')) {
    if (r.deleted) continue;
    const blob = await db.get('blobs', r.id);
    if (!blob) continue;
    parts.push(`${first ? '' : ','}${JSON.stringify(r.id)}:"${await blobToBase64(blob)}"`);
    first = false;
    n++;
  }
  parts.push('}}');
  return { blob: new Blob(parts, { type: 'application/json' }), audio: n };
}

// Unisce il backup all'archivio: vince la versione modificata più di recente, salvo
// che quella locale sia stata eliminata.
export async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('File non leggibile'); }
  if (!data || data.format !== FORMAT) throw new Error('Non è un backup di Fonogramma');
  const audio = data.audio || {};
  const count = { added: 0, skipped: 0 };
  for (const k of KINDS) {
    for (const d of data[k] || []) {
      if (!d || !d.id) continue;
      const local = await db.get(k, d.id);
      // un elemento eliminato su questo dispositivo viene ripristinato dal backup
      if (local && !local.deleted && (local.updatedAt || 0) >= (d.updatedAt || 0)) { count.skipped++; continue; }
      const doc = { ...d, deleted: 0 };
      if (k === 'recordings') {
        if (audio[d.id]) {
          await db.put('blobs', base64ToBlob(audio[d.id]), d.id);
          doc.hasAudio = 1;
        }
      }
      await db.put(k, doc);
      count.added++;
    }
  }
  emitChange('import');
  return count;
}
