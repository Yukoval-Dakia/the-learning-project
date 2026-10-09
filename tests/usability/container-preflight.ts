import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import {
  documentAssets,
  readStartAssetManifest,
  startRouteAssets,
  verifyServedAsset,
} from './built-assets';
import { loadBuiltFunctionMap } from './start-rpc-fixtures';

function targetFrom(config: FullConfig): string {
  const value = config.projects[0]?.use.baseURL;
  if (typeof value !== 'string' || !value) {
    throw new Error('USABILITY_BASE_URL is missing from the Playwright project.');
  }
  return value.replace(/\/$/, '');
}

export default async function containerPreflight(config: FullConfig): Promise<void> {
  const target = targetFrom(config);
  let health: Response;
  let page: Response;
  let fallback: Response;
  try {
    [health, page, fallback] = await Promise.all([
      fetch(`${target}/api/health`),
      fetch(`${target}/today`),
      fetch(`${target}/practice`),
    ]);
  } catch (error) {
    throw new Error(
      `[container preflight] target=${target} is unreachable; start the isolated built container first: ${String(error)}`,
    );
  }

  if (!health.ok) {
    throw new Error(
      `[container preflight] route=/api/health expected=2xx actual=${health.status} target=${target}`,
    );
  }
  if (!page.ok) {
    throw new Error(
      `[container preflight] route=/today expected=2xx actual=${page.status} target=${target}`,
    );
  }

  const actualStart = documentAssets(await page.text(), '/_build/assets/');
  const expectedStart = startRouteAssets(await readStartAssetManifest());
  for (const route of expectedStart)
    if (!actualStart.includes(route))
      throw new Error(
        `[container preflight] route=/today target=${target} is missing current Start asset ${route}`,
      );
  for (const route of actualStart)
    await verifyServedAsset(
      target,
      route,
      await readFile(join(process.cwd(), 'dist/start/client', route.replace(/^\/_build\//, ''))),
    );
  await loadBuiltFunctionMap();

  if (!fallback.ok)
    throw new Error(
      `[container preflight] route=/practice expected=2xx actual=${fallback.status} target=${target}`,
    );
  const actualSpa = documentAssets(await fallback.text(), '/assets/');
  const expectedSpa = documentAssets(
    await readFile(join(process.cwd(), 'web/dist/index.html'), 'utf8'),
    '/assets/',
  );
  if (JSON.stringify([...actualSpa].sort()) !== JSON.stringify([...expectedSpa].sort()))
    throw new Error(
      `[container preflight] route=/practice target=${target} serves stale fallback SPA asset references`,
    );
  for (const route of actualSpa)
    await verifyServedAsset(target, route, await readFile(join(process.cwd(), 'web/dist', route)));
}
