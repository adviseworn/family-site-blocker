// Where the project and its public files live. The code is in the GitHub repository REPOSITORY: the pull
// requests, the workflows and the releases are there. Its public face is a site of its own, the GitHub Pages
// site of a second repository (SITE_REPOSITORY, SITE_URL), which anyone can fetch without signing in, as
// Firefox must, whether or not the code's repository is public:
// - the guide: README.md rendered as the site's front page (scripts/guide.mjs), which the settings pages
//   link into by heading (GUIDE_URL);
// - the update files: the update manifest that versions 1.3.2 to 1.23.0 name as their update_url (from
//   1.24.0 the add-on is listed on addons.mozilla.org and updates from there), the newest signed .xpi files,
//   and the newest once more under one name, which the Firefox lock installs from (scripts/updates-manifest.mjs);
// - the Firefox lock's profile (PROFILE_URL), the same file as mac/'s.
// The site job of .github/workflows/pipeline.yml builds them after each release (scripts/release-files.mjs
// fetches the signed files from the repository's releases, where the sign job puts each version's files) and
// pushes them to the gh-pages branch of SITE_REPOSITORY. The site was at this address until 1.23.0 too, so
// the copies from 1.3.2 to 1.23.0 and the locks of that time find it where they always looked. From 1.25.0
// to 1.29.0 the project was on GitLab, and those versions' settings pages and locks name the site it had
// there (https://adviseworn.gitlab.io/family-site-blocker/), which is no longer brought up to date.
export const REPOSITORY = 'adviseworn/family-site-blocker';
export const SITE_REPOSITORY = 'adviseworn/family-site-blocker-updates';
export const SITE_BRANCH = 'gh-pages';
export const PACKAGE_NAME = 'family-site-blocker';
export const SITE_URL = 'https://adviseworn.github.io/family-site-blocker-updates/';

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
export const ICON_NAME = 'icon.png'; // the add-on's icon, for the guide's heading and the browser tab
export const ICON_URL = `${SITE_URL}${ICON_NAME}`;
