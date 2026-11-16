// Keeping the screen on while measuring. iOS stops the microphone when the screen locks, so a
// measurement would otherwise end after the phone's auto-lock delay. The browser drops the lock
// whenever the page is hidden; it is asked for again when the page returns.

export class ScreenWake {
  constructor() {
    /** @type {WakeLockSentinel|null} */
    this.sentinel = null;
    this.wanted = false;
    this.supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.request();
      });
    }
  }

  /** @param {boolean} on whether the screen should stay on */
  want(on) {
    this.wanted = on;
    if (on) this.request();
    else this.release();
  }

  async request() {
    if (!this.supported || !this.wanted || this.sentinel || document.visibilityState !== 'visible') return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!this.wanted) {
        sentinel.release().catch(() => {});
        return;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
    } catch {
      // Refused (low battery, or not allowed here): the screen follows its usual auto-lock.
    }
  }

  release() {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel) sentinel.release().catch(() => {});
  }

  /** @returns {boolean} whether the screen is being kept on */
  get held() {
    return this.sentinel !== null;
  }
}
