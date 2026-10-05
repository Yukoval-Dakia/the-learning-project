import { z } from 'zod';

import { SharedMaterial } from './materials';

// ====================================================================
// YUK-1046 — 五层模型 · 第一层：题目结构（grounding §3.1、§7.2）
// ====================================================================
//
// structure 只描述【卷面】：题干、共享材料、part 组成。它【不是】学校题型
// 枚举 —— 没有-kind 字段；任意复合结构由 parts + materials + ResponseSpec
// 组合表达（单题 = 恰好 1 part 的 group，§3.1）。
//
// 身份纪律（§3.1）：part/material 身份在语义不变时保留；拆分/合并/语义替换
// 必须生成新身份与映射；显示顺序是数据，不是数组 index 的隐含语义。

/**
 * 一个可独立呈现题面的部分（单题 group = 1 part；复合题/大题 = 多 part 或
 * stem 承载材料 + 多 part）。part_id 在 group 内稳定且唯一。
 */
export const QuestionPart = z.object({
  part_id: z.string().min(1),
  /** MathMarkdown 题干；可能内嵌图片（§7.1 —— 内嵌图与结构化 figure 并存）。 */
  prompt_md: z.string(),
  /** 展示序号（如 "(2)"）；仅显示用途，不参与身份。 */
  question_no: z.string().optional(),
  /** 该 part 依赖的共享材料（material_id 引用，validateStructure 校验解析）。 */
  material_ids: z.array(z.string().min(1)).default([]),
});
export type QuestionPartT = z.infer<typeof QuestionPart>;

/**
 * 题组结构：group root + 共享材料 + parts。revision 属于 group root；
 * 唯一键是 (group_id, revision_ordinal)，不是全局内容 hash（§3.1）。
 */
export const QuestionGroupStructure = z.object({
  group_id: z.string().min(1),
  /** 共享刺激材料（可为空 —— 无材料题）。material_id 唯一。 */
  materials: z.array(SharedMaterial).default([]),
  /** 至少一个 part：单题也是 1-part 组。part_id 唯一。 */
  parts: z.array(QuestionPart).min(1),
});
export type QuestionGroupStructureT = z.infer<typeof QuestionGroupStructure>;

/** 确定性校验问题（无 IO、可测）。 */
export interface StructureIssue {
  code: 'duplicate_part_id' | 'duplicate_material_id' | 'unresolved_material_ref' | 'empty_prompt';
  detail: string;
}

/**
 * 纯校验：part/material 身份唯一、material 引用可解析、题干非空。
 * 返回问题列表（空 = 通过）。这是发布 barrier 的确定性子集，不是发布本身。
 */
export function validateStructure(structure: QuestionGroupStructureT): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const materialIds = new Set<string>();
  for (const material of structure.materials) {
    if (materialIds.has(material.material_id)) {
      issues.push({
        code: 'duplicate_material_id',
        detail: `material_id '${material.material_id}' appears more than once`,
      });
    }
    materialIds.add(material.material_id);
  }
  const partIds = new Set<string>();
  for (const part of structure.parts) {
    if (partIds.has(part.part_id)) {
      issues.push({
        code: 'duplicate_part_id',
        detail: `part_id '${part.part_id}' appears more than once`,
      });
    }
    partIds.add(part.part_id);
    if (part.prompt_md.trim().length === 0) {
      issues.push({ code: 'empty_prompt', detail: `part '${part.part_id}' has empty prompt_md` });
    }
    for (const materialId of part.material_ids) {
      if (!materialIds.has(materialId)) {
        issues.push({
          code: 'unresolved_material_ref',
          detail: `part '${part.part_id}' references unknown material '${materialId}'`,
        });
      }
    }
  }
  return issues;
}
