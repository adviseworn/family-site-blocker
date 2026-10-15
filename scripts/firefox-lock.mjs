#!/usr/bin/env node
// The Firefox lock: enterprise policies that make Firefox install Family Site Blocker itself and keep it
// switched on. With them in force, the Add-ons Manager can't turn the add-on off, remove it or take away
// its website access, and the other ways round it are closed: private windows (where add-ons don't run
// unless someone allows it in the Add-ons Manager), Troubleshoot Mode from Firefox's menus (starts Firefox
// with add-ons off; on a Mac, holding Option at start or --safe-mode still gets there, and Firefox only
// blocks that on Windows), about:config (extensions.dnr.enabled switches off every add-on's blocking rules) and Refresh Firefox
// (would wipe the sites added on the settings page).
//
// It has to work next to other programs that set Firefox policies, such as other blockers. Firefox takes
// each policy, by name, from one place only: when a profile and another program both set one, the profile's
// wins and the other program's is dropped whole. Other blockers lock their own add-ons with ExtensionSettings
// (Plucky does), so this lock doesn't use it: it uses the older Extensions policy. Its other policies are the
// ones such programs set the same way (Plucky sets all five alike). Preferences is the one that could
// differ: if another program locks other preferences with it, the profile's Preferences replaces theirs.
//
// `npm run firefox-lock` writes them as mac/family-site-blocker-firefox.mobileconfig, a configuration
// profile: installed once with an administrator's password, it applies to every account on the Mac, and only
// an administrator can remove it. Firefox installs the add-on from XPI_PATH once in each Firefox profile (and
// tries again at the next start if the file isn't there yet). It doesn't take a newer version from there by
// itself; the lock still lets anyone install a newer signed version over it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ADDON_ID = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
export const PROFILE_PATH = join(ROOT, 'mac', 'family-site-blocker-firefox.mobileconfig');
// Readable by every account. A folder made there by one account can't be changed by the others.
export const XPI_PATH = '/Users/Shared/Family Site Blocker/family-site-blocker.xpi';

/** The policies, in the form Firefox reads them (policies.json, or the org.mozilla.firefox settings on a Mac). */
export function firefoxPolicies(xpiPath = XPI_PATH) {
  return {
    Extensions: { Install: [xpiPath], Locked: [ADDON_ID] },
    DisablePrivateBrowsing: true,
    DisableSafeMode: true,
    BlockAboutConfig: true,
    DisableProfileRefresh: true,
    Preferences: {
      'extensions.dnr.enabled': { Value: true, Status: 'locked' },
    },
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
  mkdirSync(dirname(PROFILE_PATH), { recursive: true });
  writeFileSync(PROFILE_PATH, mobileconfig());
  console.log(`Wrote ${relative(process.cwd(), PROFILE_PATH)}`);
}
