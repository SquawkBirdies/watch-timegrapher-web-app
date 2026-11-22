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
 * @property {string} microphoneId the input chosen in the microphone picker; '' for the default
 * @property {boolean} magnetNoticeSeen the magnetism notice has been read once
 * @property {number} saveMinutes how many minutes of microphone audio are kept for saving
 */

/** @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  bph: 0,
  escapement: 'lever',
  liftAngle: 52,
  humHz: 60,
  averagingSeconds: 20,
  microphoneId: '',
  magnetNoticeSeen: false,
  saveMinutes: 1,
});

export const BEAT_RATES = [18000, 19800, 21600, 25200, 28800, 36000];
export const AVERAGING_CHOICES = [10, 20, 40, 60];
/** Minutes of microphone audio that can be kept for saving. About 12 MB of memory a minute. */
export const SAVE_MINUTES = [1, 2, 5];
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
  if (typeof raw.microphoneId === 'string' && raw.microphoneId.length <= 256) s.microphoneId = raw.microphoneId;
  if (raw.magnetNoticeSeen === true) s.magnetNoticeSeen = true;
  const minutes = Number(raw.saveMinutes);
  if (SAVE_MINUTES.includes(minutes)) s.saveMinutes = minutes;
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
