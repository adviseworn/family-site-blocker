// Where the update files live: the public GitHub Pages site made from the repository UPDATES_REPO (see
// scripts/updates-manifest.mjs, which builds them, and .github/workflows/publish-updates.yml, which
// publishes them). Firefox fetches these without signing in, which is why they are public; only the update
// manifest and the signed .xpi files are there, the source stays in this private repository.
export const UPDATES_REPO = 'adviseworn/family-site-blocker-updates';
export const SITE_URL = 'https://adviseworn.github.io/family-site-blocker-updates/';

/** The update manifest the add-on's update_url names (manifest.json: browser_specific_settings.gecko). */
export const UPDATES_URL = `${SITE_URL}updates.json`;

/** Always the newest signed version, under one name: what the Firefox lock installs from. */
export const LATEST_NAME = 'family-site-blocker.xpi';
export const LATEST_URL = `${SITE_URL}${LATEST_NAME}`;
