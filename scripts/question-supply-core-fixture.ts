import type { ScanInput } from '@/capabilities/practice/public';

process.env.DATABASE_URL ??= 'postgres://fixture:fixture@127.0.0.1:1/fixture';
const { planSupplyRoutes, scanCoverageGaps } = await import('@/capabilities/practice/public');

let nextId = 0;
const input = {
  frontier: [
    {
      knowledgeId: 'kc-math-empty',
      subjectId: 'math',
      thetaHat: 0.25,
      thetaPrecision: 1,
      evidenceCount: 0,
    },
    {
      knowledgeId: 'kc-yuwen-thin',
      subjectId: 'yuwen',
      thetaHat: 0,
      thetaPrecision: 1,
      evidenceCount: 3,
    },
  ],
  questions: [
    {
      id: 'q-yuwen-low',
      kind: 'fill_blank',
      source: 'quiz_gen',
      metadata: { quiz_gen: { generation_method: 'closed_book' } },
      difficulty: 3,
      calibrationB: null,
      knowledgeIds: ['kc-yuwen-thin'],
    },
  ],
  routePreferenceBySubject: {
    math: ['quiz_gen', 'sourcing_web'],
    yuwen: ['sourcing_web'],
  },
  generationMethodBySubject: { math: 'closed_book' },
  evidenceDemandControl: {
    neededBy: '2026-08-21T00:00:00.000Z',
    maxBudgetMicroUsd: 750_000,
    maxAttempts: 2,
  },
} satisfies ScanInput;

const targets = scanCoverageGaps(input, () => `fixture-${nextId++}`);
process.stdout.write(
  `${JSON.stringify(
    { targets, routes: targets.map((target) => planSupplyRoutes(target)) },
    null,
    2,
  )}\n`,
);
