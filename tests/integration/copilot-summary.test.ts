// Wave 5 / T-D3/B — db-level coverage for `/api/today/copilot-summary`
// reader. Verifies the four "first paint" slots: Coach daily_focus,
// review_due_count (FSRS), brief_global_md (memory_brief_note), dreaming
// preview. Each test seeds the minimum row set and asserts the resulting
// `CopilotSummary` shape.

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, material_fsrs_state, memory_brief_note, question } from '@/db/schema';
import { loadCopilotSummary } from '@/server/today/copilot-summary';

import { resetDb, testDb } from '../helpers/db';

// Use a past timestamp for FSRS due_at so executeGetReviewDue sees the rows
// as overdue without us having to override "now".
const FIXTURE_NOW = new Date('2020-01-01T00:00:00.000Z');

async function seedFsrsRow(opts: { questionId: string; dueAt: Date }) {
  const db = testDb();
  await db.insert(question).values({
    id: opts.questionId,
    kind: 'short_answer',
    prompt_md: `prompt for ${opts.questionId}`,
    reference_md: 'reference',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
    version: 0,
  });
  await db.insert(material_fsrs_state).values({
    id: `fsrs_${opts.questionId}`,
    subject_kind: 'question',
    subject_id: opts.questionId,
    state: {
      due: opts.dueAt,
      stability: 1,
      difficulty: 4,
      elapsed_days: 0,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      state: 'review',
      last_review: FIXTURE_NOW,
    },
    due_at: opts.dueAt,
    last_review_event_id: null,
    updated_at: FIXTURE_NOW,
  });
}

async function seedGlobalBrief(recent_week_md: string) {
  const db = testDb();
  await db.insert(memory_brief_note).values({
    id: `brief_${createId()}`,
    scope_key: 'global',
    subject_id: null,
    recent_week_md,
    recent_months_md: '',
    long_term_md: '',
    recent_week_evidence_ids: [],
    recent_months_evidence_ids: [],
    long_term_evidence_ids: [],
    source_event_id: null,
    latest_evidence_at: null,
    evidence_count: 0,
    refreshed_at: FIXTURE_NOW,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
    version: 0,
  });
}

async function seedCoachScanEvent(opts: { daily_focus: string; today_plan?: unknown }) {
  const db = testDb();
  await db.insert(event).values({
    id: `evt_coach_${createId()}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'coach',
    action: 'experimental:coach_scan',
    subject_kind: 'query',
    subject_id: 'trigger_xyz',
    outcome: 'success',
    payload: {
      run_kind: 'daily',
      proposals_created: 0,
      pending_after: 0,
      daily_focus: opts.daily_focus,
      ...(opts.today_plan !== undefined ? { today_plan: opts.today_plan } : {}),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: FIXTURE_NOW,
  });
}

describe('loadCopilotSummary (db)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns zero counts + placeholder + null brief on an empty database', async () => {
    const summary = await loadCopilotSummary(testDb());

    expect(summary.daily_focus).toContain('Coach');
    expect(summary.plan_adjustments_count).toBeNull();
    expect(summary.review_due_count).toBe(0);
    expect(summary.brief_global_md).toBeNull();
    expect(summary.dreaming_preview).toEqual([]);
    expect(summary.pending_proposals_total).toBe(0);
    expect(summary.coach_last_run_at).toBeNull();
    expect(summary.dreaming_last_run_at).toBeNull();
  });

  it('counts overdue FSRS questions but ignores future-due rows', async () => {
    // Past relative to real wall-clock so executeGetReviewDue treats them
    // as overdue. Future is far enough out (year 2099) that it never
    // matches even on a busy CI host.
    const past = new Date('2020-01-01T00:00:00.000Z');
    const future = new Date('2099-01-01T00:00:00.000Z');
    await seedFsrsRow({ questionId: 'q_overdue_1', dueAt: past });
    await seedFsrsRow({ questionId: 'q_overdue_2', dueAt: past });
    await seedFsrsRow({ questionId: 'q_future', dueAt: future });

    const summary = await loadCopilotSummary(testDb());

    expect(summary.review_due_count).toBe(2);
  });

  it("returns first paragraph of memory_brief_note scope_key='global' capped at 280 chars", async () => {
    const longBody = `${'A'.repeat(400)}\n\nsecond paragraph that should be ignored entirely.`;
    await seedGlobalBrief(longBody);

    const summary = await loadCopilotSummary(testDb());

    expect(summary.brief_global_md).toBe('A'.repeat(280));
  });

  it('returns null brief_global_md when only non-global scope rows exist', async () => {
    const db = testDb();
    await db.insert(memory_brief_note).values({
      id: `brief_${createId()}`,
      scope_key: 'subject:wenyan',
      subject_id: null,
      recent_week_md: 'wenyan-specific brief',
      recent_months_md: '',
      long_term_md: '',
      recent_week_evidence_ids: [],
      recent_months_evidence_ids: [],
      long_term_evidence_ids: [],
      source_event_id: null,
      latest_evidence_at: null,
      evidence_count: 0,
      refreshed_at: FIXTURE_NOW,
      created_at: FIXTURE_NOW,
      updated_at: FIXTURE_NOW,
      version: 0,
    });

    const summary = await loadCopilotSummary(testDb());

    expect(summary.brief_global_md).toBeNull();
  });

  it('returns null brief_global_md when global brief has empty recent_week_md', async () => {
    await seedGlobalBrief('');

    const summary = await loadCopilotSummary(testDb());

    expect(summary.brief_global_md).toBeNull();
  });

  it('uses Coach event daily_focus (top-level payload field) when present', async () => {
    await seedCoachScanEvent({ daily_focus: '今天复盘上周的「之、其、于」' });

    const summary = await loadCopilotSummary(testDb());

    expect(summary.daily_focus).toBe('今天复盘上周的「之、其、于」');
    expect(summary.coach_last_run_at).toBe(FIXTURE_NOW.toISOString());
  });

  it('derives plan_adjustments_count from payload.today_plan when arrays present', async () => {
    await seedCoachScanEvent({
      daily_focus: 'focus',
      today_plan: {
        daily_focus: 'focus',
        review_session_proposal: { count: 5, estimated_minutes: 10 },
        plan_adjustments: [
          { kind: 'defer', learning_item_id: 'li_1' },
          { kind: 'split', learning_item_id: 'li_2' },
        ],
        maintenance_proposals: [{ kind: 'knowledge_node', payload: {} }],
      },
    });

    const summary = await loadCopilotSummary(testDb());

    expect(summary.plan_adjustments_count).toBe(3);
  });

  it('falls back to payload.today_plan.daily_focus when top-level daily_focus missing', async () => {
    await seedCoachScanEvent({
      daily_focus: '', // empty top-level
      today_plan: {
        daily_focus: '通过 today_plan 渠道获得的 focus',
        review_session_proposal: { count: 0, estimated_minutes: 0 },
        plan_adjustments: [],
        maintenance_proposals: [],
      },
    });
    // Overwrite to remove the empty top-level daily_focus to mirror the
    // legacy-payload scenario.
    const db = testDb();
    await db.delete(event);
    await db.insert(event).values({
      id: `evt_coach_${createId()}`,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'coach',
      action: 'experimental:coach_scan',
      subject_kind: 'query',
      subject_id: 'trigger_xyz',
      outcome: 'success',
      payload: {
        run_kind: 'daily',
        proposals_created: 0,
        pending_after: 0,
        today_plan: {
          daily_focus: '通过 today_plan 渠道获得的 focus',
          review_session_proposal: { count: 0, estimated_minutes: 0 },
          plan_adjustments: [],
          maintenance_proposals: [],
        },
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: FIXTURE_NOW,
    });

    const summary = await loadCopilotSummary(testDb());

    expect(summary.daily_focus).toBe('通过 today_plan 渠道获得的 focus');
  });

  it('combines coach focus + review_due + brief in a single 4-slot snapshot', async () => {
    await seedCoachScanEvent({ daily_focus: '今天先把听写错的字补回来' });
    await seedFsrsRow({
      questionId: 'q_due',
      dueAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    await seedGlobalBrief('整体上：你这周对结构助词更熟，但对代词指代仍偶有混淆。');

    const summary = await loadCopilotSummary(testDb());

    expect(summary.daily_focus).toBe('今天先把听写错的字补回来');
    expect(summary.review_due_count).toBe(1);
    expect(summary.brief_global_md).toBe('整体上：你这周对结构助词更熟，但对代词指代仍偶有混淆。');
    expect(summary.coach_last_run_at).toBe(FIXTURE_NOW.toISOString());
  });
});
