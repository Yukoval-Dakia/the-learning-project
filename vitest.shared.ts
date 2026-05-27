import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const resolveConfig = {
  alias: { '@': path.resolve(__dirname, 'src') },
};

export const allTestInclude = [
  '*.test.ts',
  'src/**/*.test.ts',
  'app/**/*.test.ts',
  'workers/src/**/*.test.ts',
  'tests/**/*.test.ts',
  'scripts/**/*.test.ts',
];

export const fastTestInclude = [
  'middleware.test.ts',
  'scripts/**/*.test.ts',
  'src/__tests__/**/*.test.ts',
  'src/ai/**/*.test.ts',
  'src/core/**/*.test.ts',
  'src/server/ai/judges/**/*.test.ts',
  'src/server/ai/tools/registry.test.ts',
  'src/server/ai/tools/mcp-bridge.test.ts',
  'src/server/events/cause-policy.test.ts',
  'src/server/export/**/*.test.ts',
  'src/server/http/**/*.test.ts',
  'src/server/ingestion/crop.test.ts',
  'src/server/ingestion/figure_attach.test.ts',
  'src/server/ingestion/tencent_mark.test.ts',
  'src/server/ingestion/tencent_mark_parser.test.ts',
  'src/server/ingestion/vision.test.ts',
  'src/server/judge/**/*.test.ts',
  'src/server/r2.test.ts',
  'src/server/review/activity-ref.test.ts',
  'src/server/review/fsrs.test.ts',
  'src/server/review/rating-advisor.test.ts',
  'src/server/session/guards.test.ts',
  'src/server/session/index.test.ts',
  'src/subjects/math/fixtures/index.test.ts',
  'src/subjects/math/fixtures/derivation.test.ts',
  'src/subjects/math/fixtures/derivation-with-images.test.ts',
  'src/subjects/physics/fixtures/schema.test.ts',
  'src/ui/**/*.test.ts',
  'src/ui/**/*.test.tsx',
  'app/api/ai/*/route.test.ts',
  'app/api/study-log/route.test.ts',
  'tests/core/**/*.test.ts',
  'tests/schema/**/*.test.ts',
  'tests/subjects/**/*.test.ts',
  'tests/integration/judge-gap-audit.test.ts',
  'tests/integration/session-single-owner.test.ts',
  'tests/integration/step12-docs-invariant.test.ts',
  'tests/integration/step9-invariant-audit.test.ts',
];

export const migrationSmokeInclude = ['tests/integration/migration-smoke.test.ts'];

export const sharedExclude = configDefaults.exclude;
