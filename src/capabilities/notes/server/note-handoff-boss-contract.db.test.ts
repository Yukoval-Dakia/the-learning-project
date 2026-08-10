import { randomUUID } from 'node:crypto';

import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  NOTE_GENERATION_SINGLETON_SECONDS,
  NOTE_HANDOFF_KINDS,
  noteHandoffJobId,
} from './note-handoff';

const TEST_SCHEMA = `pgboss_yuk857_handoff_${process.pid}`;

let boss: PgBoss;

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  boss = new PgBoss({ connectionString, schema: TEST_SCHEMA, max: 2 });
  await boss.start();
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
});

describe('Notes generation pg-boss rollout contract', () => {
  it('keeps a legacy random-id singleton job authoritative over deterministic replacement', async () => {
    const queue = `yuk857_note_generate_${randomUUID()}`;
    const artifactId = `rollout-note-${randomUUID()}`;
    const legacyJobId = randomUUID();
    const deterministicJobId = noteHandoffJobId(NOTE_HANDOFF_KINDS.generationIntent, artifactId);
    await boss.createQueue(queue);

    await expect(
      boss.send(
        queue,
        { artifact_id: artifactId },
        {
          id: legacyJobId,
          singletonKey: artifactId,
          singletonSeconds: NOTE_GENERATION_SINGLETON_SECONDS,
        },
      ),
    ).resolves.toBe(legacyJobId);

    await expect(
      boss.send(
        queue,
        { artifact_id: artifactId },
        {
          id: deterministicJobId,
          singletonKey: artifactId,
          singletonSeconds: NOTE_GENERATION_SINGLETON_SECONDS,
        },
      ),
    ).resolves.toBeNull();
    await expect(boss.getJobById(queue, legacyJobId)).resolves.toMatchObject({ state: 'created' });
    await expect(boss.getJobById(queue, deterministicJobId)).resolves.toBeNull();
  });
});
