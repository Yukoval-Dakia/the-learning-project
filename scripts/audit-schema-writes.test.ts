import { describe, expect, it } from 'vitest';
import { extractMergedPrRefsFromGitLog, validateAllowlistHygiene } from './audit-schema-writes';

const OPTIONS = {
  today: '2026-05-23',
  mergedPrRefs: new Set<string>(),
  statusText: '',
};

describe('audit-schema allowlist hygiene', () => {
  it('rejects legacy string resolves_when on business entries', () => {
    const result = validateAllowlistHygiene(
      {
        'question.rubric_json': {
          reason: 'Sub 1 JudgeTask grading config; not yet written by ingestion',
          resolves_when: 'Sub 1 JudgeTask + question authoring path implemented',
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'question.rubric_json',
        code: 'invalid_resolves_when',
      }),
    ]);
    expect(result.allowlist).toEqual({});
  });

  it('does not require reason or resolves_when on _comment markers', () => {
    const result = validateAllowlistHygiene(
      {
        _comment: 'schema fields with no write path',
        _comment_phase1c1_lane_a: 'historical marker',
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([]);
    expect(result.allowlist).toEqual({});
  });

  it('rejects entries whose expected_by date has passed', () => {
    const result = validateAllowlistHygiene(
      {
        'answer.input_kind': {
          reason: 'Answer table currently unused; review submit will write',
          resolves_when: {
            kind: 'manual',
            ref: 'Phase 1c.2 review submit path implemented',
            expected_by: '2026-05-22',
          },
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'answer.input_kind',
        code: 'expired_expected_by',
      }),
    ]);
  });

  it('extracts merged PR refs from squash-merge and merge-commit subjects', () => {
    const refs = extractMergedPrRefsFromGitLog(
      [
        'a2b119a docs(plan): YUK-38 fix codex review findings + Linear reorg (#107)',
        'abc1234 Merge pull request #104 from Yukoval-Dakia/yuk-38-track2',
        'def5678 chore: unrelated commit',
      ].join('\n'),
    );

    expect([...refs].sort()).toEqual(['104', '107']);
  });

  it('rejects pr entries whose ref is already merged into local history', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.title': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'pr',
            ref: '#107',
            expected_by: '2026-07-31',
          },
        },
      },
      {
        ...OPTIONS,
        mergedPrRefs: new Set(['107']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'artifact.title',
        code: 'merged_pr',
      }),
    ]);
  });

  it('rejects phase entries whose ref appears in a shipped status line', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.generated_by': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'phase',
            ref: 'Foundation closeout P0',
            expected_by: '2026-07-31',
          },
        },
      },
      {
        ...OPTIONS,
        statusText:
          '**最后更新**：2026-05-23（Foundation closeout P-1 + P0 已 ship — PR #86 / #91）',
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'artifact.generated_by',
        code: 'shipped_phase',
      }),
    ]);
  });

  it('accepts manual entries that preserve the current legacy text as ref', () => {
    const result = validateAllowlistHygiene(
      {
        'memory_brief_note.scope_key': {
          reason:
            'Schema lands in the LearningRecord migration; scheduled Dreaming refresh writes the row in the next batch',
          resolves_when: {
            kind: 'manual',
            ref: 'memory_brief_refresh boss handler implemented',
            expected_by: '2026-07-31',
          },
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([]);
    expect(result.allowlist['memory_brief_note.scope_key']).toEqual({
      reason:
        'Schema lands in the LearningRecord migration; scheduled Dreaming refresh writes the row in the next batch',
      resolves_when: {
        kind: 'manual',
        ref: 'memory_brief_refresh boss handler implemented',
        expected_by: '2026-07-31',
      },
    });
  });
});
