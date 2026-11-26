// Light or dark, as chosen in the settings. The style sheet has the colours of both; with no
// choice made it follows the phone, and a choice sets data-theme on the page's root element,
// which the style sheet obeys whatever the phone's setting. The address bar's colour is set to
// match. index.html applies a stored choice once more before the page is first drawn, so that it
// never shows in the phone's theme first.

/** @typedef {import('../store.js').Theme} Theme */

/** The page background in each theme, as in css/app.css, for the browser's own bars. */
const BAR_COLOURS = { light: '#f4f6f9', dark: '#0f1217' };

/**
 * @param {Theme} theme
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
  // Two theme-color tags, one for each of the phone's settings: with a choice made, both carry
  // its colour.
  for (const meta of /** @type {NodeListOf<HTMLMetaElement>} */ (document.querySelectorAll('meta[name="theme-color"]'))) {
    const own = /** @type {'light'|'dark'} */ ((meta.media || '').includes('dark') ? 'dark' : 'light');
    meta.content = BAR_COLOURS[theme === 'auto' ? own : theme];
  }
}
