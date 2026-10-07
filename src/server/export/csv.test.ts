// Phase 1c.1 Step 9.E — CSV exporters over event stream only.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { evaluationMemberFromRows, freezeEvaluationInput } from '@/core/assessment-input';
import {
  PublishedQuestionRevision,
  SubmissionRecord,
  deriveIssuanceBinding,
} from '@/core/schema/assessment';
import { type Row, buildMistakesCsv, buildReviewEventsCsv, csvEscape } from './csv';

describe('csvEscape', () => {
  it('returns empty string for null/undefined', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('passes through plain strings unmodified', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('123')).toBe('123');
  });

  it('coerces numbers to strings', () => {
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape(0)).toBe('0');
  });

  it('quotes strings containing comma', () => {
    expect(csvEscape('a, b')).toBe('"a, b"');
  });

  it('quotes strings containing double-quote and escapes inner quotes', () => {
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('quotes strings containing newline', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('quotes strings containing carriage return', () => {
    expect(csvEscape('line1\rline2')).toBe('"line1\rline2"');
  });
});

function objectCell(value: unknown) {
  return z.record(z.string(), z.unknown()).parse(value);
}

function nativeFixture(): Record<string, Row[]> {
  const now = new Date('2026-10-05T00:01:00.000Z');
  const revision = PublishedQuestionRevision.parse({
    revision_id: 'rev-native',
    group_id: 'q-native',
    revision_ordinal: 1,
    integrity_digest: 'sha256:frozen',
    published_at: now.toISOString(),
    supersedes_revision_id: null,
    structure: {
      group_id: 'q-native',
      materials: [
        {
          material_id: 'passage',
          kind: 'passage',
          asset: { asset_id: 'txt-frozen', digest: 'sha256:passage' },
          content_md: '原材料：他说"水速",\n不要删去条件。',
        },
      ],
      parts: [
        {
          part_id: 'part-native',
          prompt_md: '原题：求静水船速, 并解释。',
          material_ids: ['passage'],
        },
      ],
    },
    response_spec: {
      slots: [
        {
          slot_id: 'slot',
          part_id: 'part-native',
          kind: 'single_choice',
          options: [
            { option_id: 'a', label: 'A', text: '12 km/h' },
            { option_id: 'b', label: 'B', text: '15 km/h' },
          ],
        },
      ],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'unit',
          slot_refs: ['slot'],
          criterion: { kind: 'option_set_key', accepted_option_ids: ['b'] },
          points: 5,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['unit'],
          executor: { kind: 'deterministic', comparator: 'exact_option_set' },
        },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'accept' },
    },
  });
  const issuance = {
    issuance_id: 'iss-native',
    ...deriveIssuanceBinding(revision),
    claim_policy: 'unbounded',
    claim_status: 'unclaimed',
    claimed_by_ref: null,
    container_occurrence_ref: null,
    issued_at: now,
  };
  const contract = SubmissionRecord.parse({
    submission_id: 'sub-native',
    issuance_id: issuance.issuance_id,
    revision_id: revision.revision_id,
    evaluation_group_id: 'group-native',
    response_set: { entries: [{ slot_id: 'slot', kind: 'choice', option_ids: ['a'] }] },
    group_evidence: [],
    idempotency_key: 'original',
    submitted_at: now.toISOString(),
  });
  const submission = { ...contract, submitted_at: now };
  const inputSnapshot = freezeEvaluationInput(contract, revision, [
    evaluationMemberFromRows(submission, issuance),
  ]);
  const card = {
    due: new Date('2026-10-06T00:01:00.000Z'),
    stability: 1.5,
    difficulty: 7,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 'learning',
    last_review: now,
  };
  return {
    question: [
      {
        id: 'q-native',
        prompt_md: '已编辑的新题',
        reference_md: '已编辑的新答案',
        knowledge_ids: ['k-live'],
        difficulty: 99,
      },
    ],
    knowledge: [
      { id: 'k-frozen', name: '冻结知识' },
      { id: 'k-live', name: '新知识' },
    ],
    question_revision: [
      { ...revision, published_at: now, availability: 'general_pool', published_by: null },
    ],
    assessment_issuance: [issuance],
    assessment_submission: [submission],
    evaluation_group: [
      { evaluation_group_id: 'group-native', submission_ids: ['sub-native'], created_at: now },
    ],
    evaluation: [
      {
        evaluation_id: 'eval-original',
        evaluation_group_id: 'group-native',
        submission_id: 'sub-native',
        attempt: 1,
        status: 'completed',
        aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
        unit_results: [
          {
            status: 'scored',
            scoring_unit_id: 'unit',
            points_awarded: 0,
            scored_because: 'response',
            evidence_citations: [],
          },
        ],
        plan_digest: 'sha256:plan',
        run_refs: [],
        provenance: { source: 'automatic', assisted: false, input_snapshot: inputSnapshot },
        created_at: now,
      },
    ],
    evaluation_effective_head: [
      {
        evaluation_group_id: 'group-native',
        submission_id: 'sub-native',
        effective_evaluation_id: 'eval-original',
        generation: 1,
        updated_at: now,
      },
    ],
    material_fsrs_state: [
      {
        subject_kind: 'knowledge',
        subject_id: 'k-frozen',
        state: { ...card, due: '2099-01-01T00:00:00.000Z', reps: 99 },
      },
    ],
    event: [
      {
        id: 'submission-receipt',
        action: 'experimental:assessment_submission',
        subject_kind: 'submission',
        subject_id: 'sub-native',
        created_at: now,
        payload: {
          learning_scope: {
            version: 1,
            group_id: 'q-native',
            questions: [
              {
                id: 'q-native',
                knowledge_ids: ['k-frozen'],
                difficulty: 3,
                kind: 'single_choice',
                source: 'manual',
              },
            ],
            ability_global_by_knowledge_id: {},
          },
        },
      },
      {
        id: 'native-attempt',
        action: 'experimental:assessment_attempt',
        subject_kind: 'question',
        subject_id: 'q-native',
        created_at: now,
        payload: {
          submission_id: 'sub-native',
          issuance_id: 'iss-native',
          revision_id: 'rev-native',
          evaluation_group_id: 'group-native',
          original_evaluation_id: 'eval-original',
          response_md: '我选"A",\n保留我的推导。',
        },
      },
      {
        id: 'settlement',
        action: 'experimental:assessment_settlement',
        subject_kind: 'evaluation_group',
        subject_id: 'group-native',
        created_at: now,
        payload: {
          evaluation_group_id: 'group-native',
          evaluation_id: 'eval-original',
          effect: 'applied',
          effects: { fsrs_applied: ['knowledge:k-frozen'] },
          replay_inputs: {
            kind: 'plan',
            groupId: 'group-native',
            occurrenceAt: now.toISOString(),
            rating: 'good',
            ratingSource: 'user',
          },
        },
      },
      {
        id: 'settlement:snapshot:fsrs',
        action: 'experimental:state_snapshot',
        subject_kind: 'event',
        subject_id: 'settlement',
        caused_by_event_id: 'settlement:checkpoint:fsrs',
        created_at: now,
        payload: {
          attempt_event_id: 'settlement',
          theta_snapshots: [],
          fsrs_snapshots: [
            {
              subject_kind: 'knowledge',
              subject_id: 'k-frozen',
              before: { ...card, stability: 0.5, due: '2026-10-04T00:00:00.000Z' },
              after: card,
            },
          ],
        },
      },
    ],
  };
}

/** Parse RFC 4180 fields so multiline answers are tested as one CSV record. */
function csvRecords(csv: string): Record<string, string>[] {
  const rows: string[][] = [[]];
  let field = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      rows[rows.length - 1].push(field);
      field = '';
      if (char === '\n') rows.push([]);
    } else field += char;
  }
  rows[rows.length - 1].push(field);
  const [header, ...data] = rows;
  return data.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])));
}

function replaceNativeEvaluation(
  tables: Record<string, Row[]>,
  points: number,
  provenance: Record<string, unknown> = {},
) {
  const original = tables.evaluation[0];
  tables.evaluation.push({
    ...original,
    evaluation_id: 'eval-replacement',
    attempt: 2,
    aggregate: { kind: 'points_total', points, policy: { kind: 'sum' } },
    unit_results: [
      {
        status: 'scored',
        scoring_unit_id: 'unit',
        points_awarded: points,
        scored_because: 'response',
        evidence_citations: [],
      },
    ],
    provenance: { ...objectCell(original.provenance), ...provenance },
    created_at: new Date('2026-10-05T01:00:00.000Z'),
  });
  tables.evaluation_effective_head[0].effective_evaluation_id = 'eval-replacement';
}

describe('native assessment CSV snapshots', () => {
  it.each(['objects', 'JSON strings'])(
    'exports frozen originals and historical FSRS with %s cells',
    (form) => {
      const tables = nativeFixture();
      if (form === 'JSON strings')
        for (const [table, fields] of Object.entries({
          event: ['payload'],
          assessment_submission: ['response_set', 'group_evidence'],
          evaluation_group: ['submission_ids'],
          question_revision: ['structure', 'response_spec', 'scoring_basis', 'execution_plan'],
          assessment_issuance: ['part_ids', 'material_bindings', 'option_order'],
          evaluation: ['aggregate', 'unit_results', 'run_refs', 'provenance'],
          material_fsrs_state: ['state'],
        }))
          for (const row of tables[table])
            for (const field of fields) row[field] = JSON.stringify(row[field]);
      const mistakes = csvRecords(buildMistakesCsv(tables));
      expect(mistakes).toHaveLength(1);
      expect(mistakes[0]).toMatchObject({
        id: 'native-attempt',
        knowledge_names: '冻结知识',
        difficulty: '3',
        wrong_answer_md: '我选"A",\n保留我的推导。',
        reference_md: 'B. 15 km/h',
        judge_original_outcome: 'incorrect',
        judge_effective_outcome: 'incorrect',
        fsrs_state_reps: '99',
        review_count: '1',
      });
      expect(mistakes[0].prompt_md).toContain('原材料：他说"水速",\n不要删去条件。');
      expect(mistakes[0].prompt_md).toContain('A. 12 km/h');
      expect(buildMistakesCsv(tables)).not.toContain('已编辑');
      expect(csvRecords(buildReviewEventsCsv(tables))).toEqual([
        expect.objectContaining({
          id: 'assessment:group-native',
          created_at: '2026-10-05T00:01:00.000Z',
          rating: 'good',
          before_stability: '0.5',
          before_due: '2026-10-04T00:00:00.000Z',
          after_stability: '1.5',
          after_due: '2026-10-06T00:01:00.000Z',
        }),
      ]);
    },
  );
  it('retains original failure after correction and includes newly effective failure', () => {
    const corrected = nativeFixture();
    replaceNativeEvaluation(corrected, 5);
    expect(csvRecords(buildMistakesCsv(corrected))[0]).toMatchObject({
      judge_original_outcome: 'incorrect',
      judge_effective_outcome: 'correct',
    });
    const newlyWrong = nativeFixture();
    newlyWrong.evaluation[0].aggregate = {
      kind: 'points_total',
      points: 5,
      policy: { kind: 'sum' },
    };
    newlyWrong.evaluation[0].unit_results = [
      {
        status: 'scored',
        scoring_unit_id: 'unit',
        points_awarded: 5,
        scored_because: 'response',
        evidence_citations: [],
      },
    ];
    replaceNativeEvaluation(newlyWrong, 0);
    expect(csvRecords(buildMistakesCsv(newlyWrong))[0]).toMatchObject({
      judge_original_outcome: 'correct',
      judge_effective_outcome: 'incorrect',
    });
  });
  it('validates all joint members, retains max-member occurrence, and renders partial issuances of a capped group', () => {
    const tables = nativeFixture();
    const revision = PublishedQuestionRevision.parse({
      ...tables.question_revision[0],
      published_at: '2026-10-05T00:01:00.000Z',
    });
    revision.structure.parts.push({
      part_id: 'part-second',
      prompt_md: '第二问：逆流速度。',
      material_ids: [],
    });
    revision.response_spec.slots.push({
      slot_id: 'slot-second',
      part_id: 'part-second',
      kind: 'single_choice',
      options: [
        { option_id: 'a', label: 'A', text: '第二问12 km/h' },
        { option_id: 'b', label: 'B', text: '第二问18 km/h' },
      ],
    });
    revision.scoring_basis.units.push({
      material_refs: [],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      scoring_unit_id: 'unit-second',
      slot_refs: ['slot-second'],
      criterion: { kind: 'option_set_key', accepted_option_ids: ['a'] },
      points: 5,
    });
    revision.scoring_basis.aggregation = { kind: 'capped_sum', cap: 5 };
    tables.question_revision[0] = { ...tables.question_revision[0], ...revision };
    const firstIssuance = {
      ...tables.assessment_issuance[0],
      ...deriveIssuanceBinding(revision, { part_ids: ['part-native'] }),
    };
    const secondIssuance = {
      ...tables.assessment_issuance[0],
      issuance_id: 'iss-second',
      ...deriveIssuanceBinding(revision, { part_ids: ['part-second'] }),
    };
    tables.assessment_issuance = [firstIssuance, secondIssuance];
    const first = SubmissionRecord.parse({
      ...tables.assessment_submission[0],
      submitted_at: '2026-10-05T00:01:00.000Z',
    });
    const last = SubmissionRecord.parse({
      ...first,
      submission_id: 'sub-second',
      issuance_id: 'iss-second',
      idempotency_key: 'second',
      submitted_at: '2026-10-05T00:05:00.000Z',
      response_set: { entries: [{ kind: 'choice', slot_id: 'slot-second', option_ids: ['b'] }] },
    });
    const firstRow = { ...first, submitted_at: new Date(first.submitted_at) };
    const lastRow = { ...last, submitted_at: new Date(last.submitted_at) };
    const issued = (row: Row) => ({
      issuance_id: z.string().parse(row.issuance_id),
      ...deriveIssuanceBinding(revision, { part_ids: z.array(z.string()).parse(row.part_ids) }),
      issued_at: new Date('2026-10-05T00:01:00Z'),
    });
    const input = freezeEvaluationInput(first, revision, [
      evaluationMemberFromRows(firstRow, issued(firstIssuance)),
      evaluationMemberFromRows(lastRow, issued(secondIssuance)),
    ]);
    tables.assessment_submission = [firstRow, lastRow];
    tables.evaluation_group[0].submission_ids = ['sub-native', 'sub-second'];
    tables.evaluation[0].provenance = { source: 'automatic', input_snapshot: input };
    tables.evaluation[0].aggregate = {
      kind: 'points_total',
      points: 0,
      policy: { kind: 'capped_sum', cap: 5 },
    };
    tables.evaluation[0].unit_results = ['unit', 'unit-second'].map((scoring_unit_id) => ({
      status: 'scored',
      scoring_unit_id,
      points_awarded: 0,
      scored_because: 'response',
      evidence_citations: [],
    }));
    const learning_scope = {
      version: 1,
      group_id: 'q-native',
      questions: [
        {
          id: 'part-native',
          knowledge_ids: ['k-frozen'],
          difficulty: 3,
          kind: 'single_choice',
          source: 'manual',
        },
        {
          id: 'part-second',
          knowledge_ids: ['k-second'],
          difficulty: 4,
          kind: 'single_choice',
          source: 'manual',
        },
      ],
      ability_global_by_knowledge_id: {},
    };
    tables.event[0].payload = { learning_scope };
    tables.event[1].subject_id = 'part-native';
    tables.event.push(
      {
        ...tables.event[0],
        id: 'second-receipt',
        subject_id: 'sub-second',
        payload: { learning_scope },
      },
      {
        ...tables.event[1],
        id: 'second-attempt',
        subject_id: 'part-second',
        created_at: last.submitted_at,
        payload: {
          ...objectCell(tables.event[1].payload),
          submission_id: 'sub-second',
          issuance_id: 'iss-second',
          original_evaluation_id: null,
        },
      },
    );
    tables.event[2].payload = {
      ...objectCell(tables.event[2].payload),
      effects: { fsrs_applied: ['knowledge:k-frozen', 'knowledge:k-second'] },
      replay_inputs: {
        ...objectCell(objectCell(tables.event[2].payload).replay_inputs),
        occurrenceAt: last.submitted_at,
      },
    };
    const mistakes = csvRecords(buildMistakesCsv(tables));
    expect(mistakes).toHaveLength(2);
    expect(mistakes[0]).toMatchObject({
      knowledge_names: '冻结知识',
      difficulty: '3',
      reference_md: 'B. 15 km/h',
      review_count: '1',
      judge_original_outcome: 'incorrect',
    });
    expect(mistakes[1]).toMatchObject({
      knowledge_names: 'k-second',
      difficulty: '4',
      reference_md: 'A. 第二问12 km/h',
      review_count: '1',
    });
    expect(mistakes[0].prompt_md).not.toContain('第二问');
    expect(csvRecords(buildReviewEventsCsv(tables))).toEqual([
      expect.objectContaining({
        created_at: last.submitted_at,
        after_due: '',
        knowledge_names: '冻结知识; k-second',
      }),
    ]);
    tables.assessment_submission.pop();
    expect(csvRecords(buildReviewEventsCsv(tables))).toEqual([]);
  });
  it('uses the first actual candidate for queued anchors instead of the first activation', () => {
    const tables = nativeFixture();
    const payload = tables.event[1].payload;
    tables.event[1].payload = { ...objectCell(payload), original_evaluation_id: null };
    replaceNativeEvaluation(tables, 5);
    tables.event.push({
      id: 'first-activation',
      action: 'experimental:assessment_activation',
      subject_kind: 'evaluation_group',
      subject_id: 'group-native',
      created_at: new Date(),
      payload: { evaluation_id: 'eval-replacement' },
    });
    expect(csvRecords(buildMistakesCsv(tables))[0]).toMatchObject({
      judge_original_outcome: 'incorrect',
      judge_effective_outcome: 'correct',
    });
  });
  it('renders canonical frozen response values when the participation receipt has no markdown capture', () => {
    const tables = nativeFixture();
    tables.event[1].payload = { ...objectCell(tables.event[1].payload), response_md: null };
    expect(csvRecords(buildMistakesCsv(tables))[0].wrong_answer_md).toBe('A. 12 km/h');
  });
  it('keeps explicit good independent from incorrect, self-report unknown, and partial distinct', () => {
    const tables = nativeFixture();
    expect(csvRecords(buildReviewEventsCsv(tables))[0].rating).toBe('good');
    replaceNativeEvaluation(tables, 5, { source: 'self_report' });
    tables.evaluation[1].unit_results = [
      {
        status: 'pending',
        scoring_unit_id: 'unit',
        pending: { reason: 'unjudgeable', detail: 'Explicit self-report has no score.' },
      },
    ];
    tables.evaluation[1].aggregate = {
      kind: 'unresolved',
      reason: 'pending_units',
      detail: 'Explicit self-report.',
    };
    expect(csvRecords(buildMistakesCsv(tables))[0].judge_effective_outcome).toBe('unknown');
    tables.evaluation.pop();
    replaceNativeEvaluation(tables, 2);
    expect(csvRecords(buildMistakesCsv(tables))[0].judge_effective_outcome).toBe('partial');
  });
  it('preserves user cause priority and looks up attribution by subject or caused-by without changing score', () => {
    const tables = nativeFixture();
    tables.event.push(
      {
        id: 'attribution',
        action: 'judge',
        subject_kind: 'event',
        subject_id: 'native-attempt',
        caused_by_event_id: 'appeal',
        created_at: new Date(),
        payload: { coarse_outcome: 'correct', cause: { primary_category: 'knowledge_gap' } },
      },
      {
        id: 'user-cause',
        action: 'experimental:user_cause',
        subject_kind: 'event',
        subject_id: 'different',
        caused_by_event_id: 'native-attempt',
        created_at: new Date(),
        payload: { primary_category: 'concept', user_notes: '我的原因' },
      },
    );
    expect(csvRecords(buildMistakesCsv(tables))[0]).toMatchObject({
      cause_primary: 'concept',
      cause_user_notes: '我的原因',
      judge_effective_outcome: 'incorrect',
    });
    tables.event.push({
      id: 'retract-cause',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'user-cause',
      created_at: new Date(),
      payload: { correction_kind: 'retract' },
    });
    expect(csvRecords(buildMistakesCsv(tables))[0].cause_primary).toBe('knowledge_gap');
  });
  it('applies same-time corrections by dispatch order instead of lexical ID', () => {
    const tables = nativeFixture();
    const at = new Date('2026-10-05T00:02:00Z');
    tables.event.push(
      {
        id: 'z-retract',
        action: 'correct',
        subject_kind: 'event',
        subject_id: 'native-attempt',
        dispatch_seq: 1,
        created_at: at,
        payload: { correction_kind: 'retract' },
      },
      {
        id: 'a-restore',
        action: 'correct',
        subject_kind: 'event',
        subject_id: 'native-attempt',
        dispatch_seq: 2,
        created_at: at,
        payload: { correction_kind: 'restore' },
      },
    );
    expect(csvRecords(buildMistakesCsv(tables))).toHaveLength(1);
    tables.event[4].dispatch_seq = 3;
    expect(csvRecords(buildMistakesCsv(tables))).toEqual([]);
    expect(csvRecords(buildReviewEventsCsv(tables))).toEqual([]);
  });
  it.each(['retract', 'mark_wrong'])('excludes native %s participation', (correction_kind) => {
    const tables = nativeFixture();
    tables.event.push({
      id: 'correction',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'native-attempt',
      created_at: new Date(),
      payload: { correction_kind },
    });
    expect(csvRecords(buildMistakesCsv(tables))).toEqual([]);
    expect(csvRecords(buildReviewEventsCsv(tables))).toEqual([]);
  });
  it('deduplicates replay and exports its historical state at the retained original occurrence time', () => {
    const tables = nativeFixture();
    tables.event.push(
      {
        ...tables.event[2],
        id: 'replay',
        created_at: new Date('2026-10-10T00:00:00Z'),
        payload: {
          ...objectCell(tables.event[2].payload),
          replay_of: 'settlement',
          reverted_settlement_event_ids: ['settlement'],
        },
      },
      {
        ...tables.event[3],
        id: 'replay:snapshot:fsrs',
        subject_id: 'replay',
        caused_by_event_id: 'replay:checkpoint:fsrs',
        payload: { ...objectCell(tables.event[3].payload), attempt_event_id: 'replay' },
      },
    );
    tables.event.reverse();
    expect(csvRecords(buildReviewEventsCsv(tables))).toHaveLength(1);
    expect(csvRecords(buildReviewEventsCsv(tables))[0]).toMatchObject({
      created_at: '2026-10-05T00:01:00.000Z',
      after_due: '2026-10-06T00:01:00.000Z',
    });
    expect(csvRecords(buildMistakesCsv(tables))[0].review_count).toBe('1');
  });
  it('does not create a review for capture-only or first failed-pending effects, but keeps retained scheduling after a failed replacement', () => {
    for (const effect of ['applied', 'failed_pending']) {
      const tables = nativeFixture();
      tables.event[2].payload = {
        ...objectCell(tables.event[2].payload),
        effect,
        effects: { fsrs_applied: [] },
      };
      expect(csvRecords(buildReviewEventsCsv(tables))).toEqual([]);
    }
    const tables = nativeFixture();
    tables.event.push({
      ...tables.event[2],
      id: 'failed',
      payload: {
        evaluation_group_id: 'group-native',
        effect: 'failed_pending',
        effects: { fsrs_applied: [] },
      },
    });
    expect(csvRecords(buildReviewEventsCsv(tables))).toHaveLength(1);
    tables.event.push({
      ...tables.event[2],
      id: 'replacement',
      payload: {
        evaluation_group_id: 'group-native',
        effect: 'ineligible',
        effects: { fsrs_applied: [] },
        supersedes_settlement_event_id: 'settlement',
        reverted_settlement_event_ids: ['settlement'],
      },
    });
    expect(csvRecords(buildReviewEventsCsv(tables))).toHaveLength(1);
  });
  it('excludes withdrawn groups', () => {
    const tables = nativeFixture();
    tables.event.push({
      ...tables.event[2],
      id: 'withdraw',
      payload: {
        evaluation_group_id: 'group-native',
        effect: 'withdrawn',
        effects: { fsrs_applied: [] },
      },
    });
    expect(csvRecords(buildReviewEventsCsv(tables))).toEqual([]);
    expect(csvRecords(buildMistakesCsv(tables))).toEqual([]);
  });
  it.each(['in_progress', 'abandoned', 'reopened', 'completed'])(
    'enforces buffered paper generation disclosure for %s sessions',
    (status) => {
      const tables = nativeFixture();
      tables.event[1].session_id = 'paper-session';
      tables.event[1].payload = {
        ...objectCell(tables.event[1].payload),
        paper_feedback_policy: 'judge_now_show_later',
        paper_started_at: '2026-10-05T00:00:00.000Z',
      };
      tables.learning_session = [
        {
          id: 'paper-session',
          status: status === 'reopened' ? 'completed' : status,
          started_at:
            status === 'reopened' ? '2026-10-05T01:00:00.000Z' : '2026-10-05T00:00:00.000Z',
        },
      ];
      expect(csvRecords(buildMistakesCsv(tables))).toHaveLength(status === 'completed' ? 1 : 0);
      expect(csvRecords(buildReviewEventsCsv(tables))).toHaveLength(status === 'completed' ? 1 : 0);
    },
  );
  it('leaves scalar snapshot columns blank for multiple FSRS subjects', () => {
    const tables = nativeFixture();
    tables.event[2].payload = {
      ...objectCell(tables.event[2].payload),
      effects: { fsrs_applied: ['knowledge:k-frozen', 'knowledge:k-other'] },
    };
    const snapshot = objectCell(tables.event[3].payload);
    const cards = z.array(z.record(z.string(), z.unknown())).parse(snapshot.fsrs_snapshots);
    tables.event[3].payload = {
      ...snapshot,
      fsrs_snapshots: [...cards, { ...cards[0], subject_id: 'k-other' }],
    };
    const row = csvRecords(buildReviewEventsCsv(tables))[0];
    for (const key of [
      'before_stability',
      'before_due',
      'after_stability',
      'after_due',
      'due_at_before',
      'due_at_next',
    ])
      expect(row[key]).toBe('');
    expect(row.rating).toBe('good');
  });
  it.each(['subject_id', 'caused_by_event_id', 'payload'])(
    'rejects mismatched historical snapshot %s without using current FSRS',
    (field) => {
      const tables = nativeFixture();
      tables.event[3][field] =
        field === 'payload'
          ? { attempt_event_id: 'wrong', theta_snapshots: [], fsrs_snapshots: [] }
          : 'wrong';
      expect(csvRecords(buildReviewEventsCsv(tables))[0]).toMatchObject({
        after_due: '',
        before_due: '',
        after_stability: '',
      });
    },
  );
  it.each(['issuance', 'head', 'original', 'member', 'input', 'queued_candidate'])(
    'fails closed on malformed %s coordinates/contracts',
    (failure) => {
      const tables = nativeFixture();
      if (failure === 'issuance') tables.assessment_issuance[0].revision_id = 'wrong';
      if (failure === 'head') tables.evaluation_effective_head[0].submission_id = 'wrong';
      if (failure === 'original')
        tables.event[1].payload = {
          ...objectCell(tables.event[1].payload),
          original_evaluation_id: 'wrong',
        };
      if (failure === 'member')
        tables.assessment_submission.push({
          submission_id: 'broken-member',
          evaluation_group_id: 'group-native',
          response_set: '{broken',
        });
      if (failure === 'input')
        tables.evaluation[0].provenance = {
          source: 'automatic',
          input_snapshot: { version: 1, digest: 'wrong' },
        };
      if (failure === 'queued_candidate') {
        tables.event[1].payload = {
          ...objectCell(tables.event[1].payload),
          original_evaluation_id: null,
        };
        replaceNativeEvaluation(tables, 0);
        tables.evaluation[0].aggregate = '{broken';
      }
      expect(csvRecords(buildMistakesCsv(tables))).toEqual([]);
      expect(csvRecords(buildReviewEventsCsv(tables))).toEqual([]);
    },
  );
});

describe('buildMistakesCsv', () => {
  function fixture() {
    return {
      knowledge: [
        { id: 'k1', name: '虚词' },
        { id: 'k2', name: '实词' },
      ],
      question: [
        {
          id: 'q1',
          prompt_md: '解释"之"的用法',
          reference_md: '助词；代词；动词',
          knowledge_ids: '["k1"]',
          difficulty: 4,
        },
      ],
      event: [
        // Attempt event (failure on q1)
        {
          id: 'evt_attempt_1',
          action: 'attempt',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'failure',
          payload:
            '{"answer_md":"只记得 代词","answer_image_refs":[],"referenced_knowledge_ids":["k1","k2"]}',
          caused_by_event_id: null,
          created_at: 1699000000,
        },
        // Chained judge with cause
        {
          id: 'evt_judge_1',
          action: 'judge',
          subject_kind: 'event',
          subject_id: 'evt_attempt_1',
          outcome: 'success',
          payload:
            '{"cause":{"primary_category":"knowledge_gap","secondary_categories":[],"analysis_md":"需要复习","confidence":0.7},"referenced_knowledge_ids":["k1"]}',
          caused_by_event_id: 'evt_attempt_1',
          created_at: 1699003600,
        },
        // Review event for last_review tracking
        {
          id: 'evt_review_1',
          action: 'review',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'success',
          payload:
            '{"fsrs_rating":"good","fsrs_state_after":{"due":1700200000,"stability":2,"difficulty":5,"scheduled_days":3,"learning_steps":0,"reps":3,"lapses":1,"state":"review","last_review":1700100000},"user_response_md":null,"referenced_knowledge_ids":[]}',
          caused_by_event_id: null,
          created_at: 1700200000,
        },
      ] as Row[],
      material_fsrs_state: [
        {
          subject_kind: 'question',
          subject_id: 'q1',
          state:
            '{"due":1700000000,"stability":2,"difficulty":5,"reps":3,"lapses":1,"state":"review"}',
        },
      ] as Row[],
    };
  }

  it('renders header line + one row per failure attempt', () => {
    const csv = buildMistakesCsv(fixture());
    const lines = csv.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('id,created_at,prompt_md');
    expect(lines[0]).toContain('knowledge_names');
  });

  it('joins knowledge_names by "; " using knowledge.name lookup', () => {
    const csv = buildMistakesCsv(fixture());
    expect(csv).toContain('虚词; 实词');
  });

  it('includes judge cause primary_category in projected row', () => {
    const csv = buildMistakesCsv(fixture());
    expect(csv).toContain('knowledge_gap');
  });

  it('uses active user cause before judge cause in projected row', () => {
    const tables = fixture();
    tables.event.push({
      id: 'evt_user_cause_1',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'evt_attempt_1',
      outcome: 'success',
      payload: '{"primary_category":"concept","user_notes":"manual correction"}',
      caused_by_event_id: 'evt_attempt_1',
      created_at: 1699007200,
    });

    const csv = buildMistakesCsv(tables);
    const cols = csv.split('\n')[1].split(',');
    expect(cols[6]).toBe('concept');
    expect(cols[7]).toBe('manual correction');
  });

  it('falls back to judge cause when user cause is retracted', () => {
    const tables = fixture();
    tables.event.push(
      {
        id: 'evt_user_cause_1',
        action: 'experimental:user_cause',
        subject_kind: 'event',
        subject_id: 'evt_attempt_1',
        outcome: 'success',
        payload: '{"primary_category":"concept","user_notes":"manual correction"}',
        caused_by_event_id: 'evt_attempt_1',
        created_at: 1699007200,
      },
      {
        id: 'evt_correct_user_cause_1',
        action: 'correct',
        subject_kind: 'event',
        subject_id: 'evt_user_cause_1',
        outcome: 'success',
        payload: '{"correction_kind":"retract","reason_md":"wrong"}',
        caused_by_event_id: null,
        created_at: 1699007300,
      },
    );

    const csv = buildMistakesCsv(tables);
    const cols = csv.split('\n')[1].split(',');
    expect(cols[6]).toBe('knowledge_gap');
    expect(cols[7]).toBe('');
  });

  it('decomposes fsrs_state JSON columns from material_fsrs_state', () => {
    const csv = buildMistakesCsv(fixture());
    expect(csv).toContain('1700000000');
    expect(csv).toContain(',3,'); // reps
    expect(csv).toContain(',1,'); // lapses
  });

  it('counts review events per question as last_reviewed_at / review_count', () => {
    const csv = buildMistakesCsv(fixture());
    const header = csv.split('\n')[0].split(',');
    const cols = csv.split('\n')[1].split(',');
    // YUK-1054 — judge_* 双轨列追加在 review_count 之后，按表头索引断言。
    expect(cols[header.indexOf('last_reviewed_at')]).toBe('1700200000');
    expect(cols[header.indexOf('review_count')]).toBe('1');
    expect(cols[header.indexOf('judge_effective_outcome')]).toBe('');
    expect(cols[header.indexOf('judge_original_outcome')]).toBe('');
  });

  // Codex (PR #295) — ADR-0028 deletes the question-level FSRS row for labeled
  // questions and keeps the projection on the knowledge node. Export must fall
  // back to the knowledge row so fsrs_state_* is not lost, marking the source.
  it('falls back to the knowledge-level FSRS row for labeled questions (source kind=knowledge)', () => {
    const tables = fixture();
    // Drop the question-level row; add a knowledge-level row for k1.
    tables.material_fsrs_state = [
      {
        subject_kind: 'knowledge',
        subject_id: 'k1',
        state:
          '{"due":1700500000,"stability":3,"difficulty":4,"reps":7,"lapses":2,"state":"review"}',
      },
    ] as Row[];

    const csv = buildMistakesCsv(tables);
    const header = csv.split('\n')[0].split(',');
    const cols = csv.split('\n')[1].split(',');
    const dueIdx = header.indexOf('fsrs_state_due');
    const repsIdx = header.indexOf('fsrs_state_reps');
    const lapsesIdx = header.indexOf('fsrs_state_lapses');
    const sourceIdx = header.indexOf('fsrs_state_source_kind');
    expect(cols[dueIdx]).toBe('1700500000');
    expect(cols[repsIdx]).toBe('7');
    expect(cols[lapsesIdx]).toBe('2');
    expect(cols[sourceIdx]).toBe('knowledge');
  });

  it('picks the most-overdue knowledge row when a question probes several knowledge points', () => {
    const tables = fixture();
    // q1 is labeled with k1 + k2 (override the fixture question labels).
    (tables.question[0] as { knowledge_ids: string }).knowledge_ids = '["k1","k2"]';
    tables.material_fsrs_state = [
      {
        subject_kind: 'knowledge',
        subject_id: 'k1',
        state:
          '{"due":1700900000,"stability":3,"difficulty":4,"reps":1,"lapses":0,"state":"review"}',
      },
      {
        // k2 is more overdue (smaller due) → its state must win.
        subject_kind: 'knowledge',
        subject_id: 'k2',
        state:
          '{"due":1700100000,"stability":3,"difficulty":4,"reps":9,"lapses":3,"state":"review"}',
      },
    ] as Row[];

    const csv = buildMistakesCsv(tables);
    const header = csv.split('\n')[0].split(',');
    const cols = csv.split('\n')[1].split(',');
    expect(cols[header.indexOf('fsrs_state_due')]).toBe('1700100000');
    expect(cols[header.indexOf('fsrs_state_reps')]).toBe('9');
    expect(cols[header.indexOf('fsrs_state_source_kind')]).toBe('knowledge');
  });

  it('marks fsrs_state_source_kind=question when the question-level row exists', () => {
    const csv = buildMistakesCsv(fixture());
    const header = csv.split('\n')[0].split(',');
    const cols = csv.split('\n')[1].split(',');
    expect(cols[header.indexOf('fsrs_state_source_kind')]).toBe('question');
  });

  it('handles missing judge gracefully (cause blank)', () => {
    const tables = fixture();
    tables.event = tables.event.filter((e) => e.action !== 'judge');
    const csv = buildMistakesCsv(tables);
    expect(csv.split('\n').length).toBe(2);
  });

  it('handles no review events (review_count=0, last_reviewed_at empty)', () => {
    const tables = fixture();
    tables.event = tables.event.filter((e) => e.action !== 'review');
    const csv = buildMistakesCsv(tables);
    const header = csv.split('\n')[0].split(',');
    const cols = csv.split('\n')[1].split(',');
    expect(cols[header.indexOf('last_reviewed_at')]).toBe('');
    expect(cols[header.indexOf('review_count')]).toBe('0');
  });
});

describe('buildReviewEventsCsv', () => {
  function fixture() {
    return {
      knowledge: [{ id: 'k1', name: '虚词' }],
      question: [
        {
          id: 'q1',
          prompt_md: '解释 之 的用法',
          knowledge_ids: '["k1"]',
        },
      ],
      event: [
        {
          id: 'evt_review_1',
          action: 'review',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'failure',
          payload:
            '{"fsrs_rating":"again","fsrs_state_after":{"stability":1.5,"difficulty":7,"due":1700200000,"state":"learning","reps":1,"lapses":1,"scheduled_days":0,"learning_steps":1,"last_review":1700100000},"user_response_md":null,"referenced_knowledge_ids":[]}',
          caused_by_event_id: null,
          created_at: 1700100000,
        },
      ] as Row[],
    };
  }

  it('renders header + 1 row per review event', () => {
    const csv = buildReviewEventsCsv(fixture());
    const lines = csv.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('created_at,mistake_id,prompt_excerpt');
    expect(lines[0]).toContain('rating');
    expect(lines[0]).toContain('due_at_next');
  });

  it('rating column outputs the text label directly (again/hard/good)', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain(',again,');
  });

  it('decomposes fsrs_state_after JSON columns', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain('1.5');
    expect(csv).toContain('1700200000');
  });

  it('handles missing fsrs_state_after gracefully', () => {
    const f = fixture();
    f.event[0].payload = '{"fsrs_rating":"again"}';
    const csv = buildReviewEventsCsv(f);
    expect(csv.split('\n').length).toBe(2);
  });

  it('joins knowledge_names from question.knowledge_ids', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain('虚词');
  });

  // YUK-324 — D1→PG migration drift. The `postgres` driver returns jsonb
  // columns ALREADY parsed (here knowledge_ids as a string[]). The old code
  // did a bare JSON.parse(question.knowledge_ids) expecting a string, which
  // threw on the array form → backup CSV export 500. This asserts the parsed
  // (array) shape is accepted without throwing and resolves to the name.
  it('accepts knowledge_ids already parsed as an array (postgres jsonb driver shape)', () => {
    const f = fixture();
    // postgres driver hands back the jsonb column as a real array, not a string.
    (f.question[0] as unknown as { knowledge_ids: string[] }).knowledge_ids = ['k1'];
    let csv = '';
    expect(() => {
      csv = buildReviewEventsCsv(f as unknown as Record<string, Row[]>);
    }).not.toThrow();
    expect(csv).toContain('虚词');
  });
});
