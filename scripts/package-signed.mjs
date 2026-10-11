#!/usr/bin/env node
// npm run package:signed -- <the signed .xpi downloaded from addons.mozilla.org>
//
// Writes dist/family-site-blocker-<version>.zip. Opening that zip in Finder gives
// family-site-blocker-<version>.xpi: byte for byte the file Mozilla signed, but with a clear name and the
// add-on's gate icon instead of a blank page. The icon travels the way Finder's own Compress stores one:
// an AppleDouble file at __MACOSX/._<name> holding the Finder info, with the has-custom-icon flag set, and
// a resource fork with assets/finder-icon.icns as resource 'icns' -16455. Archive Utility, which opens zips
// when you double-click them, puts both back on the file. Checked in Finder on macOS 26.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readZip } from './read-zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ICNS_PATH = join(ROOT, 'assets', 'finder-icon.icns');
const ADDON_ID = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;

const CUSTOM_ICON_ID = -16455; // kCustomIconResource: where Finder looks for a file's own icon
const HAS_CUSTOM_ICON = 0x0400; // kHasCustomIcon, in the Finder flags

/** A resource fork holding one unnamed resource, laid out as macOS writes them. */
export function resourceFork(type, id, data) {
  const dataSection = Buffer.alloc(4 + data.length);
  dataSection.writeUInt32BE(data.length, 0);
  data.copy(dataSection, 4);
  const typeList = Buffer.alloc(2 + 8);
  typeList.writeUInt16BE(0, 0); // one type
  typeList.write(type, 2, 'latin1');
  typeList.writeUInt16BE(0, 6); // one resource of that type
  typeList.writeUInt16BE(typeList.length, 8); // its reference follows the type list
  const reference = Buffer.alloc(12);
  reference.writeInt16BE(id, 0);
  reference.writeUInt16BE(0xffff, 2); // no name; attributes 0 and data offset 0 follow, then a spare handle
  const mapLength = 28 + typeList.length + reference.length;
  const header = Buffer.alloc(16);
  header.writeUInt32BE(256, 0);
  header.writeUInt32BE(256 + dataSection.length, 4);
  header.writeUInt32BE(dataSection.length, 8);
  header.writeUInt32BE(mapLength, 12);
  const mapHead = Buffer.alloc(12);
  mapHead.writeUInt16BE(28, 8); // type list offset
  mapHead.writeUInt16BE(mapLength, 10); // name list offset: empty, at the end
  return Buffer.concat([header, Buffer.alloc(240), dataSection, header, mapHead, typeList, reference]);
}

/** The __MACOSX/._<name> sidecar that gives a file the icon in `icns` when the zip is opened on a Mac. */
export function iconSidecar(icns) {
  const finderInfo = Buffer.alloc(32);
  finderInfo.writeUInt16BE(HAS_CUSTOM_ICON, 8);
  const fork = resourceFork('icns', CUSTOM_ICON_ID, icns);
  const header = Buffer.alloc(26 + 2 * 12);
  header.writeUInt32BE(0x00051607, 0); // AppleDouble
  header.writeUInt32BE(0x00020000, 4); // version 2
  header.write('Mac OS X        ', 8, 'latin1');
  header.writeUInt16BE(2, 24);
  header.writeUInt32BE(9, 26); // Finder info
  header.writeUInt32BE(header.length, 30);
  header.writeUInt32BE(finderInfo.length, 34);
  header.writeUInt32BE(2, 38); // resource fork
  header.writeUInt32BE(header.length + finderInfo.length, 42);
  header.writeUInt32BE(fork.length, 46);
  return Buffer.concat([header, finderInfo, fork]);
}

/** Checks that `xpiPath` is this add-on, signed by Mozilla, and wraps it for a Mac. Returns what it wrote. */
export function packageSigned(xpiPath, { outDir = join(ROOT, 'dist'), icns = readFileSync(ICNS_PATH) } = {}) {
  const xpi = readFileSync(xpiPath);
  let files;
  try {
    files = readZip(xpi);
  } catch {
    throw new Error(`${xpiPath} isn't an add-on file: it can't be read as a zip.`);
  }
  if (!files.has('manifest.json')) throw new Error(`${xpiPath} isn't an add-on file: it has no manifest.json.`);
  const manifest = JSON.parse(files.get('manifest.json').data.toString('utf8'));
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (id !== ADDON_ID) throw new Error(`${xpiPath} is a different add-on (${id ?? 'no id'}), not Family Site Blocker.`);
  if (!files.has('META-INF/cose.sig') && !files.has('META-INF/mozilla.rsa')) {
    throw new Error(`${xpiPath} isn't signed by Mozilla. Upload dist/family-site-blocker-firefox.zip to addons.mozilla.org and use the .xpi it gives you.`);
  }

  const name = `family-site-blocker-${manifest.version}`;
  const zip = join(resolve(outDir), `${name}.zip`);
  const stage = mkdtempSync(join(tmpdir(), 'family-site-blocker-signed-'));
  try {
    // Written fresh, so nothing else attached to the download (such as macOS's quarantine flag) comes along.
    writeFileSync(join(stage, `${name}.xpi`), xpi);
    mkdirSync(join(stage, '__MACOSX'));
    writeFileSync(join(stage, '__MACOSX', `._${name}.xpi`), iconSidecar(icns));
    for (const file of [`${name}.xpi`, `__MACOSX/._${name}.xpi`]) chmodSync(join(stage, file), 0o644); // readable by every account
    mkdirSync(dirname(zip), { recursive: true });
    rmSync(zip, { force: true });
    const run = spawnSync('zip', ['-qX', zip, `${name}.xpi`, '__MACOSX', `__MACOSX/._${name}.xpi`], { cwd: stage, encoding: 'utf8' });
    if (run.error?.code === 'ENOENT') throw new Error('The zip command is not installed.');
    if (run.status !== 0) throw new Error(`zip failed: ${run.error?.message ?? run.stderr}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return { zip, xpi: `${name}.xpi`, version: manifest.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run package:signed -- <the signed .xpi from addons.mozilla.org>');
    process.exit(1);
  }
  try {
    // npm runs scripts from the project folder; read the path from where the command was typed.
    const { zip, xpi } = packageSigned(resolve(process.env.INIT_CWD ?? process.cwd(), file));
    console.log(`Wrote ${relative(process.cwd(), zip)}. Open it in Finder to get ${xpi} with the add-on's icon.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
