// YUK-710 (P0F/6) — unit tests for the PURE teaching-brief survival report computation.
//
// Pins the report math against hand-built fixtures: empty DB, a single seen, and a full seen →
// action → outcome chain. No DB import → runs in the unit partition (scripts/**/*.test.ts is
// matched by the fast/unit include; the DB-touching loader in report-teaching-brief.ts is NOT
// imported here). The reporting-honesty invariants (n/a on 0 denominator, sample counts, no
// negative time-to-action) are asserted directly.

import { describe, expect, it } from 'vitest';
import {
  type TeachingBriefReportInput,
  computeTeachingBriefReport,
  formatTeachingBriefReport,
  parseCliFlag,
} from './lib/teaching-brief-report';

function emptyInput(from = '2026-07-06', to = '2026-07-19'): TeachingBriefReportInput {
  return {
    from,
    to,
    briefSeen: [],
    primaryActions: [],
    acks: [],
    decisions: [],
    probesServed: [],
    probeResults: [],
    skippedCorruptOutcomes: 0,
  };
}

describe('computeTeachingBriefReport (YUK-710)', () => {
  it('empty window → zero counts and n/a rates (never a fake 0%)', () => {
    const report = computeTeachingBriefReport(emptyInput());
    expect(report.window).toEqual({ from: '2026-07-06', to: '2026-07-19' });
    expect(report.days_with_briefs).toBe(0);
    expect(report.brief_days_seen).toBe(0);
    expect(report.total_brief_seen_events).toBe(0);
    // n/a, not 0%: denominator 0 ⇒ rate null.
    expect(report.brief_to_action).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(report.probe_completion.rate).toBeNull();
    expect(report.confirmed_to_scoped_practice.rate).toBeNull();
    expect(report.time_to_action.count).toBe(0);
    expect(report.time_to_action.median_ms).toBeNull();
    expect(report.decisions).toEqual({ accept: 0, edit: 0, dismiss: 0 });
    // Honest formatting: the empty report reads "n/a" and "no paired samples", not zeros.
    const text = formatTeachingBriefReport(report);
    expect(text).toContain('n/a (0 denominator)');
    expect(text).toContain('no paired samples');
  });

  it('single seen, no action → 1 day, brief→action 0/1 (rate 0), no paired time-to-action', () => {
    const input = emptyInput();
    input.briefSeen = [
      { brief_id: 'b1', local_day: '2026-07-10', seen_at: '2026-07-10T01:00:00.000Z' },
    ];
    const report = computeTeachingBriefReport(input);
    expect(report.days_with_briefs).toBe(1);
    expect(report.brief_days_seen).toBe(1);
    // A real 0 (seen but nobody acted) — denominator 1 ⇒ rate 0, distinct from the n/a above.
    expect(report.brief_to_action).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(report.total_action_starts).toBe(0);
    expect(report.time_to_action.count).toBe(0);
  });

  it('a repeated seen on the same brief × day collapses to one brief-day but two raw events', () => {
    const input = emptyInput();
    input.briefSeen = [
      { brief_id: 'b1', local_day: '2026-07-10', seen_at: '2026-07-10T01:00:00.000Z' },
      { brief_id: 'b1', local_day: '2026-07-10', seen_at: '2026-07-10T05:00:00.000Z' },
    ];
    const report = computeTeachingBriefReport(input);
    expect(report.brief_days_seen).toBe(1);
    expect(report.days_with_briefs).toBe(1);
    expect(report.total_brief_seen_events).toBe(2);
  });

  it('full chain: seen → action same day → outcome → scoped practice', () => {
    const input: TeachingBriefReportInput = {
      from: '2026-07-06',
      to: '2026-07-19',
      briefSeen: [
        { brief_id: 'b1', local_day: '2026-07-10', seen_at: '2026-07-10T01:00:00.000Z' },
        { brief_id: 'b2', local_day: '2026-07-11', seen_at: '2026-07-11T02:00:00.000Z' },
      ],
      acks: [],
      primaryActions: [
        // b1 accepted 90s after being seen.
        {
          brief_id: 'b1',
          action_kind: 'accept_probe',
          local_day: '2026-07-10',
          started_at: '2026-07-10T01:01:30.000Z',
        },
        // b1 later confirmed → scoped practice, joined to its probe_result id.
        {
          brief_id: 'b1',
          action_kind: 'scoped_practice',
          local_day: '2026-07-10',
          started_at: '2026-07-10T03:00:00.000Z',
          result_event_id: 'res_confirmed',
        },
      ],
      decisions: [{ kind: 'accept' }, { kind: 'edit' }, { kind: 'dismiss' }, { kind: 'dismiss' }],
      probesServed: [
        { probe_question_id: 'q1', has_result: true },
        { probe_question_id: 'q2', has_result: false },
      ],
      probeResults: [
        { result_event_id: 'res_confirmed', resolution: 'confirmed' },
        { result_event_id: 'res_retired', resolution: 'retired' },
      ],
      skippedCorruptOutcomes: 0,
    };
    const report = computeTeachingBriefReport(input);

    expect(report.days_with_briefs).toBe(2);
    expect(report.brief_days_seen).toBe(2);
    // b1 acted, b2 did not → 1 of 2.
    expect(report.brief_to_action).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(report.total_action_starts).toBe(2);
    expect(report.action_starts_by_kind).toEqual({
      accept_probe: 1,
      answer_probe: 0,
      scoped_practice: 1,
    });
    expect(report.decisions).toEqual({ accept: 1, edit: 1, dismiss: 2 });
    expect(report.probes_served).toBe(2);
    expect(report.probe_completion).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(report.outcomes).toEqual({ confirmed: 1, retired: 1 });
    // 1 confirmed, and it had a scoped_practice start joined by result_event_id.
    expect(report.confirmed_to_scoped_practice).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
    // Earliest action on b1 × 2026-07-10 was accept_probe, 90_000 ms after the seen.
    expect(report.time_to_action.count).toBe(1);
    expect(report.time_to_action.median_ms).toBe(90_000);
    expect(report.time_to_action.min_ms).toBe(90_000);
    expect(report.time_to_action.max_ms).toBe(90_000);
    expect(report.time_to_action.unpaired_action_brief_days).toBe(0);
  });

  it('a confirmed outcome with no scoped-practice start → 0/1, not a fake success', () => {
    const input = emptyInput();
    input.probeResults = [{ result_event_id: 'res_c', resolution: 'confirmed' }];
    const report = computeTeachingBriefReport(input);
    expect(report.confirmed_to_scoped_practice).toEqual({ numerator: 0, denominator: 1, rate: 0 });
  });

  it('an action with no matching same-day seen is counted as unpaired, not a negative latency', () => {
    const input = emptyInput();
    input.briefSeen = [
      { brief_id: 'b1', local_day: '2026-07-10', seen_at: '2026-07-10T01:00:00.000Z' },
    ];
    input.primaryActions = [
      // Same brief but a DIFFERENT day than any seen → unpairable.
      {
        brief_id: 'b1',
        action_kind: 'answer_probe',
        local_day: '2026-07-12',
        started_at: '2026-07-12T01:00:00.000Z',
      },
    ];
    const report = computeTeachingBriefReport(input);
    expect(report.time_to_action.count).toBe(0);
    expect(report.time_to_action.unpaired_action_brief_days).toBe(1);
    // The 07-10 seen had no action; the 07-12 action had no seen → 0 of 1 brief-days converted.
    expect(report.brief_to_action).toEqual({ numerator: 0, denominator: 1, rate: 0 });
  });

  it('time-to-action median is the middle of an odd sample and the mean of an even one', () => {
    const input = emptyInput();
    input.briefSeen = [
      { brief_id: 'b1', local_day: '2026-07-10', seen_at: '2026-07-10T00:00:00.000Z' },
      { brief_id: 'b2', local_day: '2026-07-10', seen_at: '2026-07-10T00:00:00.000Z' },
      { brief_id: 'b3', local_day: '2026-07-10', seen_at: '2026-07-10T00:00:00.000Z' },
    ];
    input.primaryActions = [
      {
        brief_id: 'b1',
        action_kind: 'accept_probe',
        local_day: '2026-07-10',
        started_at: '2026-07-10T00:00:10.000Z',
      },
      {
        brief_id: 'b2',
        action_kind: 'accept_probe',
        local_day: '2026-07-10',
        started_at: '2026-07-10T00:00:20.000Z',
      },
      {
        brief_id: 'b3',
        action_kind: 'accept_probe',
        local_day: '2026-07-10',
        started_at: '2026-07-10T00:00:30.000Z',
      },
    ];
    const report = computeTeachingBriefReport(input);
    expect(report.time_to_action.count).toBe(3);
    expect(report.time_to_action.median_ms).toBe(20_000);
    expect(report.time_to_action.min_ms).toBe(10_000);
    expect(report.time_to_action.max_ms).toBe(30_000);
  });

  it('drops an unrecognized action_kind (no NaN phantom key; by-kind sum equals total)', () => {
    const input = emptyInput();
    input.primaryActions = [
      {
        brief_id: 'b1',
        action_kind: 'accept_probe',
        local_day: '2026-07-10',
        started_at: '2026-07-10T00:00:10.000Z',
      },
      // A malformed / injected kind (cast past the type) must be dropped, not counted.
      {
        brief_id: 'b1',
        action_kind: 'totally_bogus' as unknown as 'accept_probe',
        local_day: '2026-07-10',
        started_at: '2026-07-10T00:00:20.000Z',
      },
    ];
    const report = computeTeachingBriefReport(input);
    expect(report.total_action_starts).toBe(1);
    expect(report.skipped_unrecognized_action_rows).toBe(1);
    // No NaN phantom key: the three known kinds sum to exactly total_action_starts.
    const byKindSum =
      report.action_starts_by_kind.accept_probe +
      report.action_starts_by_kind.answer_probe +
      report.action_starts_by_kind.scoped_practice;
    expect(byKindSum).toBe(report.total_action_starts);
    expect(Object.keys(report.action_starts_by_kind)).toEqual([
      'accept_probe',
      'answer_probe',
      'scoped_practice',
    ]);
    // The skipped count is surfaced as missing data in the text report.
    expect(formatTeachingBriefReport(report)).toContain('unrecognized action_kind');
  });

  it('surfaces skipped_corrupt_outcomes as missing data, excluded from the outcome counts', () => {
    const input = emptyInput();
    // The loader dropped 3 chain-broken probe_results; only 1 deliverable confirmed outcome remains.
    input.skippedCorruptOutcomes = 3;
    input.probeResults = [{ result_event_id: 'res_c', resolution: 'confirmed' }];
    const report = computeTeachingBriefReport(input);
    expect(report.skipped_corrupt_outcomes).toBe(3);
    // The dropped rows never inflate confirmed/retired (the whole point of the round-4 fix).
    expect(report.outcomes).toEqual({ confirmed: 1, retired: 0 });
    expect(formatTeachingBriefReport(report)).toContain('broken chain');
  });

  it('counts an outcome ack as an action so a retired brief-day registers as converted', () => {
    const input = emptyInput();
    input.briefSeen = [
      { brief_id: 'b1', local_day: '2026-07-10', seen_at: '2026-07-10T01:00:00.000Z' },
    ];
    // A retired outcome offers no primary_action_started — only the "知道了" ack (BRIEF_ACK_ACTION).
    input.acks = [
      { brief_id: 'b1', local_day: '2026-07-10', acknowledged_at: '2026-07-10T01:02:00.000Z' },
    ];
    const report = computeTeachingBriefReport(input);
    // The ack makes the seen brief-day count as converted (1/1); without it a retired day would be
    // permanently non-converted (round-6 codex P2).
    expect(report.brief_to_action).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    // But an ack is NOT a primary action start (those are the three CTA kinds only).
    expect(report.total_action_starts).toBe(0);
    expect(report.action_starts_by_kind).toEqual({
      accept_probe: 0,
      answer_probe: 0,
      scoped_practice: 0,
    });
    // Time-to-action pairs seen → ack (120s).
    expect(report.time_to_action.count).toBe(1);
    expect(report.time_to_action.median_ms).toBe(120_000);
  });
});

describe('parseCliFlag (YUK-710)', () => {
  it('reads a space-form and an inline-form flag value', () => {
    const argv = ['node', 'script', '--from', '2026-07-06', '--to', '2026-07-19'];
    expect(parseCliFlag(argv, 'from')).toBe('2026-07-06');
    expect(parseCliFlag(argv, 'to')).toBe('2026-07-19');
    expect(parseCliFlag(['--from=2026-07-06'], 'from')).toBe('2026-07-06');
  });

  it('treats a value that looks like another flag as missing (no silent swallow)', () => {
    // `--from --to 2026-07-19`: --from's value was omitted, so it must be undefined (not '--to').
    const argv = ['--from', '--to', '2026-07-19'];
    expect(parseCliFlag(argv, 'from')).toBeUndefined();
    expect(parseCliFlag(argv, 'to')).toBe('2026-07-19');
  });

  it('returns undefined for an absent flag or a trailing flag with no value', () => {
    expect(parseCliFlag([], 'from')).toBeUndefined();
    expect(parseCliFlag(['--from'], 'from')).toBeUndefined();
  });
});
