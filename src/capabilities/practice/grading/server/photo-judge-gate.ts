import type { ModelExecutorRequest } from '@/core/schema/assessment';
import { currentModelPinForKind } from './model-slice-registry';

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
