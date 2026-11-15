// The trace: one dot per beat, time across, milliseconds ahead of an ideal clock up the side,
// like the paper strip of a bench timegrapher. A gaining watch climbs, a losing one falls, and
// the gap between the tick line and the tock line is the beat error. Touching the trace shows
// the value of the nearest dot; touching an empty part hides it again.

import { prepare, chartColors } from './canvas.js';
import { traceRange, ticks } from './model.js';

/** @typedef {import('./model.js').TracePoint} TracePoint */

const PAD = { left: 40, right: 10, top: 10, bottom: 24 };

export class TraceView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    /** @type {TracePoint[]} */
    this.points = [];
    this.from = 0;
    this.to = 30;
    this.message = '';
    /** @type {[number, number]} */
    this.range = [-0.5, 0.5];
    /** @type {TracePoint|null} the dot being touched */
    this.picked = null;
    /** @type {(() => void) | null} */
    this.onPick = null;
    const pick = (/** @type {PointerEvent} */ e) => {
      this.picked = this.nearest(e.offsetX, e.offsetY);
      this.draw();
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pick(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons || e.pointerType === 'mouse') pick(e);
    });
    // A mouse reading ends when the pointer leaves; a finger's reading stays until the next
    // touch, since the finger lifting off would otherwise hide it at once.
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.picked = null;
      this.draw();
    });
  }

  /**
   * @param {TracePoint[]} points
   * @param {number} from left edge in seconds
   * @param {number} to right edge in seconds
   * @param {string} message shown when there are no points
   */
  set(points, from, to, message) {
    this.points = points;
    this.from = from;
    this.to = to;
    this.message = message;
    this.range = traceRange(points);
    if (this.picked && !points.some((p) => p.t === (this.picked && this.picked.t))) this.picked = null;
    this.draw();
  }

  /** @param {number} t */
  x(t) {
    const w = this.canvas.clientWidth - PAD.left - PAD.right;
    return PAD.left + ((t - this.from) / Math.max(1e-9, this.to - this.from)) * w;
  }

  /** @param {number} y */
  y(y) {
    const h = this.canvas.clientHeight - PAD.top - PAD.bottom;
    const [lo, hi] = this.range;
    const clamped = Math.min(hi, Math.max(lo, y));
    return PAD.top + (1 - (clamped - lo) / (hi - lo)) * h;
  }

  /**
   * @param {number} px
   * @param {number} py
   * @returns {TracePoint|null}
   */
  nearest(px, py) {
    let best = null;
    let bestD = 24 * 24;
    for (const p of this.points) {
      const d = (this.x(p.t) - px) ** 2 + (this.y(p.y) - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  draw() {
    const { ctx, width, height } = prepare(this.canvas);
    const c = chartColors(this.canvas);
    const [lo, hi] = this.range;
    ctx.font = `11px ${c.font}`;
    ctx.lineWidth = 1;

    // Grid and axis labels.
    ctx.strokeStyle = c.grid;
    ctx.fillStyle = c.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = ticks(lo, hi, 4);
    const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;
    const yDigits = yStep < 0.1 ? 2 : yStep < 1 ? 1 : 0;
    for (const v of yTicks) {
      const py = Math.round(this.y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(width - PAD.right, py);
      ctx.stroke();
      ctx.fillText(v.toFixed(yDigits).replace('-', '−'), PAD.left - 6, py);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of ticks(this.from, this.to, 4)) {
      const px = Math.round(this.x(t)) + 0.5;
      if (px < PAD.left - 1 || px > width - PAD.right + 1) continue;
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, height - PAD.bottom);
      ctx.stroke();
      // Labels at the edges are kept inside the canvas.
      const label = `${t.toFixed(0)} s`;
      const half = ctx.measureText(label).width / 2;
      ctx.fillText(label, Math.min(width - half - 1, Math.max(half + 1, px)), height - PAD.bottom + 6);
    }

    if (this.points.length === 0) {
      ctx.fillStyle = c.faint;
      ctx.font = `14px ${c.font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(this.message, PAD.left + (width - PAD.left - PAD.right) / 2, PAD.top + (height - PAD.top - PAD.bottom) / 2);
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left - 4, PAD.top - 4, width - PAD.left - PAD.right + 8, height - PAD.top - PAD.bottom + 8);
    ctx.clip();
    // Low-confidence dots underneath, then tocks, then ticks.
    const layers = [
      { pick: (/** @type {TracePoint} */ p) => !p.ok, color: c.dim },
      { pick: (/** @type {TracePoint} */ p) => p.ok && p.type === 1, color: c.tock },
      { pick: (/** @type {TracePoint} */ p) => p.ok && p.type === 0, color: c.tick },
    ];
    for (const layer of layers) {
      ctx.fillStyle = layer.color;
      ctx.beginPath();
      for (const p of this.points) {
        if (!layer.pick(p)) continue;
        const r = p.cycles > 1 ? 3.5 : p.ok ? 2.4 : 2;
        const px = this.x(p.t);
        const py = this.y(p.y);
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, 2 * Math.PI);
      }
      ctx.fill();
    }
    ctx.restore();

    const p = this.picked;
    if (p) {
      const px = this.x(p.t);
      const py = this.y(p.y);
      ctx.strokeStyle = c.text;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, height - PAD.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = c.surface;
      ctx.fillStyle = p.ok ? (p.type === 0 ? c.tick : c.tock) : c.dim;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
      const sign = p.y < 0 ? '−' : '+';
      const label = `${p.t.toFixed(1)} s · ${p.type === 0 ? 'tick' : 'tock'}${p.ok ? '' : ' (low confidence)'} · ${sign}${Math.abs(p.y).toFixed(2)} ms`;
      ctx.font = `600 12px ${c.font}`;
      const tw = ctx.measureText(label).width + 12;
      const bx = Math.min(width - PAD.right - tw, Math.max(PAD.left, px - tw / 2));
      const by = py > PAD.top + 34 ? py - 30 : py + 10;
      ctx.fillStyle = c.surface;
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, 20, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 6, by + 10);
    }
  }
}
