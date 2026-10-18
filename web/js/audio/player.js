// Player per le registrazioni: riproduzione filtrata, loop senza interruzioni
// (tutto, selezione, ciclo cardiaco), velocità ridotta a intonazione costante.
import { buildChain, makeLimiter, dbToGain } from './graph.js';
import { wsola } from './wsola.js';

export class LoopPlayer {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.state = null;
    this.token = 0;
  }

  ensure() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
      this.limiter = makeLimiter(this.ctx);
      this.gain = new GainNode(this.ctx, { gain: 1 });
      this.gain.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async render(samples, fs, a, b, bands, speed, normalize) {
    const pre = Math.min(a, Math.round(0.3 * fs));
    const seg = samples.subarray(a - pre, b);
    const oc = new OfflineAudioContext(1, Math.max(1, seg.length), fs);
    const buf = oc.createBuffer(1, Math.max(1, seg.length), fs);
    buf.copyToChannel(seg, 0);
    const src = new AudioBufferSourceNode(oc, { buffer: buf });
    const ch = buildChain(oc, bands);
    src.connect(ch.input);
    ch.output.connect(oc.destination);
    src.start();
    const rendered = await oc.startRendering();
    let y = rendered.getChannelData(0).slice(pre);
    if (speed !== 1) y = wsola(y, speed, fs);
    if (normalize) {
      let pk = 0;
      for (let i = 0; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]));
      if (pk > 1e-6) { const g = 0.8 / pk; for (let i = 0; i < y.length; i++) y[i] *= g; }
    }
    const f = Math.min(y.length >> 2, Math.round(0.004 * fs));
    for (let i = 0; i < f; i++) { const g = i / f; y[i] *= g; y[y.length - 1 - i] *= g; }
    return y;
  }

  async play({ samples, fs, start, end, startAt = null, loop = true, speed = 1, bands = [], volumeDb = 0, normalize = true, onEnd }) {
    const token = ++this.token;
    this.stop();
    const ctx = this.ensure();
    await ctx.resume();
    const a = Math.max(0, Math.round(start * fs));
    const b = Math.min(samples.length, Math.max(a + Math.round(0.05 * fs), Math.round(end * fs)));
    const y = await this.render(samples, fs, a, b, bands, speed, normalize);
    if (token !== this.token) return false;
    const buf = ctx.createBuffer(1, y.length, fs);
    buf.copyToChannel(y, 0);
    const node = new AudioBufferSourceNode(ctx, { buffer: buf, loop });
    node.connect(this.gain);
    this.gain.gain.value = dbToGain(volumeDb);
    node.onended = () => {
      if (this.node === node) { this.node = null; this.state = null; onEnd && onEnd(); }
    };
    const dur = (b - a) / fs;
    const off = startAt !== null ? Math.max(0, Math.min(dur - 0.01, startAt - a / fs)) : 0;
    node.start(0, off / speed);
    this.node = node;
    this.state = { t0: ctx.currentTime, start: a / fs, dur, speed, loop, off };
    return true;
  }

  position() {
    if (!this.node || !this.state) return null;
    const el = (this.ctx.currentTime - this.state.t0) * this.state.speed + (this.state.off || 0);
    const p = this.state.loop ? el % this.state.dur : Math.min(el, this.state.dur);
    return this.state.start + p;
  }

  get playing() { return !!this.node; }

  setVolume(db) { if (this.gain) this.gain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02); }

  stop() {
    if (this.node) {
      try { this.node.onended = null; this.node.stop(); } catch {}
      this.node = null;
      this.state = null;
    }
  }

  async close() {
    this.stop();
    if (this.ctx) try { await this.ctx.close(); } catch {}
    this.ctx = null;
  }
}
