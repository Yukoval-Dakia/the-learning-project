import { describe, expect, it, vi } from 'vitest';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import {
  COPILOT_EVIDENCE_CHECKPOINT_TTL_MS,
  type CopilotEvidenceCheckpointBinding,
  bindingsEqual,
  comparisonResumeInputBlock,
  copilotEvidenceCheckpointId,
  createInMemoryCopilotEvidenceCheckpointStore,
  loadCheckpointFailClosed,
  referenceResumeInputBlock,
  rehydrateCopilotEvidenceSubmission,
} from './evidence-checkpoint';
import { REALISTIC_EVIDENCE_TRACE } from './evidence-review.actual-fixture';
import {
  type ComparisonEvidenceSubmission,
  type CopilotEvidenceLedgerRecord,
  type ReferenceEvidenceSubmission,
  buildCopilotEvidenceSourceCatalog,
  createComparisonEvidenceSubmission,
  createReferenceEvidenceSubmission,
} from './evidence-submission';

const requestUnits = [
  { index: 0, start_utf16: 0, end_utf16: 4, text: 'A01？', text_sha256: 'x0', syntax_only: false },
  { index: 1, start_utf16: 5, end_utf16: 9, text: 'A03？', text_sha256: 'x1', syntax_only: false },
];
const replyUnits = [
  { index: 0, start_utf16: 0, end_utf16: 3, text: 'ok.', text_sha256: 'r0', syntax_only: false },
  { index: 1, start_utf16: 4, end_utf16: 7, text: 'no.', text_sha256: 'r1', syntax_only: false },
];
const sourceCatalog = buildCopilotEvidenceSourceCatalog(REALISTIC_EVIDENCE_TRACE);
const outputSource = sourceCatalog.find(
  (source) =>
    source.call_index === 0 && source.side === 'output' && source.json_pointer === '/total',
);
if (!outputSource) throw new Error('fixture output source missing');
const outputSourceId = outputSource.source_id;

function referenceSubmission() {
  return createReferenceEvidenceSubmission({
    requestUnits,
    toolTrace: REALISTIC_EVIDENCE_TRACE,
    sourceCatalog,
  });
}

function comparisonSubmission() {
  return createComparisonEvidenceSubmission({
    requestUnits,
    replyUnits,
    selectedReply: 'ok. no.',
    reference: {
      output: {
        protocol_version: 1,
        evidence_points: [
          {
            point_index: 0,
            request_unit_indices: [0],
            kind: 'observed_fact',
            statement_md: 'fact',
            source_refs: [
              {
                call_index: 0,
                side: 'output',
                json_pointer: '/total',
                role: 'value',
              },
            ],
          },
        ],
        request_coverage: [
          {
            request_unit_index: 0,
            status: 'answerable',
            evidence_point_indices: [0],
          },
          {
            request_unit_index: 1,
            status: 'answerable',
            evidence_point_indices: [0],
          },
        ],
        trace_coverage: [],
        safe_reply: 'safe',
      },
      digest_sha256: 'a'.repeat(64),
    },
    toolTrace: REALISTIC_EVIDENCE_TRACE,
    sourceComplete: true,
  });
}

function baseBinding(overrides: Partial<CopilotEvidenceCheckpointBinding> = {}) {
  return {
    task_kind: 'CopilotEvidenceReviewTask' as const,
    slot: 'reference',
    protocol_version: 1,
    prompt_fingerprint: 'prompt-v1',
    base_input_sha256: 'b'.repeat(64),
    source_catalog_sha256: 'c'.repeat(64),
    binding_extras: {},
    ...overrides,
  };
}

describe('copilot evidence checkpoint binding', () => {
  it('derives a stable id from every binding field', () => {
    const binding = baseBinding();
    expect(copilotEvidenceCheckpointId(binding)).toBe(copilotEvidenceCheckpointId(binding));
    expect(copilotEvidenceCheckpointId(binding)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      copilotEvidenceCheckpointId(baseBinding({ slot: 'comparison:original:pass_1' })),
    ).not.toBe(copilotEvidenceCheckpointId(binding));
    expect(
      copilotEvidenceCheckpointId(baseBinding({ base_input_sha256: 'd'.repeat(64) })),
    ).not.toBe(copilotEvidenceCheckpointId(binding));
    expect(
      copilotEvidenceCheckpointId(baseBinding({ source_catalog_sha256: 'e'.repeat(64) })),
    ).not.toBe(copilotEvidenceCheckpointId(binding));
    expect(copilotEvidenceCheckpointId(baseBinding({ protocol_version: 2 }))).not.toBe(
      copilotEvidenceCheckpointId(binding),
    );
    expect(copilotEvidenceCheckpointId(baseBinding({ prompt_fingerprint: 'prompt-v2' }))).not.toBe(
      copilotEvidenceCheckpointId(binding),
    );
    expect(
      copilotEvidenceCheckpointId(
        baseBinding({ task_kind: 'CopilotEvidenceVerificationTask' as const }),
      ),
    ).not.toBe(copilotEvidenceCheckpointId(binding));
    expect(
      copilotEvidenceCheckpointId(
        baseBinding({ binding_extras: { selected_text_kind: 'original' } }),
      ),
    ).not.toBe(copilotEvidenceCheckpointId(binding));
  });

  it('treats any stored-binding drift as a mismatch (fail closed)', () => {
    const binding = baseBinding();
    expect(bindingsEqual(binding, baseBinding())).toBe(true);
    expect(bindingsEqual(binding, baseBinding({ protocol_version: 2 }))).toBe(false);
    expect(
      bindingsEqual(binding, baseBinding({ binding_extras: { selected_text_kind: 'original' } })),
    ).toBe(false);
    expect(bindingsEqual(binding, baseBinding({ slot: 'other' }))).toBe(false);
  });

  it('exposes an explicit multi-day TTL constant', () => {
    expect(COPILOT_EVIDENCE_CHECKPOINT_TTL_MS).toBeGreaterThanOrEqual(24 * 3600 * 1000);
  });
});

describe('copilot evidence ledger rehydration', () => {
  it('replays accepted reference records into a fresh submission with identical progress', () => {
    const first = referenceSubmission();
    const listener: CopilotEvidenceLedgerRecord[] = [];
    first.setAppendListener((record) => listener.push(record));
    expect(
      first.appendEvidencePoints({
        points: [
          {
            request_unit_indices: [0],
            kind: 'observed_fact',
            statement_md: 'fact one',
            sources: [{ source_id: outputSourceId, role: 'value' }],
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(listener).toHaveLength(1);

    const second = referenceSubmission();
    const result = rehydrateCopilotEvidenceSubmission(second, listener);
    expect(result).toEqual({ ok: true });
    expect(second.progress()).toMatchObject({ evidence_point_count: 1, safe_reply_set: false });
    // Duplicate replay of the same ledger must be rejected by the submission
    // semantics — accepted records are single ledger entries.
    expect(
      second.appendEvidencePoints({
        points: [
          {
            request_unit_indices: [0],
            kind: 'observed_fact',
            statement_md: 'fact one again',
            sources: [{ source_id: outputSourceId, role: 'value' }],
          },
        ],
      }).ok,
    ).toBe(true); // a second point is a NEW record, not a duplicate index
    expect(second.resumeState()).toMatchObject({ evidence_point_count: 2 });
  });

  it('fails closed when records no longer validate against the current submission', () => {
    const submission = referenceSubmission();
    const bogus: CopilotEvidenceLedgerRecord[] = [
      {
        kind: 'evidence_points',
        points: [
          {
            request_unit_indices: [9],
            kind: 'observed_fact',
            statement_md: 'out of range',
            sources: [{ source_id: outputSourceId, role: 'value' }],
          },
        ],
      },
    ];
    expect(rehydrateCopilotEvidenceSubmission(submission, bogus)).toMatchObject({
      ok: false,
      reason: expect.any(String),
    });
    expect(submission.progress().evidence_point_count).toBe(0);
  });

  it('replays accepted comparison checks and derives the resume block', () => {
    const first = comparisonSubmission();
    const listener: CopilotEvidenceLedgerRecord[] = [];
    first.setAppendListener((record) => listener.push(record));
    expect(
      first.appendReplyChecks({
        checks: [
          {
            reply_unit_index: 0,
            request_unit_indices: [0],
            status: 'supported',
            evidence_point_indices: [0],
            reason_codes: ['supported'],
          },
        ],
      }),
    ).toMatchObject({ ok: true });

    const second = comparisonSubmission();
    expect(rehydrateCopilotEvidenceSubmission(second, listener)).toEqual({ ok: true });
    expect(second.resumeState()).toEqual({
      reply_unit_total: 2,
      reply_check_unit_indices: [0],
    });
    expect(comparisonResumeInputBlock(second.resumeState())).toEqual({
      protocol: 'append_ledger_recovery_v1',
      accepted: { reply_unit_total: 2, reply_check_unit_indices: [0] },
    });
  });

  it('summarizes reference resume state for the model input block', () => {
    const submission = referenceSubmission();
    submission.appendEvidencePoints({
      points: [
        {
          request_unit_indices: [0],
          kind: 'observed_fact' as const,
          statement_md: 'fact',
          sources: [{ source_id: outputSourceId, role: 'value' as const }],
        },
        {
          request_unit_indices: [1],
          kind: 'observed_fact',
          statement_md: 'fact two',
          sources: [{ source_id: outputSourceId, role: 'value' }],
        },
      ],
    });
    const state = submission.resumeState();
    expect(state).toEqual({
      evidence_point_count: 2,
      evidence_points_by_request_unit: [
        { request_unit_index: 0, point_indices: [0] },
        { request_unit_index: 1, point_indices: [1] },
      ],
      not_material_call_indices: [],
      safe_reply_set: false,
    });
    expect(referenceResumeInputBlock(state)).toEqual({
      protocol: 'append_ledger_recovery_v1',
      accepted: state,
    });
  });
});

describe('in-memory copilot evidence checkpoint store', () => {
  it('persists appends, seal, and attempt audits per binding', async () => {
    const store = createInMemoryCopilotEvidenceCheckpointStore();
    const binding = baseBinding();
    store.appendRecords(binding, [
      {
        kind: 'evidence_points',
        points: [
          {
            request_unit_indices: [0],
            kind: 'observed_fact',
            statement_md: 'fact',
            sources: [{ source_id: outputSourceId, role: 'value' }],
          },
        ],
      },
    ]);
    store.recordAttempt(binding, {
      outcome: 'failed_retryable',
      failure_kind: 'budget_timeout',
      task_run_id: 'run_timeout',
      task_input_sha256: 'i'.repeat(64),
      finished_at: new Date(0).toISOString(),
    });
    const loaded = await store.load(binding);
    expect(loaded).toMatchObject({
      status: 'open',
      revision: 1,
      records: [{ kind: 'evidence_points' }],
      attempts: [{ outcome: 'failed_retryable', failure_kind: 'budget_timeout' }],
    });

    const sealed = {
      output_json: { protocol_version: 1 },
      digest_sha256: 'f'.repeat(64),
      task_run_id: 'run_success',
    };
    await expect(store.markSealed(binding, sealed)).resolves.toEqual({ status: 'ok' });
    await expect(store.verifySealedRun(binding, sealed)).resolves.toBe(true);
    await expect(store.verifySealedRun(binding, { ...sealed, task_run_id: 'other' })).resolves.toBe(
      false,
    );
    const sealedLoaded = await store.load(binding);
    expect(sealedLoaded).toMatchObject({
      status: 'sealed',
      sealed: { task_run_id: 'run_success' },
    });

    // Appends after seal are refused; a second seal of the same digest is idempotent.
    store.appendRecords(binding, [{ kind: 'safe_reply', safe_reply: 'late' }]);
    await expect(store.markSealed(binding, sealed)).resolves.toEqual({ status: 'ok' });
    const afterSeal = await store.load(binding);
    expect(afterSeal?.records).toHaveLength(1);
  });

  it('returns nothing for an absent binding and isolates bindings from each other', async () => {
    const store = createInMemoryCopilotEvidenceCheckpointStore();
    const binding = baseBinding();
    store.appendRecords(binding, [{ kind: 'safe_reply', safe_reply: 'x' }]);
    await expect(store.load(baseBinding({ slot: 'comparison:original:pass_1' }))).resolves.toBe(
      undefined,
    );
    const loaded = await store.load(binding);
    expect(loaded?.records).toEqual([{ kind: 'safe_reply', safe_reply: 'x' }]);
  });

  it('loadCheckpointFailClosed swallows store errors and binding mismatches', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createInMemoryCopilotEvidenceCheckpointStore();
    const binding = baseBinding();
    store.appendRecords(binding, [{ kind: 'safe_reply', safe_reply: 'x' }]);
    // Tamper with the stored binding: same map slot, wrong stored identity.
    store.tamperStoredBinding(binding, baseBinding({ protocol_version: 2 }));
    await expect(loadCheckpointFailClosed(store, binding)).resolves.toBeUndefined();
    const throwingStore = {
      load: async () => {
        throw new Error('db down');
      },
    };
    await expect(loadCheckpointFailClosed(throwingStore, binding)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('checkpoint ids bind the full original input hash', () => {
  it('changes whenever any bound bit changes', () => {
    const base = {
      task_kind: 'CopilotEvidenceVerificationTask' as const,
      slot: 'comparison:original:pass_1',
      protocol_version: 1,
      prompt_fingerprint: 'prompt-v1',
      base_input_sha256: sha256CanonicalJson({ a: 1 }),
      source_catalog_sha256: sha256CanonicalJson({ b: 2 }),
      binding_extras: { reference_digest_sha256: 'g'.repeat(64) },
    };
    const variants = [
      { ...base, base_input_sha256: sha256CanonicalJson({ a: 2 }) },
      { ...base, source_catalog_sha256: sha256CanonicalJson({ b: 3 }) },
      { ...base, binding_extras: { reference_digest_sha256: 'h'.repeat(64) } },
      { ...base, slot: 'comparison:blind_reference:pass_1' },
    ];
    const baseId = copilotEvidenceCheckpointId(base);
    for (const variant of variants) {
      expect(copilotEvidenceCheckpointId(variant)).not.toBe(baseId);
    }
  });
});

describe('submission listener plumbing', () => {
  it('notifies only accepted appends and supports late attachment', () => {
    const submission = referenceSubmission();
    const records: CopilotEvidenceLedgerRecord[] = [];
    submission.setAppendListener((record) => records.push(record));
    expect(
      submission.appendEvidencePoints({
        points: [
          {
            request_unit_indices: [77],
            kind: 'observed_fact',
            statement_md: 'invalid',
            sources: [{ source_id: outputSourceId, role: 'value' }],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(records).toHaveLength(0);
    const accepted = {
      points: [
        {
          request_unit_indices: [0],
          kind: 'observed_fact' as const,
          statement_md: 'valid',
          sources: [{ source_id: outputSourceId, role: 'value' as const }],
        },
      ],
    };
    submission.appendEvidencePoints(accepted);
    submission.appendEvidencePoints(accepted);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'evidence_points' });
    expect(submission.progress().evidence_point_count).toBe(1);
  });

  it('exposes the ledger record vocabulary for both submission kinds', () => {
    const reference = referenceSubmission();
    const comparison = comparisonSubmission();
    expect(typeof (reference as ReferenceEvidenceSubmission).setAppendListener).toBe('function');
    expect(typeof (comparison as ComparisonEvidenceSubmission).setAppendListener).toBe('function');
    expect(typeof reference.resumeState).toBe('function');
    expect(typeof comparison.resumeState).toBe('function');
  });
});
