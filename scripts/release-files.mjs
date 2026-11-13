#!/usr/bin/env node
// The files of the releases on GitHub. The sign job of .github/workflows/pipeline.yml gives each version a
// release, tagged v<version>, that holds its files, the signed family-site-blocker-<version>.xpi among them
// (PACKAGE_NAME in scripts/updates-site.mjs), and the Mozilla backup (scripts/amo-backup.mjs) adds the versions
// Mozilla signed that have none. This lists the versions whose release holds the signed file and saves the
// newest ones in a folder, under the name scripts/updates-manifest.mjs expects: the update-files job builds
// the update files from them, and the Firefox lock check tests the lock with the newest. It can also put a
// file in a version's release, making the release when there is none (upload), which is how the backup adds
// a version.
//
// usage: node scripts/release-files.mjs <folder to save them in> [how many of the newest versions; all by default]
// In a workflow it reads GITHUB_API_URL and GITHUB_REPOSITORY, which GitHub sets, and GITHUB_TOKEN, which the
// workflow passes; elsewhere it asks api.github.com about the repository, with the token in GITHUB_TOKEN or
// GH_TOKEN when there is one (a private repository needs it). Exits 3 when nothing has been released yet, 1 on
// any other problem.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions } from '../extension/lib/lock.js';
import { PACKAGE_NAME, REPOSITORY } from './updates-site.mjs';

export const xpiName = (version) => `${PACKAGE_NAME}-${version}.xpi`;
export const tagName = (version) => `v${version}`;
export const releaseName = (version) => `Family Site Blocker ${version}`;

/** The version a release's tag names, or null for a tag that isn't v<version>. */
export const versionOf = (tag) => /^v(\d+(?:\.\d+)*)$/.exec(tag ?? '')?.[1] ?? null;

/** Where to ask: GitHub's API and the repository, with the workflow's token or a personal one, or none. */
export function target(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  return {
    api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    repository: env.GITHUB_REPOSITORY || REPOSITORY,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  };
}

const API_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': PACKAGE_NAME };

async function ask(url, headers, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...API_HEADERS, ...headers, ...options.headers } });
  if (!response.ok && !(options.missingIsFine && response.status === 404)) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

/** Every release of the repository, as GitHub's API lists them, through all its pages. */
export async function releases({ api, repository, headers } = target()) {
  const all = [];
  for (let url = `${api}/repos/${repository}/releases?per_page=100`; url; ) {
    const response = await ask(url, headers);
    all.push(...(await response.json()));
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1] ?? null;
  }
  return all;
}

/** The signed file among a release's files, when the release is published and holds it. */
const signedFile = (release) => {
  const version = versionOf(release.tag_name);
  return version && !release.draft ? (release.assets ?? []).find((asset) => asset.name === xpiName(version)) : undefined;
};

/** Every version whose release holds its signed file, oldest first. `list` is what releases() gave, if already asked. */
export async function releasedVersions(where = target(), list) {
  const versions = (list ?? (await releases(where))).filter(signedFile).map((release) => versionOf(release.tag_name));
  return [...new Set(versions)].sort(compareVersions);
}

/** The newest `count` of the versions given (all when count is undefined), oldest first. */
export const newest = (versions, count) => (count === undefined ? versions : versions.slice(Math.max(0, versions.length - count)));

/** Saves the signed files of `versions` in `folder` and returns their paths. */
export async function download(versions, folder, where = target(), list) {
  const all = list ?? (await releases(where));
  mkdirSync(folder, { recursive: true });
  const paths = [];
  for (const version of versions) {
    const asset = all.filter((release) => release.tag_name === tagName(version)).map(signedFile).find(Boolean);
    if (!asset) throw new Error(`No release ${tagName(version)} holding ${xpiName(version)}: 404`);
    // A release file's address in the API hands over the file itself when asked for it as a stream of bytes:
    // GitHub answers with a redirect to where the file is stored, which wants none of the API's headers.
    const first = await fetch(asset.url, { redirect: 'manual', headers: { ...where.headers, Accept: 'application/octet-stream', 'User-Agent': PACKAGE_NAME } });
    const response = first.status >= 300 && first.status < 400 && first.headers.get('location') ? await fetch(new URL(first.headers.get('location'), asset.url)) : first;
    if (!response.ok) throw new Error(`${asset.url} answered ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
    const path = join(folder, xpiName(version));
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    paths.push(path);
  }
  return paths;
}

/** Whether the repository has the tag v<version>. */
export async function tagged(version, { api, repository, headers } = target()) {
  return (await ask(`${api}/repos/${repository}/git/ref/tags/${tagName(version)}`, headers, { missingIsFine: true })).ok;
}

/**
 * Puts `data` in the release of `version` as `name`. A version with no release gets one, with `notes` on its
 * page: on its tag v<version> when the repository has that tag, otherwise on `commit`, where GitHub then makes
 * the tag (without either there is nowhere to make it, and this throws). The new release is marked as the
 * latest only when `latest` says so: this is for versions from before, and the latest release is the newest
 * version's. Returns the address the file downloads from.
 */
export async function upload(version, name, data, where = target(), { commit, notes = '', latest = false } = {}) {
  const { api, repository, headers } = where;
  const repo = `${api}/repos/${repository}`;
  const found = await ask(`${repo}/releases/tags/${tagName(version)}`, headers, { missingIsFine: true });
  let release;
  if (found.ok) release = await found.json();
  else {
    const onTag = await tagged(version, where);
    if (!onTag && !commit) throw new Error(`Version ${version} has no release to put ${name} in, and neither a tag ${tagName(version)} nor a commit to make one on`);
    const made = await ask(`${repo}/releases`, headers, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tagName(version), ...(onTag ? {} : { target_commitish: commit }), name: releaseName(version), body: notes, make_latest: latest ? 'true' : 'false' }),
    });
    release = await made.json();
  }
  const url = `${release.upload_url.replace(/\{[^}]*\}$/, '')}?name=${encodeURIComponent(name)}`;
  const sent = await ask(url, headers, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
  return (await sent.json()).browser_download_url ?? url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [folder, count] = process.argv.slice(2);
  if (!folder || (count !== undefined && !/^\d+$/.test(count))) {
    console.error('usage: node scripts/release-files.mjs <folder> [how many of the newest versions]');
    process.exit(2);
  }
  try {
    const where = target();
    const list = await releases(where);
    const versions = await releasedVersions(where, list);
    if (versions.length === 0) {
      console.error('Nothing has been released on GitHub yet: no release holds a signed file.');
      process.exit(3);
    }
    const chosen = newest(versions, count === undefined ? undefined : Number(count));
    const paths = await download(chosen, folder, where, list);
    console.log(`Saved ${paths.length} of ${versions.length} released versions in ${folder}: ${chosen.join(', ')}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
