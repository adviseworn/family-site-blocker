#!/usr/bin/env node
// Builds extension/rules/adult.json from every .txt file in blocklists/.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDomainList } from '../extension/lib/domains.js';
import { buildRules } from '../extension/lib/rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BLOCKLIST_DIR = join(ROOT, 'blocklists');
export const RULES_PATH = join(ROOT, 'extension', 'rules', 'adult.json');

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

export function renderRules(domains) {
  return `${JSON.stringify(buildRules(domains), null, 2)}\n`;
}

function main() {
  const { files, domains, invalid } = loadBlocklists();
  if (domains.length === 0) {
    console.error('No domains found in blocklists/*.txt');
    process.exit(1);
  }
  mkdirSync(dirname(RULES_PATH), { recursive: true });
  writeFileSync(RULES_PATH, renderRules(domains));
  console.log(`Read ${files.join(', ')}`);
  console.log(`Wrote ${domains.length} domains to ${RULES_PATH}`);
  if (invalid.length > 0) {
    console.log(`Skipped ${invalid.length} entries that are not domain names, for example:`);
    for (const { file, entry } of invalid.slice(0, 10)) console.log(`  ${file}: ${entry}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
