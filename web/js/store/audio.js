// Caricamento dell'audio di una registrazione (locale o dal server di casa).
import { getLocalAudio } from './repo.js';
import { fetchAudio } from './sync.js';
import { decodeAny } from '../audio/wav.js';

export async function loadRecordingBlob(rec) {
  let blob = await getLocalAudio(rec.id);
  if (!blob) blob = await fetchAudio(rec.id);
  return blob;
}

export async function loadRecordingAudio(rec) {
  const blob = await loadRecordingBlob(rec);
  return decodeAny(await blob.arrayBuffer());
}
