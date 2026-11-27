// The averaged beat: the tick and the tock as the pipeline's template holds them, energy above
// 1.5 kHz summed over the bands, around the moment each beat is timed. It is drawn as a sound
// level (the square root of the energy), which keeps the quiet sounds inside a beat visible
// beside the loud one. Above the curves a bar for each beat runs from where its unlock begins
// to where its lock begins, while an amplitude that rests on them is shown: the amplitude comes
// from the bars' lengths, and the beat error is measured between the two unlocks.

import { prepare, chartColors } from './canvas.js';
import { ticks, beatName } from './model.js';

/** @typedef {import('../dsp/pipeline.js').WaveformEvent} WaveformEvent */

/** The top holds the two bars, one under the other, clear of the curves. */
const PAD = { left: 12, right: 12, top: 30, bottom: 24 };
/** Where the two bars lie, from the top of the canvas, in pixels. */
const BAR_Y = [8, 20];
/** Half the height of a bar's end caps, in pixels. */
const CAP = 4;

export class WaveformView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    /** @type {WaveformEvent|null} */
    this.wave = null;
    this.message = '';
    /** @type {0|1|null} which kind of beat is the tick; null while they have no names */
    this.tick = null;
  }

  /**
   * @param {WaveformEvent|null} wave
   * @param {string} message shown when there is no waveform
   * @param {0|1|null} [tick] which kind of beat is the tick. Without names both beats are drawn
   *   in one colour, the second with a broken line so that the two can be told apart
   */
  set(wave, message, tick = null) {
    this.wave = wave;
    this.message = message;
    this.tick = tick;
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
    /** @param {0|1} type */
    const colour = (type) => {
      const name = beatName(type, this.tick);
      return name === 'tick' ? c.tick : name === 'tock' ? c.tock : c.beat;
    };
    // The tick comes first, in the bars and on top where the curves overlap; without names,
    // the pipeline's first kind of beat.
    const first = this.tick === null ? 0 : this.tick;
    /** @param {0|1} type */
    const dashes = (type) => (this.tick === null && type !== first ? [5, 3] : []);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (const b of [...wave.beats].sort((p, q) => Number(p.type === first) - Number(q.type === first))) {
      ctx.strokeStyle = colour(b.type);
      ctx.setLineDash(dashes(b.type));
      ctx.beginPath();
      for (let i = 0; i < b.values.length; i++) {
        const px = x(fromMs + (i / wave.rate) * 1000);
        const py = y(b.values[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (!wave.marks) return;

    // A bar from each beat's unlock to its lock, with its length beside it. An end that lies
    // outside the window is cut off there and gets no cap.
    ctx.font = `11px ${c.font}`;
    ctx.textBaseline = 'middle';
    for (const type of /** @type {(0|1)[]} */ ([first, 1 - first])) {
      const m = wave.marks[type];
      const row = BAR_Y[type === first ? 0 : 1];
      const x0 = Math.max(PAD.left, x(m.unlockMs));
      const x1 = Math.min(width - PAD.right, x(m.lockMs));
      if (!(x1 > x0)) continue;
      ctx.strokeStyle = colour(type);
      ctx.lineWidth = 2;
      ctx.setLineDash(dashes(type));
      ctx.beginPath();
      ctx.moveTo(x0, row);
      ctx.lineTo(x1, row);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const [ms, px] of /** @type {[number, number][]} */ ([[m.unlockMs, x0], [m.lockMs, x1]])) {
        if (ms < fromMs || ms > toMs) continue;
        ctx.moveTo(px, row - CAP);
        ctx.lineTo(px, row + CAP);
      }
      ctx.stroke();
      // The length is the reading; it stands to the right of the bar, or to its left when the
      // bar ends too near the edge.
      const label = `${(m.lockMs - m.unlockMs).toFixed(2)} ms`;
      const space = ctx.measureText(label).width + 6;
      const right = x1 + space <= width - PAD.right;
      ctx.fillStyle = c.text;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillText(label, right ? x1 + 6 : x0 - 6, row + 0.5);
    }
  }
}
