// Learner-declared curriculum for task inputs. `goal.declared_stage` is a course
// band, never an ability reading. Preferred subjects are a light mix bias only:
// they never narrow or replace the band, the ticket, or a pinned knowledge point.
// One consistent standard band applies; custom, silence, or disagreement do not
// invent one.

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { DeclaredStage, type DeclaredStageT } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { goal, learning_session, subject } from '@/db/schema';

type DbLike = Db | Tx;

export type StandardStage = Exclude<DeclaredStageT, 'custom'>;

export type UnconstrainedReason = 'undeclared' | 'custom' | 'conflicting';

export interface PreferredSubject {
  readonly id: string;
  readonly label: string;
}

/** `weight` is fixed: callers must not treat this list as a scope filter. */
export interface SubjectMixBias {
  readonly weight: 'light';
  readonly preferred_subjects: readonly PreferredSubject[];
}

export interface LearnerCurriculum {
  readonly declared_stage: StandardStage | null;
  readonly stage_label: string | null;
  readonly unconstrained_reason: UnconstrainedReason | null;
  readonly subject_mix_bias: SubjectMixBias;
  /** Shared teaching/quiz header: stage line plus mix-bias line. */
  readonly header_md: string | null;
  /** Stage line alone; the startup segment keeps it while the bias may be dropped. */
  readonly stage_md: string | null;
  /** Mix-bias line alone: droppable on its own, it is only a light preference. */
  readonly preferences_md: string | null;
}

const STAGE_LABEL: Record<StandardStage, string> = {
  middle_school: '初中',
  high_school: '高中',
  university: '大学',
};

/**
 * Placement leanings reach the DB through an unvalidated string array
 * (`placement_leanings`), so the rendered header is bounded here rather than there.
 */
const MAX_PREFERRED_SUBJECTS = 8;
const MAX_PREFERRED_SUBJECT_LABEL_CHARS = 16;

type StageClass =
  | { readonly kind: 'band'; readonly stage: StandardStage }
  | { readonly kind: 'custom' }
  | { readonly kind: 'unknown' };

function classifyDeclaredStage(raw: string): StageClass {
  const parsed = DeclaredStage.safeParse(raw);
  if (!parsed.success) return { kind: 'unknown' };
  switch (parsed.data) {
    case 'middle_school':
    case 'high_school':
    case 'university':
      return { kind: 'band', stage: parsed.data };
    case 'custom':
      return { kind: 'custom' };
  }
}

export function foldDeclaredStages(
  raws: readonly (string | null | undefined)[],
): Pick<LearnerCurriculum, 'declared_stage' | 'stage_label' | 'unconstrained_reason'> {
  const seen = new Set<string>();
  let band: StandardStage | null = null;
  let bandCount = 0;
  let custom = false;
  let unknown = false;
  for (const raw of raws) {
    if (raw == null || raw.length === 0 || seen.has(raw)) continue;
    seen.add(raw);
    const classified = classifyDeclaredStage(raw);
    switch (classified.kind) {
      case 'band':
        bandCount += 1;
        band = classified.stage;
        break;
      case 'custom':
        custom = true;
        break;
      case 'unknown':
        unknown = true;
        break;
    }
  }
  if (seen.size === 0) {
    return { declared_stage: null, stage_label: null, unconstrained_reason: 'undeclared' };
  }
  if (!unknown && !custom && bandCount === 1 && band) {
    return {
      declared_stage: band,
      stage_label: STAGE_LABEL[band],
      unconstrained_reason: null,
    };
  }
  if (!unknown && custom && bandCount === 0) {
    return { declared_stage: null, stage_label: null, unconstrained_reason: 'custom' };
  }
  return { declared_stage: null, stage_label: null, unconstrained_reason: 'conflicting' };
}

export function subjectMixBias(preferred: readonly PreferredSubject[]): SubjectMixBias {
  const byId = new Map<string, PreferredSubject>();
  for (const subject of preferred) {
    if (byId.size >= MAX_PREFERRED_SUBJECTS) break;
    const id = subject.id.trim();
    const label = subject.label.trim().slice(0, MAX_PREFERRED_SUBJECT_LABEL_CHARS);
    if (id.length === 0 || label.length === 0 || byId.has(id)) continue;
    byId.set(id, { id, label });
  }
  return { weight: 'light', preferred_subjects: [...byId.values()] };
}

export function renderCurriculumHeader(
  curriculum: Pick<LearnerCurriculum, 'declared_stage' | 'stage_label' | 'unconstrained_reason'>,
): string | null {
  const lines: string[] = [];
  if (curriculum.declared_stage && curriculum.stage_label) {
    const label = curriculum.stage_label;
    lines.push(
      `课程约束：学段是${label}。讲解、出题和提示停在${label}课内；问到更高学段的概念时，先说明超纲，再按${label}能懂的方式讲。这不是能力判断。`,
    );
  } else if (curriculum.unconstrained_reason === 'custom') {
    lines.push('课程约束：学段标成自定义，本次不按标准学段限制。');
  } else if (curriculum.unconstrained_reason === 'conflicting') {
    lines.push('课程约束：进行中的目标学段不一致，本次不按单一学段限制。');
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

export function renderCurriculumPreferences(
  curriculum: Pick<LearnerCurriculum, 'subject_mix_bias'>,
): string | null {
  const names = curriculum.subject_mix_bias.preferred_subjects.map((item) => item.label);
  return names.length > 0 ? `偏好学科只作轻度搭配偏置，不是范围：${names.join('、')}。` : null;
}

export function assembleLearnerCurriculum(input: {
  declaredStages: readonly (string | null | undefined)[];
  preferredSubjects: readonly PreferredSubject[];
}): LearnerCurriculum {
  const fold = foldDeclaredStages(input.declaredStages);
  const subject_mix_bias = subjectMixBias(input.preferredSubjects);
  const stage_md = renderCurriculumHeader(fold);
  const preferences_md = renderCurriculumPreferences({ subject_mix_bias });
  const header_md = [stage_md, preferences_md].filter(Boolean).join('\n') || null;
  return { ...fold, subject_mix_bias, header_md, stage_md, preferences_md };
}

/** How a task prompt must read `curriculum` on its input. */
export const CURRICULUM_TASK_RULE =
  'curriculum.declared_stage 是课程范围约束，不是能力判断：middle_school 初中、high_school 高中、university 大学。有值时，讲解、出题和提示都停在该学段课内；问到更高学段的概念时，先说明超纲，再按该学段能懂的方式讲。null 表示未声明、自定义或几个目标的学段不一致，此时不另加学段限制。subject_mix_bias.weight 恒为 light，preferred_subjects 只在自行选择跨学科搭配时略微提高这些学科的比例，不得改掉已经定下的学科、知识点或学段，也不得排除其他学科。';

function preferredSubjectIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id.length === 0 || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_PREFERRED_SUBJECTS) break;
  }
  return ids;
}

/** Active goals' declared stages, plus the latest placement subject leanings. */
export async function readLearnerCurriculum(db: DbLike): Promise<LearnerCurriculum> {
  const [stageRows, leaningRows] = await Promise.all([
    db.select({ declared_stage: goal.declared_stage }).from(goal).where(eq(goal.status, 'active')),
    db
      .select({ leanings: learning_session.placement_leanings })
      .from(learning_session)
      .where(
        and(eq(learning_session.type, 'placement'), isNotNull(learning_session.placement_leanings)),
      )
      .orderBy(desc(learning_session.created_at))
      .limit(1),
  ]);
  const ids = preferredSubjectIds(leaningRows[0]?.leanings);
  const labels =
    ids.length > 0
      ? await db
          .select({ id: subject.id, display_name: subject.display_name })
          .from(subject)
          .where(inArray(subject.id, ids))
      : [];
  const labelById = new Map(labels.map((row) => [row.id, row.display_name]));
  return assembleLearnerCurriculum({
    declaredStages: stageRows.map((row) => row.declared_stage),
    // An unknown or deleted subject has no learner-readable label; a bare id would
    // leak into the header, so it is dropped rather than rendered.
    preferredSubjects: ids.flatMap((id) => {
      const label = labelById.get(id);
      return label ? [{ id, label }] : [];
    }),
  });
}
