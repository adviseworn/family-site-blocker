// Where the update files live: the public GitHub Pages site made from the repository UPDATES_REPO (see
// scripts/updates-manifest.mjs, which builds them, and .github/workflows/publish-updates.yml, which
// publishes them). Firefox fetches these without signing in, which is why they are public; only the update
// manifest and the signed .xpi files are there, the source stays in this repository.
export const UPDATES_REPO = 'adviseworn/family-site-blocker-updates';
export const SITE_URL = 'https://adviseworn.github.io/family-site-blocker-updates/';

/** The update manifest that versions 1.3.2 to 1.23.0 name as their update_url (from 1.24.0 the add-on is listed on addons.mozilla.org and updates from there). */
export const UPDATES_URL = `${SITE_URL}updates.json`;

/** Always the newest signed version, under one name: what the Firefox lock installs from. */
export const LATEST_NAME = 'family-site-blocker.xpi';
export const LATEST_URL = `${SITE_URL}${LATEST_NAME}`;
