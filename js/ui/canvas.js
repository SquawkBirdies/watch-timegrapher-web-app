// Shared drawing helpers: a canvas sized for the screen's pixel density, and the chart colours
// read from the page's style sheet so that light and dark mode come from one place.

/**
 * Size a canvas's backing store to its displayed size and return a context in CSS pixels.
 * @param {HTMLCanvasElement} canvas
 * @returns {{ctx: CanvasRenderingContext2D, width: number, height: number}}
 */
export function prepare(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const w = Math.max(1, Math.round(width * ratio));
  const h = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/**
 * @typedef {Object} ChartColors
 * @property {string} tick
 * @property {string} tock
 * @property {string} beat a beat the pipeline has not yet named tick or tock
 * @property {string} dim low-confidence points
 * @property {string} grid
 * @property {string} text
 * @property {string} faint secondary text
 * @property {string} surface
 * @property {string} font
 */

/**
 * @param {Element} element
 * @returns {ChartColors}
 */
export function chartColors(element) {
  const style = getComputedStyle(element);
  const v = (/** @type {string} */ name) => style.getPropertyValue(name).trim();
  return {
    tick: v('--tick'),
    tock: v('--tock'),
    beat: v('--beat'),
    dim: v('--dim'),
    grid: v('--grid'),
    text: v('--muted'),
    faint: v('--faint'),
    surface: v('--surface'),
    font: v('--font'),
  };
}
