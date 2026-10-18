#!/usr/bin/env node
// npm run blocklist: fetches the latest copy of the community list that widens the built-in list (see
// blocklists/community.txt) and writes it there, with a note of where and when it came from. Then run
// `npm run build` to rebuild the rules and the Firefox lock's profile from it, and release a new version.
//
// The list is StevenBlack/hosts's "porn" extension on its own (MIT; it gathers Clefspeare13/pornhosts and
// bigdargon/hostsVN's adult list, both MIT), a hosts file with one adult site per line. It was chosen for
// being widely used, rebuilt by its maintainers every few days, and free of the well-known sites that
// broader lists sweep up by mistake; the fast checks keep an eye on that (test/blocker.test.mjs).
import { writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDomainList } from '../extension/lib/domains.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const COMMUNITY_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts';
export const COMMUNITY_PATH = join(ROOT, 'blocklists', 'community.txt');

/** The file as it is saved: a note from this project, then the list exactly as published. */
export function communityList(text, fetchedOn = new Date()) {
  const { domains } = parseDomainList(text);
  if (domains.length < 10_000) throw new Error(`Only ${domains.length} domains in the downloaded list; expected tens of thousands. Not saving it.`);
  const day = fetchedOn.toISOString().slice(0, 10);
  return [
    '# Community list: StevenBlack/hosts, "porn" extension only (MIT), unchanged below this note.',
    `# From ${COMMUNITY_URL}`,
    `# Fetched ${day}; ${domains.length} domains. Refresh with: npm run blocklist, then npm run build.`,
    '# Firefox\'s own copy of the built-in list (the lock) takes starter.txt first, then this file, up to 1,000 sites.',
    '',
    text.replace(/\r\n/g, '\n').trimEnd(),
    '',
  ].join('\n');
}

async function main() {
  const response = await fetch(COMMUNITY_URL);
  if (!response.ok) throw new Error(`${COMMUNITY_URL}: HTTP ${response.status}`);
  const file = communityList(await response.text());
  writeFileSync(COMMUNITY_PATH, file);
  console.log(`Wrote ${relative(process.cwd(), COMMUNITY_PATH)} (${parseDomainList(file).domains.length} domains). Now run: npm run build`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
