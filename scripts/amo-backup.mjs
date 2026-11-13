#!/usr/bin/env node
// Backs up the signed add-on from addons.mozilla.org: every version Mozilla has signed (listed or not, from
// 1.1.1 on) whose release on GitHub doesn't hold its signed file is downloaded, checked to be a signed copy of
// this add-on of that version, saved under the name the update files use (family-site-blocker-<version>.xpi)
// and put in the version's release, next to the files the sign job puts there, so the update site and the lock
// check see every signed version as released. A version with no release gets one, on its tag when there is
// one, otherwise on the commit that made the version (scripts/version-commit.mjs). Mozilla keeps the files
// too, but the project's own copy outlives any account there.
// The Mozilla backup workflow (.github/workflows/mozilla-backup.yml) runs this, by hand.
//
// usage: node scripts/amo-backup.mjs <folder to save the files in>
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET, the API key from https://addons.mozilla.org/developers/addon/api/key/ ;
// uploads when the workflow's GITHUB_TOKEN (or a personal one, in GITHUB_TOKEN or GH_TOKEN) is set, otherwise
// only saves. Prints a line a version. Exits 1 on any problem, 2 on usage.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions } from '../extension/lib/lock.js';
import { get, listVersions } from './amo-signed.mjs';
import { releasedVersions, releases, tagName, tagged, target, upload, xpiName } from './release-files.mjs';
import { backupNotes } from './release-notes.mjs';
import { describeXpi } from './updates-manifest.mjs';
import { versionCommit } from './version-commit.mjs';

/**
 * Backs up what the releases lack. Returns an entry a version Mozilla lists, oldest first: { version, state },
 * the state being 'kept' (its release holds the file already), 'saved' (downloaded, not uploaded: no token),
 * 'backed up' (downloaded and put in its release), 'saved: no release, tag or commit to put it in' (a version
 * from before this history) or 'not signed: <Mozilla's status for the file>'. `commitOf` gives the commit that
 * made a version, or null.
 */
export async function backup(folder, key, { api, github = target(), commitOf = () => null, log = () => {} } = {}) {
  const list = await releases(github);
  const have = await releasedVersions(github, list);
  const released = new Set(list.filter((release) => !release.draft).map((release) => release.tag_name));
  const listed = (await listVersions(key, api)).sort((a, b) => compareVersions(a.version, b.version));
  mkdirSync(folder, { recursive: true });
  const results = [];
  for (const entry of listed) {
    const { version } = entry;
    let state;
    if (have.includes(version)) state = 'kept';
    else if (entry.file?.status !== 'public' || !entry.file.url) state = `not signed: ${entry.file?.status ?? 'no file'}`;
    else {
      const data = Buffer.from(await (await get(new URL(entry.file.url), key)).arrayBuffer());
      const name = xpiName(version);
      describeXpi(name, data); // throws unless it is a signed copy of this add-on, of this version
      writeFileSync(join(folder, name), data);
      if (Object.keys(github.headers).length === 0) state = 'saved';
      else {
        const commit = released.has(tagName(version)) || (await tagged(version, github)) ? undefined : commitOf(version);
        if (commit === null) state = 'saved: no release, tag or commit to put it in';
        else {
          // The latest release is the newest version's: a version newer than every one released takes the mark.
          const latest = have.every((other) => compareVersions(other, version) < 0);
          await upload(version, name, data, github, { commit, notes: backupNotes(version), latest });
          have.push(version);
          state = 'backed up';
        }
      }
    }
    results.push({ version, state });
    log(`${version}: ${state}`);
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [folder] = process.argv.slice(2);
  const key = { issuer: process.env.AMO_JWT_ISSUER, secret: process.env.AMO_JWT_SECRET };
  if (!folder) {
    console.error('usage: AMO_JWT_ISSUER=… AMO_JWT_SECRET=… node scripts/amo-backup.mjs <folder>');
    process.exit(2);
  }
  if (!key.issuer || !key.secret) {
    console.error('No API key: AMO_JWT_ISSUER and AMO_JWT_SECRET must be set (on GitHub: Settings → Secrets and variables → Actions). They come from https://addons.mozilla.org/developers/addon/api/key/');
    process.exit(1);
  }
  try {
    const results = await backup(folder, key, { api: process.env.AMO_API, commitOf: (version) => versionCommit(version), log: console.log });
    const count = (state) => results.filter((entry) => entry.state === state).length;
    const saved = results.filter((entry) => entry.state.startsWith('saved')).length;
    const unsigned = results.length - count('backed up') - saved - count('kept');
    console.log(`${results.length} versions on addons.mozilla.org: ${count('backed up')} backed up now, ${saved} saved in ${folder} only, ${count('kept')} already in their releases, ${unsigned} not signed.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
