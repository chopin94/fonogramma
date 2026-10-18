// Codifica WAV PCM 16 bit mono e decodifica di file audio.

export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Decodifica WAV PCM/float senza ricampionare (mantiene la frequenza originale).
export function parseWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (v.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12, fmt = null, data = null;
  while (o + 8 <= v.byteLength) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), sr: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    if (id === 'data') { data = { off: o + 8, size: Math.min(size, v.byteLength - o - 8) }; break; }
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data) return null;
  const { format, ch, sr, bits } = fmt;
  const bps = bits / 8, frames = Math.floor(data.size / (bps * ch));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const p = data.off + (i * ch + c) * bps;
      let s;
      if (format === 3 && bits === 32) s = v.getFloat32(p, true);
      else if (bits === 16) s = v.getInt16(p, true) / 32768;
      else if (bits === 24) { const b = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16); s = b / 8388608; }
      else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
      else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
      else s = 0;
      acc += s;
    }
    out[i] = acc / ch;
  }
  return { samples: out, sampleRate: sr };
}

export async function decodeAny(arrayBuffer) {
  const w = parseWav(arrayBuffer.slice(0));
  if (w) return w;
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const ab = await ctx.decodeAudioData(arrayBuffer);
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return { samples: out, sampleRate: ab.sampleRate };
}
