// The commit the site was built from, so that a screenshot or a report says which version made
// it (added at Lawrence Fan's request on 28 November 2026). GitHub Pages' Jekyll build writes it
// into version.json; served any other way, as from a local server, that file is still its
// template, and there is no version to show.

/**
 * The commit in version.json's text, or null when it holds none.
 * @param {string} text
 * @returns {string|null} the full hash, in lower case
 */
export function parseVersion(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v.commit === 'string' && /^[0-9a-f]{40}$/.test(v.commit) ? v.commit : null;
  } catch {
    return null;
  }
}

/**
 * The site's commit, from version.json beside the page.
 * @param {string} [url]
 * @returns {Promise<string|null>} null when it cannot be had
 */
export async function loadVersion(url = 'version.json') {
  try {
    const response = await fetch(url);
    return response.ok ? parseVersion(await response.text()) : null;
  } catch {
    return null;
  }
}

/**
 * The short form shown, the first seven characters, as git and GitHub show a commit.
 * @param {string} commit
 * @returns {string}
 */
export function shortVersion(commit) {
  return commit.slice(0, 7);
}
