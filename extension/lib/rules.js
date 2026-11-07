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

/**
 * Rules that block a listed page outright, for a browser that hasn't given the extension access to
 * websites, as Firefox for Android can leave it. Blocking a request needs no such access, where sending
 * the page to the block page does (a redirect), and Firefox picks the one rule that fits a request and only
 * then asks whether the extension may act on it: a redirect it may not act on is dropped, no other rule
 * is tried, and the page loads. At priority 2 these come before the redirect rules, which have priority 1,
 * so the request is stopped, and the background script sends the tab to the block page itself. It keeps
 * them as session rules while access is missing, built from the whole list, the person's sites included;
 * their ids start beyond every id the static and the dynamic rules use.
 */
export const PAGE_BLOCK_FIRST_ID = 1_000_001;
export const PAGE_BLOCK_PRIORITY = 2;

export function pageBlockRules(domains, firstId = PAGE_BLOCK_FIRST_ID) {
  const rules = [];
  for (let i = 0; i < domains.length; i += CHUNK_SIZE) {
    rules.push({
      id: firstId + rules.length,
      priority: PAGE_BLOCK_PRIORITY,
      action: { type: 'block' },
      condition: { requestDomains: domains.slice(i, i + CHUNK_SIZE).flatMap((domain) => [domain, `${domain}.`]), resourceTypes: ['main_frame'] },
    });
  }
  return rules;
}
