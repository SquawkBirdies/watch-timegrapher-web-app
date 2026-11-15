// Settings kept on this device between visits. The browser's storage can be unavailable (private
// browsing, storage turned off), so every read and write is allowed to fail: the app then
// starts from the defaults each time.

/**
 * @typedef {Object} Settings
 * @property {number} bph beat rate in vibrations per hour; 0 means detect it
 * @property {import('./dsp/estimate.js').Escapement} escapement
 * @property {number} liftAngle degrees, for amplitude
 * @property {50|60} humHz mains frequency
 * @property {number} averagingSeconds window of the rate and beat-error readings
 */

/** @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  bph: 0,
  escapement: 'lever',
  liftAngle: 52,
  humHz: 60,
  averagingSeconds: 20,
});

export const BEAT_RATES = [18000, 19800, 21600, 25200, 28800, 36000];
export const AVERAGING_CHOICES = [10, 20, 40, 60];
export const LIFT_RANGE = [30, 70];

const KEY = 'timegrapher.settings.v1';

/**
 * Keep only valid values; anything else falls back to the default.
 * @param {Record<string, unknown>} raw
 * @returns {Settings}
 */
export function clean(raw) {
  const s = { ...DEFAULTS };
  const bph = Number(raw.bph);
  if (bph === 0 || BEAT_RATES.includes(bph)) s.bph = bph;
  if (raw.escapement === 'lever' || raw.escapement === 'coaxial') s.escapement = raw.escapement;
  const lift = Number(raw.liftAngle);
  if (Number.isFinite(lift) && lift >= LIFT_RANGE[0] && lift <= LIFT_RANGE[1]) s.liftAngle = Math.round(lift * 10) / 10;
  const hum = Number(raw.humHz);
  if (hum === 50 || hum === 60) s.humHz = hum;
  const avg = Number(raw.averagingSeconds);
  if (AVERAGING_CHOICES.includes(avg)) s.averagingSeconds = avg;
  return s;
}

/** @returns {Settings} */
export function loadSettings() {
  try {
    const text = localStorage.getItem(KEY);
    return clean(text ? JSON.parse(text) : {});
  } catch {
    return { ...DEFAULTS };
  }
}

/** @param {Settings} settings */
export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: the settings last until the page is closed.
  }
}
