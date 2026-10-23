#!/usr/bin/env node
// The Firefox lock: enterprise policies that make Firefox install Family Site Blocker itself and keep it
// switched on. With them in force, the Add-ons Manager can't turn the add-on off, remove it or take away
// its website access, and the other ways round it are closed: private windows (where add-ons don't run
// unless someone allows it in the Add-ons Manager), Troubleshoot Mode from Firefox's menus (starts Firefox
// with add-ons off), about:config (extensions.dnr.enabled switches off every add-on's blocking rules) and
// Refresh Firefox (would wipe the sites added on the settings page).
//
// On a Mac, holding Option while Firefox opens, or --safe-mode, still starts Troubleshoot Mode: Firefox only
// checks DisableSafeMode at that point on Windows, and no add-on runs there. So the lock also gives Firefox
// its own copy of the built-in list (WebsiteFilter). That filter is part of Firefox, not an add-on, so the
// built-in sites stay blocked with add-ons off. It is made from blocklists/*.txt, like the add-on's rules,
// and `npm run build` writes both. Firefox's filter takes at most 1,000 entries and stops pages and frames
// but not images or scripts, so it backs the add-on up rather than replacing it. The entries are match
// patterns, so one entry can take a whole top-level domain: the adult-only ones (.xxx, .porn, .sex, .adult)
// and .sexy go in first as one entry each, which covers over a thousand of the list's sites and every site
// on those domains that no list has yet. The rest of the room goes to starter.txt (the test case and the
// largest sites), then popular.txt (the built-in sites people visit most, in order; npm run blocklist
// writes it), then the other lists in name order; never.txt's sites are left out, as everywhere.
//
// Firefox checks the Option key before it reads any policy, but not when the environment variable
// MOZ_DISABLE_SAFE_MODE_KEY is set (toolkit/xre/SafeMode.h). mac/ also gets a launch agent that sets it
// for every account at login; installed by an administrator next to the profile, it closes the Option key,
// leaving Troubleshoot Mode to the Terminal (open -a Firefox --args --safe-mode), which Screen Time can keep
// out like any app. An account can switch the agent off under Login Items, so it is a hurdle, not a lock.
//
// It has to work next to other programs that set Firefox policies, such as other blockers. Firefox takes
// each policy, by name, from one place only: when a profile and another program both set one, the profile's
// wins and the other program's is dropped whole. Other blockers lock their own add-ons with ExtensionSettings
// (Plucky does), so this lock doesn't use it: it uses the older Extensions policy. Its other policies are the
// ones such programs set the same way (Plucky sets all five alike), plus WebsiteFilter, which Plucky's
// settings as the tests model them don't include. Preferences and WebsiteFilter are the ones that could
// differ: if another program sets either of them, the profile's replaces theirs.
//
// `npm run firefox-lock` writes them as mac/family-site-blocker-firefox.mobileconfig, a configuration
// profile: installed once with an administrator's password, it applies to every account on the Mac, and only
// an administrator can remove it. Firefox installs the add-on from XPI_URL, the newest signed version on the
// update site (scripts/updates-site.mjs), once in each Firefox profile for each value of that address (and
// tries again at the next start if it couldn't fetch it). So installing a profile whose address differs from
// the last one's makes Firefox install the newest version in every account at its next start, permissions
// included, with nobody at the screen. From version 1.3.2 the add-on then updates itself
// (scripts/updates-manifest.mjs), and the lock keeps automatic add-on updates switched on (ExtensionUpdate).
// The lock still lets anyone install a newer signed version over it by hand.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDomainList } from '../extension/lib/domains.js';
import { BLOCKLIST_DIR, listFiles, loadNever } from './build-rules.mjs';
import { LATEST_URL } from './updates-site.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ADDON_ID = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
export const PROFILE_PATH = join(ROOT, 'mac', 'family-site-blocker-firefox.mobileconfig');
// The newest signed version, on the public update site; the Mac has to be online when Firefox first starts.
export const XPI_URL = LATEST_URL;

// Firefox's own filter reads at most this many entries and ignores the rest without saying so.
export const FILTER_LIMIT = 1000;
// Top-level domains taken whole, one entry each: the adult-only ones (ICM Registry's) and .sexy.
export const WHOLE_DOMAINS = ['xxx', 'porn', 'sex', 'adult', 'sexy'];
const FIRST = ['starter.txt', 'popular.txt']; // the lists that fill the filter first, in this order

/** A site and all its subdomains, over http and https on any port, as Firefox's filter writes it (a match pattern). */
export const filterPattern = (domain) => `*://*.${domain}/*`;

/** Whether a site is on one of the top-level domains the filter takes whole. */
export const onWholeDomain = (domain) => WHOLE_DOMAINS.includes(domain.slice(domain.lastIndexOf('.') + 1));

/**
 * The built-in sites for Firefox's own filter: every domain in blocklists/*.txt but never.txt's, starter.txt
 * first (the test case and the largest sites), then popular.txt (the most visited, in order), then the other
 * lists in name order, leaving out the sites on the top-level domains taken whole, up to the room Firefox's
 * limit leaves after those domains. Returns the sites it takes, the ones left over, and how many the whole
 * domains cover.
 */
export function filterSites(dir = BLOCKLIST_DIR) {
  const files = listFiles(dir);
  const ordered = [...FIRST.filter((name) => files.includes(name)), ...files.filter((name) => !FIRST.includes(name))];
  const never = loadNever(dir);
  const domains = new Set();
  const covered = new Set();
  for (const file of ordered) {
    for (const domain of parseDomainList(readFileSync(join(dir, file), 'utf8')).domains) {
      if (never.has(domain)) continue;
      (onWholeDomain(domain) ? covered : domains).add(domain);
    }
  }
  const all = [...domains];
  const room = FILTER_LIMIT - WHOLE_DOMAINS.length;
  return { sites: all.slice(0, room), leftOut: all.slice(room), covered: covered.size };
}

/** The filter's entries: the whole top-level domains, then the sites, as match patterns. */
export const filterEntries = (dir = BLOCKLIST_DIR) => [...WHOLE_DOMAINS.map((tld) => filterPattern(tld)), ...filterSites(dir).sites.map(filterPattern)];

/**
 * The policies, in the form Firefox reads them (policies.json, or the org.mozilla.firefox settings on a Mac).
 * `xpiSource` is the address or file path Firefox installs the add-on from.
 */
export function firefoxPolicies(xpiSource = XPI_URL, entries = filterEntries()) {
  return {
    Extensions: { Install: [xpiSource], Locked: [ADDON_ID] },
    ExtensionUpdate: true,
    DisablePrivateBrowsing: true,
    DisableSafeMode: true,
    BlockAboutConfig: true,
    DisableProfileRefresh: true,
    Preferences: {
      'extensions.dnr.enabled': { Value: true, Status: 'locked' },
    },
    WebsiteFilter: { Block: entries },
  };
}

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plistValue(value, depth) {
  const pad = '\t'.repeat(depth);
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (Number.isInteger(value)) return `${pad}<integer>${value}</integer>`;
  if (typeof value === 'string') return `${pad}<string>${escape(value)}</string>`;
  if (Array.isArray(value)) return [`${pad}<array>`, ...value.map((item) => plistValue(item, depth + 1)), `${pad}</array>`].join('\n');
  const entries = Object.entries(value).flatMap(([key, item]) => [`${pad}\t<key>${escape(key)}</key>`, plistValue(item, depth + 1)]);
  return [`${pad}<dict>`, ...entries, `${pad}</dict>`].join('\n');
}

/** An Apple property list (XML), as configuration profiles and `defaults import` use. */
export function plist(value) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(value, 0),
    '</plist>',
    '',
  ].join('\n');
}

/** The settings Firefox reads on a Mac: the policies, and the switch that makes it read them. */
export const macSettings = (policies = firefoxPolicies()) => ({ EnterprisePoliciesEnabled: true, ...policies });

/** The configuration profile that puts macSettings() in force for every account on the Mac. */
export function mobileconfig(settings = macSettings()) {
  return plist({
    PayloadContent: [
      {
        PayloadContent: { 'org.mozilla.firefox': { Forced: [{ mcx_preference_settings: settings }] } },
        PayloadDisplayName: 'Firefox settings',
        PayloadIdentifier: 'local.parental-controls.family-site-blocker.firefox.settings',
        PayloadType: 'com.apple.ManagedClient.preferences',
        PayloadUUID: '27DF5EE7-2FC4-49DA-8FBF-D509708E1522',
        PayloadVersion: 1,
      },
    ],
    PayloadDescription:
      'Keeps the Family Site Blocker add-on installed and switched on in Firefox, for every account on this Mac. ' +
      `Firefox installs the newest signed version from ${XPI_URL}, keeps it up to date, and nobody can turn it off or remove it there. ` +
      'Firefox also gets its own copy of the add-on\u2019s built-in list of sites (whole adult domains such as .porn and .xxx, and the sites people visit most), which keeps blocking them when add-ons don\u2019t run, as in Troubleshoot Mode. ' +
      'Private windows, Troubleshoot Mode from Firefox\u2019s menus, about:config and Refresh Firefox, which could get round it, are turned off. ' +
      'Settings that other programs, such as another blocker, give Firefox for their own add-ons stay in force. ' +
      'Only an administrator can remove this profile.',
    PayloadDisplayName: 'Family Site Blocker for Firefox',
    PayloadIdentifier: 'local.parental-controls.family-site-blocker.firefox',
    PayloadOrganization: 'Family Site Blocker',
    PayloadScope: 'System',
    PayloadType: 'Configuration',
    PayloadUUID: 'C3B0C6B7-3BE0-4536-A299-E2F9BF95B6E2',
    PayloadVersion: 1,
  });
}

// --- The launch agent that closes the Option key ---------------------------------------------------------
export const AGENT_LABEL = 'local.parental-controls.family-site-blocker.firefox-troubleshoot-key';
export const AGENT_PATH = join(ROOT, 'mac', `${AGENT_LABEL}.plist`);
export const SAFE_MODE_KEY_VARIABLE = 'MOZ_DISABLE_SAFE_MODE_KEY';

/**
 * A launch agent for /Library/LaunchAgents: at each account's login, it sets the variable that makes
 * Firefox ignore the Option key, in the environment that apps opened from the Dock, Finder and Spotlight get.
 */
export function launchAgent() {
  return plist({
    Label: AGENT_LABEL,
    ProgramArguments: ['/bin/launchctl', 'setenv', SAFE_MODE_KEY_VARIABLE, '1'],
    RunAtLoad: true,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { sites, leftOut, covered } = filterSites();
  mkdirSync(dirname(PROFILE_PATH), { recursive: true });
  writeFileSync(PROFILE_PATH, mobileconfig());
  writeFileSync(AGENT_PATH, launchAgent());
  console.log(
    `Wrote ${relative(process.cwd(), PROFILE_PATH)}, with ${WHOLE_DOMAINS.length} whole domains (${WHOLE_DOMAINS.map((tld) => `.${tld}`).join(', ')}, ` +
      `covering ${covered} built-in sites) and ${sites.length} built-in sites in Firefox's own filter, and ${relative(process.cwd(), AGENT_PATH)}`,
  );
  if (leftOut.length > 0) {
    console.log(
      `Firefox's own filter takes at most ${FILTER_LIMIT} entries, so ${leftOut.length} sites were left out of it, ` +
        `for example ${leftOut.slice(0, 3).join(', ')}. The add-on still blocks them while it runs, but not in Troubleshoot Mode.`,
    );
  }
}
