// Small numeric helpers shared by the pipeline stages. No browser or Node dependencies.

/**
 * Select the k-th smallest of the first n values of `a`, partially reordering `a` in place.
 * @param {Float64Array|Float32Array} a
 * @param {number} k zero-based rank
 * @param {number} [n] number of leading values to consider
 * @returns {number}
 */
export function quickselect(a, k, n = a.length) {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

/**
 * Median of the first n values of `a`. Reorders `a` in place.
 * @param {Float64Array|Float32Array} a
 * @param {number} [n]
 * @returns {number}
 */
export function medianInPlace(a, n = a.length) {
  if (n === 0) return NaN;
  const mid = n >> 1;
  const upper = quickselect(a, mid, n);
  if (n & 1) return upper;
  let lower = -Infinity;
  for (let i = 0; i < mid; i++) if (a[i] > lower) lower = a[i];
  return 0.5 * (lower + upper);
}

/**
 * Median of a list of numbers. The input is not modified.
 * @param {ArrayLike<number>} values
 * @returns {number}
 */
export function median(values) {
  return medianInPlace(Float64Array.from(values));
}

/**
 * Percentile with linear interpolation between order statistics (as numpy does).
 * @param {ArrayLike<number>} values
 * @param {number} p percentile, 0 to 100
 * @returns {number}
 */
export function percentile(values, p) {
  const a = Float64Array.from(values).sort();
  if (a.length === 0) return NaN;
  const pos = (p / 100) * (a.length - 1);
  const i = Math.floor(pos);
  const frac = pos - i;
  return i + 1 < a.length ? a[i] * (1 - frac) + a[i + 1] * frac : a[i];
}

/**
 * Arithmetic mean.
 * @param {ArrayLike<number>} values
 * @returns {number}
 */
export function mean(values) {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return values.length ? s / values.length : NaN;
}

/**
 * Population standard deviation.
 * @param {ArrayLike<number>} values
 * @returns {number}
 */
export function std(values) {
  const m = mean(values);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - m;
    s += d * d;
  }
  return values.length ? Math.sqrt(s / values.length) : NaN;
}

/**
 * Robust standard deviation: 1.4826 times the median absolute deviation.
 * @param {ArrayLike<number>} values
 * @returns {number}
 */
export function robustSd(values) {
  const m = median(values);
  const dev = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i] - m);
  return 1.4826 * medianInPlace(dev);
}

/**
 * Offset of the vertex of the parabola through three equally spaced points, relative to the
 * middle point, in units of the spacing. Returns 0 when the points do not form a peak.
 * @param {number} a value before the peak
 * @param {number} b value at the peak
 * @param {number} c value after the peak
 * @returns {number}
 */
export function parabolicOffset(a, b, c) {
  const d = a - 2 * b + c;
  return d < 0 ? (0.5 * (a - c)) / d || 0 : 0;
}

/**
 * Running median filter of odd width k, with zero padding at the edges.
 * @param {ArrayLike<number>} values
 * @param {number} k odd window width
 * @returns {Float64Array}
 */
export function medfilt(values, k) {
  const n = values.length;
  const half = k >> 1;
  const out = new Float64Array(n);
  const win = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) {
      const idx = i - half + j;
      win[j] = idx >= 0 && idx < n ? values[idx] : 0;
    }
    out[i] = medianInPlace(win);
  }
  return out;
}

/**
 * Robust straight-line fit y = a + b x, by iteratively reweighted least squares with Tukey's
 * biweight. Outliers end with zero weight.
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @param {number} [iterations]
 * @returns {{a: number, b: number, weights: Float64Array, residualSd: number}} residualSd is the
 *   root-mean-square residual of the points that kept some weight, with two degrees of freedom
 *   removed for the fitted line
 */
export function robustLine(x, y, iterations = 6) {
  const n = x.length;
  const w = new Float64Array(n).fill(1);
  const r = new Float64Array(n);
  let a = 0;
  let b = 0;
  // Centre x for numerical conditioning.
  const x0 = mean(x);
  for (let it = 0; it < iterations; it++) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const wi = w[i] * w[i];
      const xi = x[i] - x0;
      sw += wi;
      sx += wi * xi;
      sy += wi * y[i];
      sxx += wi * xi * xi;
      sxy += wi * xi * y[i];
    }
    const det = sw * sxx - sx * sx;
    if (!(det > 0)) break;
    b = (sw * sxy - sx * sy) / det;
    a = (sy - b * sx) / sw - b * x0;
    for (let i = 0; i < n; i++) r[i] = y[i] - (a + b * x[i]);
    const s = robustSd(r) + 1e-12;
    for (let i = 0; i < n; i++) {
      const u = r[i] / (4.685 * s);
      w[i] = Math.abs(u) < 1 ? (1 - u * u) * (1 - u * u) : 0;
    }
  }
  let kept = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    r[i] = y[i] - (a + b * x[i]);
    if (w[i] > 0) {
      kept++;
      ss += r[i] * r[i];
    }
  }
  return { a, b, weights: w, residualSd: kept > 2 ? Math.sqrt(ss / (kept - 2)) : robustSd(r) };
}

/**
 * Small seeded random number generator (mulberry32). The same seed always gives the same
 * values, so that a recording always gives the same reading.
 * @param {number} seed
 * @returns {() => number} uniform values in [0, 1)
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Natural logarithm of the gamma function, by Lanczos's approximation; for x > 0.
 * @param {number} x
 * @returns {number}
 */
export function logGamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = c[0];
  for (let i = 1; i < 9; i++) sum += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/**
 * The share of a chi-squared distribution with `dof` degrees of freedom that lies below x:
 * the regularised lower incomplete gamma function P(dof / 2, x / 2), by its series for small x
 * and its continued fraction for large.
 * @param {number} x
 * @param {number} dof
 * @returns {number}
 */
export function chiSquaredBelow(x, dof) {
  if (!(x > 0)) return 0;
  const a = dof / 2;
  const h = x / 2;
  const front = Math.exp(a * Math.log(h) - h - logGamma(a));
  if (h < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 1000; n++) {
      term *= h / (a + n);
      sum += term;
      if (term < sum * 1e-16) break;
    }
    return front * sum;
  }
  // Lentz's method for the upper function's continued fraction.
  const tiny = 1e-300;
  let b = h + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let f = d;
  for (let n = 1; n < 1000; n++) {
    const an = -n * (n - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return 1 - front * f;
}

/**
 * The value that a chi-squared variable with `dof` degrees of freedom stays below with
 * probability p (SciPy's chi2.ppf), by bisection.
 * @param {number} p between 0 and 1
 * @param {number} dof
 * @returns {number}
 */
export function chiSquaredQuantile(p, dof) {
  let lo = 0;
  let hi = Math.max(1, dof);
  while (chiSquaredBelow(hi, dof) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-13 * hi; i++) {
    const mid = 0.5 * (lo + hi);
    if (chiSquaredBelow(mid, dof) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
