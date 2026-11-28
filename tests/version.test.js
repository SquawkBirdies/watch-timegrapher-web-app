// The commit the site was built from, shown in the fine print and the diagnostic's report. GitHub
// Pages' Jekyll build writes it into version.json; these tests hold the setup that makes that
// safe: Jekyll may template only version.json, and must publish every file the pages load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { parseVersion, loadVersion, shortVersion, repositoryUrl, showVersion } from '../js/version.js';

const root = new URL('../', import.meta.url);
const read = (/** @type {string} */ path) => readFileSync(new URL(path, root), 'utf8');

test('the version is the 40-character commit GitHub wrote, or nothing: never the template, an empty value or anything else', async () => {
  const commit = '50d4ce3f024ac5d832c0608f1e524e8c79077d94';
  assert.equal(parseVersion(`{"commit": "${commit}"}`), commit);
  assert.equal(shortVersion(commit), '50d4ce3');
  // Served from a local server, the file is still its template.
  assert.equal(parseVersion(read('version.json')), null);
  // A build that knew no commit leaves it empty.
  assert.equal(parseVersion('{"commit": ""}'), null);
  for (const text of ['', 'null', '{}', '{"commit": "50d4ce3"}', '{"commit": "main"}', '<html>']) assert.equal(parseVersion(text), null, text);
  assert.equal(await loadVersion(`data:application/json,${encodeURIComponent(`{"commit": "${commit}"}`)}`), commit);
  assert.equal(await loadVersion('data:application/json,%7B%7D'), null);
});

test('the repository is found from a GitHub Pages address, and from no other', () => {
  const site = (/** @type {string} */ hostname, /** @type {string} */ pathname) => repositoryUrl({ hostname, pathname });
  assert.equal(site('squawkbirdies.github.io', '/watch-timegrapher-web-app/'), 'https://github.com/squawkbirdies/watch-timegrapher-web-app');
  assert.equal(site('squawkbirdies.github.io', '/watch-timegrapher-web-app/diagnostic.html'), 'https://github.com/squawkbirdies/watch-timegrapher-web-app');
  assert.equal(site('squawkbirdies.github.io', '/'), null);
  assert.equal(site('localhost', '/watch-timegrapher-web-app/'), null);
  assert.equal(site('example.com', '/watch-timegrapher-web-app/'), null);
});

test('the version line on a page shows the short commit as a link to the commit on GitHub, and stays hidden without a version', async () => {
  const commit = 'acdbe37b55b110484bcf789b8206c59f8581059a';
  const json = `data:application/json,${encodeURIComponent(`{"commit": "${commit}"}`)}`;
  // Just enough of a page: the line and the link inside it.
  const page = () => {
    const line = { hidden: true };
    const link = { textContent: '', /** @type {Record<string, string>} */ attributes: {}, setAttribute(/** @type {string} */ k, /** @type {string} */ v) { this.attributes[k] = v; } };
    const doc = /** @type {Document} */ (/** @type {unknown} */ ({ getElementById: (/** @type {string} */ id) => ({ version: line, 'version-link': link })[id] ?? null }));
    return { doc, line, link };
  };
  const pages = { hostname: 'squawkbirdies.github.io', pathname: '/watch-timegrapher-web-app/check.html' };
  const shown = page();
  assert.equal(await showVersion(shown.doc, pages, json), commit);
  assert.equal(shown.line.hidden, false);
  assert.equal(shown.link.textContent, 'acdbe37');
  assert.deepEqual(shown.link.attributes, { href: `https://github.com/squawkbirdies/watch-timegrapher-web-app/commit/${commit}` });
  // Served elsewhere with a version, the hash is shown without a link, there being no repository to point to.
  const elsewhere = page();
  await showVersion(elsewhere.doc, { hostname: 'localhost', pathname: '/' }, json);
  assert.equal(elsewhere.link.textContent, 'acdbe37');
  assert.deepEqual(elsewhere.link.attributes, {});
  // The template, as from a local server: nothing is shown.
  const none = page();
  assert.equal(await showVersion(none.doc, pages, 'data:application/json,%7B%7D'), null);
  assert.equal(none.line.hidden, true);
  assert.equal(none.link.textContent, '');
});

test('every page has the same version line in its fine print, filled in by the same code', () => {
  const line = /<p(?: class="[a-z]+")? id="version" hidden>Version <a id="version-link"><\/a>\.<\/p>/;
  for (const [page, script] of [['index.html', 'js/main.js'], ['diagnostic.html', 'js/diagnostic.js'], ['check.html', 'check.html']]) {
    assert.match(read(page), line, page);
    assert.match(read(script), /showVersion\(document, location\)/, script);
  }
});

test('GitHub builds the site with Jekyll, which templates version.json alone and publishes every file the pages load', () => {
  assert.equal(existsSync(new URL('.nojekyll', root)), false, 'Jekyll is not switched off');
  const lines = read('version.json').split('\n');
  assert.deepEqual(lines.slice(0, 3), ['---', 'layout: null', '---']);
  assert.match(lines[3], /^\{"commit": "\{\{ site\.github\.build_revision \}\}"\}$/);
  // The folders and files left out, from the config's list.
  const config = read('_config.yml');
  const excluded = [...config.matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(excluded, ['README.md', 'CLAUDE.md', 'docs', 'tools', 'package.json', 'jsconfig.json']);
  const published = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => !f.startsWith('.') && !f.startsWith('_') && !excluded.some((x) => f === x || f.startsWith(`${x}/`)));
  // Every page, script, style and demo recording is among them.
  for (const f of ['index.html', 'diagnostic.html', 'check.html', 'version.json', 'js/main.js', 'js/version.js', 'js/dsp/worker.js', 'css/app.css', 'tests/fixtures/eta-2836-2-safari.wav', 'tests/fixtures/omega-3861-safari.wav']) {
    assert.ok(published.includes(f), `${f} is published`);
  }
  // No Markdown is published, since GitHub's build would make a page of it and read it as a
  // template; and no file but version.json starts with front matter.
  assert.deepEqual(published.filter((f) => /\.(md|markdown)$/i.test(f)), []);
  const withFrontMatter = published.filter((f) => {
    const fd = openSync(new URL(f, root), 'r');
    const head = Buffer.alloc(4);
    const n = readSync(fd, head, 0, 4, 0);
    closeSync(fd);
    return head.subarray(0, n).toString('latin1') === '---\n';
  });
  assert.deepEqual(withFrontMatter, ['version.json']);
});
