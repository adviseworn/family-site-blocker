#!/usr/bin/env node
// The files that let Firefox update Family Site Blocker by itself: updates.json, the update manifest that
// the add-on's update_url points at (manifest.json: browser_specific_settings.gecko.update_url), and the
// signed .xpi files it links to. Firefox reads updates.json about once a day, and installs the newest
// version listed that is newer than the one it has, after checking the file against the hash given here.
// The newest version is there a second time as family-site-blocker.xpi, one name that never changes: the
// Firefox lock installs from it (scripts/firefox-lock.mjs), so a profile the lock sets up starts from the
// newest version, and so does an account whose copy predates the update address.
//
// Firefox has to fetch these without signing in, so they live on a public GitHub Pages site made from the
// repository UPDATES_REPO (scripts/updates-site.mjs): only these files are there, the source stays in this
// private repository. The "Publish updates" workflow (.github/workflows/publish-updates.yml) builds them
// from every signed release with this script and pushes them there; "Sign with Mozilla" runs it after each
// new release.
//
// usage: node scripts/updates-manifest.mjs <folder with the signed .xpi files> <folder to write the site to>
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions } from '../extension/lib/lock.js';
import { ADDON_ID } from './firefox-lock.mjs';
import { readZip } from './read-zip.mjs';
import { LATEST_NAME, LATEST_URL, SITE_URL, UPDATES_REPO, UPDATES_URL } from './updates-site.mjs';

export { LATEST_NAME, LATEST_URL, SITE_URL, UPDATES_REPO, UPDATES_URL };

const XPI_NAME = /^family-site-blocker-(\d+(?:\.\d+)*)\.xpi$/;

// Versions like 1.3.2 are ordered numerically, part by part, as Firefox does: compareVersions, which the
// settings page shares (extension/lib/lock.js).
export { compareVersions };

/**
 * Reads a signed .xpi of this add-on: its version, the Firefox it needs, and the file's hash. Throws if the file
 * is something else (another add-on, unsigned, or not named family-site-blocker-<version>.xpi).
 */
export function describeXpi(name, data) {
  const match = XPI_NAME.exec(name);
  if (!match) throw new Error(`${name} isn't named family-site-blocker-<version>.xpi`);
  let files;
  try {
    files = readZip(data);
  } catch {
    throw new Error(`${name} can't be read as a zip`);
  }
  if (!files.has('manifest.json')) throw new Error(`${name} has no manifest.json`);
  const manifest = JSON.parse(files.get('manifest.json').data.toString('utf8'));
  const gecko = manifest.browser_specific_settings?.gecko ?? {};
  if (gecko.id !== ADDON_ID) throw new Error(`${name} is a different add-on (${gecko.id ?? 'no id'})`);
  if (manifest.version !== match[1]) throw new Error(`${name} holds version ${manifest.version}`);
  if (!files.has('META-INF/cose.sig') && !files.has('META-INF/mozilla.rsa')) throw new Error(`${name} isn't signed by Mozilla`);
  return {
    name,
    version: manifest.version,
    minFirefox: gecko.strict_min_version,
    hash: `sha256:${createHash('sha256').update(data).digest('hex')}`,
  };
}

/**
 * The update manifest, in the JSON form Firefox reads: every version given, oldest first, each with the
 * address of its file on the site and the file's hash. `xpis` is [{ name, data }].
 */
export function updatesManifest(xpis, siteUrl = SITE_URL) {
  const updates = xpis
    .map(({ name, data }) => describeXpi(name, data))
    .sort((a, b) => compareVersions(a.version, b.version))
    .map(({ name, version, minFirefox, hash }) => ({
      version,
      update_link: `${siteUrl}${name}`,
      update_hash: hash,
      // Firefox reads the Firefox versions an update needs from "applications" here, whatever the add-on's
      // own manifest calls them.
      ...(minFirefox ? { applications: { gecko: { strict_min_version: minFirefox } } } : {}),
    }));
  return { addons: { [ADDON_ID]: { updates } } };
}

const ABOUT = 'The files Firefox reads to keep Family Site Blocker up to date, and the newest signed version under one name, which the Firefox lock installs from. There is nothing to see here.';
const INDEX = `<!doctype html>\n<meta charset="utf-8">\n<title>Family Site Blocker updates</title>\n<p>${ABOUT}</p>\n`;
const README = `# Family Site Blocker updates\n\n${ABOUT}\n`;

/**
 * Builds the site: copies the signed .xpi files from `xpiDir` to `outDir`, writes updates.json for them,
 * copies the newest once more as family-site-blocker.xpi, and adds a plain index page and README, and
 * .nojekyll (so GitHub Pages serves the files exactly as they are). Returns the versions it listed, oldest
 * first.
 */
export function buildSite(xpiDir, outDir, siteUrl = SITE_URL) {
  const names = readdirSync(xpiDir).filter((name) => XPI_NAME.test(name)).sort();
  if (names.length === 0) throw new Error(`No family-site-blocker-<version>.xpi files in ${xpiDir}`);
  const xpis = names.map((name) => ({ name, data: readFileSync(join(xpiDir, name)) }));
  const manifest = updatesManifest(xpis, siteUrl);
  const updates = manifest.addons[ADDON_ID].updates;
  const newest = basename(updates.at(-1).update_link);
  mkdirSync(outDir, { recursive: true });
  for (const name of names) copyFileSync(join(xpiDir, name), join(outDir, name));
  copyFileSync(join(xpiDir, newest), join(outDir, LATEST_NAME));
  writeFileSync(join(outDir, 'updates.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(outDir, 'index.html'), INDEX);
  writeFileSync(join(outDir, 'README.md'), README);
  writeFileSync(join(outDir, '.nojekyll'), '');
  return updates.map((update) => update.version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [xpiDir, outDir] = process.argv.slice(2);
  if (!xpiDir || !outDir) {
    console.error(`usage: node ${basename(process.argv[1])} <folder with signed .xpi files> <folder to write the site to>`);
    process.exit(2);
  }
  const versions = buildSite(xpiDir, outDir);
  console.log(`Wrote ${outDir}: updates.json listing ${versions.join(', ')}, newest ${versions.at(-1)} (also as ${LATEST_NAME})`);
}
