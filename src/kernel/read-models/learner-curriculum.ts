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
  /** Shared companion/teaching header. Null when there is nothing to say. */
  readonly header_md: string | null;
}

const STAGE_LABEL: Record<StandardStage, string> = {
  middle_school: '初中',
  high_school: '高中',
  university: '大学',
};

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
    const id = subject.id.trim();
    const label = subject.label.trim();
    if (id.length === 0 || label.length === 0 || byId.has(id)) continue;
    byId.set(id, { id, label });
  }
  return { weight: 'light', preferred_subjects: [...byId.values()] };
}

export function renderCurriculumHeader(
  curriculum: Pick<
    LearnerCurriculum,
    'declared_stage' | 'stage_label' | 'unconstrained_reason' | 'subject_mix_bias'
  >,
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
  const names = curriculum.subject_mix_bias.preferred_subjects.map((item) => item.label);
  if (names.length > 0) {
    lines.push(`偏好学科只作轻度搭配偏置，不是范围：${names.join('、')}。`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

export function assembleLearnerCurriculum(input: {
  declaredStages: readonly (string | null | undefined)[];
  preferredSubjects: readonly PreferredSubject[];
}): LearnerCurriculum {
  const fold = foldDeclaredStages(input.declaredStages);
  const bias = subjectMixBias(input.preferredSubjects);
  const curriculum = { ...fold, subject_mix_bias: bias };
  return { ...curriculum, header_md: renderCurriculumHeader(curriculum) };
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
    preferredSubjects: ids.map((id) => ({ id, label: labelById.get(id) ?? id })),
  });
}
