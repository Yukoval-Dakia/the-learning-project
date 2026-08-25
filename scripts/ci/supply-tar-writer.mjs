// Deterministic ustar writer for the YUK-914 runtime-closure artifact.
//
// The archive must hash to the same SHA-256 on every platform, so the writer
// zeroes all volatile metadata (mtime/uid/gid/uname/gname), normalizes modes to
// 755/644/777, and emits entries in byte-sorted path order. Paths beyond the
// 100-byte name field use the ustar prefix split; anything beyond prefix+name
// falls back to a GNU longname ('L') pseudo-entry, which the reader supports.

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';

const BLOCK = 512;
const GNU_LONGNAME = 'L';
const FILE_MODE = 0o100644;
const EXEC_MODE = 0o100755;
const DIR_MODE = 0o040755;
const SYMLINK_MODE = 0o120777;

export class TarFormatError extends Error {}

/**
 * @typedef {object} TarEntry
 * @property {string} path archive path (forward slashes)
 * @property {string} source path relative to the write root (forward slashes)
 * @property {'file'|'dir'|'symlink'} type
 * @property {number} mode normalized tar mode
 * @property {number} size payload bytes (files only)
 * @property {string} [linkTarget] symlink target (symlinks only)
 */

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function octal(value, length) {
  const text = value.toString(8);
  if (text.length > length - 1) throw new TarFormatError(`octal field overflow: ${value}`);
  return `${text.padStart(length - 1, '0')}\u0000`;
}

export function pad(bytes) {
  const remainder = bytes % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder, 0);
}

function headerFor(entry, pathInHeader, typeOverride, prefixField) {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(pathInHeader.slice(0, 100), 0, 'utf8');
  header.write(octal(entry.mode & 0o7777, 8), 100, 'utf8');
  header.write(octal(0, 8), 108, 'utf8');
  header.write(octal(0, 8), 116, 'utf8');
  header.write(
    octal(typeOverride === GNU_LONGNAME ? entry.size : entry.type === 'file' ? entry.size : 0, 12),
    124,
    'utf8',
  );
  header.write(octal(0, 12), 136, 'utf8');
  header.write(' '.repeat(8), 148, 'utf8');
  const typeFlag = typeOverride ?? (entry.type === 'file' ? '0' : entry.type === 'dir' ? '5' : '2');
  header.write(typeFlag, 156, 'utf8');
  if (entry.type === 'symlink') {
    if (!entry.linkTarget || entry.linkTarget.length > 100) {
      throw new TarFormatError(`symlink target missing or too long: ${entry.path}`);
    }
    header.write(entry.linkTarget, 157, 'utf8');
  }
  header.write('ustar', 257, 'utf8');
  header.write('00', 263, 'utf8');
  if (prefixField !== undefined) {
    if (prefixField.length > 155) throw new TarFormatError(`ustar prefix overflow: ${prefixField}`);
    header.write(prefixField, 345, 'utf8');
  }
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 'utf8');
  header.write('\u0000 ', 154, 'utf8');
  return header;
}

function headerWithPrefix(entry) {
  if (entry.path.length <= 100) return headerFor(entry, entry.path);
  const boundary = entry.path.lastIndexOf('/', 155);
  if (boundary > 0 && boundary <= 155 && entry.path.length - boundary - 1 <= 100) {
    return headerFor(
      entry,
      entry.path.slice(boundary + 1),
      undefined,
      entry.path.slice(0, boundary),
    );
  }
  return null;
}

function longNameEntry(path) {
  const payload = Buffer.from(`${path}\u0000`, 'utf8');
  const header = headerFor(
    { type: 'file', mode: 0o644, size: payload.length },
    '././@LongLink',
    GNU_LONGNAME,
  );
  return { header, payload };
}

async function writeAll(stream, buffer) {
  if (!stream.write(buffer)) await once(stream, 'drain');
}

export async function collectTarEntries(rootDir, entryPrefix) {
  const entries = [];
  async function walk(dir, prefix) {
    const children = await fs.readdir(dir, { withFileTypes: true });
    children.sort((left, right) => byteCompare(left.name, right.name));
    for (const child of children) {
      const childPath = join(dir, child.name);
      const archivePath = `${prefix}/${child.name}`;
      if (child.isDirectory()) {
        entries.push({
          path: archivePath,
          source: childPath,
          type: 'dir',
          mode: DIR_MODE,
          size: 0,
        });
        await walk(childPath, archivePath);
      } else if (child.isFile()) {
        const stat = await fs.stat(childPath);
        const executable = (stat.mode & 0o111) !== 0;
        entries.push({
          path: archivePath,
          source: childPath,
          type: 'file',
          mode: executable ? EXEC_MODE : FILE_MODE,
          size: stat.size,
        });
      } else if (child.isSymbolicLink()) {
        entries.push({
          path: archivePath,
          source: childPath,
          type: 'symlink',
          mode: SYMLINK_MODE,
          size: 0,
          linkTarget: await fs.readlink(childPath),
        });
      } else {
        throw new TarFormatError(`unsupported directory entry: ${childPath}`);
      }
    }
  }
  entries.push({ path: entryPrefix, source: rootDir, type: 'dir', mode: DIR_MODE, size: 0 });
  await walk(rootDir, entryPrefix);
  entries.sort((left, right) => byteCompare(left.path, right.path));
  return entries;
}

// `entry.source` is an absolute on-disk path; it never contributes to the
// archive bytes, which are fully determined by entry.path, metadata, and content.
export async function writeDeterministicTar(outPath, entries) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createWriteStream(outPath, { mode: 0o666 });
  try {
    for (const entry of entries) {
      if (headerWithPrefix(entry) === null) {
        const long = longNameEntry(entry.path);
        hash.update(long.header);
        bytes += long.header.length;
        await writeAll(stream, long.header);
        const longBlock = Buffer.concat([long.payload, pad(long.payload.length)]);
        hash.update(longBlock);
        bytes += longBlock.length;
        await writeAll(stream, longBlock);
      }
      const header = headerWithPrefix(entry) ?? headerFor(entry, entry.path.slice(0, 100));
      hash.update(header);
      bytes += header.length;
      await writeAll(stream, header);
      if (entry.type === 'file') {
        const source = createReadStream(entry.source);
        for await (const chunk of source) {
          hash.update(chunk);
          bytes += chunk.length;
          await writeAll(stream, chunk);
        }
        const padding = pad(entry.size);
        if (padding.length) {
          hash.update(padding);
          bytes += padding.length;
          await writeAll(stream, padding);
        }
      }
    }
    const trailer = Buffer.alloc(BLOCK * 2, 0);
    hash.update(trailer);
    bytes += trailer.length;
    await writeAll(stream, trailer);
    stream.end();
    await once(stream, 'finish');
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return { sha256: hash.digest('hex'), bytes };
}
