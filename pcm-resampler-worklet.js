class PCMResampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.targetRate = 16000;
    this.frameSize = 1600;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];
    const ratio = sampleRate / this.targetRate;
    for (let i = 0; i < channel.length; i += ratio) {
      const sample = Math.max(-1, Math.min(1, channel[Math.floor(i)]));
      this.buffer.push(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
      if (this.buffer.length >= this.frameSize) {
        const out = new Int16Array(this.buffer.splice(0, this.frameSize));
        this.port.postMessage(out.buffer, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pcm-resampler', PCMResampler);
