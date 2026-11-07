#!/usr/bin/env node
// Sums up a test suite's TAP output in the pipeline's log (node --test writes TAP when it isn't talking to a
// terminal): how many tests ran, passed, failed and were skipped, and the failing tests by name. Exits 1 when a
// suite's file is missing, when nothing ran, when a test failed or was cancelled, or when more tests were
// skipped than allowed (--allow-skips=N: one fast check needs a Mac, the Finder icon on the .xpi).
// usage: node scripts/ci-summary.mjs [--allow-skips=N] <suite>=<file.tap> ...
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The totals node --test prints at the end of a run (the last of each, should a run hold several). */
export function totals(tap) {
  const last = (name) => {
    const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  return { tests: last('tests'), pass: last('pass'), fail: last('fail'), cancelled: last('cancelled'), skipped: last('skipped') };
}

/** The failing tests, as TAP names them, without the ones marked as skipped or to do. */
export const failures = (tap) => [...tap.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]).filter((name) => !/# (SKIP|TODO)\b/.test(name));

/** What to say about one suite, and whether it passed whole. */
export function judge(name, tap, allowedSkips = 0) {
  if (tap === null) return { line: `${name}: did not run`, ok: false };
  const t = totals(tap);
  if (t.tests === null) return { line: `${name}: no totals in the output, so the run didn't finish`, ok: false };
  const line = `${name}: ${t.tests} tests, ${t.pass ?? 0} passed, ${t.fail ?? 0} failed, ${t.cancelled ?? 0} cancelled, ${t.skipped ?? 0} skipped`;
  const ok = t.tests > 0 && (t.fail ?? 0) === 0 && (t.cancelled ?? 0) === 0 && (t.skipped ?? 0) <= allowedSkips && (t.pass ?? 0) + (t.skipped ?? 0) === t.tests;
  return { line, ok };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let allowedSkips = 0;
  const suites = [];
  for (const arg of process.argv.slice(2)) {
    const skips = /^--allow-skips=(\d+)$/.exec(arg);
    if (skips) allowedSkips = Number(skips[1]);
    else if (arg.includes('=')) suites.push(arg.split(/=(.*)/s).slice(0, 2));
    else {
      console.error('usage: node scripts/ci-summary.mjs [--allow-skips=N] <suite>=<file.tap> ...');
      process.exit(2);
    }
  }
  let status = 0;
  for (const [name, file] of suites) {
    const tap = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const { line, ok } = judge(name, tap, allowedSkips);
    console.log(ok ? line : `${line}: not every test ran and passed`);
    if (tap) for (const failure of failures(tap)) console.log(`  not ok: ${failure}`);
    if (!ok) status = 1;
  }
  process.exit(status);
}
