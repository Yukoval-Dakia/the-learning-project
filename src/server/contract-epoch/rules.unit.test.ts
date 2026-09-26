// YUK-1055 — contract-epoch 纯规则单测（rules.ts / jobs.ts 零 import → unit 分区）。

import { describe, expect, it } from 'vitest';
import { jobEpochDisposition } from './jobs';
import { ContractEpochFenceError, gateContractEpoch, validateEpochTransition } from './rules';

describe('gateContractEpoch', () => {
  it('absent marker → implicit legacy/active → runnable', () => {
    expect(gateContractEpoch(null)).toEqual({
      runnable: true,
      marker: { epoch: 'legacy', state: 'active' },
    });
  });

  it('(legacy, active) marker → runnable for legacy code', () => {
    const v = gateContractEpoch({ epoch: 'legacy', state: 'active' });
    expect(v.runnable).toBe(true);
  });

  it('preparing → maintenance fence regardless of epoch', () => {
    for (const epoch of ['legacy', 'assessment-contract-v1']) {
      const v = gateContractEpoch({ epoch, state: 'preparing' });
      expect(v).toMatchObject({ runnable: false, reason: 'maintenance' });
    }
    // 新代码也 fenced（post-cutover app 不在维护窗内跑旧数据）。
    expect(
      gateContractEpoch({ epoch: 'legacy', state: 'preparing' }, 'assessment-contract-v1'),
    ).toMatchObject({ runnable: false, reason: 'maintenance' });
  });

  it('ready → still fenced (安静窗口，未激活)', () => {
    expect(gateContractEpoch({ epoch: 'assessment-contract-v1', state: 'ready' })).toMatchObject({
      runnable: false,
      reason: 'maintenance',
    });
  });

  it('active + epoch mismatch → epoch_mismatch fence', () => {
    // 新代码在 legacy DB 上：fenced。
    expect(
      gateContractEpoch({ epoch: 'legacy', state: 'active' }, 'assessment-contract-v1'),
    ).toMatchObject({ runnable: false, reason: 'epoch_mismatch' });
    // 本代码（legacy）在新 epoch DB 上：stale worker 被拒。
    expect(gateContractEpoch({ epoch: 'assessment-contract-v1', state: 'active' })).toMatchObject({
      runnable: false,
      reason: 'epoch_mismatch',
    });
  });

  it('active + epoch match → runnable', () => {
    expect(
      gateContractEpoch(
        { epoch: 'assessment-contract-v1', state: 'active' },
        'assessment-contract-v1',
      ).runnable,
    ).toBe(true);
  });
});

describe('validateEpochTransition', () => {
  const cur = (epoch: string, state: 'preparing' | 'ready' | 'active') => ({ epoch, state });

  it('begin_prepare is always allowed (安全方向)', () => {
    for (const state of ['active', 'preparing', 'ready'] as const) {
      expect(
        validateEpochTransition(cur('legacy', state), 'begin_prepare', 'legacy'),
      ).toMatchObject({ ok: true, next: { epoch: 'legacy', state: 'preparing' } });
    }
    // cutover 起点：(legacy, active) → (assessment-contract-v1, preparing)
    expect(
      validateEpochTransition(cur('legacy', 'active'), 'begin_prepare', 'assessment-contract-v1'),
    ).toMatchObject({ ok: true, next: { epoch: 'assessment-contract-v1', state: 'preparing' } });
    // 首个 marker（空表）只能 begin_prepare。
    expect(validateEpochTransition(null, 'begin_prepare', 'legacy')).toMatchObject({ ok: true });
  });

  it('mark_ready requires preparing; epoch switch lands here', () => {
    expect(
      validateEpochTransition(cur('legacy', 'preparing'), 'mark_ready', 'assessment-contract-v1'),
    ).toMatchObject({ ok: true, next: { epoch: 'assessment-contract-v1', state: 'ready' } });
    expect(
      validateEpochTransition(cur('legacy', 'active'), 'mark_ready', 'assessment-contract-v1'),
    ).toMatchObject({ ok: false, error: 'ready_requires_preparing' });
    // 幂等：同 epoch ready→ready 允许（重复核验报告）。
    expect(validateEpochTransition(cur('x', 'ready'), 'mark_ready', 'x')).toMatchObject({
      ok: true,
    });
  });

  it('activate: same-epoch from preparing|ready; cross-epoch requires ready', () => {
    expect(validateEpochTransition(cur('legacy', 'preparing'), 'activate', 'legacy')).toMatchObject(
      { ok: true, next: { epoch: 'legacy', state: 'active' } },
    );
    expect(
      validateEpochTransition(
        cur('assessment-contract-v1', 'ready'),
        'activate',
        'assessment-contract-v1',
      ),
    ).toMatchObject({ ok: true, next: { epoch: 'assessment-contract-v1', state: 'active' } });
    // 换 epoch 激活必须经 ready。
    expect(
      validateEpochTransition(cur('legacy', 'preparing'), 'activate', 'assessment-contract-v1'),
    ).toMatchObject({ ok: false, error: 'activate_new_epoch_requires_ready' });
    // 已 active 不重复落行。
    expect(validateEpochTransition(cur('legacy', 'active'), 'activate', 'legacy')).toMatchObject({
      ok: false,
      error: 'noop_active_to_active',
    });
  });
});

describe('jobEpochDisposition', () => {
  it('drain: epoch-agnostic housekeeping / pure triggers', () => {
    for (const q of [
      'echo',
      'prune_job_events',
      'prune_orphan_review_sessions',
      'prune_orphan_conversation_sessions',
      'prune_orphan_placement_sessions',
      'promote_conversation_idle',
      'event_subscription_dispatch',
      'nightly_orchestrator',
      'ai_task_run_reconcile_nightly',
      'copilot_run_reconcile',
      'memory_event_ingest',
      'memory_brief_regen',
      'memory_brief_sweep',
      'memory_ingest_outbox_poll',
      'memory_ingest_outbox_recover',
      'memory_reconcile',
      'projection_oracle_sweep',
      'subject_profile_audit_nightly',
      'merge_attribution_sweep',
      'kg_borrow_shadow_sweep',
      'hub_auto_sync_nightly',
      'hub_sync_mutation_wake',
      'hub_sync_recovery',
      'note_verify',
      'note_generate',
      'note_refine',
      'jyeoo_staged_asset_reap',
    ]) {
      expect(jobEpochDisposition(q), q).toBe('drain');
    }
  });

  it('translate: old-contract durable payloads (judge/verify/supply/ingest/calibration)', () => {
    for (const q of [
      'judge_run',
      'judge_pending_reconcile',
      'rejudge',
      'judge_calibration_sample',
      'quiz_gen',
      'quiz_verify',
      'source_verify',
      'variant_gen',
      'variant_verify',
      'supply_execute',
      'supply_planner',
      'question_supply_nightly',
      'verify_dispatch_recover',
      'attribution_followup',
      'reference_answer_backfill',
      'answer_class_backfill',
      'prepare_intervention',
      'intervention_prepare_recovery',
      'ingestion_operation',
      'auto_enroll',
      'tencent_ocr_extract',
      'item_prior_backfill',
      'recalibration_nightly',
      'kt_estimate_nightly',
      'axis_state_nightly',
      'embed_backfill',
      'kc_dedup_nightly',
      'confusable_contrast_nightly',
      'practice_stream_compose_nightly',
      'copilot_run',
      'session_summary',
      'coach_daily',
      'coach_weekly',
      'dreaming_nightly',
      'goal_scope_propose_nightly',
      'research_meeting_nightly',
      'research_meeting_agent_nightly',
      'frontier_fill_nightly',
      'knowledge_edge_propose_nightly',
      'knowledge_maintenance_nightly',
    ]) {
      expect(jobEpochDisposition(q), q).toBe('translate');
    }
  });

  it('fenced: fail-closed default for unlisted queues and all *_dlq', () => {
    expect(jobEpochDisposition('some_future_queue')).toBe('fenced');
    expect(jobEpochDisposition('memory_event_ingest_dlq')).toBe('fenced');
    expect(jobEpochDisposition('quiz_verify_dlq')).toBe('fenced');
  });
});

describe('ContractEpochFenceError', () => {
  it('carries deterministic surface/marker/reason', () => {
    const err = new ContractEpochFenceError('job:judge_run', {
      runnable: false,
      marker: { epoch: 'legacy', state: 'preparing' },
      reason: 'maintenance',
    });
    expect(err.name).toBe('ContractEpochFenceError');
    expect(err.message).toContain('job:judge_run');
    expect(err.message).toContain('legacy/preparing');
    expect(err.reason).toBe('maintenance');
  });
});
