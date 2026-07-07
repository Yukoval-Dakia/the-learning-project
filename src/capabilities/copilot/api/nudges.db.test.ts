import { newId } from '@/core/ids';
import { event, learning_session } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
// YUK-577 — nudge routes: GET filters (shadow/expired/consumed/backstop) + dismiss/opened. design §3.5/§3.6.
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { NUDGE_ACTION } from '../server/nudge-triggers';
import { GET, dismissPOST, openedPOST } from './nudges';

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

async function getNudgeIds(): Promise<string[]> {
  const res = await GET();
  const body = (await res.json()) as { nudges: Array<{ id: string }> };
  return body.nudges.map((n) => n.id);
}

describe('GET /api/copilot/nudges', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a fresh, non-shadow, unhandled nudge', async () => {
    const id = await seedNudge({});
    expect(await getNudgeIds()).toContain(id);
  });

  it('EXCLUDES shadow=true rows (surfacing gate)', async () => {
    const shadow = await seedNudge({ shadow: true });
    expect(await getNudgeIds()).not.toContain(shadow);
  });

  it('EXCLUDES expired rows', async () => {
    const expired = await seedNudge({ expiresInMs: -1000 });
    expect(await getNudgeIds()).not.toContain(expired);
  });

  it('EXCLUDES a nudge once dismissed', async () => {
    const id = await seedNudge({});
    await dismissPOST(new Request('http://x'), { id });
    expect(await getNudgeIds()).not.toContain(id);
  });

  it('EXCLUDES a nudge once opened', async () => {
    const id = await seedNudge({});
    await openedPOST(new Request('http://x'), { id });
    expect(await getNudgeIds()).not.toContain(id);
  });

  it('backstop: defers an interrupt-sensitive kind while a practice session is active', async () => {
    const streak = await seedNudge({ kind: 'kc_wrong_streak', subjectKind: 'knowledge' });
    const ingestion = await seedNudge({ kind: 'ingestion_complete' });
    // No active session → both shown.
    let ids = await getNudgeIds();
    expect(ids).toContain(streak);
    expect(ids).toContain(ingestion);
    // Active tutor session → streak (interrupt-sensitive) deferred; ingestion still shown.
    await testDb().insert(learning_session).values({ id: 'ls1', type: 'tutor', status: 'active' });
    ids = await getNudgeIds();
    expect(ids).not.toContain(streak);
    expect(ids).toContain(ingestion);
  });
});

describe('POST /api/copilot/nudges/[id]/{dismiss,opened}', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('dismiss writes a dismissed event anchored to the nudge', async () => {
    const id = await seedNudge({});
    const res = await dismissPOST(new Request('http://x'), { id });
    expect(res.status).toBe(200);
    const rows = await testDb()
      .select()
      .from(event)
      .where(eqAction('experimental:copilot_nudge_dismissed'));
    expect(rows).toHaveLength(1);
    expect(rows[0].caused_by_event_id).toBe(id);
  });

  it('opened writes an opened event anchored to the nudge', async () => {
    const id = await seedNudge({});
    await openedPOST(new Request('http://x'), { id });
    const rows = await testDb()
      .select()
      .from(event)
      .where(eqAction('experimental:copilot_nudge_opened'));
    expect(rows).toHaveLength(1);
    expect(rows[0].caused_by_event_id).toBe(id);
  });

  it('404 on an unknown nudge id (no orphan companion write)', async () => {
    const res = await dismissPOST(new Request('http://x'), { id: 'nope' });
    expect(res.status).toBe(404);
    const rows = await testDb()
      .select()
      .from(event)
      .where(eqAction('experimental:copilot_nudge_dismissed'));
    expect(rows).toHaveLength(0);
  });
});

function eqAction(action: string) {
  return eq(event.action, action);
}
