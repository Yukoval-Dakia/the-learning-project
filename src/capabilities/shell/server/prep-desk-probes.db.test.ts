// YUK-567 slice-2 — loadActiveProbes read model. A probe is "active" (in the 待你试做
// queue) while its mind_probe question has no experimental:probe_result event; once
// answered it drops out. Ordered newest-first, capped at ACTIVE_PROBES_MAX.

import {
  answerProbe,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { PrepDeskProbesResponseSchema } from '@/capabilities/shell/api/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadActiveProbes } from './prep-desk-probes';

let seq = 0;
async function serve(probeMd: string, now: Date): Promise<string> {
  seq += 1;
  const served = await serveProbeOnce({
    db: testDb(),
    conjectureProposalId: `conj_${seq}`,
    knowledgeId: 'kn_x',
    probeMd,
    now,
  });
  if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);
  return served.probe_question_id;
}

describe('loadActiveProbes', () => {
  beforeEach(async () => {
    await resetDb();
    seq = 0;
  });

  it('lists served-but-unanswered probes, newest first', async () => {
    const p1 = await serve('probe A', new Date('2026-07-13T00:00:01Z'));
    const p2 = await serve('probe B', new Date('2026-07-13T00:00:02Z'));

    const { probes } = await loadActiveProbes(testDb());
    expect(() => PrepDeskProbesResponseSchema.parse({ probes })).not.toThrow();
    expect(probes.map((p) => p.probe_question_id)).toEqual([p2, p1]); // newest first
    expect(probes[0]).toMatchObject({ prompt_md: 'probe B', knowledge_id: 'kn_x' });
  });

  it('excludes answered probes (those with a probe_result event)', async () => {
    const p1 = await serve('unanswered', new Date('2026-07-13T00:00:01Z'));
    const p2 = await serve('answered', new Date('2026-07-13T00:00:02Z'));
    await answerProbe({ db: testDb(), probeQuestionId: p2, outcome: 1, resolution: 'retired' });

    const { probes } = await loadActiveProbes(testDb());
    expect(probes.map((p) => p.probe_question_id)).toEqual([p1]);
  });

  it('returns a calm empty list when there are no active probes', async () => {
    const { probes } = await loadActiveProbes(testDb());
    expect(probes).toEqual([]);
  });

  it('caps at the concurrent-probe max (3)', async () => {
    await serve('a', new Date('2026-07-13T00:00:01Z'));
    await serve('b', new Date('2026-07-13T00:00:02Z'));
    await serve('c', new Date('2026-07-13T00:00:03Z'));

    const { probes } = await loadActiveProbes(testDb());
    expect(probes).toHaveLength(3);
  });
});
