// Builds the declarativeNetRequest rules for a list of domains. The built-in ruleset (at build
// time) and the user's own list (at runtime) both come from here, so they behave identically.

export const BLOCK_PAGE = '/blocked.html';
export const CHUNK_SIZE = 500;

/**
 * Two rules per chunk of domains:
 *  - loading the site as a page (main_frame) is redirected to the "Site blocked" page;
 *  - everything else (iframes, scripts, images, fetches, ...) is blocked outright.
 * requestDomains matches the listed domain and all of its subdomains, on any scheme and port.
 *
 * Each domain is listed twice, with and without a trailing dot. "exampleadultsite.com." is the same
 * site, and Chrome already treats it that way, but Firefox matches it only if it is listed.
 */
export function buildRules(domains, firstId = 1) {
  const rules = [];
  let id = firstId;
  for (let i = 0; i < domains.length; i += CHUNK_SIZE) {
    const requestDomains = domains.slice(i, i + CHUNK_SIZE).flatMap((domain) => [domain, `${domain}.`]);
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'redirect', redirect: { extensionPath: BLOCK_PAGE } },
      condition: { requestDomains, resourceTypes: ['main_frame'] },
    });
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'block' },
      condition: { requestDomains, excludedResourceTypes: ['main_frame'] },
    });
  }
  return rules;
}

/**
 * The domains a set of rules blocks, each once. Every domain lives on the redirect rules (the block rules
 * repeat the same list), and each is listed twice, with and without a trailing dot.
 */
export function domainsOf(rules) {
  return rules
    .filter((rule) => rule.action.type === 'redirect')
    .flatMap((rule) => rule.condition.requestDomains)
    .filter((domain) => !domain.endsWith('.'));
}
