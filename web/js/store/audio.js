// Caricamento dell'audio di una registrazione dall'archivio locale.
import { getLocalAudio } from './repo.js';
import { decodeAny } from '../audio/wav.js';

export async function loadRecordingBlob(rec) {
  const blob = await getLocalAudio(rec.id);
  if (!blob) throw new Error('Audio non presente su questo dispositivo');
  return blob;
}

export async function loadRecordingAudio(rec) {
  const blob = await loadRecordingBlob(rec);
  return decodeAny(await blob.arrayBuffer());
}
