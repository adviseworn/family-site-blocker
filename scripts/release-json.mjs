#!/usr/bin/env node
// The release of one version on GitLab (Deploy → Releases), as the Releases API takes it: the tag v<version>
// made on the commit, the release's name, the notes shown on its page, and the links to the files the sign
// job put in the package registry: the signed .xpi, the zip that gives it the add-on's icon on a Mac, and the
// Firefox lock's profile. The sign job of .gitlab-ci.yml prints this and posts it.
// usage: node scripts/release-json.mjs <version> <commit> <the package registry folder's URL>   prints the JSON
import { pathToFileURL } from 'node:url';
import { PAGE_URL } from './amo-metadata.mjs';
import { PROFILE_NAME, PROFILE_URL } from './updates-site.mjs';

export { PROFILE_NAME };

/** What the release page says. */
export function notes(version) {
  return [
    `Version ${version}, signed by Mozilla for Firefox.`,
    `**In Firefox, on a computer or an Android phone:** open ${PAGE_URL} and click **Add to Firefox**. Firefox keeps it up to date from there.`,
    'From a file instead:',
    [
      `- **On a Mac:** download \`family-site-blocker-${version}.zip\` and double-click it. You get \`family-site-blocker-${version}.xpi\` with the add-on's icon.`,
      `- **Elsewhere:** download \`family-site-blocker-${version}.xpi\`.`,
    ].join('\n'),
    'Then in Firefox, open `about:addons`, click the gear (⚙), choose **Install Add-on From File…** and pick the `.xpi`.',
    `- **The Firefox lock for a Mac:** \`${PROFILE_NAME}\` (also at ${PROFILE_URL}), Firefox's settings with its own copy of the built-in list (README: "Lock it, so nobody can switch it off"). Install it again when it changes.`,
  ].join('\n\n');
}

/** The release, for POST /projects/:id/releases. */
export function release({ version, commit, packageUrl }) {
  const url = packageUrl.replace(/\/$/, '');
  const link = (name, type) => ({ name, url: `${url}/${name}`, link_type: type });
  return {
    tag_name: `v${version}`,
    ref: commit,
    name: `Family Site Blocker ${version}`,
    description: notes(version),
    assets: {
      links: [link(`family-site-blocker-${version}.xpi`, 'package'), link(`family-site-blocker-${version}.zip`, 'package'), link(PROFILE_NAME, 'other')],
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, commit, packageUrl] = process.argv.slice(2);
  if (!version || !commit || !packageUrl) {
    console.error('Usage: node scripts/release-json.mjs <version> <commit> <package registry folder URL>');
    process.exit(1);
  }
  console.log(JSON.stringify(release({ version, commit, packageUrl }), null, 2));
}
