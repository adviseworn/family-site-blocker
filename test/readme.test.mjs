// Run with: npm test. The README's headings carry the anchors that the settings page's links go to (#89): the lock
// line's (extension/lib/lock.js), the sections' (extension/options.html, extension/lockbox.html) and the README's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { describeLock } from '../extension/lib/lock.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readme = read('README.md').replace(/^```[^]*?^```/gm, ''); // not the headings of a code block, if ever there are any

// GitHub's anchor for a heading: lower case, everything but letters, numbers, spaces, hyphens and underscores dropped, spaces to hyphens.
const anchor = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
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
        for (const ownStamp of [null, { version: '1.8.0', entries: 1000, digest: 'cd', sameSince: '1.5.0' }]) states.push({ installType, firefox, own: '1.8.0', stamp, ownStamp });
      }
    }
  }
  const linked = new Set(states.flatMap((state) => describeLock(state).parts).filter((part) => typeof part !== 'string').map((part) => part.anchor));
  assert.ok(linked.size >= 3, [...linked].join(', '));
  for (const a of linked) assert.ok(anchors.has(a), `#${a} is not a heading in the README`);
});

test('every link into the README from the settings pages, and within the README, is a heading', () => {
  const fromPages = ['extension/options.html', 'extension/lockbox.html'].flatMap((path) => [...read(path).matchAll(/family-site-blocker#([\w-]+)/g)].map((m) => m[1]));
  const within = [...readme.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]);
  assert.ok(fromPages.length >= 4 && within.length >= 10, `${fromPages.length} links from the pages, ${within.length} within the README`);
  for (const a of [...fromPages, ...within]) assert.ok(anchors.has(a), `#${a} is not a heading in the README`);
});
