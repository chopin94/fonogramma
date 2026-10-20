// Motore di acquisizione live: sorgente (fonendoscopio via jack, simulatore o file),
// guadagno, riduzione rumore, filtri, ascolto in cuffia protetto da limitatore,
// AudioWorklet → worker real-time → worker di analisi.
import { buildChain, makeLimiter, dbToGain } from './graph.js';
import { generateDemo } from './demo.js';

const TAP_URL = new URL('./worklets/tap.js', import.meta.url);
const DENOISE_URL = new URL('./worklets/denoise.js', import.meta.url);

export async function listInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter((d) => d.kind === 'audioinput');
}

export function secureContextProblem() {
  if (!window.isSecureContext) return 'Il microfono richiede una connessione sicura: apri l\'app dal suo indirizzo https://.';
  if (!navigator.mediaDevices?.getUserMedia) return 'Questo browser non permette l\'accesso al microfono.';
  return null;
}

export class LiveEngine {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.handlers = {};
    this.reqs = new Map();
    this.reqId = 0;
    this.gen = 0;
  }

  on(evt, fn) { this.handlers[evt] = fn; }
  emit(evt, data) { this.handlers[evt] && this.handlers[evt](data); }

  async start(opts) {
    if (this.running || this.ctx) await this.stop();
    const gen = ++this.gen;
    const abortIfStale = async (stream, ctx) => {
      if (gen === this.gen) return;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (ctx) try { await ctx.close(); } catch {}
      const e = new Error('Avvio annullato');
      e.name = 'AbortError';
      throw e;
    };
    const {
      source = 'mic', deviceId = '', channel = 'mix', demoId = 'normale', file = null,
      bands = [], gainDb = 0, monitor = false, volumeDb = 0, denoise = false, denoiseStrength = 1.5, config = {},
    } = opts;
    if (source === 'mic') {
      const p = secureContextProblem();
      if (p) throw new Error(p);
    }
    let stream = null;
    if (source === 'mic') {
      const audio = {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: channel === 'mix' ? 1 : 2 },
      };
      if (deviceId) audio.deviceId = { exact: deviceId };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (err) {
        if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
          delete audio.deviceId;
          stream = await navigator.mediaDevices.getUserMedia({ audio });
        } else throw err;
      }
    }
    await abortIfStale(stream, null);
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.stream = stream;
    await ctx.audioWorklet.addModule(TAP_URL);
    await ctx.audioWorklet.addModule(DENOISE_URL);
    await abortIfStale(stream, ctx);

    let src;
    if (stream) {
      src = ctx.createMediaStreamSource(stream);
      const track = stream.getAudioTracks()[0];
      this.inputLabel = track ? track.label : 'Microfono';
    } else {
      const data = source === 'demo' ? generateDemo(demoId, ctx.sampleRate, 30) : file.samples;
      const rate = source === 'demo' ? ctx.sampleRate : file.sampleRate;
      const buf = ctx.createBuffer(1, data.length, rate);
      buf.copyToChannel(data, 0);
      src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
      src.start();
      this.bufferSource = src;
      this.inputLabel = source === 'demo' ? 'Simulatore' : (file.name || 'File audio');
    }

    this.inputNode = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    if (stream && channel !== 'mix') {
      const sp = ctx.createChannelSplitter(2);
      src.connect(sp);
      sp.connect(this.inputNode, channel === 'R' ? 1 : 0);
    } else src.connect(this.inputNode);

    this.pre = new GainNode(ctx, { gain: dbToGain(gainDb) });
    this.denoise = new AudioWorkletNode(ctx, 'pcg-denoise', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.denoise.port.postMessage({ enabled: !!denoise, strength: denoiseStrength });
    this.post = new GainNode(ctx);
    this.inputNode.connect(this.pre);
    this.pre.connect(this.denoise);
    this.chain = buildChain(ctx, bands);
    this.denoise.connect(this.chain.input);
    this.chain.output.connect(this.post);

    this.tap = new AudioWorkletNode(ctx, 'pcg-tap', {
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', processorOptions: { blockSize: 512 },
    });
    this.inputNode.connect(this.tap, 0, 0);
    this.post.connect(this.tap, 0, 1);
    this.silent = new GainNode(ctx, { gain: 0 });
    this.tap.connect(this.silent);
    this.silent.connect(ctx.destination);

    this.limiter = makeLimiter(ctx);
    this.monitorGain = new GainNode(ctx, { gain: monitor ? dbToGain(volumeDb) : 0 });
    this.post.connect(this.limiter);
    this.limiter.connect(this.monitorGain);
    this.monitorGain.connect(ctx.destination);

    this.worker = new Worker(new URL('../workers/live.js', import.meta.url), { type: 'module' });
    this.anaWorker = new Worker(new URL('../workers/analysis.js', import.meta.url), { type: 'module' });
    const audioCh = new MessageChannel();
    const anaCh = new MessageChannel();
    this.tap.port.postMessage({ type: 'port', port: audioCh.port1 }, [audioCh.port1]);
    this.anaWorker.postMessage({ type: 'live-port', port: anaCh.port2 }, [anaCh.port2]);
    this.worker.onmessage = (e) => this.onWorker(e.data);
    this.worker.onerror = (e) => this.emit('error', new Error('Errore nel worker audio: ' + (e.message || '')));
    this.anaWorker.onmessage = (e) => {
      if (e.data.type === 'analysis') this.emit('analysis', e.data);
      else if (e.data.type === 'error') console.warn('Analisi:', e.data.message);
    };
    this.worker.postMessage({ type: 'init', fs: ctx.sampleRate, audioPort: audioCh.port2, analysisPort: anaCh.port1, config }, [audioCh.port2, anaCh.port1]);
    if (ctx.state === 'suspended') await ctx.resume();
    this.running = true;
    this.source = source;
    this.emit('state', { running: true, fs: ctx.sampleRate, label: this.inputLabel });
  }

  onWorker(d) {
    if (d.type === 'frame') this.emit('frame', d);
    else if (d.type === 'ready') this.bucket = d.bucket;
    else if (d.type === 'recording' || d.type === 'grab') {
      const p = this.reqs.get(d.reqId);
      if (p) { this.reqs.delete(d.reqId); p.resolve(d.samples ? { samples: d.samples, fs: d.fs } : null); }
    }
  }

  request(msg) {
    if (!this.worker) return Promise.resolve(null);
    const reqId = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.reqs.set(reqId, { resolve, reject });
      this.worker.postMessage({ ...msg, reqId });
    });
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  setBands(bands) {
    if (!this.ctx) return;
    const old = this.chain;
    const ch = buildChain(this.ctx, bands);
    this.denoise.disconnect();
    this.denoise.connect(ch.input);
    ch.output.connect(this.post);
    this.chain = ch;
    old.dispose();
  }

  setGain(db) { if (this.pre) this.pre.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02); }
  setMonitor(on, volumeDb) { if (this.monitorGain) this.monitorGain.gain.setTargetAtTime(on ? dbToGain(volumeDb) : 0, this.ctx.currentTime, 0.03); }
  setDenoise(on, strength) { if (this.denoise) this.denoise.port.postMessage({ enabled: !!on, strength }); }
  configure(config) { if (this.worker) this.worker.postMessage({ type: 'config', config }); }
  startRecording() { if (this.worker) this.worker.postMessage({ type: 'rec-start' }); }
  stopRecording() { return this.request({ type: 'rec-stop' }); }
  grab(seconds) { return this.request({ type: 'grab', seconds }); }

  async stop() {
    this.gen++;
    this.running = false;
    for (const p of this.reqs.values()) p.resolve(null);
    this.reqs.clear();
    try { this.worker && this.worker.terminate(); } catch {}
    try { this.anaWorker && this.anaWorker.terminate(); } catch {}
    this.worker = this.anaWorker = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) { try { await this.ctx.close(); } catch {} }
    this.ctx = null;
    this.emit('state', { running: false });
  }
}
