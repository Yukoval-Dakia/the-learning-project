import { z } from 'zod';

import { ExecutionPlan } from './execution';
import { RevisionId } from './ids';
import { ResponseSpec } from './response';
import { ScoringBasis } from './scoring';
import type { QuestionGroupStructureT } from './structure';
import { QuestionGroupStructure } from './structure';

// ====================================================================
// YUK-1046 — 统一评估契约 · 发布版本与发题绑定（grounding §3.1、§3.3、§7.3）
// ====================================================================
//
// PublishedQuestionRevision 是不可变发布表示：五层模型的 1–4 层整体版本化。
// integrity_digest 覆盖材料/资产 digest、内容、作答契约、评分依据与执行计划
// 的明确引用（§3.1）—— 归一化可能重建树 ID，digest 不因 archive 改变（§3.2）。
//
// 发题（issuance）时绑定 revision、目标 part、实际材料与选项展示映射；
// 不能提交时再取 latest（§3.1）。新 serve 默认不 shuffle（§7.3）——
// “以上都对”/引用字母选项保持原顺序。

/** 发布版本包络：结构 + 作答要求 + 评分依据 + 执行计划一起版本化。 */
export const PublishedQuestionRevision = z.object({
  revision_id: RevisionId,
  group_id: z.string().min(1),
  /** group 内序数；唯一键 (group_id, revision_ordinal)，非全局内容 hash。 */
  revision_ordinal: z.number().int().min(1),
  /** 完整性 digest（材料/资产/内容/契约/计划引用）；不可变。 */
  integrity_digest: z.string().min(1),
  structure: QuestionGroupStructure,
  response_spec: ResponseSpec,
  scoring_basis: ScoringBasis,
  execution_plan: ExecutionPlan,
  published_at: z.string().datetime(),
  /** 被本版替换的旧 revision；首版为 null。历史提交仍绑定原版（§3.3 表）。 */
  supersedes_revision_id: RevisionId.nullable(),
});
export type PublishedQuestionRevisionT = z.infer<typeof PublishedQuestionRevision>;

// ---------- 发题绑定 ----------

/** 实际发出的材料（material_id + 当时资产 digest —— 同版资产）。 */
export const IssuedMaterialBinding = z.object({
  material_id: z.string().min(1),
  asset_digest: z.string().min(1),
});
export type IssuedMaterialBindingT = z.infer<typeof IssuedMaterialBinding>;

/** 某选择槽实际呈现的选项顺序（默认 = ResponseSpec 声明顺序，不 shuffle）。 */
export const IssuedOptionOrder = z.object({
  slot_id: z.string().min(1),
  option_ids: z.array(z.string().min(1)).min(1),
});
export type IssuedOptionOrderT = z.infer<typeof IssuedOptionOrder>;

export const IssuanceBinding = z.object({
  revision_id: RevisionId,
  /** 本次发出的 part 子集。 */
  part_ids: z.array(z.string().min(1)).min(1),
  material_bindings: z.array(IssuedMaterialBinding).default([]),
  option_order: z.array(IssuedOptionOrder).default([]),
});
export type IssuanceBindingT = z.infer<typeof IssuanceBinding>;

/** 一次性 claim（teaching/probe/intervention 诊断等；§3.3）。 */
export const IssuanceClaimState = z.object({
  policy: z.enum(['one_time', 'unbounded']),
  status: z.enum(['unclaimed', 'claimed', 'released']),
  claimed_by_ref: z.string().min(1).nullable(),
});
export type IssuanceClaimStateT = z.infer<typeof IssuanceClaimState>;

export const AssessmentIssuance = z.object({
  issuance_id: z.string().min(1),
  binding: IssuanceBinding,
  issued_at: z.string().datetime(),
  claim: IssuanceClaimState,
});
export type AssessmentIssuanceT = z.infer<typeof AssessmentIssuance>;

// ---------- 确定性校验（发题 barrier 的纯子集） ----------

export interface IssuanceBindingIssue {
  code:
    | 'revision_mismatch'
    | 'unknown_part'
    | 'duplicate_part_binding'
    | 'unknown_material_binding'
    | 'unbound_part_material'
    | 'unknown_option_order_slot'
    | 'option_order_not_permutation'
    | 'option_order_slot_out_of_scope'
    | 'table_cell_out_of_scope'
    | 'missing_option_order';
  detail: string;
}

/**
 * 纯校验：issuance 绑定与 revision 一致 —— part/material 引用可解析、
 * 选择槽的呈现顺序是【该槽选项的排列】（默认原序；若声明了顺序必须完整）。
 * “实际所见锚点”由此成立：issuance + 绑定即学生当时所见（§7 消费面）。
 */
export function validateIssuanceBinding(
  binding: IssuanceBindingT,
  revision: PublishedQuestionRevisionT,
): IssuanceBindingIssue[] {
  const issues: IssuanceBindingIssue[] = [];
  // P1-2：issuance 绑定的 revision 必须就是被校验的 revision ——
  // 拿 r1 的绑定去校验 r2 必须当场报错，不得静默放行（否则 DTO 会把 r2
  // 冒充学生所见）。
  if (binding.revision_id !== revision.revision_id) {
    issues.push({
      code: 'revision_mismatch',
      detail: `binding targets revision '${binding.revision_id}' but was validated against '${revision.revision_id}'`,
    });
    return issues; // 身份都不对，后续校验无意义 —— fail fast。
  }
  const structure: QuestionGroupStructureT = revision.structure;

  const partIds = new Set(structure.parts.map((part) => part.part_id));
  const boundParts = new Set<string>();
  for (const partId of binding.part_ids) {
    if (!partIds.has(partId)) {
      issues.push({ code: 'unknown_part', detail: `binding references unknown part '${partId}'` });
    }
    if (boundParts.has(partId)) {
      issues.push({
        code: 'duplicate_part_binding',
        detail: `part '${partId}' bound twice`,
      });
    }
    boundParts.add(partId);
  }

  const materialsById = new Map(
    structure.materials.map((material) => [material.material_id, material] as const),
  );
  const boundMaterialIds = new Set<string>();
  for (const materialBinding of binding.material_bindings) {
    const material = materialsById.get(materialBinding.material_id);
    if (material == null) {
      issues.push({
        code: 'unknown_material_binding',
        detail: `binding references unknown material '${materialBinding.material_id}'`,
      });
    } else if (material.asset.digest !== materialBinding.asset_digest) {
      issues.push({
        code: 'unknown_material_binding',
        detail: `material '${materialBinding.material_id}' digest mismatch (served asset differs from revision)`,
      });
    }
    boundMaterialIds.add(materialBinding.material_id);
  }
  // 被发出的 part 所引用的材料必须全部实际绑定（学生所见 = 判分所引）。
  for (const partId of boundParts) {
    const part = structure.parts.find((candidate) => candidate.part_id === partId);
    if (part == null) continue;
    for (const materialId of part.material_ids) {
      if (!boundMaterialIds.has(materialId)) {
        issues.push({
          code: 'unbound_part_material',
          detail: `issued part '${partId}' references material '${materialId}' that the issuance does not bind`,
        });
      }
    }
  }

  // P1-6：只校验【发出范围内】的选择槽（slot.part_id ∈ binding.part_ids）。
  // P1-B：发出范围内的表格，其全部单元格槽也必须在发出范围内
  // （scope closure）—— 不静默吞掉缺失单元格，也不把未发出的 part 混进来。
  const slotPartById = new Map(
    revision.response_spec.slots.map((slot) => [slot.slot_id, slot.part_id] as const),
  );
  for (const slot of revision.response_spec.slots) {
    if (slot.kind !== 'table' || !boundParts.has(slot.part_id)) continue;
    for (const cell of slot.cells) {
      const cellPart = slotPartById.get(cell.slot_id);
      if (cellPart == null || !boundParts.has(cellPart)) {
        issues.push({
          code: 'table_cell_out_of_scope',
          detail: `issued table '${slot.slot_id}' references cell slot '${cell.slot_id}' outside the issued part scope`,
        });
      }
    }
  }

  const choiceSlots = revision.response_spec.slots
    .filter(
      (slot) =>
        slot.kind === 'single_choice' || slot.kind === 'multi_choice' || slot.kind === 'matching',
    )
    .filter((slot) => boundParts.has(slot.part_id));
  const orderBySlot = new Map(binding.option_order.map((entry) => [entry.slot_id, entry] as const));

  for (const slot of choiceSlots) {
    const optionIds =
      slot.kind === 'matching'
        ? slot.right_options.map((option) => option.option_id)
        : slot.options.map((option) => option.option_id);
    const order = orderBySlot.get(slot.slot_id);
    if (order == null) {
      issues.push({
        code: 'missing_option_order',
        detail: `choice slot '${slot.slot_id}' has no served option order`,
      });
      continue;
    }
    const declared = new Set(optionIds);
    const served = order.option_ids;
    const servedUnique = new Set(served);
    const isPermutation =
      served.length === optionIds.length &&
      servedUnique.size === served.length &&
      served.every((id) => declared.has(id));
    if (!isPermutation) {
      issues.push({
        code: 'option_order_not_permutation',
        detail: `slot '${slot.slot_id}' served order is not a permutation of declared options`,
      });
    }
    orderBySlot.delete(slot.slot_id);
  }
  for (const [staleSlotId, entry] of orderBySlot) {
    // 在 spec 中但不在发出范围内：跨 scope 的呈现映射，拒绝。
    const knownSlot = revision.response_spec.slots.find((slot) => slot.slot_id === staleSlotId);
    if (knownSlot != null && !boundParts.has(knownSlot.part_id)) {
      issues.push({
        code: 'option_order_slot_out_of_scope',
        detail: `option_order references slot '${staleSlotId}' outside the issued part scope`,
      });
    } else {
      issues.push({
        code: 'unknown_option_order_slot',
        detail: `option_order references non-choice or unknown slot '${staleSlotId}' (order=${entry.option_ids.join(',')})`,
      });
    }
  }
  return issues;
}
