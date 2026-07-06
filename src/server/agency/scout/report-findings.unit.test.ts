// YUK-572 PR-1 — report_findings schema + evidence-ref backstop unit test. Pure, no DB.

import { describe, expect, it } from 'vitest';
import {
  ReportFindingsSchema,
  createFindingsCapture,
  filterPrimaryEvidenceRefs,
  isPrimaryEvidenceRef,
} from './report-findings';

describe('ReportFindingsSchema', () => {
  it('parses a well-formed findings object', () => {
    const parsed = ReportFindingsSchema.safeParse({
      single_or_multi_mechanism: 'single',
      evidence_attribution_contradiction: 'none',
      suggested_probe_angle: 'probe the boundary case',
      findings_md: 'The learner conflates X with Y.',
      evidence_refs: ['attempt_1', 'probe_2'],
      confidence: 0.6,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an out-of-range mechanism enum', () => {
    const parsed = ReportFindingsSchema.safeParse({
      single_or_multi_mechanism: 'quadruple',
      evidence_attribution_contradiction: 'none',
      suggested_probe_angle: 'x',
      findings_md: 'y',
      evidence_refs: [],
      confidence: 0.4,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects confidence outside [0,1] and over-long fields', () => {
    expect(
      ReportFindingsSchema.safeParse({
        single_or_multi_mechanism: 'multi',
        evidence_attribution_contradiction: 'none',
        suggested_probe_angle: 'x',
        findings_md: 'y',
        evidence_refs: [],
        confidence: 1.5,
      }).success,
    ).toBe(false);
    expect(
      ReportFindingsSchema.safeParse({
        single_or_multi_mechanism: 'multi',
        evidence_attribution_contradiction: 'x'.repeat(1501),
        suggested_probe_angle: 'x',
        findings_md: 'y',
        evidence_refs: [],
        confidence: 0.4,
      }).success,
    ).toBe(false);
  });

  it('caps evidence_refs at 12', () => {
    const parsed = ReportFindingsSchema.safeParse({
      single_or_multi_mechanism: 'single',
      evidence_attribution_contradiction: 'none',
      suggested_probe_angle: 'x',
      findings_md: 'y',
      evidence_refs: Array.from({ length: 13 }, (_, i) => `e${i}`),
      confidence: 0.4,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('createFindingsCapture', () => {
  it('starts null and is a fresh ref each call', () => {
    const a = createFindingsCapture();
    const b = createFindingsCapture();
    expect(a.value).toBeNull();
    expect(a).not.toBe(b);
  });
});

describe('filterPrimaryEvidenceRefs', () => {
  it('keeps primary event ids, order-preserving', () => {
    expect(filterPrimaryEvidenceRefs(['attempt_1', 'probe_2', 'prediction_score_3'])).toEqual([
      'attempt_1',
      'probe_2',
      'prediction_score_3',
    ]);
  });

  it('filters out agent_note ids (self-reinforcement backstop)', () => {
    expect(
      filterPrimaryEvidenceRefs(['attempt_1', 'agent_note_abc', 'probe_2', 'agent_note_def']),
    ).toEqual(['attempt_1', 'probe_2']);
  });

  it('returns empty when every ref is an agent_note (caller then rejects)', () => {
    expect(filterPrimaryEvidenceRefs(['agent_note_x', 'agent_note_y'])).toEqual([]);
  });

  it('isPrimaryEvidenceRef classifies the agent_note prefix', () => {
    expect(isPrimaryEvidenceRef('agent_note_abc')).toBe(false);
    expect(isPrimaryEvidenceRef('attempt_abc')).toBe(true);
  });
});
