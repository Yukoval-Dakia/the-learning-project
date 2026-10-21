// ====================================================================
// YUK-1568 S3 — typed 组声明的服务端身份绑定 + 父子 question 行投影。
//
// 两件完整职责：
//
// 1) `bindDeclaredGroupIds` —— 模型候选文档的局部 id（part_id / unit_id /
//    slot_id / item_id / material_id / criterion_id）在【首次服务端持久化】
//    一次性绑定为真实 id：按调用方给的 namespace（既有请求/来源/paid-output
//    身份派生）sha256 派生 —— 同候选同 namespace 重放铸出同一组 id，
//    持久层 PK/回执重放是二次兜底。先校验声明引用闭包（material_refs /
//    blank_order / accepted_item_ids / 作用域内重复），dangling 一律拒绝，
//    绝不改写下标或显示 label 冒充身份、绝不注入缺省 blank_order /
//    answer_shape。绑定作用域随 schema 寻址面：part/unit/material 文档级，
//    slot 按所属 part、item/criterion 按所属 unit。
//    根组身份：单 part 声明的 groupId = 该 part 绑定 id（根行即题目本身）；
//    多 part 才铸独立 root id + 每 part 一条真实 child 行。
//
// 2) 子行投影守闸与行值规则 —— `assertTypedGroupChildrenInsertable`（先
//    FOR UPDATE 根、再查绑定 part_id 撞既有行；锁序沿用 parts.ts）与
//    `typedChildChoicesMd`（choices 列口径）。真正的子行 INSERT 字面量在
//    shared-submit.ts 内核 `submitDraftQuestionInTx` 内（YUK-1043
//    per-site：内容写点须与 publishQuestionGroup seam 同函数闭包，writer
//    审计按写点所在函数判定）。child 行内容列与组契约逐字段同源（同一份
//    单 part 文档走既有 draftCanonicalIdentity/draftDocumentToStructuredQuestion
//    投影），created_by 按 part 写口约定保持 NULL（ADR-0006 v2：
//    provenance 走 metadata + 事件）。
//
// 非职责：不重发组 revision（发布 seam 由提交内核一次性调用），不在本文件做
// 来源 URL claim / exact+near 去重（提交内核的供给投影段统一处理）。
// ====================================================================

import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { DraftPartT, QuestionDraftDocumentT } from '@/core/schema/question-draft';
import type { Tx } from '@/db/client';
import { question } from '@/db/schema';

// ---------- 身份绑定 ----------

export type DeclaredIdDomain =
  | 'group'
  | 'part'
  | 'unit'
  | 'slot'
  | 'item'
  | 'material'
  | 'criterion';

/** domain → 声明局部 id → 已绑定真实 id。带作用域的域（slot→part、
 *  item/criterion→unit）键为 JSON 编码的 [scope, local]，避免分隔符歧义。 */
export type BoundIdMap = Partial<Record<DeclaredIdDomain, Record<string, string>>>;

export interface BoundDeclaredGroup {
  /** 绑定后的完整 v2 文档（可直接进 saveDraftEditInTx 的 document 输入）。 */
  document: QuestionDraftDocumentT;
  /** 根组 question.id —— 由同一 namespace 派生，供提交内核当 newGroupId。
   *  单 part 声明时为该 part 的绑定 id（根行即该题本身，无独立 root/child）。 */
  groupId: string;
  idMap: BoundIdMap;
}

export interface BindIssue {
  code: string;
  detail: string;
  part_id?: string;
  unit_id?: string;
}

export type BindDeclaredIdsResult =
  | { ok: true; bound: BoundDeclaredGroup }
  | { ok: false; issues: BindIssue[] };

/**
 * 首次服务端绑定：把声明文档的局部身份铸成确定性真实 id。
 * - namespace：幂等身份依据（如 `yuk1568-candidate:<request_id>`）。同一候选
 *   重放必须给同一 namespace；不同候选绝不可共享。
 * - 只接受「新组」声明：doc.base/doc.presentation 存在即拒绝 —— 绑定过的
 *   文档不重绑；presentation 的 block_id/bind 内嵌声明 id，重绑会留悬空
 *   引用，声明侧 presentation 由提交链从契约统一生成。
 */
export function bindDeclaredGroupIds(
  doc: QuestionDraftDocumentT,
  params: { namespace: string },
): BindDeclaredIdsResult {
  const issues: BindIssue[] = [];
  if (doc.base != null) {
    issues.push({
      code: 'invalid_declared_identity',
      detail: 'declared group document must not carry base (edit-target) identity',
    });
  }
  if (doc.presentation != null) {
    issues.push({
      code: 'invalid_declared_identity',
      detail:
        'declared group document must not carry presentation (blocks/binds embed declared ids; it is derived from the bound contract at submit)',
    });
  }

  // 绑定域的作用域按 schema 寻址面定：
  //   - group/part/unit/material 文档级唯一（unit_id 是判分契约里的扁平寻址
  //     身份，跨 part 重复会让 scoring_basis 引用歧义 ⇒ 拒）；
  //   - slot 作用域 = 所属 part（blank_order 只引用本 part 槽；不同 part
  //     各自声明 's1' 合法）；
  //   - item / criterion 作用域 = 所属 unit（不同 select unit 各有 A/B 项、
  //     各 rubric criteria 同名都是合法声明；key.accepted_item_ids 只解析
  //     本 unit 的 items）。
  // 带作用域域的 digest/map key 以 JSON [scope, local] 区分；ref 解析同样
  // 限定在声明它的作用域内，跨作用域同名的局部 id 不互相命中。
  const digest = (domain: DeclaredIdDomain, scopedKey: string): string =>
    `bd_${domain}_${createHash('sha256')
      .update(`yuk1568:bind:${params.namespace}`)
      .update('\0')
      .update(domain)
      .update('\0')
      .update(scopedKey)
      .digest('hex')
      .slice(0, 20)}`;

  const idMap: BoundIdMap = {};
  const seen = new Set<string>();
  const claim = (domain: DeclaredIdDomain, local: string, scope?: string): string => {
    const mapKey = scope != null ? JSON.stringify([scope, local]) : local;
    const seenKey = `${domain}\0${mapKey}`;
    if (seen.has(seenKey)) {
      issues.push({
        code: 'duplicate_declared_id',
        detail:
          scope != null
            ? `${domain} id '${local}' declared more than once within '${scope}'`
            : `${domain} id '${local}' declared more than once`,
      });
      return local;
    }
    seen.add(seenKey);
    const boundId = digest(domain, mapKey);
    const domainMap = idMap[domain] ?? (Object.create(null) as Record<string, string>);
    domainMap[mapKey] = boundId;
    idMap[domain] = domainMap;
    return boundId;
  };
  const ref = (
    domain: DeclaredIdDomain,
    local: string,
    at: Omit<BindIssue, 'code'>,
    scope?: string,
  ): string => {
    const mapKey = scope != null ? JSON.stringify([scope, local]) : local;
    const boundId = idMap[domain]?.[mapKey];
    if (boundId == null) {
      issues.push({
        ...at,
        code: 'dangling_declared_ref',
        detail: `${at.detail} references undeclared ${domain} id '${local}'`,
      });
      return local;
    }
    return boundId;
  };

  const boundMaterials = doc.materials.map((material) => ({
    ...material,
    material_id: claim('material', material.material_id),
  }));

  const boundParts: DraftPartT[] = doc.parts.map((part) => {
    const boundPartId = claim('part', part.part_id);
    const at = { part_id: part.part_id };
    const boundUnits = part.units.map((unit) => {
      const boundUnitId = claim('unit', unit.unit_id);
      // slot 身份属于本 part 的槽空间：同 part 内重复 = 冲突，跨 part 同名合法。
      const boundSlotId = claim('slot', unit.slot_id, part.part_id);
      const spec = unit.response_spec;
      const boundSpec =
        spec.kind === 'select'
          ? {
              ...spec,
              items: spec.items.map((item) => ({
                ...item,
                item_id: claim('item', item.item_id, unit.unit_id),
              })),
            }
          : spec;
      // key 只解析本 unit 的 items（spec 先绑定，引用按本 unit 作用域查表）。
      const boundKey =
        unit.key?.kind === 'select'
          ? {
              ...unit.key,
              accepted_item_ids: unit.key.accepted_item_ids.map((itemId) =>
                ref(
                  'item',
                  itemId,
                  {
                    ...at,
                    unit_id: unit.unit_id,
                    detail: `unit '${unit.unit_id}' key`,
                  },
                  unit.unit_id,
                ),
              ),
            }
          : unit.key;
      return {
        ...unit,
        unit_id: boundUnitId,
        slot_id: boundSlotId,
        response_spec: boundSpec,
        key: boundKey,
        material_refs: unit.material_refs.map((materialId) =>
          ref('material', materialId, {
            ...at,
            unit_id: unit.unit_id,
            detail: `unit '${unit.unit_id}' material_refs`,
          }),
        ),
        rubric:
          unit.rubric != null
            ? {
                ...unit.rubric,
                criteria: unit.rubric.criteria.map((criterion) => ({
                  ...criterion,
                  criterion_id: claim('criterion', criterion.criterion_id, unit.unit_id),
                })),
              }
            : unit.rubric,
      };
    });
    return {
      ...part,
      part_id: boundPartId,
      material_ids: part.material_ids.map((materialId) =>
        ref('material', materialId, {
          ...at,
          detail: `part '${part.part_id}' material_ids`,
        }),
      ),
      units: boundUnits,
      // blank_order 只能引用本 part 声明过的槽（跨 part 同名 slot 不命中）。
      blank_order: part.blank_order?.map((slotId) =>
        ref(
          'slot',
          slotId,
          {
            ...at,
            detail: `part '${part.part_id}' blank_order`,
          },
          part.part_id,
        ),
      ),
    };
  });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    bound: {
      document: { ...doc, parts: boundParts, materials: boundMaterials },
      // 单 part 组 = 根行自身即该题：groupId 就是已绑定 part_id（不另铸
      // 独立 root id，也没有子行）。多 part 才有独立 root + 每 part 真实
      // child 行。
      groupId: boundParts.length === 1 ? boundParts[0].part_id : digest('group', 'root'),
      idMap,
    },
  };
}

// ---------- 父子行投影 ----------

/**
 * 投影失败哨兵：抛出即要求外层事务整体回滚（绝不提交半个 root+子集）。
 * 保留为内部错误向上传递，不在事务内折为成功或已提交冲突。
 */
export class TypedGroupProjectionError extends Error {
  constructor(
    message: string,
    public readonly code: 'root_missing' | 'part_id_conflict',
  ) {
    super(message);
    this.name = 'TypedGroupProjectionError';
  }
}

/**
 * 多 part 文档投影子行前的守闸（只读）：先 FOR UPDATE 锁根（锁序沿用
 * parts.ts，FK KEY SHARE 与根 FOR UPDATE 互斥，先锁根防「先子后根」
 * 倒置），再查绑定 part_id 撞既有 question 行 —— 已占用 id 不静默覆盖。
 * 真正的子行 INSERT 字面量在 shared-submit.ts 内核内（YUK-1043 per-site：
 * 内容写点与 publishQuestionGroup seam 同函数闭包，writer 审计可见）。
 * 单 part 文档不调用（单 part 组 = 根行自身，不产子行）。
 */
export async function assertTypedGroupChildrenInsertable(
  tx: Tx,
  input: { groupId: string; document: QuestionDraftDocumentT },
): Promise<void> {
  const doc = input.document;
  const [rootLock] = await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, input.groupId))
    .for('update')
    .limit(1);
  if (rootLock == null) {
    throw new TypedGroupProjectionError(
      `assertTypedGroupChildrenInsertable: root question '${input.groupId}' not found (children must follow the root row in the same transaction)`,
      'root_missing',
    );
  }
  const existing = await tx
    .select({ id: question.id })
    .from(question)
    .where(
      inArray(
        question.id,
        doc.parts.map((part) => part.part_id),
      ),
    );
  const existingIds = new Set(existing.map((row) => row.id));
  const collision = doc.parts.find((part) => existingIds.has(part.part_id));
  if (collision != null) {
    throw new TypedGroupProjectionError(
      `assertTypedGroupChildrenInsertable: declared part id '${collision.part_id}' already bound to an existing question row`,
      'part_id_conflict',
    );
  }
}

/**
 * 子行 choices 列：只在「本 part 恰好一个 select 单元且 part 仅此单元」时
 * 落列 —— 与 draft 投影的 choices 口径一致（多 select 单元 part 的
 * choices 无确定序，不冒充）。纯函数。
 */
export function typedChildChoicesMd(part: DraftPartT): string[] | null {
  const selectUnits = part.units.filter(
    (unit) => unit.response_class === 'select' && unit.response_spec.kind === 'select',
  );
  return selectUnits.length === 1 &&
    part.units.length === 1 &&
    selectUnits[0].response_spec.kind === 'select'
    ? selectUnits[0].response_spec.items.map((item) => item.label_md ?? item.item_id)
    : null;
}
