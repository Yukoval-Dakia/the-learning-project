// Deterministic tar reader for the YUK-914 runtime-closure artifact.
//
// Extraction is guarded: every entry path must resolve inside destRoot, no
// `..` segments survive, and symlink targets must resolve inside the root.
// Supports the ustar prefix split and the GNU longname ('L') pseudo-entry the
// writer emits. Anything else (pax, hardlinks, sparse, …) is rejected.

import { once } from 'node:events';
import { createWriteStream, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { TarFormatError, pad } from './supply-tar-writer.mjs';

const BLOCK = 512;
const GNU_LONGNAME = 'L';

function parseOctal(block, offset, length) {
  const text = block
    .subarray(offset, offset + length)
    .toString('utf8')
    .replaceAll('\u0000', '')
    .replaceAll(' ', '');
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value)) throw new TarFormatError(`invalid octal field: ${text}`);
  return value;
}

function readString(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function verifyChecksum(block) {
  let actual = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : block[index];
  }
  const recorded = parseOctal(block, 148, 8);
  if (recorded !== actual) throw new TarFormatError('tar header checksum mismatch');
}

function safeJoin(root, archivePath) {
  if (archivePath.startsWith('/') || archivePath.includes('\\')) {
    throw new TarFormatError(`tar entry escapes the archive root: ${archivePath}`);
  }
  const target = resolve(root, ...archivePath.split('/'));
  const normalizedRoot = resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new TarFormatError(`tar entry escapes the extraction root: ${archivePath}`);
  }
  for (const segment of archivePath.split('/')) {
    if (segment === '..') throw new TarFormatError(`tar entry traversal segment: ${archivePath}`);
  }
  return target;
}

/**
 * Extracts a deterministic tar. Returns the parsed entries; every entry path is
 * guarded to stay inside destRoot and symlink targets must resolve inside it.
 */
export async function extractDeterministicTar(tarPath, destRoot) {
  const extracted = [];
  const fileHandle = await fs.open(tarPath, 'r');
  try {
    let buffer = Buffer.alloc(0);
    let offset = 0;
    async function ensure(count) {
      while (buffer.length - offset < count) {
        const chunk = Buffer.alloc(BLOCK);
        const { bytesRead } = await fileHandle.read(chunk, 0, BLOCK, null);
        if (bytesRead === 0) return false;
        buffer =
          offset === 0
            ? Buffer.concat([chunk.subarray(0, bytesRead)])
            : Buffer.concat([buffer.subarray(offset), chunk.subarray(0, bytesRead)]);
        offset = 0;
      }
      return true;
    }
    async function consume(count) {
      const skipped = Math.min(count, buffer.length - offset);
      offset += skipped;
      const remaining = count - skipped;
      for (let index = 0; index < remaining; index += BLOCK) {
        const chunk = Buffer.alloc(BLOCK);
        const { bytesRead } = await fileHandle.read(chunk, 0, BLOCK, null);
        if (bytesRead === 0) throw new TarFormatError('unexpected end of tar archive');
      }
    }
    let pendingLongName = null;
    for (;;) {
      if (!(await ensure(BLOCK))) break;
      const header = buffer.subarray(offset, offset + BLOCK);
      if (header.every((byte) => byte === 0)) {
        await consume(BLOCK);
        continue;
      }
      verifyChecksum(header);
      const typeFlag = String.fromCharCode(header[156]);
      const size = parseOctal(header, 124, 12);
      const mode = parseOctal(header, 100, 8);
      offset += BLOCK;
      if (typeFlag === GNU_LONGNAME) {
        const payload = Buffer.alloc(size);
        let filled = 0;
        while (filled < size) {
          if (!(await ensure(Math.min(BLOCK, size - filled))))
            throw new TarFormatError('truncated longname entry');
          const take = Math.min(BLOCK, size - filled, buffer.length - offset);
          buffer.copy(payload, filled, offset, offset + take);
          offset += take;
          filled += take;
        }
        await consume(pad(size).length);
        const end = payload.indexOf(0);
        pendingLongName = payload.subarray(0, end === -1 ? size : end).toString('utf8');
        continue;
      }
      const nameField = readString(header, 0, 100);
      const prefixField = readString(header, 345, 155);
      const path = pendingLongName ?? (prefixField ? `${prefixField}/${nameField}` : nameField);
      pendingLongName = null;
      const destPath = safeJoin(destRoot, path);
      if (typeFlag === '5') {
        await fs.mkdir(destPath, { recursive: true });
        extracted.push({ path, type: 'dir', mode, size: 0 });
      } else if (typeFlag === '2') {
        const linkTarget = readString(header, 157, 100);
        const resolvedTarget = resolve(dirname(destPath), linkTarget);
        const normalizedRoot = resolve(destRoot);
        if (
          resolvedTarget !== normalizedRoot &&
          !resolvedTarget.startsWith(`${normalizedRoot}${sep}`)
        ) {
          throw new TarFormatError(
            `tar symlink escapes the extraction root: ${path} -> ${linkTarget}`,
          );
        }
        await fs.mkdir(dirname(destPath), { recursive: true });
        await fs.symlink(linkTarget, destPath);
        extracted.push({ path, type: 'symlink', mode, size: 0, linkTarget });
      } else if (typeFlag === '0' || typeFlag === '\u0000') {
        await fs.mkdir(dirname(destPath), { recursive: true });
        const sink = createWriteStream(destPath, {
          mode: 0o666,
          flags: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
        });
        let remaining = size;
        while (remaining > 0) {
          if (buffer.length - offset === 0 && !(await ensure(Math.min(BLOCK, remaining)))) {
            throw new TarFormatError('unexpected end of tar payload');
          }
          const take = Math.min(remaining, buffer.length - offset);
          const chunk = buffer.subarray(offset, offset + take);
          offset += take;
          remaining -= take;
          if (!sink.write(chunk)) await once(sink, 'drain');
        }
        sink.end();
        await once(sink, 'finish');
        await fs.chmod(destPath, (mode & 0o111) !== 0 ? 0o755 : 0o644);
        extracted.push({ path, type: 'file', mode, size });
      } else {
        throw new TarFormatError(`unsupported tar typeflag: ${typeFlag} (${path})`);
      }
      const padding = pad(size).length;
      if (padding > 0) await consume(padding);
    }
  } finally {
    await fileHandle.close();
  }
  return extracted;
}
