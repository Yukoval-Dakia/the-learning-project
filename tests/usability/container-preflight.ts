import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';

interface BuiltAssets {
  js: string | undefined;
  css: string | undefined;
}

function builtAssets(html: string): BuiltAssets {
  return {
    js: html.match(/\/assets\/index-[^"']+\.js/)?.[0],
    css: html.match(/\/assets\/index-[^"']+\.css/)?.[0],
  };
}

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
  try {
    [health, page] = await Promise.all([fetch(`${target}/api/health`), fetch(`${target}/today`)]);
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

  const html = await page.text();
  const actual = builtAssets(html);
  if (!actual.js || !actual.css || html.includes('/src/main.tsx')) {
    throw new Error(
      `[container preflight] route=/today target=${target} is not serving hashed Vite JS+CSS assets; refuse to test a dev/stale checkout`,
    );
  }

  const localHtml = await readFile(join(process.cwd(), 'web/dist/index.html'), 'utf8');
  const expected = builtAssets(localHtml);
  if (!expected.js || !expected.css) {
    throw new Error(
      '[container preflight] local web/dist has no hashed JS+CSS assets; run pnpm rw:web:build first',
    );
  }

  for (const kind of ['js', 'css'] as const) {
    if (actual[kind] !== expected[kind]) {
      throw new Error(
        `[container preflight] route=/today target=${target} serves a stale SPA ${kind.toUpperCase()} asset; expected=${expected[kind]} actual=${actual[kind]}`,
      );
    }
  }

  for (const route of [actual.js, actual.css]) {
    const asset = await fetch(new URL(route, `${target}/`).toString());
    if (!asset.ok) {
      throw new Error(
        `[container preflight] route=${route} expected=2xx actual=${asset.status} target=${target}`,
      );
    }
  }
}
