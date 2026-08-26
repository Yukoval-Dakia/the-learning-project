// YUK-391 (kind Step 4) — answer-class ↔ 客观位 consistency + route-parity contract.
//
// The five retired per-kind judge-routing mirrors (route-resolve.ts if-chain,
// judge-routing.ts gen-time twin, verify-framework EXACT_KINDS,
// target-discovery OBJECTIVE_KINDS, PROSE_KINDS consumers + the
// QUIZ_PLAN_OBJECTIVE_KINDS plan set) all encoded the same distinction the
// answer_class axis already carries. This suite pins the convergence:
//
//   1. ROUTE PARITY — both routing twins reproduce, cell for cell, the route
//      matrix frozen from the PRE-refactor implementation (commit 69616028,
//      captured by enumerating resolveQuestionJudgeRoute /
//      defaultJudgeKindForQuestion over the full matrix). A5/灰度: any kind/route
//      cell that cannot be kept identical must be documented here, not silently
//      flipped.
//   2. 客观位 CONSISTENCY — for every cell, the deterministic-vs-LLM SIDE of
//      deriveAnswerClass ({exact,keyword} vs {semantic,steps}) agrees with the
//      side of the resolved route ({exact,keyword} vs the model-backed routes),
//      except the one documented pre-existing carve-out: physics reroutes
//      computation (even keyword-class) to its preferred unit_dimension route.
//   3. KIND FAMILIES — the kind-level predicates derived from deriveAnswerClass
//      equal the retired hand-maintained sets.
//   4. TWINS SYNC — route-resolve (with profile) and defaultJudgeKindForQuestion
//      (without) stay behavior-synced on the profile-free dimension.

import { describe, expect, it } from 'vitest';
import { resolveQuestionJudgeRoute } from '@/capabilities/practice/server/judge/route-resolve';
import { subjectProfiles } from '@/subjects/profile';
import {
  ANSWER_CLASSES,
  type AnswerClass,
  OBJECTIVE_ANSWER_KINDS,
  deriveAnswerClass,
  isKeywordConditionalAnswerKind,
  isLlmGradedAnswerKind,
  isObjectiveAnswerKind,
} from './answer-class';
import { defaultJudgeKindForQuestion } from './judge-routing';

// All 9 canonical QuestionKind values (core/schema/business.ts enum order).
const KINDS = [
  'choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'computation',
  'reading',
  'translation',
  'derivation',
] as const;

const CHOICES = ['甲', '乙'];
const RUBRIC_KW: { criteria: []; keywords: string[] } = { criteria: [], keywords: ['x'] };

// Deterministic routes (local string compare) vs model-backed routes — the
// 客观位 split (mirrors OBJECTIVE_JUDGE_ROUTES in server/mastery/personalized-difficulty).
const OBJECTIVE_ROUTES = new Set(['exact', 'keyword']);
const OBJECTIVE_CLASSES = new Set<AnswerClass>(['exact', 'keyword']);

function matrixKey(profileId: string, kind: string, withChoices: boolean, withKw: boolean): string {
  return `${profileId}|${kind}|${withChoices ? 'c' : '-'}|${withKw ? 'k' : '-'}`;
}

// ── FROZEN golden matrices (captured from the pre-YUK-391 implementation) ──────
//
// Regenerate ONLY with a deliberate A5 rollout note — these values are the
// byte-level route-parity contract the convergence must reproduce. Cells are
// `${profileId}|${kind}|${choices?c:-}|${keywords?k:-}`.
const GOLDEN_RUNTIME = JSON.parse(`{
  "general|choice|-|-": "exact",
  "general|choice|-|k": "exact",
  "general|choice|c|-": "exact",
  "general|choice|c|k": "exact",
  "general|computation|-|-": "semantic",
  "general|computation|-|k": "keyword",
  "general|computation|c|-": "exact",
  "general|computation|c|k": "exact",
  "general|derivation|-|-": "semantic",
  "general|derivation|-|k": "semantic",
  "general|derivation|c|-": "exact",
  "general|derivation|c|k": "exact",
  "general|essay|-|-": "semantic",
  "general|essay|-|k": "semantic",
  "general|essay|c|-": "exact",
  "general|essay|c|k": "exact",
  "general|fill_blank|-|-": "exact",
  "general|fill_blank|-|k": "keyword",
  "general|fill_blank|c|-": "exact",
  "general|fill_blank|c|k": "exact",
  "general|reading|-|-": "semantic",
  "general|reading|-|k": "semantic",
  "general|reading|c|-": "exact",
  "general|reading|c|k": "exact",
  "general|short_answer|-|-": "semantic",
  "general|short_answer|-|k": "semantic",
  "general|short_answer|c|-": "exact",
  "general|short_answer|c|k": "exact",
  "general|translation|-|-": "semantic",
  "general|translation|-|k": "semantic",
  "general|translation|c|-": "exact",
  "general|translation|c|k": "exact",
  "general|true_false|-|-": "exact",
  "general|true_false|-|k": "exact",
  "general|true_false|c|-": "exact",
  "general|true_false|c|k": "exact",
  "math|choice|-|-": "exact",
  "math|choice|-|k": "exact",
  "math|choice|c|-": "exact",
  "math|choice|c|k": "exact",
  "math|computation|-|-": "semantic",
  "math|computation|-|k": "keyword",
  "math|computation|c|-": "exact",
  "math|computation|c|k": "exact",
  "math|derivation|-|-": "steps",
  "math|derivation|-|k": "steps",
  "math|derivation|c|-": "exact",
  "math|derivation|c|k": "exact",
  "math|essay|-|-": "semantic",
  "math|essay|-|k": "semantic",
  "math|essay|c|-": "exact",
  "math|essay|c|k": "exact",
  "math|fill_blank|-|-": "exact",
  "math|fill_blank|-|k": "keyword",
  "math|fill_blank|c|-": "exact",
  "math|fill_blank|c|k": "exact",
  "math|reading|-|-": "semantic",
  "math|reading|-|k": "semantic",
  "math|reading|c|-": "exact",
  "math|reading|c|k": "exact",
  "math|short_answer|-|-": "semantic",
  "math|short_answer|-|k": "semantic",
  "math|short_answer|c|-": "exact",
  "math|short_answer|c|k": "exact",
  "math|translation|-|-": "semantic",
  "math|translation|-|k": "semantic",
  "math|translation|c|-": "exact",
  "math|translation|c|k": "exact",
  "math|true_false|-|-": "exact",
  "math|true_false|-|k": "exact",
  "math|true_false|c|-": "exact",
  "math|true_false|c|k": "exact",
  "physics|choice|-|-": "exact",
  "physics|choice|-|k": "exact",
  "physics|choice|c|-": "exact",
  "physics|choice|c|k": "exact",
  "physics|computation|-|-": "unit_dimension",
  "physics|computation|-|k": "unit_dimension",
  "physics|computation|c|-": "exact",
  "physics|computation|c|k": "exact",
  "physics|derivation|-|-": "semantic",
  "physics|derivation|-|k": "semantic",
  "physics|derivation|c|-": "exact",
  "physics|derivation|c|k": "exact",
  "physics|essay|-|-": "semantic",
  "physics|essay|-|k": "semantic",
  "physics|essay|c|-": "exact",
  "physics|essay|c|k": "exact",
  "physics|fill_blank|-|-": "exact",
  "physics|fill_blank|-|k": "keyword",
  "physics|fill_blank|c|-": "exact",
  "physics|fill_blank|c|k": "exact",
  "physics|reading|-|-": "semantic",
  "physics|reading|-|k": "semantic",
  "physics|reading|c|-": "exact",
  "physics|reading|c|k": "exact",
  "physics|short_answer|-|-": "semantic",
  "physics|short_answer|-|k": "semantic",
  "physics|short_answer|c|-": "exact",
  "physics|short_answer|c|k": "exact",
  "physics|translation|-|-": "semantic",
  "physics|translation|-|k": "semantic",
  "physics|translation|c|-": "exact",
  "physics|translation|c|k": "exact",
  "physics|true_false|-|-": "exact",
  "physics|true_false|-|k": "exact",
  "physics|true_false|c|-": "exact",
  "physics|true_false|c|k": "exact",
  "yuwen|choice|-|-": "exact",
  "yuwen|choice|-|k": "exact",
  "yuwen|choice|c|-": "exact",
  "yuwen|choice|c|k": "exact",
  "yuwen|computation|-|-": "semantic",
  "yuwen|computation|-|k": "keyword",
  "yuwen|computation|c|-": "exact",
  "yuwen|computation|c|k": "exact",
  "yuwen|derivation|-|-": "semantic",
  "yuwen|derivation|-|k": "semantic",
  "yuwen|derivation|c|-": "exact",
  "yuwen|derivation|c|k": "exact",
  "yuwen|essay|-|-": "semantic",
  "yuwen|essay|-|k": "semantic",
  "yuwen|essay|c|-": "exact",
  "yuwen|essay|c|k": "exact",
  "yuwen|fill_blank|-|-": "exact",
  "yuwen|fill_blank|-|k": "keyword",
  "yuwen|fill_blank|c|-": "exact",
  "yuwen|fill_blank|c|k": "exact",
  "yuwen|reading|-|-": "semantic",
  "yuwen|reading|-|k": "semantic",
  "yuwen|reading|c|-": "exact",
  "yuwen|reading|c|k": "exact",
  "yuwen|short_answer|-|-": "semantic",
  "yuwen|short_answer|-|k": "semantic",
  "yuwen|short_answer|c|-": "exact",
  "yuwen|short_answer|c|k": "exact",
  "yuwen|translation|-|-": "semantic",
  "yuwen|translation|-|k": "semantic",
  "yuwen|translation|c|-": "exact",
  "yuwen|translation|c|k": "exact",
  "yuwen|true_false|-|-": "exact",
  "yuwen|true_false|-|k": "exact",
  "yuwen|true_false|c|-": "exact",
  "yuwen|true_false|c|k": "exact"
}`) as Record<string, string>;

const GOLDEN_GEN = JSON.parse(`{
  "choice|-": "exact",
  "choice|k": "exact",
  "computation|-": "semantic",
  "computation|k": "keyword",
  "derivation|-": "semantic",
  "derivation|k": "semantic",
  "essay|-": "semantic",
  "essay|k": "semantic",
  "fill_blank|-": "exact",
  "fill_blank|k": "keyword",
  "reading|-": "semantic",
  "reading|k": "semantic",
  "short_answer|-": "semantic",
  "short_answer|k": "semantic",
  "translation|-": "semantic",
  "translation|k": "semantic",
  "true_false|-": "exact",
  "true_false|k": "exact"
}`) as Record<string, string>;

const PROFILE_IDS = Object.values(subjectProfiles)
  .map((p) => p.id)
  .sort();

function matrixCells(): Array<{
  profileId: string;
  profile: (typeof subjectProfiles)[string];
  kind: (typeof KINDS)[number];
  withChoices: boolean;
  withKw: boolean;
  route: string;
  answerClass: AnswerClass;
}> {
  const cells = [];
  for (const profileId of PROFILE_IDS) {
    const profile = subjectProfiles[profileId];
    for (const kind of KINDS) {
      for (const withChoices of [false, true]) {
        for (const withKw of [false, true]) {
          const route = resolveQuestionJudgeRoute(
            {
              id: `q-${matrixKey(profileId, kind, withChoices, withKw)}`,
              kind,
              rubric_json: withKw ? RUBRIC_KW : null,
              choices_md: withChoices ? CHOICES : null,
              judge_kind_override: null,
            },
            profile,
          );
          const answerClass = deriveAnswerClass({
            kind,
            rubric_json: withKw ? RUBRIC_KW : null,
            choices_md: withChoices ? CHOICES : null,
          });
          cells.push({ profileId, profile, kind, withChoices, withKw, route, answerClass });
        }
      }
    }
  }
  return cells;
}

describe('YUK-391 route parity: both twins reproduce the frozen pre-refactor matrix', () => {
  it('runtime twin (resolveQuestionJudgeRoute) matches every golden cell', () => {
    expect(Object.keys(GOLDEN_RUNTIME)).toHaveLength(9 * 2 * 2 * PROFILE_IDS.length);
    for (const cell of matrixCells()) {
      const key = matrixKey(cell.profileId, cell.kind, cell.withChoices, cell.withKw);
      expect(cell.route, key).toBe(GOLDEN_RUNTIME[key]);
    }
  });

  it('gen twin (defaultJudgeKindForQuestion) matches every golden cell', () => {
    expect(Object.keys(GOLDEN_GEN)).toHaveLength(9 * 2);
    for (const kind of KINDS) {
      for (const withKw of [false, true]) {
        const key = `${kind}|${withKw ? 'k' : '-'}`;
        expect(
          defaultJudgeKindForQuestion({ kind, rubric_json: withKw ? RUBRIC_KW : null }),
          key,
        ).toBe(GOLDEN_GEN[key]);
      }
    }
  });
});

describe('YUK-391 客观位 consistency: answer-class side ⟺ route side', () => {
  it('every matrix cell agrees, except the documented physics unit_dimension carve-out', () => {
    for (const cell of matrixCells()) {
      const key = matrixKey(cell.profileId, cell.kind, cell.withChoices, cell.withKw);
      const classSide = OBJECTIVE_CLASSES.has(cell.answerClass) ? 'objective' : 'llm';
      const routeSide = OBJECTIVE_ROUTES.has(cell.route) ? 'objective' : 'llm';
      if (classSide === routeSide) continue;
      // The ONLY sanctioned divergence (pre-existing, both before and after the
      // convergence): physics declares unit_dimension as a preferred route, which
      // reroutes computation rows — including the keyword class — to a model-backed
      // route BEFORE the class-based chain. Family calibration reads this profile
      // gate, not the bare class.
      expect(
        {
          key,
          profile: cell.profileId,
          kind: cell.kind,
          route: cell.route,
          answerClass: cell.answerClass,
        },
        key,
      ).toMatchObject({ profile: 'physics', kind: 'computation', route: 'unit_dimension' });
    }
  });
});

describe('YUK-391 kind families: deriveAnswerClass-derived predicates equal the retired sets', () => {
  it('OBJECTIVE_ANSWER_KINDS = {choice, true_false, fill_blank} (EXACT_KINDS / OBJECTIVE_KINDS / QUIZ_PLAN_OBJECTIVE_KINDS)', () => {
    expect([...OBJECTIVE_ANSWER_KINDS].sort()).toEqual(['choice', 'fill_blank', 'true_false']);
    for (const kind of ['choice', 'true_false', 'fill_blank']) {
      expect(isObjectiveAnswerKind(kind), kind).toBe(true);
    }
  });

  it('isLlmGradedAnswerKind = PROSE_KINDS ∪ {derivation} (quiz_gen exact-guard set)', () => {
    for (const kind of ['short_answer', 'reading', 'translation', 'essay', 'derivation']) {
      expect(isLlmGradedAnswerKind(kind), kind).toBe(true);
    }
    for (const kind of ['choice', 'true_false', 'fill_blank']) {
      expect(isLlmGradedAnswerKind(kind), kind).toBe(false);
    }
  });

  it('computation is the unique keyword-conditional kind (class flips keyword↔semantic)', () => {
    expect(isKeywordConditionalAnswerKind('computation')).toBe(true);
    for (const kind of KINDS) {
      if (kind === 'computation') continue;
      expect(isKeywordConditionalAnswerKind(kind), kind).toBe(false);
    }
  });

  it('raw profile-vocab kind strings classify exactly like the retired hand-sets (no normalization)', () => {
    // EXACT_KINDS / OBJECTIVE_KINDS matched on the RAW string: profile-vocab
    // values fell through to the semantic side unless the row carried choices.
    expect(isObjectiveAnswerKind('single_choice')).toBe(false);
    expect(isObjectiveAnswerKind('multiple_choice')).toBe(false);
    expect(isObjectiveAnswerKind('calculation')).toBe(false);
    expect(isObjectiveAnswerKind('reading_comprehension')).toBe(false);
    expect(isObjectiveAnswerKind('')).toBe(false);
  });
});

describe('YUK-391 twins sync + structural priority regressions', () => {
  it('runtime twin === gen twin on the profile-free dimension for semantic-preferring profiles', () => {
    // yuwen / general prefer neither steps nor any physics special: the runtime
    // resolver must reduce to the gen-time default for every choices-less cell.
    for (const profileId of ['yuwen', 'general']) {
      for (const kind of KINDS) {
        for (const withKw of [false, true]) {
          const runtime = resolveQuestionJudgeRoute(
            {
              id: 'q-sync',
              kind,
              rubric_json: withKw ? RUBRIC_KW : null,
              choices_md: null,
              judge_kind_override: null,
            },
            subjectProfiles[profileId],
          );
          const gen = defaultJudgeKindForQuestion({ kind, rubric_json: withKw ? RUBRIC_KW : null });
          expect(runtime, `${profileId}|${kind}|${withKw}`).toBe(gen);
        }
      }
    }
  });

  it('choices present → exact regardless of kind (runtime twin; gen twin is choices-blind)', () => {
    for (const profileId of PROFILE_IDS) {
      for (const kind of KINDS) {
        const route = resolveQuestionJudgeRoute(
          {
            id: 'q-choices',
            kind,
            rubric_json: RUBRIC_KW,
            choices_md: CHOICES,
            judge_kind_override: null,
          },
          subjectProfiles[profileId],
        );
        expect(route, `${profileId}|${kind}`).toBe('exact');
      }
    }
  });

  it('derivation ladder: steps for math, semantic for semantic-preferring profiles', () => {
    expect(
      resolveQuestionJudgeRoute(
        {
          id: 'q',
          kind: 'derivation',
          rubric_json: null,
          choices_md: null,
          judge_kind_override: null,
        },
        subjectProfiles.math,
      ),
    ).toBe('steps');
    for (const profileId of ['yuwen', 'general', 'physics']) {
      expect(
        resolveQuestionJudgeRoute(
          {
            id: 'q',
            kind: 'derivation',
            rubric_json: null,
            choices_md: null,
            judge_kind_override: null,
          },
          subjectProfiles[profileId],
        ),
        profileId,
      ).toBe('semantic');
    }
  });

  it('override wins first in both twins', () => {
    for (const profileId of PROFILE_IDS) {
      expect(
        resolveQuestionJudgeRoute(
          {
            id: 'q',
            kind: 'choice',
            choices_md: CHOICES,
            rubric_json: null,
            judge_kind_override: 'semantic',
          },
          subjectProfiles[profileId],
        ),
        profileId,
      ).toBe('semantic');
    }
    expect(defaultJudgeKindForQuestion({ kind: 'choice', judge_kind_override: 'keyword' })).toBe(
      'keyword',
    );
  });

  it('raw profile-vocab kinds: choices carry the row to exact; bare vocab falls to semantic', () => {
    const yuwen = subjectProfiles.yuwen;
    expect(
      resolveQuestionJudgeRoute(
        {
          id: 'q',
          kind: 'single_choice',
          rubric_json: null,
          choices_md: CHOICES,
          judge_kind_override: null,
        },
        yuwen,
      ),
    ).toBe('exact');
    expect(
      resolveQuestionJudgeRoute(
        {
          id: 'q',
          kind: 'reading_comprehension',
          rubric_json: null,
          choices_md: null,
          judge_kind_override: null,
        },
        yuwen,
      ),
    ).toBe('semantic');
    // physics reads the RAW kind for its unit_dimension gate (calculation is the
    // profile-vocab form) — preserved by the convergence.
    expect(
      resolveQuestionJudgeRoute(
        {
          id: 'q',
          kind: 'calculation',
          rubric_json: null,
          choices_md: null,
          judge_kind_override: null,
        },
        subjectProfiles.physics,
      ),
    ).toBe('unit_dimension');
  });

  it('multimodal_direct gate: only prose-semantic cells gate; computation and reference_solution never do', () => {
    const physics = subjectProfiles.physics;
    const figureRow = {
      id: 'q',
      rubric_json: null,
      choices_md: null,
      judge_kind_override: null,
      image_refs: ['fig-1'],
    };
    // prose + figure + physics preference → gate fires
    expect(resolveQuestionJudgeRoute({ ...figureRow, kind: 'short_answer' }, physics)).toBe(
      'multimodal_direct',
    );
    // computation keeps its unconditional semantic (pre-gate in the legacy chain)
    expect(resolveQuestionJudgeRoute({ ...figureRow, kind: 'computation' }, physics)).toBe(
      'unit_dimension',
    );
    // a rubric reference_solution belongs to steps@1, never the gate
    expect(
      resolveQuestionJudgeRoute(
        {
          ...figureRow,
          kind: 'short_answer',
          rubric_json: {
            criteria: [],
            reference_solution: {
              expected_signals: ['s1'],
              final_answer: 'x',
              answer_equivalents: [],
            },
          },
        },
        physics,
      ),
    ).toBe('semantic');
    // math does not prefer multimodal_direct → unchanged semantic
    expect(
      resolveQuestionJudgeRoute({ ...figureRow, kind: 'short_answer' }, subjectProfiles.math),
    ).toBe('semantic');
  });
});

describe('YUK-391 answer-class coverage of the matrix', () => {
  it('every profile sees every one of the 4 answer classes across the matrix', () => {
    for (const profileId of PROFILE_IDS) {
      const classes = new Set(
        matrixCells()
          .filter((c) => c.profileId === profileId)
          .map((c) => c.answerClass),
      );
      expect([...classes].sort(), profileId).toEqual([...ANSWER_CLASSES].sort());
    }
  });
});
