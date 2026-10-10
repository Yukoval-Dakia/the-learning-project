// YUK-577 — nudge routes: GET filters (shadow/expired/consumed/backstop) + dismiss/opened. design §3.5/§3.6.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@/core/ids';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { NUDGE_ACTION } from '../server/nudge-triggers';
import { CopilotNudgeCompanionResponseSchema } from './contracts';
import { dismissPOST, openedPOST } from './nudges';

const NOW = Date.now();

async function seedNudge(opts: {
  shadow?: boolean;
  expiresInMs?: number;
  kind?: 'ingestion_complete' | 'kc_wrong_streak';
  subjectKind?: 'learning_session' | 'knowledge';
  headline?: string;
}): Promise<string> {
  const id = newId();
  await writeEvent(testDb(), {
    id,
    actor_kind: 'agent',
    actor_ref: 'copilot_nudge_trigger',
    action: NUDGE_ACTION,
    subject_kind: opts.subjectKind ?? 'learning_session',
    subject_id: `subj_${id}`,
    payload: {
      kind: opts.kind ?? 'ingestion_complete',
      headline: opts.headline ?? 'hi',
      expires_at: new Date(NOW + (opts.expiresInMs ?? 86_400_000)).toISOString(),
      shadow: opts.shadow ?? false,
      in_active_session: false,
      evidence: {},
    },
    caused_by_event_id: `cause_${id}`,
  });
  return id;
}

describe('POST /api/copilot/nudges/[id]/{dismiss,opened}', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('opened is IDEMPOTENT: double-POST for one nudge → exactly one opened event (KPI honesty)', async () => {
    const id = await seedNudge({});
    const r1 = await openedPOST(new Request('http://x'), { id });
    const r2 = await openedPOST(new Request('http://x'), { id });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200); // dedup returns ok, not an error
    expect(CopilotNudgeCompanionResponseSchema.parse(await r1.json())).toHaveProperty('event_id');
    expect(CopilotNudgeCompanionResponseSchema.parse(await r2.json())).toEqual({
      ok: true,
      deduped: true,
    });
    const rows = await testDb()
      .select()
      .from(event)
      .where(eqAction('experimental:copilot_nudge_opened'));
    expect(rows).toHaveLength(1);
  });

  it('dismiss is IDEMPOTENT: double-POST for one nudge → exactly one dismissed event', async () => {
    const id = await seedNudge({});
    await dismissPOST(new Request('http://x'), { id });
    await dismissPOST(new Request('http://x'), { id });
    const rows = await testDb()
      .select()
      .from(event)
      .where(eqAction('experimental:copilot_nudge_dismissed'));
    expect(rows).toHaveLength(1);
  });
});

function eqAction(action: string) {
  return eq(event.action, action);
}
