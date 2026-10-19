// Safe search: the rules that keep the big search engines' adult filters on, and YouTube in Restricted
// Mode, whatever the settings on the site say. A site blocker can't filter search results, and Google
// Images, Bing and the rest show explicit results with their filter off; each of them, though, reads a
// strict-filter setting from the address itself. So a search page's address gets that setting added
// (a redirect to the same address plus one parameter, done by the browser before the request goes out),
// and every request to YouTube carries the YouTube-Restrict header that network administrators use.
//
// npm run build writes these rules to rules/safe-search.json, a ruleset of its own in manifest.json next
// to the adult-N.json files, so the list can be rebuilt without touching them.

/**
 * Each engine: the pattern that picks out its search pages (a regular expression matched against the
 * whole address; RE2 syntax, for Chrome) and the parameter that turns its strict filter on. Anything the
 * pattern doesn't match (the engine's home page, mail, maps) is left alone.
 */
export const ENGINES = [
  {
    name: 'Google',
    example: 'https://www.google.com/search?q=test',
    pattern: '^https?://(?:www\\.)?google\\.[a-z]{2,3}(?:\\.[a-z]{2})?/(?:search|webhp|imgres)\\?',
    key: 'safe',
    value: 'active',
  },
  {
    name: 'Bing',
    example: 'https://www.bing.com/search?q=test',
    pattern: '^https?://(?:www\\.|cn\\.)?bing\\.com/(?:search|images/search|images/async|videos/search|videos/asyncv2|news/search)\\?',
    key: 'adlt',
    value: 'strict',
  },
  {
    name: 'DuckDuckGo',
    example: 'https://duckduckgo.com/?q=test',
    pattern: '^https?://(?:(?:html|lite|start|safe)\\.)?duckduckgo\\.com/(?:html/?|lite/?)?\\?',
    key: 'kp',
    value: '1',
  },
  {
    name: 'Yahoo',
    example: 'https://search.yahoo.com/search?p=test',
    pattern: '^https?://(?:[a-z0-9-]+\\.)*search\\.yahoo\\.com/(?:yhs/)?search',
    key: 'vm',
    value: 'r',
  },
  {
    name: 'Brave Search',
    example: 'https://search.brave.com/search?q=test',
    pattern: '^https?://search\\.brave\\.com/(?:search|images|videos|news)\\?',
    key: 'safesearch',
    value: 'strict',
  },
];

/** The header YouTube reads, and the hosts it must go to (the site and the services its pages call). */
export const YOUTUBE = {
  header: 'YouTube-Restrict',
  value: 'Strict',
  domains: ['youtube.com', 'youtube-nocookie.com', 'youtubei.googleapis.com', 'youtube.googleapis.com'],
};

export const FIRST_ID = 1001; // the adult rulesets count up from 1; these stay out of their way
// Every kind of request both Chrome and Firefox know, so the header goes on page loads and the calls a
// page makes alike. (Left out, a rule would skip page loads.)
const EVERY_TYPE = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];

/** The whole ruleset, in the browsers' declarativeNetRequest form. */
export function safeSearchRules() {
  const rules = [];
  let id = FIRST_ID;
  for (const { pattern, key, value } of ENGINES) {
    // A search address already carrying the setting is let through as it is: the higher priority of this
    // rule stops the redirect below from firing again on the address it produced.
    rules.push({
      id: id++,
      priority: 2,
      action: { type: 'allow' },
      condition: { regexFilter: `${pattern}.*[?&]${key}=${value}(?:&|#|$)`, resourceTypes: ['main_frame', 'sub_frame'] },
    });
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'redirect', redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key, value }] } } } },
      condition: { regexFilter: pattern, resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }
  rules.push({
    id: id++,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: YOUTUBE.header, operation: 'set', value: YOUTUBE.value }] },
    condition: { requestDomains: YOUTUBE.domains, resourceTypes: EVERY_TYPE },
  });
  return rules;
}

/**
 * What the rules would do to an address: the address with the filter setting added, or the same address
 * when it already has it or isn't a search page. A stand-in for the browser, for the tests and the
 * settings page's own check.
 */
export function safeSearchAddress(url) {
  for (const { pattern, key, value } of ENGINES) {
    if (!new RegExp(pattern).test(url)) continue;
    const address = new URL(url);
    address.searchParams.set(key, value);
    return address.href;
  }
  return url;
}
