import { existsSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

// js/css only — the same set server/built-asset-cache.ts offers to clients.
const TEXT = new Set(['.js', '.css']);
const root = join(process.cwd(), 'dist/start/client');
const brotli = promisify(brotliCompress);
const gzipFile = promisify(gzip);

if (!existsSync(root)) {
  console.error(`compress-built-assets: ${root} is missing`);
  process.exit(1);
}

async function textFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await textFiles(path)));
    else if (TEXT.has(extname(entry.name))) found.push(path);
  }
  return found;
}

async function storeIfSmaller(path, body, rawSize) {
  if (body.length >= rawSize) {
    await rm(path, { force: true });
    return 0;
  }
  await writeFile(path, body);
  return body.length;
}

async function compressOne(path) {
  const source = await readFile(path);
  const [br, gz] = await Promise.all([
    brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
    gzipFile(source, { level: 9 }),
  ]);
  const [brBytes, gzBytes] = await Promise.all([
    storeIfSmaller(`${path}.br`, br, source.length),
    storeIfSmaller(`${path}.gz`, gz, source.length),
  ]);
  return { raw: source.length, br: brBytes, gz: gzBytes };
}

const files = await textFiles(root);
if (files.length === 0) {
  console.error(`compress-built-assets: no js/css under ${root}`);
  process.exit(1);
}

const totals = { raw: 0, br: 0, gz: 0 };
const queue = files.slice();
const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
  while (queue.length > 0) {
    const path = queue.pop();
    if (!path) break;
    const sizes = await compressOne(path);
    totals.raw += sizes.raw;
    totals.br += sizes.br;
    totals.gz += sizes.gz;
  }
});
await Promise.all(workers);
console.log(
  `compress-built-assets: ${files.length} files, ${totals.raw} bytes → br ${totals.br} / gz ${totals.gz}`,
);
