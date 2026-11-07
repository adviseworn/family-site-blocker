#!/usr/bin/env node
// The add-on's page on addons.mozilla.org, in words, which Sign with Mozilla sends with each version (web-ext
// sign --amo-metadata): the public summary, description, category and links, the version's license and
// release notes, and the notes only Mozilla's reviewers see. From 1.24.0 the add-on is listed there, so
// Firefox on a computer or an Android phone installs it from PAGE_URL with one click and keeps it up to date
// from there. The name and icon come from the manifest; the author shown is the Mozilla account's display
// name, set on the account, not here. Nothing here names anyone. The page's homepage is the project's public
// site, the guide (scripts/updates-site.mjs); the project itself is private, so it isn't linked.
//
// usage: node scripts/amo-metadata.mjs <version> <commit> [the commit's title]   prints the JSON
import { pathToFileURL } from 'node:url';
import { GUIDE_URL } from './updates-site.mjs';

export const SLUG = 'family-site-blocker';
export const PAGE_URL = `https://addons.mozilla.org/firefox/addon/${SLUG}/`;
export const HOME_URL = GUIDE_URL;

/** One of Mozilla's own license choices, which the page shows; the code has no open license of its own. */
export const LICENSE = 'all-rights-reserved';

/** The page, apart from the name and the icon. Mozilla keeps summaries to 250 characters. */
export const LISTING = {
  slug: SLUG,
  summary: {
    'en-US':
      'Blocks adult websites for a family: a built-in list of sixty thousand sites and your own, safe search turned on, pictures judged before they show, and a record of every try, kept on the device. For Firefox on a computer or an Android phone.',
  },
  description: {
    'en-US': [
      'Family Site Blocker blocks adult websites in the browser it is installed in, for a family. It starts with a built-in list of about sixty thousand sites, lets you add your own on its settings page, turns safe search on at the main search engines and YouTube, and judges every picture and video a page shows before it appears, keeping the ones that show nudity hidden.',
      'It keeps a record on the computer or phone, and nowhere else: every try at a listed site, with the time and whether it was blocked, the pictures it hid, and the times it was off. The settings page shows whether it is working, with a test site.',
      'For a parent there is a locked-away password page: a password you can only get back after a wait you choose. On a Mac, a configuration profile can lock the add-on so that nobody can switch it off; on a phone there is no lock, so anyone who can open Firefox’s settings can remove it.',
      `The full guide, with how it works and what it can't do: ${HOME_URL}`,
    ].join('\n\n'),
  },
  categories: ['privacy-security'],
  homepage: { 'en-US': HOME_URL },
  is_experimental: false,
  requires_payment: false,
};

/**
 * The release notes shown on the version: the sentence the version's commit on main carries as its title
 * (a merge request's title, less the version and the request's number), or just the version.
 */
export function releaseNotes(title = '', version) {
  const sentence = title
    .replace(/\s*\([#!]\d+\)\s*$/, '')
    .replace(/\s*\(\d+(?:\.\d+)+\)\s*$/, '')
    .trim();
  if (!sentence || /^(merge|revert)\b/i.test(sentence)) return `Version ${version}.`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** What Mozilla's reviewers are told: where the code comes from, how the upload is made, and which files aren't ours. */
export function approvalNotes({ version, commit }) {
  return [
    'Family Site Blocker is a parental-control add-on for a family’s own devices. Its own code is plain JavaScript, not minified, bundled or compiled. The files that aren’t its own, unchanged from their packages:',
    '- extension/vendor/tf.fesm.min.js: dist/tf.fesm.min.js of @tensorflow/tfjs 4.22.0 on npm.',
    '- extension/vendor/tf-backend-wasm.min.js: dist/tf-backend-wasm.es2017.min.js of @tensorflow/tfjs-backend-wasm 4.22.0 on npm, under a shorter name; extension/vendor/tfjs-backend-wasm.wasm and tfjs-backend-wasm-simd.wasm: dist/tfjs-backend-wasm.wasm and dist/tfjs-backend-wasm-simd.wasm of the same package.',
    '- extension/models/: the MobileNetV2 and InceptionV3 model weights of NSFWJS 4.4.0 (data, not code; extension/vendor/LICENSES.md has the details).',
    'extension/rules/*.json are data too: declarativeNetRequest rules built from the plain lists in blocklists/ by scripts/build-rules.mjs.',
    `The project's repository on GitLab is private; its guide is public at ${HOME_URL}. This upload was made from the repository at commit ${commit} (tagged v${version} once this version is published) by \`npm run package:firefox\` (scripts/package-firefox.mjs copies the extension folder and drops background.service_worker, which only Chromium reads, from manifest.json).`,
    'The add-on sends nothing anywhere: the record it keeps stays in the browser’s storage for the extension (data_collection_permissions: none). The content script on every page keeps pictures hidden until the background script has judged them with the models, on the device; the wasm-unsafe-eval entry in the CSP is for TensorFlow.js’s WebAssembly backend.',
  ].join('\n');
}

/** Everything web-ext sends: the page, and the version's license, release notes and reviewer notes. */
export function metadata({ version, commit, title }) {
  return {
    ...LISTING,
    version: {
      license: LICENSE,
      release_notes: { 'en-US': releaseNotes(title, version) },
      approval_notes: approvalNotes({ version, commit }),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, commit, title] = process.argv.slice(2);
  if (!version || !commit) {
    console.error('Usage: node scripts/amo-metadata.mjs <version> <commit> [the commit’s title]');
    process.exit(1);
  }
  console.log(JSON.stringify(metadata({ version, commit, title }), null, 2));
}
