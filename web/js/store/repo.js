// Accesso ai dati: pazienti, visite, registrazioni (con audio). Ogni modifica è
// marcata "dirty" e verrà inviata al server di casa dalla sincronizzazione.
import * as db from './db.js';
import { uuid } from '../util.js';

const listeners = new Set();
export function onDataChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emitChange(kind) { listeners.forEach((fn) => fn(kind)); }

let syncHook = null;
export function setSyncHook(fn) { syncHook = fn; }

function stamp(doc) {
  doc.updatedAt = Date.now();
  doc.dirty = 1;
  return doc;
}

async function save(store, doc) {
  stamp(doc);
  await db.put(store, doc);
  emitChange(store);
  syncHook && syncHook();
  return doc;
}

const alive = (d) => d && !d.deleted;
const byName = (a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'it');

// ---------- Pazienti ----------
export async function listPatients() {
  return (await db.all('patients')).filter(alive).sort(byName);
}
export async function getPatient(id) {
  const p = id ? await db.get('patients', id) : null;
  return alive(p) ? p : null;
}
export async function savePatient(p) {
  if (!p.id) { p.id = uuid(); p.createdAt = Date.now(); }
  return save('patients', p);
}
export async function deletePatient(id) {
  const p = await db.get('patients', id);
  if (!p) return;
  for (const v of await db.byIndex('visits', 'patientId', id)) await deleteVisit(v.id, false);
  for (const r of await db.byIndex('recordings', 'patientId', id)) await deleteRecording(r.id, false);
  p.deleted = 1;
  await save('patients', p);
}

// ---------- Visite ----------
export async function listVisits(patientId) {
  const vs = (await db.byIndex('visits', 'patientId', patientId)).filter(alive);
  return vs.sort((a, b) => b.date - a.date);
}
export async function recentVisits(limit = 8) {
  const vs = (await db.all('visits')).filter(alive).sort((a, b) => b.date - a.date);
  return vs.slice(0, limit);
}
export async function getVisit(id) {
  const v = id ? await db.get('visits', id) : null;
  return alive(v) ? v : null;
}
export async function saveVisit(v) {
  if (!v.id) {
    v.id = uuid();
    v.createdAt = Date.now();
    v.date = v.date || Date.now();
    v.heart = v.heart || {};
    v.lung = v.lung || {};
    v.vitals = v.vitals || {};
    v.status = v.status || 'aperta';
  }
  return save('visits', v);
}
export async function deleteVisit(id, emit = true) {
  const v = await db.get('visits', id);
  if (!v) return;
  for (const r of await db.byIndex('recordings', 'visitId', id)) await deleteRecording(r.id, false);
  v.deleted = 1;
  if (emit) await save('visits', v);
  else { stamp(v); await db.put('visits', v); }
}

// ---------- Registrazioni ----------
export async function listRecordings({ visitId, patientId, free } = {}) {
  let rs;
  if (visitId) rs = await db.byIndex('recordings', 'visitId', visitId);
  else if (patientId) rs = await db.byIndex('recordings', 'patientId', patientId);
  else rs = await db.all('recordings');
  rs = rs.filter(alive);
  if (free) rs = rs.filter((r) => !r.patientId);
  return rs.sort((a, b) => b.createdAt - a.createdAt);
}
export async function getRecording(id) {
  const r = id ? await db.get('recordings', id) : null;
  return alive(r) ? r : null;
}
export async function saveRecording(rec, blob) {
  if (!rec.id) { rec.id = uuid(); rec.createdAt = rec.createdAt || Date.now(); }
  if (blob) { await db.put('blobs', blob, rec.id); rec.audioSynced = 0; rec.hasAudio = 1; }
  return save('recordings', rec);
}
export async function deleteRecording(id, emit = true) {
  const r = await db.get('recordings', id);
  if (!r) return;
  r.deleted = 1;
  await db.del('blobs', id);
  if (emit) await save('recordings', r);
  else { stamp(r); await db.put('recordings', r); }
}
export async function getLocalAudio(id) {
  return db.get('blobs', id);
}
