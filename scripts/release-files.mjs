#!/usr/bin/env node
// Fetches the signed .xpi files of the newest versions released on GitLab. The sign job puts each release's
// files in the project's package registry, under family-site-blocker/<version> (scripts/updates-site.mjs,
// PACKAGE_NAME), and the mozilla-backup job the older versions Mozilla signed; this lists the versions there
// and saves the newest ones in a folder, named family-site-blocker-<version>.xpi as scripts/updates-manifest.mjs
// expects. The update-files job builds the update files from them, and the lock-check job tests the lock with
// the newest.
//
// usage: node scripts/release-files.mjs <folder to save them in> [how many of the newest versions; all by default]
// In a pipeline it reads CI_API_V4_URL, CI_PROJECT_ID and CI_JOB_TOKEN; elsewhere it asks gitlab.com about the
// project with the personal access token in GITLAB_TOKEN (the project is private). Exits 3 when nothing has
// been released yet, 1 on any other problem.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions } from '../extension/lib/lock.js';
import { PACKAGE_NAME, PROJECT_PATH } from './updates-site.mjs';

export const xpiName = (version) => `${PACKAGE_NAME}-${version}.xpi`;

/** Where to ask: GitLab's API and the project, with the pipeline's job token or a personal access token. */
export function target(env = process.env) {
  return {
    api: (env.CI_API_V4_URL ?? 'https://gitlab.com/api/v4').replace(/\/$/, ''),
    project: env.CI_PROJECT_ID ?? encodeURIComponent(PROJECT_PATH),
    headers: env.CI_JOB_TOKEN ? { 'JOB-TOKEN': env.CI_JOB_TOKEN } : env.GITLAB_TOKEN ? { 'PRIVATE-TOKEN': env.GITLAB_TOKEN } : {},
  };
}

async function get(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

/** Every version of the release files in the package registry, oldest first. */
export async function releasedVersions({ api, project, headers } = target()) {
  const versions = [];
  for (let page = 1; page; ) {
    const url = `${api}/projects/${project}/packages?package_type=generic&package_name=${PACKAGE_NAME}&per_page=100&page=${page}`;
    const response = await get(url, headers);
    for (const entry of await response.json()) if (entry.name === PACKAGE_NAME && entry.version) versions.push(entry.version);
    const next = response.headers.get('x-next-page');
    page = next ? Number(next) : 0;
  }
  return [...new Set(versions)].sort(compareVersions);
}

/** The newest `count` of the versions given (all when count is undefined), oldest first. */
export const newest = (versions, count) => (count === undefined ? versions : versions.slice(Math.max(0, versions.length - count)));

/** Saves the signed files of `versions` in `folder` and returns their paths. */
export async function download(versions, folder, { api, project, headers } = target()) {
  mkdirSync(folder, { recursive: true });
  const paths = [];
  for (const version of versions) {
    const name = xpiName(version);
    const response = await get(`${api}/projects/${project}/packages/generic/${PACKAGE_NAME}/${version}/${name}`, headers);
    const path = join(folder, name);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    paths.push(path);
  }
  return paths;
}

/** Puts `data` in the package registry as `name` under PACKAGE_NAME/<version>, where the release files live. */
export async function upload(version, name, data, { api, project, headers } = target()) {
  const url = `${api}/projects/${project}/packages/generic/${PACKAGE_NAME}/${version}/${name}`;
  const response = await fetch(url, { method: 'PUT', headers, body: data });
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  return url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [folder, count] = process.argv.slice(2);
  if (!folder || (count !== undefined && !/^\d+$/.test(count))) {
    console.error('usage: node scripts/release-files.mjs <folder> [how many of the newest versions]');
    process.exit(2);
  }
  try {
    const versions = await releasedVersions();
    if (versions.length === 0) {
      console.error('Nothing has been released on GitLab yet: the package registry holds no release files.');
      process.exit(3);
    }
    const chosen = newest(versions, count === undefined ? undefined : Number(count));
    const paths = await download(chosen, folder);
    console.log(`Saved ${paths.length} of ${versions.length} released versions in ${folder}: ${chosen.join(', ')}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
