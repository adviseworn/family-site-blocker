#!/usr/bin/env node
// Prints what Mozilla's add-on linter found, from its JSON report, in the pipeline's log (as annotations on
// a GitHub run, where there are such things), and fails when it found errors or warnings. addons.mozilla.org
// runs the same linter before it will publish and sign a version.
// usage: node scripts/lint-firefox-report.mjs lint.json
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { errors = [], warnings = [], notices = [] } = report;

const github = !!process.env.GITHUB_ACTIONS;
// GitHub's workflow commands need %, CR and LF escaped.
const escape = (text) => (github ? String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A') : String(text));
const describe = (m) => escape(`${m.code}: ${m.message}${m.file ? ` (${m.file}${m.line ? `:${m.line}` : ''})` : ''}`);
const say = (level, title, text) => console.log(github ? `::${level} title=${title}::${text}` : `${title}: ${text}`);

for (const m of errors) say('error', 'Firefox linter error', describe(m));
for (const m of warnings) say('warning', 'Firefox linter warning', describe(m));
for (const m of notices) say('notice', 'Firefox linter notice', describe(m));
say('notice', 'Firefox linter summary', `${errors.length} errors, ${warnings.length} warnings, ${notices.length} notices`);

process.exit(errors.length || warnings.length ? 1 : 0);
