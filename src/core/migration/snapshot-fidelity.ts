import type { PublishedQuestionRevisionT } from '../schema/assessment';
import {
  validateExecutionPlan,
  validateResponseSpec,
  validateScoringBasis,
  validateStructure,
} from '../schema/assessment';
import { extractAnswerHead } from '../schema/judge-routing';
import { canonicalHash } from './canonical';
import type { RevisionRegistryEntry } from './revision-registry';
import type { RawEventRow, RecordClassification } from './types';

// ====================================================================
// 历史迁移 apply · 冻结 snapshot 提取 + 内容/坐标 fidelity
// 校验
// ====================================================================
//
// 「frozen snapshot + coordinates fidelity validation」决策的唯一 owner：
//   - 分类记录 → 冻结 snapshot / 可机械比对内容面的提取（attempt /
//     durable review / pending 三形态 payload 遍历，提取规则逐字保留）；
//   - snapshot → revision 内容可推导性验证（题干/选项/
//     参考答案机械比对，超机械比对面走 question_asserted，不冒充已验证）；
//   - registry 坐标对 revision 契约的普适校验（part/slot/unit
//     关联 + 契约自身确定性校验子集）。
// 改任何 fidelity 规则（归一化口径、判据种类、坐标约束、快照提取形态）
// 只应发生在本文件。

interface EventPayload {
  [key: string]: unknown;
}

function payloadOf(payload: unknown): EventPayload {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as EventPayload)
    : {};
}

/** 分类记录的冻结 snapshot（attempt 事件 / durable pending submit）与 digest。 */
export function frozenSnapshotOf(
  record: RecordClassification,
  eventById: Map<string, RawEventRow>,
  pendingByRunId: Map<string, RawEventRow>,
): {
  snapshot: unknown;
  digest: string | null;
} {
  if (record.source_kind !== 'event') return { snapshot: null, digest: null };
  const event = eventById.get(record.source_id);
  if (event === undefined) return { snapshot: null, digest: null };
  const payload = payloadOf(event.payload);
  if (event.action === 'attempt') {
    const snapshot = payload.question_snapshot ?? null;
    return { snapshot, digest: snapshot == null ? null : canonicalHash(snapshot) };
  }
  if (event.action === 'review') {
    // durable 回填 review 的冻结输入在 pending 事件的 submit.question_snapshot；
    // 绑定键是 payload.run_id === review.id（与分类器同构，evidence id 去重不可靠）。
    const pending = pendingByRunId.get(event.id);
    if (pending === undefined) return { snapshot: null, digest: null };
    const submit = payloadOf(payloadOf(pending.payload).submit);
    const snapshot = submit.question_snapshot ?? null;
    return { snapshot, digest: snapshot == null ? null : canonicalHash(snapshot) };
  }
  if (event.action === 'experimental:judge_pending_attempt') {
    // 未回填 run 的冻结输入本体（缺件 pending 仍有权做 digest 对照）。
    const submit = payloadOf(payload.submit);
    const snapshot = submit.question_snapshot ?? null;
    return { snapshot, digest: snapshot == null ? null : canonicalHash(snapshot) };
  }
  return { snapshot: null, digest: null };
}

/** 冻结 snapshot 的【可机械比对】内容面（题干/选项/参考 —— 学习者所见）。 */
interface SnapshotContentView {
  prompt_md: string | null;
  choices_md: string[] | null;
  reference_md: string | null;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** 从记录自身的冻结 snapshot 提取可机械比对内容（attempt/durable/pending 三形态）。 */
export function snapshotContentViewOf(
  record: RecordClassification,
  eventById: Map<string, RawEventRow>,
  pendingByRunId: Map<string, RawEventRow>,
): SnapshotContentView | null {
  const snapshotOf = (raw: unknown): SnapshotContentView | null => {
    if (raw === null || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    // AttemptQuestionSnapshot：question.{prompt_md,choices_md,reference_md}
    // FrozenQuestionSnapshot：顶层 {prompt_md,choices_md,reference_md}。
    const q =
      obj.question !== null && typeof obj.question === 'object'
        ? (obj.question as Record<string, unknown>)
        : obj;
    const prompt = typeof q.prompt_md === 'string' ? q.prompt_md : null;
    const choices = Array.isArray(q.choices_md)
      ? (q.choices_md as unknown[]).filter((v): v is string => typeof v === 'string')
      : null;
    const reference = typeof q.reference_md === 'string' ? q.reference_md : null;
    if (prompt === null && choices === null && reference === null) return null;
    return { prompt_md: prompt, choices_md: choices, reference_md: reference };
  };
  if (record.source_kind !== 'event') return null;
  const event = eventById.get(record.source_id);
  if (event === undefined) return null;
  const payload = payloadOf(event.payload);
  if (event.action === 'attempt') return snapshotOf(payload.question_snapshot);
  if (event.action === 'review') {
    const pending = pendingByRunId.get(event.id);
    if (pending === undefined) return null;
    return snapshotOf(payloadOf(payloadOf(pending.payload).submit).question_snapshot);
  }
  if (event.action === 'experimental:judge_pending_attempt') {
    return snapshotOf(payloadOf(payload.submit).question_snapshot);
  }
  return null;
}

export interface SnapshotTransformationIssue {
  detail: string;
}

/**
 * digest_verified 的内容可推导性：registry 只证明「拿到过同一份
 * snapshot」；本函数再证明【目标 revision 的学习者所见内容可由该 snapshot 机械
 * 推导】—— solo 单 part：题干 trim/空白归一后逐字一致；选择题面：slot 选项
 * 文本与 snapshot.choices_md 序列一致（归一）；非选择题面不得出现选择题槽。
 * 评分依据/材料 digest 无法机械证明（§3.1 版本化 integrity 不等于 snapshot 字段），
 * 超出机械比对面的必须走 question_asserted 显式断言 —— 不冒充 digest_verified。
 *
 * snapshot.reference_md 一并纳入比对 —— 题干/选项相同
 * 而答案不同的同题面 snapshot 不得绑定到答案不同的 revision。只在【答案可机械
 * 推导】的计分单元判据上比对（text_key/option_set_key/numeric_key，镜像
 * evaluation.ts 确定性比较器的归一化语义）；rule_reference/holistic_level/
 * matching_pairs_key 的答案不能从参考答案文本机械推出 —— 按既有纪律跳过
 * （不冒充已验证；需要此类比对的绑定走 question_asserted）。
 */
export function verifySnapshotTransformation(
  view: SnapshotContentView,
  contract: PublishedQuestionRevisionT,
  partIds: readonly string[],
  slotId: string,
  scoringUnitId: string,
): SnapshotTransformationIssue[] {
  const issues: SnapshotTransformationIssue[] = [];
  const boundParts = contract.structure.parts.filter((part) => partIds.includes(part.part_id));
  if (boundParts.length !== 1) {
    issues.push({
      detail: `snapshot 是 solo 单题形态，但绑定 ${boundParts.length} 个 part —— 无法机械推导多 part 组合`,
    });
    return issues;
  }
  const [boundPart] = boundParts;
  if (boundPart === undefined) return issues; // length===1 已保证；TS 收窄用
  const part = boundPart;
  if (view.prompt_md === null || normalizeText(part.prompt_md) !== normalizeText(view.prompt_md)) {
    issues.push({
      detail: `题干不一致：snapshot='${normalizeText(view.prompt_md ?? '<null>').slice(0, 40)}…' vs revision part='${normalizeText(part.prompt_md).slice(0, 40)}…'（归一后逐字比对）`,
    });
  }
  const slot = contract.response_spec.slots.find((candidate) => candidate.slot_id === slotId);
  if (slot === undefined) {
    issues.push({ detail: `slot '${slotId}' 不在 revision 契约内` });
    return issues;
  }
  const isChoiceSlot = slot.kind === 'single_choice' || slot.kind === 'multi_choice';
  if (view.choices_md !== null) {
    if (!isChoiceSlot) {
      issues.push({
        detail: `snapshot 携带 ${view.choices_md.length} 个选项但槽位 '${slotId}' 是 ${slot.kind} —— 题型形态不一致`,
      });
    } else {
      const optionTexts =
        slot.kind === 'single_choice' || slot.kind === 'multi_choice'
          ? slot.options.map((option) => option.text)
          : [];
      const normalizedSnapshot = view.choices_md.map(normalizeText);
      const normalizedOptions = optionTexts.map(normalizeText);
      if (normalizedSnapshot.join('\u0001') !== normalizedOptions.join('\u0001')) {
        issues.push({
          detail: `选项文本序列不一致：snapshot ${normalizedSnapshot.length} 项 vs 槽位 ${normalizedOptions.length} 项（归一后逐项比对）`,
        });
      }
    }
  } else if (isChoiceSlot) {
    issues.push({
      detail: `revision 槽位 '${slotId}' 是选择题但 snapshot 无 choices_md —— 无法机械推导选项身份`,
    });
  }
  for (const issue of verifySnapshotReference(view, contract, slotId, scoringUnitId)) {
    issues.push(issue);
  }
  return issues;
}

/** text_key.normalization 四档的本地镜像（与 evaluation.ts 归一化同语义）。 */
function normalizeReferenceText(
  value: string,
  mode: 'exact' | 'trim' | 'trim_casefold_nfc' | 'answer_head',
): string {
  switch (mode) {
    case 'exact':
      return value;
    case 'trim':
      return value.trim();
    case 'trim_casefold_nfc':
      return value.normalize('NFKC').trim().toLowerCase();
    case 'answer_head':
      return extractAnswerHead(value).normalize('NFKC').trim().toLowerCase();
  }
}

/** 参考答案首部形态：选项字母/label 前缀（含 （C） / C. / C． 标注）。 */
const OPTION_MARKER_RE = /^[（(]?\s*([A-Za-z]{1,6})\s*[)）.．、:：]?\s*/;
const NUMERIC_HEAD_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * snapshot.reference_md ↔ 计分单元判据的机械比对：只处理答案可由
 * 参考文本确定性推导的判据；其余判据（rule_reference 等）无答案可机械比对，
 * 保持既有纪律 —— 不在此判定。
 */
function verifySnapshotReference(
  view: SnapshotContentView,
  contract: PublishedQuestionRevisionT,
  slotId: string,
  scoringUnitId: string,
): SnapshotTransformationIssue[] {
  const issues: SnapshotTransformationIssue[] = [];
  if (view.reference_md === null) return issues;
  const unit = contract.scoring_basis.units.find(
    (candidate) => candidate.scoring_unit_id === scoringUnitId,
  );
  // 坐标完整性（unit 存在/消费绑定槽位）由 validateEntryCoordinates 判定；
  // 这里只补充答案内容的机械比对，不重复坐标结论。
  if (unit === undefined || !unit.slot_refs.includes(slotId)) return issues;
  const criterion = unit.criterion;
  const head = extractAnswerHead(view.reference_md);
  if (head.length === 0) return issues;
  const slot = contract.response_spec.slots.find((candidate) => candidate.slot_id === slotId);

  if (criterion.kind === 'text_key') {
    const given = normalizeReferenceText(view.reference_md, criterion.normalization);
    const accepted = criterion.accepted_texts.map((t) =>
      normalizeReferenceText(t, criterion.normalization),
    );
    if (!accepted.includes(given)) {
      issues.push({
        detail: `参考答案不一致：snapshot reference 归一化后为 '${given.slice(0, 40)}'，不在 scoring unit '${scoringUnitId}' 的 accepted_texts 内 —— 同题面异答案快照不得绑定`,
      });
    }
    return issues;
  }

  if (criterion.kind === 'option_set_key') {
    if (slot === undefined || (slot.kind !== 'single_choice' && slot.kind !== 'multi_choice')) {
      return issues; // 选项键落在非选择槽是契约违背（坐标校验已报），不加二次结论
    }
    const options = slot.options;
    const marker = OPTION_MARKER_RE.exec(head);
    if (marker !== null && marker[1] !== undefined) {
      const letters = marker[1].toUpperCase().split('');
      const rest = normalizeText(head.slice(marker[0].length));
      const resolved = new Set<string>();
      let allResolved = true;
      for (const letter of letters) {
        const option = options.find(
          (o) => o.label.toUpperCase() === letter || o.option_id.toUpperCase() === letter,
        );
        if (option === undefined) {
          allResolved = false;
          break;
        }
        resolved.add(option.option_id);
      }
      if (allResolved) {
        // 字母路径命中且 marker 尾部非空 —— 尾部必须是所选选项的原文
        // （如 '（C）选项原文'），否则不采信字母解释，退到文本比对。
        if (rest.length > 0) {
          const tailMatches = [...resolved].some((id) => {
            const text = options.find((o) => o.option_id === id)?.text;
            return text !== undefined && normalizeText(text) === rest;
          });
          if (tailMatches) {
            if (!sameOptionSet(resolved, criterion.accepted_option_ids)) {
              issues.push({
                detail: `参考答案不一致：snapshot 选项 '${marker[1].toUpperCase()}' 解出的集合与 scoring unit '${scoringUnitId}' 的 accepted_option_ids [${criterion.accepted_option_ids.join(',')}] 不符 —— 同题面异答案快照不得绑定`,
              });
            }
            return issues;
          }
        } else {
          if (!sameOptionSet(resolved, criterion.accepted_option_ids)) {
            issues.push({
              detail: `参考答案不一致：snapshot 选项 '${marker[1].toUpperCase()}' vs scoring unit '${scoringUnitId}' 的 accepted_option_ids [${criterion.accepted_option_ids.join(',')}] —— 同题面异答案快照不得绑定`,
            });
          }
          return issues;
        }
      }
    }
    // 文本路径：参考答案首部直接是选项文本（或与 accepted 选项文本序列一致）。
    const normalizedHead = normalizeText(head);
    const acceptedOptions = options.filter((o) =>
      criterion.accepted_option_ids.includes(o.option_id),
    );
    const acceptedTexts = acceptedOptions.map((o) => normalizeText(o.text));
    const headMatchesAccepted =
      acceptedTexts.includes(normalizedHead) || acceptedTexts.join('\u0001') === normalizedHead;
    if (acceptedTexts.length > 0 && !headMatchesAccepted) {
      issues.push({
        detail: `参考答案不一致：snapshot reference '${normalizedHead.slice(0, 40)}' 与 scoring unit '${scoringUnitId}' 所接受选项的文本不符 —— 同题面异答案快照不得绑定`,
      });
    }
    return issues;
  }

  if (criterion.kind === 'numeric_key') {
    const match = NUMERIC_HEAD_RE.exec(head);
    if (match === null) return issues; // 非数值首部无法机械比对 —— 不判
    const value = Number.parseFloat(match[0]);
    if (!Number.isFinite(value)) return issues;
    const diff = Math.abs(value - criterion.expected);
    const inTolerance =
      criterion.tolerance.kind === 'absolute'
        ? diff <= criterion.tolerance.value
        : criterion.expected === 0
          ? diff === 0
          : diff / Math.abs(criterion.expected) <= criterion.tolerance.ratio;
    if (!inTolerance) {
      issues.push({
        detail: `参考答案不一致：snapshot 数值 ${value} 超出 scoring unit '${scoringUnitId}' 期望 ${criterion.expected}±容差 —— 同题面异答案快照不得绑定`,
      });
    }
    if (criterion.expected_unit !== undefined && criterion.expected_unit.trim().length > 0) {
      const unitSuffix = head.slice(match[0].length).trim();
      if (unitSuffix.length > 0 && unitSuffix !== criterion.expected_unit.trim()) {
        issues.push({
          detail: `参考答案单位不一致：snapshot '${unitSuffix}' vs 契约 '${criterion.expected_unit}'`,
        });
      }
    }
    return issues;
  }
  // rule_reference / holistic_level / matching_pairs_key：答案不能从参考文本
  // 机械推出（既有纪律：超机械比对面走 question_asserted）—— 不在此判定。
  return issues;
}

function sameOptionSet(resolved: ReadonlySet<string>, accepted: readonly string[]): boolean {
  return resolved.size === accepted.length && accepted.every((id) => resolved.has(id));
}

export interface EntryCoordinateIssue {
  detail: string;
}

/**
 * 每一条 mapped 绑定（不限 submission 锚）都必须对上目标库 revision 契约：
 * part_ids ⊆ structure.parts；slot 存在且属于绑定 part 集；scoring_unit 存在
 * 且【关联】绑定槽位（unit.slot_refs 覆盖 slot —— 不允许拿他槽的 unit 判本题）；
 * 契约自身过发布 barrier 的确定性子集校验。
 */
export function validateEntryCoordinates(
  entry: RevisionRegistryEntry,
  contract: PublishedQuestionRevisionT,
): EntryCoordinateIssue[] {
  const issues: EntryCoordinateIssue[] = [];
  const contractIssues = [
    ...validateStructure(contract.structure),
    ...validateResponseSpec(contract.response_spec, contract.structure),
    ...validateScoringBasis(contract.scoring_basis, contract.response_spec, contract.structure),
    ...validateExecutionPlan(contract.execution_plan, contract.scoring_basis),
  ];
  if (contractIssues.length > 0) {
    issues.push({
      detail: `revision 契约校验失败：${contractIssues.map((i) => `${i.code}(${'detail' in i ? i.detail : ''})`).join('; ')}`,
    });
    return issues;
  }
  const partIds = new Set(contract.structure.parts.map((part) => part.part_id));
  if (!entry.part_ids.every((partId) => partIds.has(partId))) {
    issues.push({
      detail: `part_ids [${entry.part_ids.join(',')}] 不在契约 parts [${[...partIds].join(',')}] 内`,
    });
  }
  const slot = contract.response_spec.slots.find(
    (candidate) => candidate.slot_id === entry.slot_id,
  );
  if (slot === undefined) {
    issues.push({ detail: `slot '${entry.slot_id}' 不在 revision 契约内` });
  } else if (!entry.part_ids.includes(slot.part_id)) {
    issues.push({
      detail: `slot '${entry.slot_id}' 属于 part '${slot.part_id}'，不在绑定 part 集 [${entry.part_ids.join(',')}] 内`,
    });
  }
  const unit = contract.scoring_basis.units.find(
    (candidate) => candidate.scoring_unit_id === entry.scoring_unit_id,
  );
  if (unit === undefined) {
    issues.push({ detail: `scoring_unit '${entry.scoring_unit_id}' 不在契约计分单元集内` });
  } else if (!unit.slot_refs.includes(entry.slot_id)) {
    issues.push({
      detail: `scoring_unit '${entry.scoring_unit_id}' 不消费绑定槽位 '${entry.slot_id}'（其 slot_refs=[${unit.slot_refs.join(',')}]）—— 不允许拿他槽单元判本题`,
    });
  }
  return issues;
}
