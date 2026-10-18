// Preleva il segnale grezzo (ingresso 0) e quello filtrato (ingresso 1) e li invia,
// a blocchi, direttamente al worker di analisi tramite una MessagePort dedicata.
class TapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bs = (options.processorOptions && options.processorOptions.blockSize) || 512;
    this.raw = new Float32Array(this.bs);
    this.fil = new Float32Array(this.bs);
    this.n = 0;
    this.out = null;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'port') this.out = e.data.port;
    };
  }

  process(inputs) {
    const a = inputs[0] && inputs[0][0];
    if (!a) return true;
    const b = inputs[1] && inputs[1][0];
    for (let i = 0; i < a.length; i++) {
      this.raw[this.n] = a[i];
      this.fil[this.n] = b ? b[i] : a[i];
      if (++this.n === this.bs) {
        if (this.out) this.out.postMessage({ raw: this.raw, fil: this.fil }, [this.raw.buffer, this.fil.buffer]);
        this.raw = new Float32Array(this.bs);
        this.fil = new Float32Array(this.bs);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcg-tap', TapProcessor);
