// The averaged beat: the tick and the tock as the pipeline's template holds them, energy above
// 1.5 kHz summed over the bands, around the moment each beat is timed. It is drawn as a sound
// level (the square root of the energy), which keeps the quiet sounds inside a beat visible
// beside the loud one. Amplitude markers will go on those sounds when amplitude is measured.

import { prepare, chartColors } from './canvas.js';
import { ticks } from './model.js';

/** @typedef {import('../dsp/pipeline.js').WaveformEvent} WaveformEvent */

const PAD = { left: 12, right: 12, top: 10, bottom: 24 };

export class WaveformView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    /** @type {WaveformEvent|null} */
    this.wave = null;
    this.message = '';
  }

  /**
   * @param {WaveformEvent|null} wave
   * @param {string} message shown when there is no waveform
   */
  set(wave, message) {
    this.wave = wave;
    this.message = message;
    this.draw();
  }

  draw() {
    const { ctx, width, height } = prepare(this.canvas);
    const c = chartColors(this.canvas);
    const w = width - PAD.left - PAD.right;
    const h = height - PAD.top - PAD.bottom;
    const fromMs = this.wave ? this.wave.from * 1000 : -12;
    const toMs = this.wave ? this.wave.to * 1000 : 12;
    const x = (/** @type {number} */ ms) => PAD.left + ((ms - fromMs) / (toMs - fromMs)) * w;
    ctx.font = `11px ${c.font}`;
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.grid;
    ctx.fillStyle = c.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const ms of ticks(fromMs, toMs, 4)) {
      const px = Math.round(x(ms)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, height - PAD.bottom);
      ctx.stroke();
      ctx.fillText(ms === 0 ? 'beat' : `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`, px, height - PAD.bottom + 6);
    }
    const wave = this.wave;
    if (!wave) {
      ctx.fillStyle = c.faint;
      ctx.font = `14px ${c.font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(this.message, PAD.left + w / 2, PAD.top + h / 2);
      return;
    }
    const level = (/** @type {number} */ v) => Math.sqrt(Math.max(0, v));
    const lo = 0;
    let hi = 1e-9;
    for (const b of wave.beats) for (const v of b.values) hi = Math.max(hi, level(v));
    const y = (/** @type {number} */ v) => PAD.top + (1 - (level(v) - lo) / (hi - lo)) * h;
    ctx.strokeStyle = c.grid;
    ctx.beginPath();
    ctx.moveTo(PAD.left, Math.round(y(0)) + 0.5);
    ctx.lineTo(width - PAD.right, Math.round(y(0)) + 0.5);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    // Tock first, so the tick is drawn on top where they overlap.
    for (const b of [...wave.beats].sort((p, q) => q.type - p.type)) {
      ctx.strokeStyle = b.type === 0 ? c.tick : c.tock;
      ctx.beginPath();
      for (let i = 0; i < b.values.length; i++) {
        const px = x(fromMs + (i / wave.rate) * 1000);
        const py = y(b.values[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }
}
