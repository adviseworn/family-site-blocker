#!/usr/bin/env node
// Turns the JSON report from Mozilla's add-on linter into annotations on the GitHub run, and fails when
// it found errors or warnings. addons.mozilla.org runs the same linter before it will sign an add-on.
// usage: node scripts/lint-firefox-report.mjs lint.json
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { errors = [], warnings = [], notices = [] } = report;

// Workflow commands need %, CR and LF escaped.
const escape = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const describe = (m) => escape(`${m.code}: ${m.message}${m.file ? ` (${m.file}${m.line ? `:${m.line}` : ''})` : ''}`);

for (const m of errors) console.log(`::error title=Firefox linter error::${describe(m)}`);
for (const m of warnings) console.log(`::warning title=Firefox linter warning::${describe(m)}`);
for (const m of notices) console.log(`::notice title=Firefox linter notice::${describe(m)}`);
console.log(`::notice title=Firefox linter summary::${errors.length} errors, ${warnings.length} warnings, ${notices.length} notices`);

process.exit(errors.length || warnings.length ? 1 : 0);
