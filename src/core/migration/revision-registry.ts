import { canonicalHash } from './canonical';

// ====================================================================
// YUK-1572 — 历史迁移 apply · revision registry v2 工件解析 +
// occurrence/snapshot 绑定裁决（自 apply.ts 迁出；函数体逐字不变）
// ====================================================================
//
// 「revision registry / occurrence snapshot binding」决策的唯一 owner：
//   - registry 工件形状（v2 schema、逐条校验、去重/唯一性纪律、
//     fail-visible 解析 —— 任何形状问题都拒绝，不猜）；
//   - 记录的冻结 snapshot digest ↔ snapshot_verified / question_asserted
//     绑定的解析裁决（pending / mapped / conflicted + reason / binding
//     判定语 —— 判定语逐字保留，审计与 worklist 消费方按文本对账）。
// 修改 registry 工件形状或绑定裁决规则只应发生在本文件。

export type RegistryBindingKind = 'snapshot_verified' | 'question_asserted';

/**
 * 语料导入（publisher/normalizer lane 或隔离演练产物）声明的 legacy → 新契约
 * 绑定。v2（review P1-4）：
 *   - occurrence/snapshot 感知：同一 legacy question 的多个历史版本可各绑不同
 *     revision/快照；多个 legacy question 也可绑同一 group revision 的不同 parts。
 *   - `snapshot_verified`：携带冻结 snapshot digest，解析时与历史记录自身的
 *     冻结 snapshot digest【逐一比对】—— 这是绑定为已验证的唯一途径。
 *   - `question_asserted`：显式、可审计的断言（缺历史证明时的唯一合法路径）；
 *     必须给出 assertion_reason，进 mapping evidence，绝不冒充已验证。
 *   - `scoring_unit_id` 必填：整题 legacy 判词必须可归属到唯一计分单元，
 *     否则 registry 拒绝（归属不明 ⇒ 不列绑定，不是规划器猜）。
 */
export interface RevisionRegistryEntry {
  question_id: string;
  revision_id: string;
  /** issuance 绑定的 part 子集（导入方声明；solo 题 = 单 part）。 */
  part_ids: string[];
  slot_id: string;
  scoring_unit_id: string;
  binding_kind: RegistryBindingKind;
  /** binding_kind=snapshot_verified 必填：冻结 snapshot 的 canonical digest。 */
  snapshot_digest: string | null;
  /** binding_kind=question_asserted 必填：断言理由（可审计）。 */
  assertion_reason: string | null;
  published_at: string | null;
}

export interface RevisionRegistry {
  registry_version: 2;
  generated_by: string;
  entries: RevisionRegistryEntry[];
}

export interface RegistryParseIssue {
  detail: string;
}

/** 解析 + 校验 registry v2 工件（fail-visible：任何形状问题都拒绝，不猜）。 */
export function parseRevisionRegistry(
  input: unknown,
): { ok: true; registry: RevisionRegistry } | { ok: false; issues: RegistryParseIssue[] } {
  const issues: RegistryParseIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ detail: 'registry 根必须是对象' }] };
  }
  const root = input as Record<string, unknown>;
  if (root.registry_version !== 2) {
    return {
      ok: false,
      issues: [
        {
          detail: `registry_version 必须为 2（得到 ${String(root.registry_version)}）—— v1（可空 snapshot_digest 的单题绑定）已被 review P1-4 废弃`,
        },
      ],
    };
  }
  if (typeof root.generated_by !== 'string' || root.generated_by.length === 0) {
    issues.push({ detail: 'generated_by 必须为非空字符串（工件来源可审计）' });
  }
  if (!Array.isArray(root.entries)) {
    issues.push({ detail: 'entries 必须为数组' });
    return { ok: false, issues };
  }
  const seenVerified = new Set<string>(); // question_id|snapshot_digest 唯一
  const seenAsserted = new Set<string>(); // question_id 唯一（一题一断言）
  const seenExact = new Set<string>(); // 完全重复拒绝
  const entries: RevisionRegistryEntry[] = [];
  for (const [idx, raw] of root.entries.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ detail: `entries[${idx}] 必须为对象` });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const questionId = entry.question_id;
    const revisionId = entry.revision_id;
    const partIds = entry.part_ids;
    const slotId = entry.slot_id;
    const scoringUnitId = entry.scoring_unit_id;
    const bindingKind = entry.binding_kind;
    if (typeof questionId !== 'string' || questionId.length === 0) {
      issues.push({ detail: `entries[${idx}].question_id 必须为非空字符串` });
      continue;
    }
    if (typeof revisionId !== 'string' || revisionId.length === 0) {
      issues.push({ detail: `entries[${idx}].revision_id 必须为非空字符串` });
      continue;
    }
    if (
      !Array.isArray(partIds) ||
      partIds.length === 0 ||
      partIds.some((p) => typeof p !== 'string' || p.length === 0)
    ) {
      issues.push({
        detail: `entries[${idx}].part_ids 必须为非空字符串数组（导入方声明 issuance 绑定子集）`,
      });
      continue;
    }
    if (typeof slotId !== 'string' || slotId.length === 0) {
      issues.push({ detail: `entries[${idx}].slot_id 必填（legacy 作答的槽位归属必须显式声明）` });
      continue;
    }
    if (typeof scoringUnitId !== 'string' || scoringUnitId.length === 0) {
      issues.push({
        detail: `entries[${idx}].scoring_unit_id 必填（整题 legacy 判词必须可归属到唯一计分单元）`,
      });
      continue;
    }
    if (bindingKind !== 'snapshot_verified' && bindingKind !== 'question_asserted') {
      issues.push({
        detail: `entries[${idx}].binding_kind 必须为 'snapshot_verified' 或 'question_asserted'`,
      });
      continue;
    }
    const snapshotDigest =
      typeof entry.snapshot_digest === 'string' && entry.snapshot_digest.length > 0
        ? entry.snapshot_digest
        : null;
    const assertionReason =
      typeof entry.assertion_reason === 'string' && entry.assertion_reason.length > 0
        ? entry.assertion_reason
        : null;
    if (bindingKind === 'snapshot_verified' && snapshotDigest === null) {
      issues.push({
        detail: `entries[${idx}] binding_kind=snapshot_verified 必须携带 snapshot_digest —— 缺历史证明只能走显式 question_asserted 断言`,
      });
      continue;
    }
    if (bindingKind === 'question_asserted' && assertionReason === null) {
      issues.push({
        detail: `entries[${idx}] binding_kind=question_asserted 必须携带 assertion_reason`,
      });
      continue;
    }
    const exactKey = `${questionId}|${revisionId}|${slotId}|${bindingKind}|${snapshotDigest ?? ''}`;
    if (seenExact.has(exactKey)) {
      issues.push({ detail: `entries[${idx}] 与既有条目完全重复（${exactKey}）` });
      continue;
    }
    seenExact.add(exactKey);
    if (bindingKind === 'snapshot_verified') {
      const verifiedKey = `${questionId}|${snapshotDigest}`;
      if (seenVerified.has(verifiedKey)) {
        issues.push({
          detail: `entries[${idx}] 同一 question 的同一 snapshot digest 有多条 snapshot_verified 绑定 —— 解析歧义，拒绝`,
        });
        continue;
      }
      seenVerified.add(verifiedKey);
    } else if (seenAsserted.has(questionId)) {
      issues.push({
        detail: `entries[${idx}] 同一 question 已有一条 question_asserted 断言 —— 一题一断言`,
      });
      continue;
    } else {
      seenAsserted.add(questionId);
    }
    entries.push({
      question_id: questionId,
      revision_id: revisionId,
      part_ids: partIds as string[],
      slot_id: slotId,
      scoring_unit_id: scoringUnitId,
      binding_kind: bindingKind,
      snapshot_digest: snapshotDigest,
      assertion_reason: assertionReason,
      published_at:
        typeof entry.published_at === 'string' && entry.published_at.length > 0
          ? entry.published_at
          : null,
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    registry: { registry_version: 2, generated_by: root.generated_by as string, entries },
  };
}

/** registry 工件的内容 digest（plan/run 身份的一部分）。 */
export function registryDigestOf(registry: RevisionRegistry | null): string | null {
  return registry === null ? null : canonicalHash(registry);
}

export function groupEntriesByQuestion(
  entries: RevisionRegistryEntry[],
): Map<string, RevisionRegistryEntry[]> {
  const map = new Map<string, RevisionRegistryEntry[]>();
  for (const entry of entries) {
    const list = map.get(entry.question_id) ?? [];
    list.push(entry);
    map.set(entry.question_id, list);
  }
  return map;
}

/**
 * 绑定裁决（原 apply.ts 内 Resolution）：registry 只能产出
 * pending/mapped/conflicted 三态；historical_unresolved 由规划器在分类层
 * 给出（缺冻结上下文），不经 registry。
 */
export interface RegistryBindingResolution {
  status: 'pending' | 'mapped' | 'conflicted';
  entry: RevisionRegistryEntry | null;
  reason: string;
  binding: 'digest_verified' | 'question_asserted' | null;
}

/**
 * registry v2 解析（P1-4）：snapshot 逐一对照 + 显式断言 + 漂移/缺证明分支。
 * 原 buildMigrationApplyPlan 内闭包 resolveAgainstRegistry —— 函数体逐字
 * 不变，仅把闭包捕获的 registryByQuestion 提为显式参数。
 */
export function resolveRegistryBinding(
  registryByQuestion: ReadonlyMap<string, RevisionRegistryEntry[]>,
  originalQuestionId: string,
  snapshotDigest: string | null,
): RegistryBindingResolution {
  const candidates = registryByQuestion.get(originalQuestionId) ?? [];
  if (candidates.length === 0) {
    return {
      status: 'pending',
      entry: null,
      reason: 'revision registry 无该题绑定 —— 身份待语料导入后解析',
      binding: null,
    };
  }
  if (snapshotDigest !== null) {
    const exact = candidates.find(
      (c) => c.binding_kind === 'snapshot_verified' && c.snapshot_digest === snapshotDigest,
    );
    if (exact !== undefined) {
      return {
        status: 'mapped',
        entry: exact,
        reason: '冻结 snapshot digest 与 registry snapshot_verified 绑定逐一一致 —— 绑定已验证',
        binding: 'digest_verified',
      };
    }
  }
  const asserted = candidates.find((c) => c.binding_kind === 'question_asserted');
  if (asserted !== undefined) {
    return {
      status: 'mapped',
      entry: asserted,
      reason: `registry question_asserted 显式断言：${asserted.assertion_reason ?? ''}（可审计，非 digest 验证）`,
      binding: 'question_asserted',
    };
  }
  if (snapshotDigest === null) {
    return {
      status: 'pending',
      entry: null,
      reason:
        '该记录无冻结 snapshot digest 可与 registry 的 snapshot_verified 绑定对照，且无显式断言 —— 不猜',
      binding: null,
    };
  }
  return {
    status: 'conflicted',
    entry: null,
    reason: `冻结 snapshot digest 与该题全部 snapshot_verified 绑定不符（记录 ${snapshotDigest.slice(0, 12)}）—— 内容漂移，不得绑定`,
    binding: null,
  };
}
