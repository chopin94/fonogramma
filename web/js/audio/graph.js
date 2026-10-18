// Costruzione della catena di filtri Web Audio (IIRFilterNode) dalle stesse sezioni
// biquadratiche usate dall'analisi JS. Usata sia dal motore live sia dal player offline.
import { sectionsForBands } from '../dsp/biquad.js';

export function buildChain(ctx, bands) {
  const secs = sectionsForBands(bands, ctx.sampleRate);
  const input = new GainNode(ctx);
  const output = new GainNode(ctx);
  const nodes = secs.map((s) => new IIRFilterNode(ctx, { feedforward: [s.b0, s.b1, s.b2], feedback: [1, s.a1, s.a2] }));
  let prev = input;
  for (const n of nodes) { prev.connect(n); prev = n; }
  prev.connect(output);
  return {
    input,
    output,
    dispose() {
      try { input.disconnect(); } catch {}
      for (const n of nodes) try { n.disconnect(); } catch {}
      try { output.disconnect(); } catch {}
    },
  };
}

// Limitatore di protezione per l'ascolto in cuffia (urti del fonendoscopio).
export function makeLimiter(ctx) {
  return new DynamicsCompressorNode(ctx, { threshold: -6, knee: 0, ratio: 20, attack: 0.001, release: 0.08 });
}

export const dbToGain = (db) => Math.pow(10, db / 20);
