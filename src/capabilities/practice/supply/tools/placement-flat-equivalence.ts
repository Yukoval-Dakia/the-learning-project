// YUK-1859 — placement 交付下唯一放行 typed 声明的口：恰 1 个 part 且其全部
// 字段与扁平 SourcedQuestion 字段逐一对齐时，返回剥掉声明的副本走同一扁平
// 提交事务（同一 fence/授权/回执语义）；否则返回 undefined，调用处走原拒绝。
// 任何字段对不上即不转——不猜、不补、不压平；多 part 一律不碰。
// 备题员切换（YUK-1468）删除定位路径时本文件整体退役。
import { extractAnswerHead } from '@/core/schema/judge-routing';
import type { DraftPartT, DraftUnitT } from '@/core/schema/question-draft';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import { parseChoiceAnswerHead } from '@/kernel/records/assessment-normalization';

function selectUnitEquivalentReasons(question: SourcedQuestionT, unit: DraftUnitT): string[] {
  const reasons: string[] = [];
  if (unit.response_class !== 'select')
    reasons.push(`unit.response_class '${unit.response_class}' 非 select`);
  const spec = unit.response_spec;
  if (spec.kind !== 'select') {
    reasons.push(`unit.response_spec.kind '${spec.kind}' 非 select`);
    return reasons;
  }
  if (spec.axes !== undefined) reasons.push('response_spec.axes 无扁平对应');
  if (spec.at_most_per_coordinate !== undefined)
    reasons.push('response_spec.at_most_per_coordinate 无扁平对应');
  if (spec.text !== undefined) reasons.push('response_spec.text 无扁平对应');
  const choices = question.choices_md ?? [];
  if (choices.length < 2 || spec.items.length !== choices.length)
    reasons.push(
      `select items ${spec.items.length} 个与 choices_md ${choices.length} 个不能一一对应`,
    );
  if (spec.items.length === choices.length) {
    spec.items.forEach((item, i) => {
      if (item.coordinates !== undefined) reasons.push(`items[${i}].coordinates 无扁平对应`);
      if (item.gap_after_codepoint !== undefined)
        reasons.push(`items[${i}].gap_after_codepoint 无扁平对应`);
      if (item.metadata !== undefined && Object.keys(item.metadata).length > 0)
        reasons.push(`items[${i}].metadata 非空`);
      if (item.label_md !== undefined && item.label_md !== choices[i])
        reasons.push(`items[${i}].label_md 与 choices_md[${i}] 不一致`);
    });
  }
  if (unit.material_refs.length > 0) reasons.push('unit.material_refs 非空');
  if (Object.keys(unit.metadata).length > 0) reasons.push('unit.metadata 非空');
  if (unit.reference_md !== undefined) reasons.push('unit.reference_md 无扁平对应');
  if (unit.rubric !== undefined) reasons.push('unit.rubric 无扁平对应');
  if (unit.points != null && unit.points !== 1)
    reasons.push(`unit.points=${unit.points}：扁平单元固定 1 分`);
  if (
    unit.method.kind !== 'set-compare' ||
    unit.method.version !== undefined ||
    unit.method.binding !== undefined ||
    unit.method.task_kind !== undefined
  )
    reasons.push('unit.method 非裸 set-compare');
  if (unit.rule !== undefined) {
    const rule = unit.rule;
    const sole = rule.cases.length === 1 ? rule.cases[0] : undefined;
    const when = sole?.when;
    const flatShape =
      rule.source === undefined &&
      sole !== undefined &&
      when !== undefined &&
      !('all' in when) &&
      !('any' in when) &&
      Object.keys(when).length === 2 &&
      when.miss !== undefined &&
      Object.keys(when.miss).length === 1 &&
      when.miss.eq === 0 &&
      when.wrong !== undefined &&
      Object.keys(when.wrong).length === 1 &&
      when.wrong.eq === 0 &&
      Object.keys(sole.award).length === 1 &&
      'points' in sole.award &&
      sole.award.points === 1 &&
      Object.keys(rule.otherwise).length === 1 &&
      'points' in rule.otherwise &&
      rule.otherwise.points === 0;
    if (!flatShape) reasons.push('unit.rule 与扁平全对 1 分/否则 0 分语义不等价');
  }
  // key 与扁平可推导答案集必须一致；扁平推导失败 ⇒ 声明的键无法无损表达。
  const head = extractAnswerHead(question.reference_md).trim();
  const flatAccepted = parseChoiceAnswerHead(head, spec.items.length);
  const expectedPick = flatAccepted != null && flatAccepted.length > 1 ? 'many' : 'one';
  const declaredPick = spec.pick ?? 'many';
  if (declaredPick !== expectedPick)
    reasons.push(`response_spec.pick '${declaredPick}' 与扁平推导 '${expectedPick}' 不一致`);
  if (unit.key !== undefined) {
    if (unit.key.kind !== 'select') {
      reasons.push(`unit.key.kind '${unit.key.kind}' 与 select 单元不一致`);
    } else if (flatAccepted == null) {
      reasons.push('reference_md 答案头不可解析为选项字母，声明的键无扁平对应');
    } else {
      const declaredIds = new Set(unit.key.accepted_item_ids);
      const expectedIds = new Set(flatAccepted.map((idx) => spec.items[idx]?.item_id));
      if (
        declaredIds.size !== expectedIds.size ||
        [...declaredIds].some((id) => !expectedIds.has(id))
      )
        reasons.push('key.accepted_item_ids 与 reference_md 答案头推导的选项集不一致');
    }
  }
  return reasons;
}

/** 逐字段核对清单——空数组 = 单 part 声明与扁平字段无损等价。 */
export function placementSinglePartFlatEquivalence(question: SourcedQuestionT): string[] {
  const parts = question.parts ?? [];
  const reasons: string[] = [];
  if (parts.length !== 1) {
    reasons.push(`parts ${parts.length} 个，非单 part`);
    return reasons;
  }
  const part: DraftPartT = parts[0];
  if (part.prompt_md !== question.prompt_md) reasons.push('part.prompt_md 与扁平题面不一致');
  if (part.question_no !== undefined) reasons.push('part.question_no 无扁平对应');
  if (part.material_ids.length > 0) reasons.push('part.material_ids 非空');
  if (part.blank_order !== undefined) reasons.push('part.blank_order 无扁平对应');
  if (part.explanation_md !== undefined) reasons.push('part.explanation_md 无扁平对应');
  if (Object.keys(part.metadata).length > 0) reasons.push('part.metadata 非空');
  if (part.units.length !== 1) {
    reasons.push(`part.units ${part.units.length} 个，非单作答位`);
    return reasons;
  }
  reasons.push(...selectUnitEquivalentReasons(question, part.units[0]));
  return reasons;
}

/**
 * placement 候选的无损降级：单 part 等价 ⇒ 返回无 parts 的副本（每次降级记一条
 * 诊断日志）；其它情况返回原对象——返回值的 parts 非空即调用处照旧拒绝。
 */
export function placementFlatEquivalent(
  question: SourcedQuestionT,
  placement: boolean,
  requestId: string,
): SourcedQuestionT {
  if (!placement || question.parts == null || question.parts.length !== 1) return question;
  if (placementSinglePartFlatEquivalence(question).length > 0) return question;
  const part = question.parts[0];
  console.info('[submit_question] placement_declared_parts_flat_equivalent', {
    request_id: requestId,
    part_id: part.part_id,
    unit_ids: part.units.map((unit) => unit.unit_id),
  });
  return { ...question, parts: undefined };
}
