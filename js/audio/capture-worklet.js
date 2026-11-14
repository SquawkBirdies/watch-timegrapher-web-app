// @ts-nocheck: this file runs in the audio worklet scope, whose globals (AudioWorkletProcessor,
// registerProcessor, currentFrame) are not in TypeScript's DOM types. The browser test covers it.

// Runs on the audio thread. Collects the microphone's 128-frame render quanta into larger
// chunks and posts them to the main thread, which forwards them to the pipeline worker.
// It also counts blocks of exact digital silence, which is how a dropped stretch of audio
// usually shows up.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.chunkFrames = o.chunkFrames || 4096;
    /** @type {Float32Array[] | null} */
    this.buffers = null;
    this.fill = 0;
    this.chunkStart = 0;
    this.silentBlocks = 0;
    this.blocks = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.post();
      if (event.data === 'stop') {
        this.post();
        this.running = false;
      }
    };
  }

  post() {
    if (!this.buffers || this.fill === 0) return;
    const channels = this.buffers.map((b) => b.slice(0, this.fill));
    this.port.postMessage(
      { type: 'chunk', startFrame: this.chunkStart, channels, silentBlocks: this.silentBlocks, blocks: this.blocks },
      channels.map((c) => c.buffer),
    );
    this.fill = 0;
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    if (!this.buffers || this.buffers.length !== input.length) {
      this.post();
      this.buffers = input.map(() => new Float32Array(this.chunkFrames));
      this.fill = 0;
    }
    if (this.fill === 0) this.chunkStart = currentFrame;
    let silent = true;
    for (let c = 0; c < input.length; c++) {
      const src = input[c];
      const dst = this.buffers[c];
      for (let i = 0; i < frames; i++) {
        const v = src[i];
        if (v !== 0) silent = false;
        dst[this.fill + i] = v;
      }
    }
    this.blocks++;
    if (silent) this.silentBlocks++;
    this.fill += frames;
    if (this.fill + frames > this.chunkFrames) this.post();
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
