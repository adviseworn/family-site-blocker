#!/usr/bin/env node
// Downloads the signed .xpi of one version of this add-on from addons.mozilla.org, when Mozilla already has
// that version: uploaded by hand, or by an earlier run of the sign job that stopped after the upload,
// or gave up waiting for a reviewer. Mozilla won't take the same version twice, so the sign job tries this
// before uploading. A listed version (from 1.24.0) is signed once Mozilla has approved it: at once after its
// automatic check, or after a reviewer has looked at it, which can take days.
//
// usage: node scripts/amo-signed.mjs <version> <folder to save it in>
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET, an API key from https://addons.mozilla.org/developers/addon/api/key/
// Prints the saved file's path. Exits with 3 when Mozilla has no such version, with 4 when it has the version
// and hasn't approved it within AMO_WAIT_MINUTES (25 unless set; the sign job sets it, to 0 while the add-on
// waits for its first reviewer: a run's minutes are counted), and with 1 on any other problem.
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ADDON_ID = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;

/** A JSON Web Token for one API request, as addons.mozilla.org expects: HS256, valid for one minute. */
export function token(issuer, secret, now = Math.floor(Date.now() / 1000)) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

export async function get(url, key) {
  const response = await fetch(url, { headers: { Authorization: `JWT ${token(key.issuer, key.secret)}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url.href} answered ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

/** Every version of this add-on on addons.mozilla.org, listed or not, as Mozilla lists them (newest first). */
export async function listVersions(key, api = 'https://addons.mozilla.org/api/v5/') {
  const versions = [];
  let url = new URL(`addons/addon/${encodeURIComponent(ADDON_ID)}/versions/?filter=all_with_unlisted&page_size=50`, api);
  while (url) {
    const page = await (await get(url, key)).json();
    versions.push(...page.results);
    url = page.next ? new URL(page.next) : null;
  }
  return versions;
}

/** This add-on's version `version` on addons.mozilla.org, listed or not, or null if there is none. */
async function findVersion(version, key, api) {
  let url = new URL(`addons/addon/${encodeURIComponent(ADDON_ID)}/versions/?filter=all_with_unlisted&page_size=50`, api);
  while (url) {
    const page = await (await get(url, key)).json();
    const found = page.results.find((entry) => entry.version === version);
    if (found) return found; // without reading the pages after it: this is asked every 15 seconds while waiting
    url = page.next ? new URL(page.next) : null;
  }
  return null;
}

/** What downloadSigned() throws when Mozilla has the version and hasn't approved it in the time allowed. */
export const NOT_APPROVED = 'NOT_APPROVED';

/**
 * Saves the signed file of `version` in `folder` and returns its path, waiting up to `waitMs` while Mozilla
 * hasn't approved and signed it (not at all with 0: one look), and then throwing an error whose code is
 * NOT_APPROVED. Returns null when Mozilla has no such version.
 */
export async function downloadSigned(version, folder, key, { api = 'https://addons.mozilla.org/api/v5/', pollMs = 15_000, waitMs = 25 * 60_000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = await findVersion(version, key, api);
    if (!found) return null;
    if (found.file?.status === 'public' && found.file.url) {
      const url = new URL(found.file.url);
      const data = Buffer.from(await (await get(url, key)).arrayBuffer());
      mkdirSync(folder, { recursive: true });
      const path = join(folder, basename(url.pathname));
      writeFileSync(path, data);
      return path;
    }
    if (Date.now() >= deadline) {
      throw Object.assign(new Error(`Mozilla hasn't approved and signed ${version} yet (file status: ${found.file?.status ?? 'none'}); a public version can wait for a reviewer.`), { code: NOT_APPROVED });
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, folder] = process.argv.slice(2);
  const key = { issuer: process.env.AMO_JWT_ISSUER, secret: process.env.AMO_JWT_SECRET };
  if (!version || !folder || !key.issuer || !key.secret) {
    console.error('Usage: AMO_JWT_ISSUER=… AMO_JWT_SECRET=… node scripts/amo-signed.mjs <version> <folder>');
    process.exit(1);
  }
  try {
    const options = process.env.AMO_API ? { api: process.env.AMO_API, pollMs: 50, waitMs: 5_000 } : {};
    // How long to wait for a version Mozilla holds: whole minutes, 0 for one look.
    const minutes = (process.env.AMO_WAIT_MINUTES ?? '').trim();
    if (/^\d+$/.test(minutes)) options.waitMs = Number(minutes) * 60_000;
    else if (minutes) throw new Error(`AMO_WAIT_MINUTES must be a whole number of minutes, not "${minutes}".`);
    const path = await downloadSigned(version, folder, key, options);
    if (!path) {
      console.error(`Mozilla has no version ${version} of this add-on yet.`);
      process.exit(3);
    }
    console.log(path);
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === NOT_APPROVED ? 4 : 1);
  }
}
