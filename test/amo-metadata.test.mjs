// Checks scripts/amo-metadata.mjs, the add-on's page on addons.mozilla.org in words. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOME_URL, LICENSE, LISTING, PAGE_URL, SLUG, approvalNotes, metadata, releaseNotes } from '../scripts/amo-metadata.mjs';
import { SITE_URL } from '../scripts/updates-site.mjs';
import * as releaseJson from '../scripts/release-json.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/amo-metadata.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// addons.mozilla.org's categories for extensions (GET /api/v5/addons/categories/), Nov 2026.
const CATEGORIES = ['alerts-updates', 'appearance', 'bookmarks', 'download-management', 'feeds-news-blogging', 'games-entertainment', 'language-support', 'other', 'photos-music-videos', 'privacy-security', 'search-tools', 'shopping', 'social-communication', 'tabs', 'web-development'];

test('the page says what the add-on does, within what Mozilla takes', () => {
  assert.equal(LISTING.slug, SLUG);
  assert.equal(PAGE_URL, `https://addons.mozilla.org/firefox/addon/${SLUG}/`);
  assert.match(SLUG, /^[a-z0-9-]+$/);
  assert.ok(LISTING.summary['en-US'].length > 0 && LISTING.summary['en-US'].length <= 250, `a summary of ${LISTING.summary['en-US'].length} characters; Mozilla takes 250`);
  assert.ok(LISTING.description['en-US'].length > LISTING.summary['en-US'].length);
  assert.ok(LISTING.categories.length >= 1 && LISTING.categories.length <= 2);
  for (const category of LISTING.categories) assert.ok(CATEGORIES.includes(category), category);
  assert.equal(LISTING.homepage['en-US'], HOME_URL);
  assert.equal(HOME_URL, SITE_URL, 'the homepage is the public site, the guide; the project itself is private');
  assert.ok(!('support_url' in LISTING), "no support site: the project's issues are private");
  assert.equal(LISTING.is_experimental, false);
  assert.equal(LISTING.requires_payment, false);
  assert.equal(LICENSE, 'all-rights-reserved');
});

test('nothing on the page or in the notes names anyone or gives an address to write to', () => {
  const everything = JSON.stringify(metadata({ version: '1.24.0', commit: 'abc1234', title: 'A title (1.24.0) (#1)' }));
  assert.ok(!('support_email' in LISTING), 'no support email');
  assert.doesNotMatch(everything, /[\w.+-]+@[\w-]+\.[\w.-]+/, 'no email address');
  assert.doesNotMatch(everything, /\b(Requested by|requester|author)\b/i, 'no one is named or credited');
  assert.doesNotMatch(everything.replaceAll(HOME_URL, ''), /adviseworn/, "the account's name appears only in the site's address");
  assert.doesNotMatch(everything, /gitlab\.com/, 'nothing points at the private project');
  assert.doesNotMatch(everything, /github/i, 'nothing points at GitHub any more');
});

test("a version's release notes are the sentence its commit on main carries, or just the version", () => {
  assert.equal(releaseNotes("A listed site is blocked even when Firefox hasn't given the add-on access to websites (1.21.1) (#162)", '1.21.1'), "A listed site is blocked even when Firefox hasn't given the add-on access to websites.");
  assert.equal(releaseNotes('Every try says less again: the explanations cut to a line each (1.21.0)', '1.21.0'), 'Every try says less again: the explanations cut to a line each.');
  assert.equal(releaseNotes('Fixes the thing. (#3)', '1.0.1'), 'Fixes the thing.');
  assert.equal(releaseNotes('The project moves to GitLab (1.25.0) (!1)', '1.25.0'), 'The project moves to GitLab.');
  assert.equal(releaseNotes('Merge branch main into x', '1.0.2'), 'Version 1.0.2.');
  assert.equal(releaseNotes('', '1.0.3'), 'Version 1.0.3.');
  assert.equal(releaseNotes(undefined, '1.0.4'), 'Version 1.0.4.');
});

test("the notes to Mozilla's reviewers say where the code is, how the upload is made and which files aren't ours", () => {
  const notes = approvalNotes({ version: '1.24.0', commit: '0123abcd' });
  assert.match(notes, /commit 0123abcd/);
  assert.match(notes, /v1\.24\.0/);
  assert.ok(notes.includes(HOME_URL), 'the guide');
  assert.match(notes, /repository on GitLab is private/);
  assert.match(notes, /npm run package:firefox/);
  // Every vendored file is accounted for, as the licence notes list them.
  for (const file of ['tf.fesm.min.js', 'tf-backend-wasm.min.js', 'tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm']) {
    assert.ok(notes.includes(file), file);
    assert.ok(read('../extension/vendor/LICENSES.md').includes(`\`${file}\``), `${file} in LICENSES.md`);
  }
  assert.match(notes, /@tensorflow\/tfjs 4\.22\.0/);
  assert.match(notes, /@tensorflow\/tfjs-backend-wasm 4\.22\.0/);
  assert.match(notes, /data_collection_permissions: none/);
});

test('the script prints the JSON web-ext sends, with the version, the license, the notes and the page', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '1.24.0', 'feedbeef', 'What changed (1.24.0) (#165)'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const sent = JSON.parse(run.stdout);
  assert.deepEqual(sent, metadata({ version: '1.24.0', commit: 'feedbeef', title: 'What changed (1.24.0) (#165)' }));
  assert.deepEqual(sent.version, { license: LICENSE, release_notes: { 'en-US': 'What changed.' }, approval_notes: approvalNotes({ version: '1.24.0', commit: 'feedbeef' }) });
  assert.equal(sent.summary['en-US'], LISTING.summary['en-US']);
  const usage = spawnSync(process.execPath, [SCRIPT, '1.24.0'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage/);
});

test('the sign job sends the page with each version, and the release notes and the README point at it', () => {
  const sign = readFileSync(`${ROOT}.gitlab-ci.yml`, 'utf8');
  assert.match(sign, /node scripts\/amo-metadata\.mjs "\$VERSION" "\$CI_COMMIT_SHA" "\$CI_COMMIT_TITLE" > dist\/amo-metadata\.json/);
  assert.match(sign, /web-ext@[\d.]+ sign --channel=listed --amo-metadata=dist\/amo-metadata\.json /);
  assert.ok(releaseJson.notes('1.24.0').includes(PAGE_URL), 'the release notes give the page');
  const readme = readFileSync(`${ROOT}README.md`, 'utf8');
  assert.ok(readme.includes(`](${PAGE_URL})`), 'the README links to the page');
  assert.doesNotMatch(readme, /\(https:\/\/addons\.mozilla\.org\/firefox\/addon\/(?!family-site-blocker\/\))/, 'only that page');
});
