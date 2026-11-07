// Where the project and its public files live. The code is a private project on GitLab (PROJECT_URL): its
// members see the repository, the merge requests, the pipelines and the releases. Its public face is the
// project's GitLab Pages site (SITE_URL), which anyone can fetch without signing in, as Firefox must:
// - the guide: README.md rendered as the site's front page (scripts/guide.mjs), which the settings pages
//   link into by heading (GUIDE_URL);
// - the update files: the update manifest that versions 1.3.2 to 1.23.0 name as their update_url (from
//   1.24.0 the add-on is listed on addons.mozilla.org and updates from there), the newest signed .xpi files,
//   and the newest once more under one name, which the Firefox lock installs from (scripts/updates-manifest.mjs);
// - the Firefox lock's profile (PROFILE_URL), the same file as mac/'s.
// The update-files job of .gitlab-ci.yml builds them after each release (scripts/release-files.mjs fetches
// the signed files from the project's package registry, where the sign job puts each release's files under
// PACKAGE_NAME/<version>). Until 1.24.0 the update files were on GitHub Pages, at an address that went down
// with the GitHub account on Nov 7, 2026.
export const PROJECT_PATH = 'adviseworn/family-site-blocker';
export const PROJECT_URL = `https://gitlab.com/${PROJECT_PATH}`;
export const PACKAGE_NAME = 'family-site-blocker';
export const SITE_URL = 'https://adviseworn.gitlab.io/family-site-blocker/';

/** The guide, README.md rendered, is the site's front page; a heading's anchor goes after a #. */
export const GUIDE_URL = SITE_URL;

/** The update manifest that versions 1.3.2 to 1.23.0 name as their update_url. */
export const UPDATES_URL = `${SITE_URL}updates.json`;

/** Always the newest signed version, under one name: what the Firefox lock installs from. */
export const LATEST_NAME = 'family-site-blocker.xpi';
export const LATEST_URL = `${SITE_URL}${LATEST_NAME}`;

/** The Firefox lock's profile, as mac/ holds it and the release and the site carry it. */
export const PROFILE_NAME = 'family-site-blocker-firefox.mobileconfig';
export const PROFILE_URL = `${SITE_URL}${PROFILE_NAME}`;
