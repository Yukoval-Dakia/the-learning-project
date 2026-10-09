import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function documentAssets(html: string, prefix: '/_build/assets/' | '/assets/'): string[] {
  if (html.includes('/src/main.tsx') || html.includes('/@vite/client'))
    throw new Error('Development document is not a built artifact');
  const paths = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)]
    .map((match) => match[1])
    .filter((path): path is string => Boolean(path?.startsWith(prefix)));
  if (!paths.some((path) => path.endsWith('.js')) || !paths.some((path) => path.endsWith('.css')))
    throw new Error(`Document has no built JS+CSS under ${prefix}`);
  if (
    paths.some(
      (path) => !/^\/(?:_build\/)?assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]+\.(js|css)$/.test(path),
    )
  )
    throw new Error('Document contains an unhashed or unsafe asset path');
  return [...new Set(paths)];
}

export function startRouteAssets(manifest: string): string[] {
  const paths: string[] = [];
  for (const key of ['__root__', '"/today"']) {
    const block = manifest.match(new RegExp(`${key}:\\s*\\{([\\s\\S]*?)\\n\\t\\}`))?.[1];
    if (!block) throw new Error(`Emitted Start manifest is missing ${key}`);
    paths.push(
      ...[
        ...block.matchAll(/"(\/_build\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]+\.(?:js|css))"/g),
      ].flatMap((match) => (match[1] ? [match[1]] : [])),
    );
  }
  if (
    !paths.some((path) => path.endsWith('.css')) ||
    !paths.some((path) => /\/index-[^/]+\.js$/.test(path))
  )
    throw new Error('Emitted Start manifest has no root entry and route CSS');
  return [...new Set(paths)];
}

export async function readStartAssetManifest(root = process.cwd()): Promise<string> {
  const directory = join(root, 'dist/start/server/assets');
  const files = (await readdir(directory)).filter(
    (name) => name.startsWith('_tanstack-start-manifest_') && name.endsWith('.js'),
  );
  if (files.length !== 1 || !files[0])
    throw new Error('Expected one local emitted Start asset manifest; run pnpm build first');
  return readFile(join(directory, files[0]), 'utf8');
}

export async function verifyServedAsset(
  target: string,
  route: string,
  local: Uint8Array,
  fetchAsset: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchAsset(new URL(route, `${target}/`));
  if (!response.ok)
    throw new Error(
      `[container preflight] route=${route} expected=2xx actual=${response.status} target=${target}`,
    );
  const actual = new Uint8Array(await response.arrayBuffer());
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  if (actual.byteLength !== local.byteLength || sha256(actual) !== sha256(local))
    throw new Error(
      `[container preflight] route=${route} target=${target} serves stale/incorrect bytes; expected_sha256=${sha256(local)} actual_sha256=${sha256(actual)}`,
    );
}
