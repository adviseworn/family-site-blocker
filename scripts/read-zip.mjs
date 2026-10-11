// Reads a zip (or .xpi) with nothing but Node, from its central directory.
import { inflateRawSync } from 'node:zlib';

/** The files in a zip: name → { data, mode }. Folders are left out; mode is the Unix mode stored for the file. */
export function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (end < 0) throw new Error('not a zip file');
  const files = new Map();
  let at = zip.readUInt32LE(end + 16);
  for (let left = zip.readUInt16LE(end + 10); left > 0; left--) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip file');
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const stored = zip.subarray(start, start + zip.readUInt32LE(at + 20));
    if (!name.endsWith('/')) {
      files.set(name, {
        data: zip.readUInt16LE(at + 10) === 8 ? inflateRawSync(stored) : stored,
        mode: zip.readUInt32LE(at + 38) >>> 16,
      });
    }
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}
