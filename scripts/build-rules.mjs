#!/usr/bin/env node
// Builds the blocking rules from every .txt file in blocklists/: extension/rules/adult-1.json,
// adult-2.json, … (each a ruleset of its own, listed in manifest.json, which this script keeps up to
// date), and extension/rules/domains.json, the same domains as a plain list, which the background script
// and the settings page read. The rules repeat each domain four times (two rules, with and without a
// trailing dot), so they are split into files of at most MAX_RULESET_BYTES: Mozilla's add-on linter, which
// runs before Mozilla signs a version, won't read a file over 4 MB.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDomainList } from '../extension/lib/domains.js';
import { buildRules } from '../extension/lib/rules.js';
import { safeSearchRules } from '../extension/lib/safesearch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BLOCKLIST_DIR = join(ROOT, 'blocklists');
export const EXTENSION_DIR = join(ROOT, 'extension');
export const MANIFEST_PATH = join(EXTENSION_DIR, 'manifest.json');
export const RULES_DIR = join(EXTENSION_DIR, 'rules');
export const DOMAINS_PATH = join(RULES_DIR, 'domains.json');
export const SAFE_SEARCH_FILE = 'safe-search.json'; // the safe-search ruleset (lib/safesearch.js), next to the adult ones
export const SAFE_SEARCH_PATH = join(RULES_DIR, SAFE_SEARCH_FILE);
export const MAX_RULESET_BYTES = 3 * 1024 * 1024;
const RULESET = /^adult-\d+\.json$/;

export function loadBlocklists(dir = BLOCKLIST_DIR) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.txt')).sort();
  const domains = new Set();
  const invalid = [];
  for (const file of files) {
    const parsed = parseDomainList(readFileSync(join(dir, file), 'utf8'));
    parsed.domains.forEach((domain) => domains.add(domain));
    parsed.invalid.forEach((entry) => invalid.push({ file, entry }));
  }
  return { files, domains: [...domains].sort(), invalid };
}

/**
 * The rules for `domains`, as the files to write: [{ id, file, text }], each file holding whole rules and
 * at most `maxBytes` (a rule larger than that on its own gets a file to itself).
 */
export function renderRulesets(domains, maxBytes = MAX_RULESET_BYTES) {
  const files = [];
  let rules = [];
  let bytes = 0;
  const flush = () => {
    if (rules.length === 0) return;
    const id = `adult-${files.length + 1}`;
    files.push({ id, file: `${id}.json`, text: `${JSON.stringify(rules)}\n` });
    rules = [];
    bytes = 0;
  };
  for (const rule of buildRules(domains)) {
    const size = JSON.stringify(rule).length + 1; // plus a comma or bracket
    if (rules.length > 0 && bytes + size > maxBytes) flush();
    rules.push(rule);
    bytes += size;
  }
  flush();
  return files;
}

/** The domains as a plain list, one per line, for the files that only need to know what is listed. */
export function renderDomains(domains) {
  return `[\n${domains.map((domain) => `  ${JSON.stringify(domain)}`).join(',\n')}\n]\n`;
}

/** manifest.json's rule_resources: the adult rulesets in these files, then the safe-search ruleset. */
export const ruleResources = (files) => [
  ...files.map(({ id, file }) => ({ id, enabled: true, path: `rules/${file}` })),
  { id: 'safe-search', enabled: true, path: `rules/${SAFE_SEARCH_FILE}` },
];

/** The safe-search ruleset as written to rules/safe-search.json. */
export const renderSafeSearch = () => `${JSON.stringify(safeSearchRules(), null, 2)}\n`;

/** manifest.json as it is kept: two-space JSON, with short lists of strings on one line. */
export function formatManifest(manifest) {
  const text = JSON.stringify(manifest, null, 2).replace(/\[\n\s+("[^"\n]*"(?:,\n\s+"[^"\n]*")*)\n\s+\]/g, (match, items) => {
    const line = `[${items.split(/,\n\s+/).join(', ')}]`;
    return line.length <= 90 ? line : match;
  });
  return `${text}\n`;
}

/** Every rule the manifest lists, in order, as the browser loads them. */
export function loadRules(manifestPath = MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return manifest.declarative_net_request.rule_resources.flatMap(({ path }) => JSON.parse(readFileSync(join(dirname(manifestPath), path), 'utf8')));
}

function main() {
  const { files, domains, invalid } = loadBlocklists();
  if (domains.length === 0) {
    console.error('No domains found in blocklists/*.txt');
    process.exit(1);
  }
  const rulesets = renderRulesets(domains);
  mkdirSync(RULES_DIR, { recursive: true });
  for (const name of readdirSync(RULES_DIR)) if (RULESET.test(name) || name === 'adult.json') rmSync(join(RULES_DIR, name));
  for (const { file, text } of rulesets) writeFileSync(join(RULES_DIR, file), text);
  writeFileSync(DOMAINS_PATH, renderDomains(domains));
  writeFileSync(SAFE_SEARCH_PATH, renderSafeSearch());
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.declarative_net_request.rule_resources = ruleResources(rulesets);
  writeFileSync(MANIFEST_PATH, formatManifest(manifest));
  console.log(`Read ${files.join(', ')}`);
  console.log(`Wrote ${domains.length} domains to ${rulesets.map(({ file }) => file).join(', ')} and domains.json in ${RULES_DIR}`);
  if (invalid.length > 0) {
    console.log(`Skipped ${invalid.length} entries that are not domain names, for example:`);
    for (const { file, entry } of invalid.slice(0, 10)) console.log(`  ${file}: ${entry}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
