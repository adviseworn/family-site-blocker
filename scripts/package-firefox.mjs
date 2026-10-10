#!/usr/bin/env node
// npm run package:firefox: builds dist/family-site-blocker-firefox.zip, the file to upload to
// addons.mozilla.org for signing. It holds the extension folder with one change to manifest.json:
// "background.service_worker" is left out. Chrome, Edge and Brave need that line, but Firefox ignores it
// and Mozilla's add-on linter warns about it (BACKGROUND_SERVICE_WORKER_IGNORED). Firefox runs the same
// background.js from "background.scripts", which stays.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ZIP_NAME = 'family-site-blocker-firefox.zip';

// Left behind in the extension folder by Chrome ("Load unpacked") or by Finder; not part of the add-on.
const LEFT_OUT = new Set(['_metadata', '.DS_Store']);

/** Firefox's copy of the manifest: the same, without the background key only Chrome, Edge and Brave read. */
export function firefoxManifest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.background.service_worker;
  return copy;
}

/**
 * Copies the extension to <outDir>/firefox with Firefox's manifest, then zips that folder's contents so
 * manifest.json sits at the top of the zip, where Mozilla requires it. Returns both paths.
 */
export function packageFirefox({ extensionDir = join(ROOT, 'extension'), outDir = join(ROOT, 'dist') } = {}) {
  const folder = join(outDir, 'firefox');
  const zip = join(outDir, ZIP_NAME);
  rmSync(folder, { recursive: true, force: true });
  rmSync(zip, { force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(extensionDir, folder, { recursive: true, filter: (path) => !LEFT_OUT.has(basename(path)) });

  const manifestPath = join(folder, 'manifest.json');
  const manifest = firefoxManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const run = spawnSync('zip', ['-qrX', zip, '.'], { cwd: folder, encoding: 'utf8' });
  if (run.error?.code === 'ENOENT') throw new Error('The zip command is not installed.');
  if (run.status !== 0) throw new Error(`zip failed: ${run.error?.message ?? run.stderr}`);
  return { folder, zip, version: manifest.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { zip, version } = packageFirefox();
  console.log(`Wrote ${relative(process.cwd(), zip)} (version ${version})`);
}
