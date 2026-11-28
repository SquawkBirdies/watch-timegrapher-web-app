// The commit the site was built from, shown in the fine print and the diagnostic's report. GitHub
// Pages' Jekyll build writes it into version.json; these tests hold the setup that makes that
// safe: Jekyll may template only version.json, and must publish every file the pages load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { parseVersion, loadVersion, shortVersion } from '../js/version.js';

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
