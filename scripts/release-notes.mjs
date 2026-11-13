#!/usr/bin/env node
// What the page of a version's release on GitHub says (Releases): how to install the version, and what each
// of the release's files is: the signed .xpi, the zip that gives it the add-on's icon on a Mac, and the
// Firefox lock's profile. The sign job of .github/workflows/pipeline.yml writes this to a file and makes the
// release with it, tagged v<version> on the commit.
// usage: node scripts/release-notes.mjs <version>   prints the notes, as Markdown
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

/** What the page of a release says when the Mozilla backup made it, for a version signed before and never released here. */
export function backupNotes(version) {
  return [
    `Version ${version}, signed by Mozilla for Firefox: \`family-site-blocker-${version}.xpi\`, as Mozilla keeps it.`,
    `This release was made afterwards, to keep the project's own copy of the signed file; it holds no other file. The newest version is at ${PAGE_URL}.`,
  ].join('\n\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version] = process.argv.slice(2);
  if (!/^\d+(\.\d+)*$/.test(version ?? '')) {
    console.error('Usage: node scripts/release-notes.mjs <version>');
    process.exit(1);
  }
  console.log(notes(version));
}
