// Sites in the browser's history that look adult from their names but aren't on either list. The list
// can't be complete (new sites appear every week, and a community list lags behind), so the history scan
// (background.js) notes such sites for the record page, where one click adds them to the person's own
// list. Only the name is judged: a plain name (ourdream.ai, swappz.com) passes unnoticed, and the odd
// innocent name may be caught (adultswim.com); nothing is blocked by being noted here.
//
// Stored under UNLISTED as { at: <when the history was looked through>, sites: [{ site, visits, last }] },
// most visited first, at most MAX_UNLISTED sites.
import { hostOf, listedDomain } from './attempts.js';

export const UNLISTED = 'unlisted';
export const MAX_UNLISTED = 50;

// Words that mark a site wherever they appear in its name.
const ANYWHERE = [
  'porn', 'xxx', 'hentai', 'nsfw', 'nude', 'nudif', 'undress', 'deepnude', 'clothoff', 'erotic', 'fetish', 'bdsm', 'milf',
  'slut', 'whore', 'horny', 'smut', 'orgasm', 'dildo', 'femdom', 'bondage', 'ahegao', 'futa', 'ecchi', 'waifu', 'yiff',
  'rule34', 'camgirl', 'sexcam', 'escort', 'hookup', 'swinger', 'incest', 'stepmom', 'stepsis', 'stepdad', 'hardcore',
  'boobs', 'tits', 'pussy', 'blowjob', 'handjob', 'cumshot', 'creampie', 'gangbang', 'threesome', 'shemale', 'ladyboy',
  'onlyfan', 'fuck', 'aigirlfriend', 'sexting', 'playboy', 'nymph', 'thots', 'xhamster', 'xvideos', 'xnxx', 'redtube', 'youporn',
];
// Words that count only at the start of a part of the name, because they hide inside ordinary words
// (essex, peacock, cumberland, illustrator, stripe, babel, camera, java).
const AT_START = [
  'sex', 'cocks?(?=[.-]|$|\\d)', 'cums?(?=[.-]|$|\\d)', 'lust(?=[.-]|$|\\d|gf|y)', 'strip(?!e)', 'babes?(?=[.-]|$|\\d)',
  'cams?(?=[.-]|$|\\d)', 'adult', 'kink', 'fap', 'thot', 'jav(?![ae])', 'bbw', 'xxx',
];
// Top-level domains sold for adult sites.
const TLDS = ['xxx', 'sex', 'porn', 'adult', 'sexy'];

const PATTERN = new RegExp(
  `(?:${ANYWHERE.join('|')})|(?:^|[.-])(?:${AT_START.join('|')})|\\.(?:${TLDS.join('|')})$`,
);

/** Whether a host name looks like an adult site's. */
export function looksAdult(host) {
  return typeof host === 'string' && PATTERN.test(host.toLowerCase());
}

// Second-level names under which sites get their own third-level names (bbc.co.uk, site.com.au).
const SHARED_SECOND_LEVELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or', 'nom', 'me']);

/** The site a host belongs to: its registered name, roughly (www.site.com and m.site.com → site.com). */
export function siteOf(host) {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const [tld, second] = [labels.at(-1), labels.at(-2)];
  const keep = tld.length === 2 && SHARED_SECOND_LEVELS.has(second) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/**
 * The adult-looking sites among history items ({ url, visitCount, lastVisitTime }) that no listed domain
 * covers, summed up by site, most visited first, then most recent: [{ site, visits, last }].
 */
export function tallyUnlisted(items, domains) {
  const sites = new Map();
  for (const item of items ?? []) {
    const host = hostOf(item.url);
    if (!host || listedDomain(host, domains) || !looksAdult(host)) continue;
    const site = siteOf(host);
    const row = sites.get(site) ?? { site, visits: 0, last: 0 };
    row.visits += Math.max(1, Number(item.visitCount) || 0);
    row.last = Math.max(row.last, Number(item.lastVisitTime) || 0);
    sites.set(site, row);
  }
  return [...sites.values()].sort((a, b) => b.visits - a.visits || b.last - a.last || a.site.localeCompare(b.site)).slice(0, MAX_UNLISTED);
}
