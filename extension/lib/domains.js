// Domain parsing shared by the settings page (in the browser) and the build script (in Node).

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const TLD = '(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})';
const DOMAIN = new RegExp(`^(?:${LABEL}\\.)+${TLD}$`);

// First column of a hosts-file line: "0.0.0.0", "127.0.0.1", "::1", ...
const HOSTS_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:]*)$/i;

/**
 * Reduces whatever was typed or pasted ("https://www.Example.com/a?b", "*.example.com",
 * "example.com:8080") to a bare, lowercase, ASCII domain. Returns null if it isn't a domain.
 *
 * A leading "www." is dropped. requestDomains matching already covers every subdomain, so
 * the bare domain blocks the whole site rather than just the www. host.
 * Single names such as "com" or "localhost" and IP addresses are rejected on purpose:
 * blocking a whole top-level domain by accident would break the web.
 */
export function normalizeDomain(input) {
  let s = String(input ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split(/[/?#]/, 1)[0]; // path, query, fragment
  s = s.replace(/^.*@/, ''); // user:password@
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/^(?:\*\.|\.)+/, '').replace(/\.+$/, ''); // "*." and stray dots
  s = s.replace(/^www\./, '');
  if (!s || /\s/.test(s)) return null;

  let host;
  try {
    host = new URL(`http://${s}`).hostname; // turns internationalized names into punycode
  } catch {
    return null;
  }
  return host.length <= 253 && DOMAIN.test(host) ? host : null;
}

/**
 * Reads a list with one entry per line. Understands "#" comments and hosts-file lines
 * ("0.0.0.0 example.com"). Returns the unique valid domains and the entries it skipped.
 */
export function parseDomainList(text) {
  const domains = new Set();
  const invalid = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    const entries = tokens.length > 1 && HOSTS_ADDRESS.test(tokens[0]) ? tokens.slice(1) : [line];
    for (const entry of entries) {
      const domain = normalizeDomain(entry);
      if (domain) domains.add(domain);
      else invalid.push(entry);
    }
  }
  return { domains: [...domains], invalid };
}
