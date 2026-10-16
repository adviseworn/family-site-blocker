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
// and `npm run build` writes both. Firefox's filter takes at most 1,000 sites and stops pages and frames but
// not images or scripts, so it backs the add-on up rather than replacing it.
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
// an administrator can remove it. Firefox installs the add-on from XPI_PATH once in each Firefox profile (and
// tries again at the next start if the file isn't there yet). It doesn't take a newer version from there by
// itself; the lock still lets anyone install a newer signed version over it.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDomainList } from '../extension/lib/domains.js';
import { BLOCKLIST_DIR } from './build-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ADDON_ID = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
export const PROFILE_PATH = join(ROOT, 'mac', 'family-site-blocker-firefox.mobileconfig');
// Readable by every account. A folder made there by one account can't be changed by the others.
export const XPI_PATH = '/Users/Shared/Family Site Blocker/family-site-blocker.xpi';

// Firefox's own filter reads at most this many sites and ignores the rest without saying so.
export const FILTER_LIMIT = 1000;
const STARTER = 'starter.txt';

/**
 * The built-in sites for Firefox's own filter: every domain in blocklists/*.txt, starter.txt first (it has the
 * test case and the largest sites), then the other lists in name order, up to Firefox's limit. Returns the
 * sites it takes and the ones left over.
 */
export function filterSites(dir = BLOCKLIST_DIR) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.txt')).sort();
  const ordered = [...files.filter((name) => name === STARTER), ...files.filter((name) => name !== STARTER)];
  const domains = new Set();
  for (const file of ordered) {
    for (const domain of parseDomainList(readFileSync(join(dir, file), 'utf8')).domains) domains.add(domain);
  }
  const all = [...domains];
  return { sites: all.slice(0, FILTER_LIMIT), leftOut: all.slice(FILTER_LIMIT) };
}

/** A site and all its subdomains, on any scheme and port, as Firefox's filter writes it (a match pattern). */
export const filterPattern = (domain) => `*://*.${domain}/*`;

/** The policies, in the form Firefox reads them (policies.json, or the org.mozilla.firefox settings on a Mac). */
export function firefoxPolicies(xpiPath = XPI_PATH, sites = filterSites().sites) {
  return {
    Extensions: { Install: [xpiPath], Locked: [ADDON_ID] },
    DisablePrivateBrowsing: true,
    DisableSafeMode: true,
    BlockAboutConfig: true,
    DisableProfileRefresh: true,
    Preferences: {
      'extensions.dnr.enabled': { Value: true, Status: 'locked' },
    },
    WebsiteFilter: { Block: sites.map(filterPattern) },
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
      `Firefox installs it from ${XPI_PATH}, and nobody can turn it off or remove it there. ` +
      'Firefox also gets its own copy of the add-on\u2019s built-in list of sites, which keeps blocking them when add-ons don\u2019t run, as in Troubleshoot Mode. ' +
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { sites, leftOut } = filterSites();
  mkdirSync(dirname(PROFILE_PATH), { recursive: true });
  writeFileSync(PROFILE_PATH, mobileconfig());
  console.log(`Wrote ${relative(process.cwd(), PROFILE_PATH)}, with ${sites.length} built-in sites in Firefox's own filter`);
  if (leftOut.length > 0) {
    console.log(
      `Firefox's own filter takes at most ${FILTER_LIMIT} sites, so ${leftOut.length} were left out of it, ` +
        `for example ${leftOut.slice(0, 3).join(', ')}. The add-on still blocks them while it runs, but not in Troubleshoot Mode.`,
    );
  }
}
