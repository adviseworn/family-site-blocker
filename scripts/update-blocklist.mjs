#!/usr/bin/env node
// npm run blocklist: fetches the latest copy of the community list that widens the built-in list (see
// blocklists/community.txt) and writes it there, with a note of where and when it came from; then ranks
// the built-in list by how much people visit each site and writes the most visited to blocklists/popular.txt
// (see below). Then run `npm run build` to rebuild the rules and the Firefox lock's profile from them, and
// release a new version.
//
// The community list is StevenBlack/hosts's "porn" extension on its own (MIT; it gathers Clefspeare13/pornhosts
// and bigdargon/hostsVN's adult list, both MIT), a hosts file with one adult site per line. It was chosen for
// being widely used, rebuilt by its maintainers every few days, and free of the well-known sites that
// broader lists sweep up by mistake; blocklists/never.txt takes out the few it does, and the fast checks keep
// an eye on that (test/blocker.test.mjs).
//
// The ranking is the Chrome UX Report's top million (Google's count of real Chrome page loads, which
// zakird/crux-top-lists caches as a CSV of origins; Google's public dataset, CC BY-SA 4.0 as tranco-list.eu
// gives it). It ranks sites in bands (the top 1,000, 5,000, 10,000, 50,000, 100,000, 500,000, 1,000,000),
// not one by one, and within a band it gives no order, so there the Majestic Million (CC BY 3.0; a ranking
// by links from across the web) decides, with sites it doesn't rank last and alphabetical among themselves.
// Firefox's own copy of the built-in list (the lock) holds at most 1,000 entries, and this is what decides
// which: starter.txt first, then popular.txt in its order (scripts/firefox-lock.mjs). Only the order is
// taken from the rankings: every site in popular.txt is on the built-in list already.
import { writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseDomainList } from '../extension/lib/domains.js';
import { loadBlocklists, loadNever } from './build-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const COMMUNITY_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts';
export const COMMUNITY_PATH = join(ROOT, 'blocklists', 'community.txt');
export const POPULAR_URL = 'https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/global/current.csv.gz';
export const POPULAR_PATH = join(ROOT, 'blocklists', 'popular.txt');
export const POPULAR_SIZE = 2000; // sites kept in popular.txt: twice what Firefox's copy can take
export const BANDS = [1000, 5000, 10_000, 50_000, 100_000, 500_000, 1_000_000];
export const LINKS_URL = 'https://downloads.majestic.com/majestic_million.csv'; // the order within a band

/** The file as it is saved: a note from this project, then the list exactly as published. */
export function communityList(text, fetchedOn = new Date()) {
  const { domains } = parseDomainList(text);
  if (domains.length < 10_000) throw new Error(`Only ${domains.length} domains in the downloaded list; expected tens of thousands. Not saving it.`);
  const day = fetchedOn.toISOString().slice(0, 10);
  return [
    '# Community list: StevenBlack/hosts, "porn" extension only (MIT), unchanged below this note.',
    `# From ${COMMUNITY_URL}`,
    `# Fetched ${day}; ${domains.length} domains. Refresh with: npm run blocklist, then npm run build.`,
    "# never.txt names the ordinary sites to leave out of it; popular.txt orders it for Firefox's own copy (the lock).",
    '',
    text.replace(/\r\n/g, '\n').trimEnd(),
    '',
  ].join('\n');
}

/**
 * The band each listed site is in, from the ranking's CSV (origin,rank lines): a Map of domain to band,
 * for the listed domains that any ranked origin is on or under. An origin counts for the shortest listed
 * domain it is under (es.pornhub.com counts for pornhub.com, which blocks it too); a site keeps the best
 * band of its origins.
 */
export function rankSites(csv, listed) {
  const ranks = new Map();
  for (const line of String(csv).split('\n')) {
    const comma = line.lastIndexOf(',');
    if (comma < 0) continue;
    const band = Number(line.slice(comma + 1).trim());
    if (!BANDS.includes(band)) continue;
    let host;
    try {
      host = new URL(line.slice(0, comma).trim()).hostname;
    } catch {
      continue;
    }
    const labels = host.split('.');
    for (let i = labels.length - 2; i >= 0; i--) {
      const domain = labels.slice(i).join('.');
      if (!listed.has(domain)) continue;
      if (!ranks.has(domain) || ranks.get(domain) > band) ranks.set(domain, band);
      break;
    }
  }
  return ranks;
}

/**
 * Each listed site's place in the Majestic Million (GlobalRank,TldRank,Domain,... lines): a Map of domain to
 * rank, credited like rankSites() to the shortest listed domain a ranked domain is on or under, keeping the
 * best rank. Majestic ranks by links from across the web rather than visits, so it only breaks ties.
 */
export function linkRanks(csv, listed) {
  const ranks = new Map();
  for (const line of String(csv).split('\n')) {
    const [rank, , host] = line.split(',');
    const place = Number(rank);
    if (!host || !Number.isInteger(place) || place < 1) continue;
    const labels = host.trim().toLowerCase().split('.');
    for (let i = labels.length - 2; i >= 0; i--) {
      const domain = labels.slice(i).join('.');
      if (!listed.has(domain)) continue;
      if (!ranks.has(domain) || ranks.get(domain) > place) ranks.set(domain, place);
      break;
    }
  }
  return ranks;
}

/** The ranked sites in order: best band first; within a band, best link rank first, unranked last, then alphabetical. */
export const inOrder = (ranks, links = new Map()) =>
  [...ranks].sort((a, b) => a[1] - b[1] || (links.get(a[0]) ?? Infinity) - (links.get(b[0]) ?? Infinity) || a[0].localeCompare(b[0]));

/** popular.txt as it is saved: a note, then the top `size` sites, most visited first, each with its band and link rank. */
export function popularList(ranks, links = new Map(), fetchedOn = new Date(), size = POPULAR_SIZE) {
  if (ranks.size < 100) throw new Error(`Only ${ranks.size} built-in sites found in the ranking; expected thousands. Not saving it.`);
  const ordered = inOrder(ranks, links).slice(0, size);
  const day = fetchedOn.toISOString().slice(0, 10);
  const width = Math.max(...ordered.map(([domain]) => domain.length));
  const note = ([domain, band]) => `# top ${band.toLocaleString('en-US')}${links.has(domain) ? `; links ${links.get(domain).toLocaleString('en-US')}` : ''}`;
  return [
    `# Popular sites: the built-in sites that Chrome users load most, most loaded first (the top ${size} of them).`,
    '# Made by npm run blocklist from the Chrome UX Report\'s top million (Google; CC BY-SA 4.0 as tranco-list.eu',
    `# gives it; cached at ${POPULAR_URL}),`,
    `# which ranks sites in bands: the top ${BANDS.map((band) => band.toLocaleString('en-US')).join(', ')}.`,
    `# Within a band, by place in the Majestic Million (${LINKS_URL}; CC BY 3.0),`,
    '# a ranking by links from across the web, sites it doesn\'t rank last and alphabetical among themselves.',
    `# Fetched ${day}; ${ordered.length} of the ${ranks.size} built-in sites Chrome ranks, ${[...ranks.keys()].filter((domain) => links.has(domain)).length} of them in the Majestic Million.`,
    '# Every site here is on starter.txt or community.txt already: this file only puts them in order, for',
    "# Firefox's own copy of the list (the lock), which takes 1,000 entries (scripts/firefox-lock.mjs).",
    '',
    ...ordered.map((entry) => `${entry[0].padEnd(width)}  ${note(entry)}`),
    '',
  ].join('\n');
}

/** Whether a site's name has an adult word in it: the ones without are worth a look (never.txt). */
const ADULT_WORDS = [
  'porn', 'sex', 'xxx', 'fuck', 'nud', 'naked', 'cum', 'milf', 'anal', 'hent', 'ero', 'adult', 'escort', 'cam', 'slut', 'boob', 'tit',
  'dick', 'cock', 'pussy', 'fap', 'hot', 'babe', 'girl', 'lady', 'ladies', 'boy', 'gay', 'lesb', 'shemale', 'trann', 'bdsm', 'fet',
  'strip', 'whore', 'bitch', 'jav', 'av', 'tube', 'hard', 'xx', 'sx', 'teen', 'mature', 'amateur', 'swing', 'dating', 'date', 'hook',
  'nsfw', 'rule34', 'yiff', 'furry', 'booru', 'doujin', 'yaoi', '18', '19', 'xh', 'xv', 'xn', 'desi', 'bhabhi', 'chudai', 'kahani',
  'orgasm', 'leak', 'fans', 'wife', 'hub', 'clip', 'vid', 'movie', 'film', 'phim', 'manga', 'comic', 'lust', 'kink', 'sissy', 'femdom',
  'bondage', 'spank', 'jizz', 'bang', 'ass', 'hole', 'bunny', 'beeg', 'missav', 'redwap', 'skirt', 'blow', 'wank', 'model', 'massage',
  'celeb', 'tryst', 'personals', 'hostess', 'bate', 'chat', 'doll', 'x-', '-x',
];
const ADULT = new RegExp(`${ADULT_WORDS.map((word) => word.replace(/[-]/g, '\\$&')).join('|')}|\\bx\\b|[^a-z]x[^a-z]`, 'i');
export const looksAdult = (domain) => ADULT.test(domain);

/** The sites in the top bands whose names don't look adult, as candidates for never.txt. */
export const worthALook = (ranks, never, upTo = 10_000) =>
  inOrder(ranks)
    .filter(([domain, band]) => band <= upTo && !never.has(domain) && !looksAdult(domain))
    .map(([domain]) => domain);

async function fetchText(url, { gzip = false } = {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return gzip ? gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8') : response.text();
}

async function main() {
  const file = communityList(await fetchText(COMMUNITY_URL));
  writeFileSync(COMMUNITY_PATH, file);
  console.log(`Wrote ${relative(process.cwd(), COMMUNITY_PATH)} (${parseDomainList(file).domains.length} domains).`);

  const listed = new Set(loadBlocklists().domains);
  const ranks = rankSites(await fetchText(POPULAR_URL, { gzip: true }), listed);
  const links = linkRanks(await fetchText(LINKS_URL), listed);
  const popular = popularList(ranks, links);
  writeFileSync(POPULAR_PATH, popular);
  console.log(`Wrote ${relative(process.cwd(), POPULAR_PATH)} (${parseDomainList(popular).domains.length} of the ${ranks.size} built-in sites Chrome ranks; Majestic ranks ${links.size}). Now run: npm run build`);

  const look = worthALook(ranks, loadNever());
  if (look.length) {
    console.log(`\nIn the top 10,000 sites of the web and on the list, with names that don't look adult; an ordinary site among them belongs in never.txt:`);
    console.log(`  ${look.join('  ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
