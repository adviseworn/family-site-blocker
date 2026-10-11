#!/usr/bin/env node
// Checks a signed .xpi against the folder that was uploaded for signing: every file there, unchanged, plus
// Mozilla's signature files in META-INF/ and nothing else. manifest.json is compared as data, because
// Mozilla rewrites its whitespace when it signs.
// usage: node scripts/check-signed.mjs <signed .xpi> <folder that was uploaded>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readZip } from './read-zip.mjs';

const [xpiPath, folder] = process.argv.slice(2);
if (!xpiPath || !folder) {
  console.error('Usage: node scripts/check-signed.mjs <signed .xpi> <folder that was uploaded>');
  process.exit(1);
}

const signed = readZip(readFileSync(xpiPath));
const uploaded = readdirSync(folder, { recursive: true })
  .filter((path) => statSync(join(folder, path)).isFile())
  .map((path) => path.split(sep).join('/'));

const problems = [];
for (const name of uploaded) {
  const entry = signed.get(name);
  const ours = readFileSync(join(folder, name));
  if (!entry) problems.push(`${name} is missing`);
  else if (name === 'manifest.json' ? !isDeepStrictEqual(JSON.parse(entry.data), JSON.parse(ours)) : !entry.data.equals(ours)) {
    problems.push(`${name} is different`);
  }
}
const signatures = [...signed.keys()].filter((name) => name.startsWith('META-INF/'));
for (const name of signed.keys()) {
  if (!uploaded.includes(name) && !name.startsWith('META-INF/')) problems.push(`${name} was added`);
}
if (signatures.length === 0) problems.push('it has no signature files (META-INF/)');

if (problems.length > 0) {
  console.error(`${xpiPath} doesn't match ${folder}: ${problems.join('; ')}`);
  process.exit(1);
}
console.log(`${xpiPath}: the ${uploaded.length} files uploaded, unchanged, plus Mozilla's signature (${signatures.join(', ')})`);
