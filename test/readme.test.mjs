// Run with: npm test. The README's headings carry the anchors that the settings page's links go to (#89): the lock
// line's (extension/lib/lock.js), the sections' (extension/options.html, extension/lockbox.html) and the README's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeLock } from '../extension/lib/lock.js';
import { ICON_SOURCE, anchor, renderGuide } from '../scripts/guide.mjs';
import { GUIDE_URL, ICON_NAME, PROFILE_NAME, SITE_URL } from '../scripts/updates-site.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readme = read('README.md').replace(/^```[^]*?^```/gm, ''); // not the headings of a code block, if ever there are any

// The anchors are GitLab's and GitHub's for these headings (scripts/guide.mjs gives the rendered guide the same ones).
const headings = [...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]);
const anchors = new Set(headings.map(anchor));

test("the headings' anchors are distinct, so each link lands in one place", () => {
  assert.ok(headings.length >= 20, `${headings.length} headings`);
  assert.equal(anchors.size, headings.length, 'two headings would get the same anchor');
});

test('every anchor the lock line links to is a heading in the README', () => {
  const states = [];
  for (const installType of ['admin', 'development', 'normal']) {
    for (const firefox of [true, false]) {
      for (const stamp of [null, { version: '1.0.0', entries: 1000 }, { version: '9.0.0', entries: 1000 }, { version: '1.0.0', entries: 1000, digest: 'ab' }, { version: '1.8.0', entries: 999, digest: 'ab' }]) {
        for (const ownStamp of [null, { version: '1.8.0', entries: 1000, digest: 'cd', sameSince: '1.5.0' }]) for (const phone of [false, true]) states.push({ installType, firefox, own: '1.8.0', stamp, ownStamp, phone });
      }
    }
  }
  const linked = new Set(states.flatMap((state) => describeLock(state).parts).filter((part) => typeof part !== 'string').map((part) => part.anchor));
  assert.ok(linked.size >= 3, [...linked].join(', '));
  for (const a of linked) assert.ok(anchors.has(a), `#${a} is not a heading in the README`);
});

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('every link into the guide from the settings pages, and within the README, is a heading', () => {
  const fromPages = ['extension/options.html', 'extension/lockbox.html'].flatMap((path) => [...read(path).matchAll(new RegExp(`${escaped(GUIDE_URL)}#([\\w-]+)`, 'g'))].map((m) => m[1]));
  const within = [...readme.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]);
  assert.ok(fromPages.length >= 4 && within.length >= 10, `${fromPages.length} links from the pages, ${within.length} within the README`);
  for (const a of [...fromPages, ...within]) assert.ok(anchors.has(a), `#${a} is not a heading in the README`);
});

test('the settings pages link into the guide on the public site, not into the private project', () => {
  assert.equal(GUIDE_URL, SITE_URL, 'the guide is the site\'s front page');
  assert.match(GUIDE_URL, /^https:\/\/adviseworn\.gitlab\.io\/family-site-blocker\/$/);
  for (const path of ['extension/options.html', 'extension/lockbox.html', 'extension/options.js']) {
    const links = [...read(path).matchAll(/https?:\/\/adviseworn\.gitlab\.io\/[^\s"'`)#]*/g)].map((m) => m[0]);
    assert.ok(links.length >= 1, `${path} links to the guide`);
    for (const link of links) assert.equal(link, GUIDE_URL, path);
    assert.doesNotMatch(read(path), /git(hub|lab)\.com\/adviseworn/, `${path} doesn't point at the repository, which is private`);
  }
});

test('the guide on the site has every heading under its anchor, so the links land, and the profile beside it', () => {
  const html = renderGuide(read('README.md'));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Family Site Blocker<\/title>/);
  for (const a of anchors) assert.ok(html.includes(`id="${a}"`), `#${a} is in the guide`);
  assert.equal((html.match(/<h[1-6] id="/g) ?? []).length, headings.length, 'a heading each');
  assert.match(html, new RegExp(`<link rel="icon" href="${escaped(ICON_NAME)}" type="image/png"`), "the add-on's icon in the browser's tab");
  assert.match(html, new RegExp(`<h1 id="family-site-blocker"><img src="${escaped(ICON_NAME)}" alt="" width="128" height="128">Family Site Blocker</h1>`), 'and before the title, once');
  assert.equal((html.match(/<img /g) ?? []).length, 1, 'the icon is the only picture the guide adds');
  assert.match(html, /<table>/, 'the files table');
  assert.match(html, /<code>exampleadultsite\.com<\/code>/);
  assert.doesNotMatch(html, /gitlab\.com\/adviseworn\/family-site-blocker\/-\//, 'no links into the private project');
  const dir = mkdtempSync(join(tmpdir(), 'family-site-blocker-guide-'));
  try {
    const file = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
    const run = spawnSync(process.execPath, [file('scripts/guide.mjs'), file('README.md'), dir, file('mac/family-site-blocker-firefox.mobileconfig')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`${headings.length} headings, ${escaped(ICON_NAME)} and ${escaped(PROFILE_NAME)}`));
    assert.deepEqual(readdirSync(dir).sort(), [PROFILE_NAME, ICON_NAME, 'index.html']);
    assert.ok(readFileSync(join(dir, ICON_NAME)).equals(readFileSync(ICON_SOURCE)), "the site's icon is the add-on's 128-pixel one");
    assert.ok(readFileSync(ICON_SOURCE).equals(readFileSync(file('extension/icons/icon128.png'))));
    assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), html);
    assert.ok(readFileSync(join(dir, PROFILE_NAME)).equals(readFileSync(file('mac/family-site-blocker-firefox.mobileconfig'))));
    assert.equal(spawnSync(process.execPath, [file('scripts/guide.mjs')], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
