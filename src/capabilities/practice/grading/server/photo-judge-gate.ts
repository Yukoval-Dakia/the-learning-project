import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { resolveTaskBinding, resolveTaskReasoning } from '@/server/ai/providers';
import { currentModelPinForKind } from './model-slice-registry';
import { photoTaskRunsMatch, readVerifiedPhotoExam } from './photo-exam-evidence';

/** 照片判分许可：把带图提交绑定到一个已实证的身份 + 放行依据。 */
export interface PhotoJudgeBinding {
  readonly task_kind: string;
  readonly model: string;
  readonly model_version: string;
  /** 放行依据：小考证据工件/事件 id（来源可追溯）。 */
  readonly evidence_ref: string;
}

/** 默认空 = 一切带图提交明确待定，不付费。 */
export const PHOTO_JUDGE_BINDINGS: readonly PhotoJudgeBinding[] = [];

/**
 * 本单元请求里图片证据的 id 集合（open 槽附件 + group 证据；与 rubric 线
 * 的构造一致）。图片之外的原媒体（audio/video/pdf）不在此列 —— 它们在执行器
 * 输入装配处已是显式 unjudgeable。
 */
export function collectImageEvidenceIds(request: ModelExecutorRequest): Set<string> {
  return new Set(
    [
      ...request.slot_responses.flatMap((entry) => (entry.kind === 'open' ? entry.evidence : [])),
      ...request.group_evidence.map((item) => item.evidence),
    ]
      .filter((item) => item.kind === 'image')
      .map((item) => item.evidence_id),
  );
}

/** 带图提交 = 请求里存在图片证据（纯图、文字加图、group_evidence 带图都算）。 */
export function requestHasImageEvidence(request: ModelExecutorRequest): boolean {
  return (request.submission_images?.count ?? 0) > 0 || collectImageEvidenceIds(request).size > 0;
}

/**
 * 照片身份判定：文本作答直接放行（与门无关）；带图提交必须命中绑定。
 * 解析不出当前 pin 即 fail-closed —— 身份未知时绝不放行照片判分。
 */
export function photoJudgeAdmission(
  request: ModelExecutorRequest,
): { ok: true; evidence_ref: string | null } | { ok: false; detail: string } {
  if (!requestHasImageEvidence(request)) return { ok: true, evidence_ref: null };
  const evidence = [
    ...request.slot_responses.flatMap((entry) => (entry.kind === 'open' ? entry.evidence : [])),
    ...request.group_evidence.map((item) => item.evidence),
  ].filter((item) => item.kind === 'image');
  const count = Math.max(request.submission_images?.count ?? 0, evidence.length);
  const bytes = Math.max(
    request.submission_images?.bytes ?? 0,
    evidence.reduce((total, item) => total + item.bytes, 0),
  );
  if (count > 8 || bytes > 32 * 1024 * 1024) {
    return { ok: false, detail: 'submission image evidence exceeds 8 images or 32 MiB' };
  }
  const taskKind = request.executor.task_kind;
  let pin: { model: string; model_version: string } | undefined;
  try {
    pin = currentModelPinForKind(taskKind);
  } catch {
    pin = undefined;
  }
  const binding =
    pin === undefined
      ? undefined
      : PHOTO_JUDGE_BINDINGS.find(
          (entry) =>
            entry.task_kind === taskKind &&
            entry.model === pin.model &&
            entry.model_version === pin.model_version,
        );
  if (binding === undefined) {
    return {
      ok: false,
      detail: `submission carries image evidence; no photo judging is bound for task '${taskKind}' at the current model pin — image-bearing submissions are not covered by text-slice admission`,
    };
  }
  return { ok: true, evidence_ref: binding.evidence_ref };
}

/** Evidence confirmation is before the recorded executor's claim/paid boundary. */
export async function confirmPhotoJudgeAdmission(db: Db, request: ModelExecutorRequest) {
  const admission = photoJudgeAdmission(request);
  if (!admission.ok || admission.evidence_ref === null) return admission;
  const task_kind = request.executor.task_kind;
  if (task_kind !== 'AssessmentRuleJudgeTask' && task_kind !== 'AssessmentRubricJudgeTask')
    return { ok: false as const, detail: 'Photo judging task is unsupported' };
  try {
    const pin = currentModelPinForKind(task_kind);
    const route = resolveTaskBinding(task_kind);
    if (
      !pin ||
      !(await readVerifiedPhotoExam(
        db,
        admission.evidence_ref,
        {
          task_kind,
          ...pin,
          provider: route.provider,
        },
        resolveTaskReasoning(task_kind, route.provider, route.model, route.reasoning)?.applied,
      ))
    )
      return {
        ok: false as const,
        detail:
          'Photo exam evidence is missing, failed, unaccounted or belongs to another identity',
      };
    // Recovery seam only: 转介已被 Owner 暂停，照片路径未接。
    return {
      ok: true as const,
      evidence_ref: admission.evidence_ref,
      photo_judgement: {
        provider: route.provider,
        applied_reasoning: resolveTaskReasoning(
          task_kind,
          route.provider,
          route.model,
          route.reasoning,
        )?.applied,
        task_kind,
        ...pin,
        evidence_ref: admission.evidence_ref,
        notice: 'AI 判、未校准' as const,
      },
    };
  } catch {
    return { ok: false as const, detail: 'Photo exam identity or evidence could not be verified' };
  }
}

export async function photoExecutionMatchesBinding(
  db: Db,
  request: ModelExecutorRequest,
  outcome: ModelUnitOutcomeT,
) {
  const photo = request.photo_judgement;
  if (!photo || outcome.kind !== 'scored') return true;
  const task_kind = photo.task_kind;
  if (task_kind !== 'AssessmentRuleJudgeTask' && task_kind !== 'AssessmentRubricJudgeTask')
    return false;
  const pin = currentModelPinForKind(task_kind);
  if (
    !pin ||
    pin.model !== photo.model ||
    pin.model_version !== photo.model_version ||
    outcome.run_refs.length === 0
  )
    return false;
  return photoTaskRunsMatch(
    db,
    outcome.run_refs,
    { task_kind, model: photo.model, model_version: photo.model_version, provider: photo.provider },
    photo.applied_reasoning,
  );
}
