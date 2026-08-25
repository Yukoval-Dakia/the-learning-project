import type { Violation } from './green-bridge-pins.mjs';

export type { Violation } from './green-bridge-pins.mjs';

export type UsabilityManifest = {
  schema_version: 1;
  mode: 'usability-lane';
  status: 'ok' | 'failed';
  generated_at: string;
  build: {
    number: string | null;
    pipeline: string | null;
    branch: string | null;
    commit: string | null;
  };
  chromium: {
    launched: boolean | null;
    browser: string | null;
    version: string | null;
    headless: boolean | null;
    error: string | null;
  } | null;
  scenarios:
    | ({
        total: number;
        expected: number;
        unexpected: number;
        flaky: number;
        skipped: number;
        ok?: boolean;
      } & { expected_total: 13 })
    | { expected_total: 13 };
  image: {
    state: string | null;
    digest: string | null;
    base_ref: string | null;
    base_digest: string | null;
    playwright_version: string | null;
  };
  cutover_ready: boolean;
  violations: Violation[];
};

export function buildManifest(input: {
  probe: unknown;
  reportText: string | null;
  pinsText: string | null;
  env?: Record<string, string | undefined>;
  now?: Date;
}): UsabilityManifest;

export function validateManifest(manifest: unknown): Violation[];
