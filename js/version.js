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

/**
 * The repository a GitHub Pages address is served from, or null for any other address. GitHub
 * serves https://OWNER.github.io/REPOSITORY/ from https://github.com/OWNER/REPOSITORY.
 * @param {{hostname: string, pathname: string}} where the page's location
 * @returns {string|null}
 */
export function repositoryUrl(where) {
  const host = where.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = where.pathname.split('/').filter(Boolean)[0];
  return host && repo ? `https://github.com/${host[1]}/${repo}` : null;
}

/**
 * Fills in a page's version line, `<p id="version" hidden>Version <a id="version-link"></a>.</p>`,
 * with the short commit linked to the commit on GitHub, and shows it. Every page has the same
 * line, so that each says which version it is (asked for on 28 November 2026). The line stays
 * hidden when there is no version to show.
 * @param {Document} doc
 * @param {{hostname: string, pathname: string}} where the page's location
 * @param {string} [url] where version.json is
 * @returns {Promise<string|null>} the full commit, or null without one
 */
export async function showVersion(doc, where, url = 'version.json') {
  const commit = await loadVersion(url);
  const line = doc.getElementById('version');
  const link = doc.getElementById('version-link');
  if (!commit || !line || !link) return commit;
  link.textContent = shortVersion(commit);
  const repo = repositoryUrl(where);
  if (repo) link.setAttribute('href', `${repo}/commit/${commit}`);
  line.hidden = false;
  return commit;
}
