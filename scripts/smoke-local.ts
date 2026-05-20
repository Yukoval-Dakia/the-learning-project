import { config } from 'dotenv';
import { buildLocalDevEnv } from './local-db-env';

config({ path: '.env', override: false });

const { NEXT_PUBLIC_BASE_URL } = buildLocalDevEnv(process.env);
const token = process.env.INTERNAL_TOKEN;

if (!token) {
  throw new Error('INTERNAL_TOKEN is missing from .env');
}

const endpoints = [
  '/api/health',
  '/api/review/due?limit=1',
  '/api/mistakes?limit=1',
  '/api/knowledge',
] as const;

let failed = false;

for (const endpoint of endpoints) {
  const res = await fetch(`${NEXT_PUBLIC_BASE_URL}${endpoint}`, {
    headers: { 'x-internal-token': token },
  });
  const text = await res.text();
  let shape = 'non-json';

  try {
    const body = JSON.parse(text) as { rows?: unknown[] } & Record<string, unknown>;
    shape = Array.isArray(body.rows)
      ? `rows:${body.rows.length}`
      : Object.keys(body).sort().join(',');
  } catch {
    // Keep non-json shape.
  }

  console.log(`${res.status} ${endpoint} ${shape}`);
  if (!res.ok) failed = true;
}

if (failed) {
  process.exit(1);
}
