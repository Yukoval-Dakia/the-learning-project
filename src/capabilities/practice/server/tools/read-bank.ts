// ADR-0072 D1 — read_bank DomainTool：按版本化 ref 批量取内容。
//
// 每个引用是 `question_revision` 的一次不可变内容版本（bank-ref.ts）。解析失
// 败 / digest 不符 / 已撤回 → 该 ref 显式错误，绝不静默回退 latest（硬边界 3）。
// 内容分层（提案 §7）：原文/作答契约（structure + response_spec）｜答案与评分
// 依据（scoring_basis）｜执行计划（execution_plan）｜来源/工作副本元数据（可
// 变投影，如实标注）。缺图/缺材料在 coverage.unavailable 如实上报，不被「读
// 到题面」掩盖。每个 ref 独立成败（部分成功合法）。
//
// YUK-1468（Stage 1 K3 扩展）：
//   - 默认响应 = overview（轻量；按需经 include/focus 展开，返回的 part/unit/
//     material/item/slot 稳定 id 可直接作 edit_question target）；
//   - focus：按稳定 id 收缩到子树（part/unit/material/item/slot）；
//   - scoring：answers+rubric+execution 的合并判分层；
//   - 长文本续读：extent.chars + next_cursor（cursor 钉住读时 revision_id）；
//   - 私有层（rubric / scoring / execution / visibility=private 材料）由
//     服务端 callerActor 角色裁决 —— include 永远不能升级角色；
//   - 历史读：bound submission（submission_id 输入，绑该 revision 的
//     assessment_submission）授权的已撤回 revision 仍可读，如实标注
//     historical + new_issuance_allowed=false。

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  question,
  question_revision,
  source_asset,
} from '@/db/schema';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  bankAssetDigestMatches,
  bankRefObjectKind,
  encodeBankRef,
  resolveBankRefs,
} from './bank-ref';

export const READ_BANK_INCLUDE_VALUES = [
  'overview',
  'content',
  'materials',
  'answers',
  'rubric',
  'scoring',
  'source',
  'relations',
  'execution',
  'metadata',
] as const;

export type ReadBankInclude = (typeof READ_BANK_INCLUDE_VALUES)[number];

export const ReadBankInputSchema = z
  .object({
    refs: z.array(z.string().min(1)).min(1).max(20),
    include: z.array(z.enum(READ_BANK_INCLUDE_VALUES)).default(['overview']),
    /** 稳定 id 聚焦：把该 ref 的读取收缩到指定子树（与 include 组合取层）。 */
    focus: z
      .array(
        z.object({
          ref: z.string().min(1).optional(),
          kind: z.enum(['part', 'unit', 'material', 'item', 'slot', 'option']),
          id: z.string().min(1),
        }),
      )
      .optional(),
    /** 长文本续读：chars=每个文本字段上限；cursor=上一响应的 next_cursor。 */
    extent: z
      .object({
        chars: z.number().int().min(64).max(200000).optional(),
        cursor: z.string().min(1).optional(),
      })
      .optional(),
    /** 历史读授权：绑定所请 revision 的既有 submission（旧作答读旧题）。 */
    submission_id: z.string().min(1).optional(),
  })
  .strict();

type ReadBankInput = z.infer<typeof ReadBankInputSchema>;
/** 引擎入口参数类型（include 可省——走 zod default）；工具层传入已解析的完整形。 */
export type ReadBankInputParam = z.input<typeof ReadBankInputSchema>;

const SlotProjectionSchema = z.object({
  slot_id: z.string(),
  part_id: z.string(),
  kind: z.string(),
  options: z
    .array(z.object({ option_id: z.string(), label: z.string(), text: z.string() }))
    .optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const FocusTargetSchema = z.object({
  kind: z.enum(['part', 'unit', 'material', 'item', 'slot', 'option']),
  id: z.string(),
});

const ReadBankOkItemSchema = z.object({
  ref: z.string(),
  status: z.literal('ok'),
  kind: z.enum(['question', 'group']),
  group_id: z.string(),
  revision_ordinal: z.number().int(),
  published_at: z.string(),
  supersedes_revision_id: z.string().nullable(),
  current: z.boolean(),
  /** 非当前 revision 的历史读（旧作答读旧题如实标注）。 */
  historical: z.boolean(),
  /** 该 revision 当前是否还允许发新 issuance（历史读 = false）。 */
  new_issuance_allowed: z.boolean(),
  lifecycle: z.object({
    availability: z.enum(['general_pool', 'container_only']).nullable(),
    admission_state: z.enum(['admitted', 'withheld']).nullable(),
    withheld_reason: z.string().nullable(),
    suspended: z.boolean(),
    suspension_reason: z.string().nullable(),
    withdrawn: z.boolean().nullable(),
    current_revision_ref: z.string().nullable(),
  }),
  /** overview 默认层：导航用的轻量索引（part/unit/material/slot 稳定 id）。 */
  overview: z
    .object({
      parts: z.array(
        z.object({
          part_id: z.string(),
          question_no: z.string().optional(),
          material_ids: z.array(z.string()),
        }),
      ),
      slot_ids: z.array(z.string()),
      unit_ids: z.array(z.string()),
      material_ids: z.array(z.string()),
    })
    .optional(),
  content: z
    .object({
      parts: z.array(
        z.object({
          part_id: z.string(),
          question_no: z.string().optional(),
          prompt_md: z.string(),
          material_ids: z.array(z.string()),
          extent: z
            .object({
              complete: z.boolean(),
              remaining: z.number(),
              next_cursor: z.string().nullable(),
            })
            .optional(),
        }),
      ),
      slots: z.array(SlotProjectionSchema),
    })
    .optional(),
  materials: z
    .array(
      z.object({
        material_id: z.string(),
        kind: z.string(),
        caption: z.string().optional(),
        alt_text: z.string().optional(),
        content_md: z.string().optional(),
        text_extent: z
          .object({
            complete: z.boolean(),
            remaining: z.number(),
            next_cursor: z.string().nullable(),
          })
          .optional(),
        visibility: z.string().optional(),
        asset: z.object({
          asset_id: z.string(),
          digest: z.string(),
          present: z.boolean(),
          digest_verified: z.boolean().nullable(),
        }),
      }),
    )
    .optional(),
  answers: z
    .object({
      units: z.array(
        z.object({
          scoring_unit_id: z.string(),
          slot_refs: z.array(z.string()),
          material_refs: z.array(z.string()),
          points: z.number().nullable(),
          level_points: z.record(z.string(), z.number()).optional(),
          criterion: z.record(z.string(), z.unknown()),
        }),
      ),
    })
    .optional(),
  rubric: z
    .object({
      rule_units: z.array(
        z.object({
          scoring_unit_id: z.string(),
          criterion: z.record(z.string(), z.unknown()),
        }),
      ),
      aggregation: z.record(z.string(), z.unknown()),
      blank_scores_zero: z.boolean(),
    })
    .optional(),
  source: z
    .object({
      source: z.string(),
      source_ref: z.string().nullable(),
      source_tier: z.object({ tier: z.number(), name: z.string() }),
      created_by: z.unknown().nullable(),
      question_id: z.string(),
    })
    .optional(),
  relations: z
    .object({
      group_part_question_ids: z.array(z.string()),
      supersedes_chain: z.array(z.object({ ref: z.string(), revision_ordinal: z.number().int() })),
    })
    .optional(),
  execution: z
    .object({
      plan_version: z.number().int(),
      assignments: z.array(
        z.object({
          scoring_unit_ids: z.array(z.string()),
          executor: z.record(z.string(), z.unknown()),
        }),
      ),
      escalation: z.record(z.string(), z.unknown()),
    })
    .optional(),
  /** scoring 合并层：answers + rubric + execution 一次取（K3 合并投影）。 */
  scoring: z
    .object({
      units: z.array(
        z.object({
          scoring_unit_id: z.string(),
          slot_refs: z.array(z.string()),
          material_refs: z.array(z.string()),
          points: z.number().nullable(),
          level_points: z.record(z.string(), z.number()).optional(),
          criterion: z.record(z.string(), z.unknown()),
          rule: z.record(z.string(), z.unknown()).nullable().optional(),
          executor: z.record(z.string(), z.unknown()).nullable().optional(),
        }),
      ),
      aggregation: z.record(z.string(), z.unknown()),
      blank_scores_zero: z.boolean(),
      escalation: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  /** focus 命中的子树列表（target 寻址返回；未命中项进 coverage.unavailable）。 */
  focused: z
    .array(
      z.object({
        target: FocusTargetSchema,
        node: z.unknown(),
      }),
    )
    .optional(),
  /** 角色不允许而拒绝的 include 层（include 不升级角色）。 */
  denied_layers: z.array(z.string()).optional(),
  metadata: z
    .object({
      note: z.literal('mutable working-copy projection — NOT part of the versioned revision'),
      working_copy_metadata: z.unknown().nullable(),
    })
    .optional(),
  coverage: z.object({
    extent: z.enum(['full_requested_fields', 'chunked']),
    complete: z.boolean(),
    remaining: z.array(z.string()),
    next_cursor: z.string().nullable().optional(),
    unavailable: z.array(z.string()),
  }),
});

const ReadBankErrorItemSchema = z.object({
  ref: z.string(),
  status: z.enum(['unresolvable', 'digest_mismatch', 'withdrawn', 'denied']),
  error_detail: z.string(),
});

export const ReadBankOutputSchema = z.object({
  items: z.array(z.union([ReadBankOkItemSchema, ReadBankErrorItemSchema])),
});

type ReadBankOutput = z.infer<typeof ReadBankOutputSchema>;

type ReadBankOkItem = z.infer<typeof ReadBankOkItemSchema>;
type ReadBankErrorItem = z.infer<typeof ReadBankErrorItemSchema>;

interface SlotLike {
  slot_id: string;
  part_id: string;
  kind: string;
  options?: Array<{ option_id: string; label: string; text: string }>;
  [key: string]: unknown;
}

function projectSlot(slot: SlotLike): z.infer<typeof SlotProjectionSchema> {
  const { slot_id, part_id, kind, options, ...rest } = slot;
  return {
    slot_id,
    part_id,
    kind,
    ...(options != null ? { options } : {}),
    ...(Object.keys(rest).length > 0 ? { detail: rest as Record<string, unknown> } : {}),
  };
}

// ---------- YUK-1468 — 角色 / cursor / focus ----------

type ReadRole = 'owner' | 'private' | 'restricted';

/**
 * 允许读私有层（answers 键值 / rubric / scoring / execution / private 材料 /
 * metadata 工作副本）的 agent refs（bare）。user 面与 system 作业默认有私有层；
 * 其余 agent 面按 allowlist。in-answer Copilot（'copilot'）保持 restricted ——
 * 练习对话面不可读答案键。
 */
const PRIVATE_LAYER_READERS = new Set([
  // 备题/校正/判分与维护面（author + maintenance 面 → private）。
  'ingestion_block_edit',
  'supply_executor',
  'quiz_verify',
  'judge',
  'question_verify',
  'maintenance',
  'knowledge_maintenance',
  'author_question',
]);

function roleForActor(actor: ToolContext['callerActor'] | undefined): ReadRole {
  if (actor == null) return 'restricted';
  if (actor.kind === 'user') return 'owner';
  if (actor.ref.startsWith('system:')) return 'private';
  const bare = actor.ref.replace(/^agent:/i, '').toLowerCase();
  return PRIVATE_LAYER_READERS.has(bare) ? 'private' : 'restricted';
}

/** 私有 include 层：include 不能升级角色 —— 受限角色请求时如实 denied。
 * answers 携带 criterion 字面值（select_key/blank_key）；metadata 是未版本化的
 * 工作副本投影 —— 两者对 restricted 同样私有。 */
const PRIVATE_INCLUDE_LAYERS = new Set<ReadBankInclude>([
  'answers',
  'rubric',
  'scoring',
  'execution',
  'metadata',
]);

interface ReadCursor {
  v: 1;
  /** 钉住读时的 revision id —— 续读漂移防线。 */
  pin: string;
  /** ref 原文（防把别的 ref 的 cursor 重用到本 ref）。 */
  ref: string;
  /** 字段坐标：part:<part_id>:prompt | material:<material_id>:text。 */
  layer: string;
  off: number;
}

function encodeReadCursor(c: ReadCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeReadCursor(raw: string): ReadCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ReadCursor;
    if (parsed.v !== 1 || typeof parsed.off !== 'number' || parsed.off < 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface ExtentResult {
  text: string;
  complete: boolean;
  remaining: number;
  next_cursor: string | null;
}

/** 长文本续读：cursor 命中本字段 ⇒ 从 off 继续；chars 上限 ⇒ 截断 + next_cursor。 */
function applyExtent(
  text: string,
  cursor: ReadCursor | null,
  chars: number | undefined,
  coords: { pin: string; ref: string; layer: string },
): ExtentResult {
  const base =
    cursor != null && cursor.layer === coords.layer && cursor.pin === coords.pin ? cursor.off : 0;
  const available = text.slice(base);
  if (chars == null) {
    return { text: available, complete: true, remaining: 0, next_cursor: null };
  }
  const slice = available.slice(0, chars);
  const remaining = available.length - slice.length;
  return {
    text: slice,
    complete: remaining === 0,
    remaining,
    next_cursor:
      remaining > 0
        ? encodeReadCursor({
            v: 1,
            pin: coords.pin,
            ref: coords.ref,
            layer: coords.layer,
            off: base + chars,
          })
        : null,
  };
}

// ---------- 主读取 ----------

/** focus：按稳定 id 从 revision 四层取子树（私有层按角色裁决）。 */
function focusRevisionNode(
  revision: {
    revision_id: string;
    structure: {
      parts: Array<Record<string, unknown>>;
      materials?: Array<Record<string, unknown>>;
    };
    response_spec: { slots: Array<Record<string, unknown>> };
    scoring_basis: { units: Array<Record<string, unknown>> };
    execution_plan: { assignments?: Array<Record<string, unknown>> };
  },
  target: { kind: 'part' | 'unit' | 'material' | 'item' | 'slot' | 'option'; id: string },
  role: ReadRole,
): unknown | null {
  const parts = revision.structure?.parts ?? [];
  const materials = revision.structure?.materials ?? [];
  const slots = revision.response_spec?.slots ?? [];
  const units = revision.scoring_basis?.units ?? [];
  const assignments = revision.execution_plan?.assignments ?? [];
  switch (target.kind) {
    case 'part': {
      const part = parts.find((p) => p.part_id === target.id);
      if (part == null) return null;
      const partUnitIds = new Set(
        slots.filter((s) => s.part_id === part.part_id).flatMap((s) => [s.slot_id]),
      );
      const unitIds = units
        .filter((u) =>
          ((u.slot_refs as string[] | undefined) ?? []).some((id) => partUnitIds.has(id)),
        )
        .map((u) => u.scoring_unit_id);
      return { kind: 'part', ...part, unit_ids: unitIds };
    }
    case 'unit': {
      const unit = units.find((u) => u.scoring_unit_id === target.id);
      if (unit == null) return null;
      if (role === 'restricted')
        return { kind: 'unit', unit_id: target.id, denied: 'private_layer' };
      const executor = assignments.find((a) =>
        ((a.scoring_unit_ids as string[] | undefined) ?? []).includes(target.id),
      );
      return {
        kind: 'unit',
        ...unit,
        ...(executor != null ? { executor: executor.executor } : {}),
      };
    }
    case 'material': {
      const material = materials.find((m) => m.material_id === target.id);
      if (material == null) return null;
      if (role === 'restricted' && material.visibility === 'private') {
        return { kind: 'material', material_id: target.id, denied: 'private_layer' };
      }
      return { kind: 'material', ...material };
    }
    case 'item':
    case 'option': {
      for (const slot of slots) {
        const items = (slot.items as Array<Record<string, unknown>> | undefined) ?? [];
        const item = items.find((i) => i.item_id === target.id);
        if (item != null) {
          return { kind: 'item', slot_id: slot.slot_id, part_id: slot.part_id, ...item };
        }
        const options = (slot.options as Array<Record<string, unknown>> | undefined) ?? [];
        const option = options.find((o) => o.option_id === target.id || o.label === target.id);
        if (option != null) {
          return { kind: 'item', slot_id: slot.slot_id, part_id: slot.part_id, ...option };
        }
      }
      return null;
    }
    case 'slot': {
      const slot = slots.find((s) => s.slot_id === target.id);
      if (slot == null) return null;
      return { kind: 'slot', ...slot };
    }
    default:
      return null;
  }
}

export interface RunReadBankOptions {
  /** 服务端角色裁决（工具层从 ctx.callerActor 解析；缺省 = restricted）。 */
  role?: ReadRole;
  /** 调用方 actor ref —— submission 归属绑定的比对对象。 */
  callerRef?: string;
}

export async function runReadBank(
  db: Db,
  rawInput: ReadBankInputParam,
  runOpts?: RunReadBankOptions,
): Promise<ReadBankOutput> {
  const input = ReadBankInputSchema.parse(rawInput);
  const role = runOpts?.role ?? 'restricted';
  const include = new Set(input.include);
  const deniedLayers: string[] = [];
  if (role === 'restricted') {
    for (const layer of PRIVATE_INCLUDE_LAYERS) {
      if (include.has(layer)) {
        include.delete(layer);
        deniedLayers.push(layer);
      }
    }
  }
  const cursor = input.extent?.cursor != null ? decodeReadCursor(input.extent.cursor) : null;
  const extentChars = input.extent?.chars;

  // 历史读授权：bound submission —— 须先验证调用方对该 submission 有读权
  // （learner/actor 绑定：issuance.claimed_by_ref === caller actor ref），否则
  // submission_id 不构成撤回 revision 的解锁证据。私有角色本就免检绑定。
  let boundRevisionIds = new Set<string>();
  if (input.submission_id != null) {
    const [binding] = await db
      .select({
        revision_id: assessment_submission.revision_id,
        claimed_by_ref: assessment_issuance.claimed_by_ref,
      })
      .from(assessment_submission)
      .innerJoin(
        assessment_issuance,
        eq(assessment_submission.issuance_id, assessment_issuance.issuance_id),
      )
      .where(eq(assessment_submission.submission_id, input.submission_id))
      .limit(1);
    const callerRef = runOpts?.callerRef ?? null;
    const callerOwnsSubmission =
      binding != null && callerRef != null && binding.claimed_by_ref === callerRef;
    if (binding != null && (callerOwnsSubmission || role !== 'restricted')) {
      boundRevisionIds = new Set([binding.revision_id]);
    }
  }

  // withdrawn 决议先取行（授权 per-ref 复核：bound submission 或私有角色）。
  const resolutions = await resolveBankRefs(db, input.refs, { allowWithdrawn: true });

  const items: Array<ReadBankOkItem | ReadBankErrorItem> = [];
  const okResolutions = resolutions.filter(
    (r): r is Extract<typeof r, { status: 'ok' }> => r.status === 'ok',
  );

  // ── 批量辅助数据（仅 include 需要的才查）──
  const groupIds = [...new Set(okResolutions.map((r) => r.revision.group_id))];

  const rootRows =
    include.has('source') || include.has('metadata')
      ? await db
          .select({
            id: question.id,
            source: question.source,
            source_ref: question.source_ref,
            metadata: question.metadata,
            created_by: question.created_by,
          })
          .from(question)
          .where(inArray(question.id, groupIds))
      : [];
  const rootById = new Map(rootRows.map((r) => [r.id, r]));

  const partRows = include.has('relations')
    ? await db
        .select({ id: question.id, parent: question.parent_question_id })
        .from(question)
        .where(
          and(
            inArray(question.parent_question_id, groupIds),
            sql`((${question.metadata} -> 'archived_at') IS NULL)`,
            sql`((${question.metadata} -> 'dismissed_at') IS NULL)`,
          ),
        )
    : [];
  const partsByGroup = new Map<string, string[]>();
  for (const p of partRows) {
    const bucket = partsByGroup.get(p.parent as string);
    if (bucket) bucket.push(p.id);
    else partsByGroup.set(p.parent as string, [p.id]);
  }

  const chainRows = include.has('relations')
    ? await db
        .select({
          group_id: question_revision.group_id,
          revision_id: question_revision.revision_id,
          ordinal: question_revision.revision_ordinal,
          digest: question_revision.integrity_digest,
        })
        .from(question_revision)
        .where(inArray(question_revision.group_id, groupIds))
    : [];
  const chainByGroup = new Map<string, Array<{ ref: string; revision_ordinal: number }>>();
  for (const c of chainRows) {
    const bucket = chainByGroup.get(c.group_id) ?? [];
    bucket.push({ ref: encodeBankRef(c.revision_id, c.digest), revision_ordinal: c.ordinal });
    chainByGroup.set(c.group_id, bucket);
  }

  // current_revision_ref 的 digest：lifecycle 指针可能指向与本次 ref 不同的版本，
  // 独立于 include 取（一次 IN 查询）。
  const currentRevisionIds = [
    ...new Set(
      okResolutions
        .map((r) => r.lifecycle?.current_revision_id)
        .filter((id): id is string => id != null),
    ),
  ];
  const currentDigestById = new Map<string, string>();
  if (currentRevisionIds.length > 0) {
    const rows = await db
      .select({
        revision_id: question_revision.revision_id,
        digest: question_revision.integrity_digest,
      })
      .from(question_revision)
      .where(inArray(question_revision.revision_id, currentRevisionIds));
    for (const r of rows) currentDigestById.set(r.revision_id, r.digest);
  }

  // 材料资产在场/摘要核验：便宜的 IN 查询——任何 include（含 overview 默认）
  // 都跑，缺图/摘要不符必须进 coverage.unavailable（B0：overview 不得谎报完整）。
  const wantMaterials = include.has('materials');
  const binaryAssetIds = [
    ...new Set(
      okResolutions.flatMap((r) =>
        (r.revision.structure?.materials ?? [])
          .filter((m) => m.content_md == null)
          .map((m) => m.asset.asset_id),
      ),
    ),
  ];
  const assetRows = binaryAssetIds.length
    ? await db
        .select({ id: source_asset.id, sha256: source_asset.sha256 })
        .from(source_asset)
        .where(inArray(source_asset.id, binaryAssetIds))
    : [];
  const assetById = new Map(assetRows.map((a) => [a.id, a]));

  for (const resolution of resolutions) {
    if (resolution.status !== 'ok') {
      items.push({
        ref: resolution.raw,
        status: resolution.status,
        error_detail: resolution.detail,
      });
      continue;
    }
    const { revision, lifecycle } = resolution;

    // 历史读授权复核：withdrawn 组的读取需 bound（且归属已验证的）submission
    // 或私有角色。
    const withdrawn = lifecycle?.withdrawn === true;
    if (withdrawn) {
      const authorized = role !== 'restricted' || boundRevisionIds.has(revision.revision_id);
      if (!authorized) {
        items.push({
          ref: resolution.raw,
          status: 'withdrawn',
          error_detail: `group '${revision.group_id}' is withdrawn; provide a bound submission_id or a private role to read its frozen revision`,
        });
        continue;
      }
    }
    const structure = revision.structure;
    const unavailable: string[] = [];

    // 资产诚实：任何 include 都核验（overview 层也要如实报 missing/digest）。
    // private 材料对 restricted 是 denied 而非 missing，由下方 denied 行报。
    for (const m of structure?.materials ?? []) {
      if (m.content_md != null) continue;
      if (role === 'restricted' && m.visibility === 'private') continue;
      const assetRow = assetById.get(m.asset.asset_id);
      if (assetRow == null) {
        unavailable.push(
          `material '${m.material_id}': asset '${m.asset.asset_id}' missing from the asset store`,
        );
      } else if (!bankAssetDigestMatches(assetRow.sha256, m.asset.digest)) {
        unavailable.push(
          `material '${m.material_id}': stored asset sha256 '${assetRow.sha256}' != revision digest '${m.asset.digest}'`,
        );
      }
    }
    const cursorForRef =
      cursor != null && cursor.ref === resolution.raw && cursor.pin === revision.revision_id
        ? cursor
        : null;
    if (cursor != null && cursor.ref === resolution.raw && cursor.pin !== revision.revision_id) {
      items.push({
        ref: resolution.raw,
        status: 'unresolvable',
        error_detail: `cursor pin '${cursor.pin}' does not match resolved revision '${revision.revision_id}'`,
      });
      continue;
    }
    let nextCursor: string | null = null;
    const takeCursor = (c: string | null) => {
      if (c != null && nextCursor == null) nextCursor = c;
    };

    const materialsProjection = wantMaterials
      ? (structure?.materials ?? [])
          .filter((m) => role !== 'restricted' || m.visibility !== 'private')
          .map((m) => {
            const hasInlineContent = m.content_md != null;
            const assetRow = assetById.get(m.asset.asset_id);
            const present = hasInlineContent || assetRow != null;
            const digestVerified = hasInlineContent
              ? null
              : assetRow != null
                ? bankAssetDigestMatches(assetRow.sha256, m.asset.digest)
                : null;
            const textExt =
              m.content_md != null
                ? applyExtent(m.content_md, cursorForRef, extentChars, {
                    pin: revision.revision_id,
                    ref: resolution.raw,
                    layer: `material:${m.material_id}:text`,
                  })
                : null;
            if (textExt != null) takeCursor(textExt.next_cursor);
            return {
              material_id: m.material_id,
              kind: m.kind,
              ...(m.caption != null ? { caption: m.caption } : {}),
              ...(m.alt_text != null ? { alt_text: m.alt_text } : {}),
              ...(textExt != null ? { content_md: textExt.text } : {}),
              ...(textExt != null && !textExt.complete
                ? {
                    text_extent: {
                      complete: textExt.complete,
                      remaining: textExt.remaining,
                      next_cursor: textExt.next_cursor,
                    },
                  }
                : {}),
              ...(m.visibility != null ? { visibility: m.visibility } : {}),
              asset: {
                asset_id: m.asset.asset_id,
                digest: m.asset.digest,
                present,
                digest_verified: digestVerified,
              },
            };
          })
      : undefined;
    const privateMaterialsOmitted =
      wantMaterials && role === 'restricted'
        ? (structure?.materials ?? []).filter((m) => m.visibility === 'private').length
        : 0;
    if (privateMaterialsOmitted > 0) {
      unavailable.push(
        `${privateMaterialsOmitted} private material(s) omitted for restricted role`,
      );
    }

    const isCurrent = lifecycle?.current_revision_id === revision.revision_id;
    const newIssuanceAllowed =
      isCurrent &&
      !withdrawn &&
      lifecycle?.suspended !== true &&
      lifecycle?.scoring_admission_state === 'admitted';

    // ── focus：稳定 id 子树（未命中进 unavailable） ──
    const focused: Array<{ target: z.infer<typeof FocusTargetSchema>; node: unknown }> = [];
    for (const f of (input.focus ?? []).filter((t) => t.ref == null || t.ref === resolution.raw)) {
      const node = focusRevisionNode(revision, f, role);
      if (node != null) {
        focused.push({ target: { kind: f.kind, id: f.id }, node });
      } else {
        unavailable.push(`focus ${f.kind} '${f.id}' not found (or denied) in ${resolution.raw}`);
      }
    }

    const item: ReadBankOkItem = {
      ref: resolution.raw,
      status: 'ok',
      kind: bankRefObjectKind(revision),
      group_id: revision.group_id,
      revision_ordinal: revision.revision_ordinal,
      published_at: revision.published_at.toISOString(),
      supersedes_revision_id: revision.supersedes_revision_id ?? null,
      current: isCurrent,
      historical: !isCurrent,
      new_issuance_allowed: newIssuanceAllowed,
      lifecycle: {
        availability: lifecycle?.availability ?? null,
        admission_state: lifecycle?.scoring_admission_state ?? null,
        withheld_reason: lifecycle?.scoring_admission_withheld_reason ?? null,
        suspended: lifecycle?.suspended === true,
        suspension_reason: lifecycle?.suspension_reason ?? null,
        withdrawn: withdrawn ? true : (lifecycle?.withdrawn ?? null),
        current_revision_ref:
          lifecycle?.current_revision_id != null
            ? encodeBankRef(
                lifecycle.current_revision_id,
                currentDigestById.get(lifecycle.current_revision_id) ?? '',
              )
            : null,
      },
      ...(include.has('overview')
        ? {
            overview: {
              parts: (structure?.parts ?? []).map((p) => ({
                part_id: p.part_id,
                ...(p.question_no != null ? { question_no: p.question_no } : {}),
                material_ids: p.material_ids ?? [],
              })),
              slot_ids: (revision.response_spec?.slots ?? []).map((s) => s.slot_id),
              unit_ids: (revision.scoring_basis?.units ?? []).map((u) => u.scoring_unit_id),
              material_ids: (structure?.materials ?? []).map((m) => m.material_id),
            },
          }
        : {}),
      ...(include.has('content')
        ? {
            content: {
              parts: (structure?.parts ?? []).map((p) => {
                const ext = applyExtent(p.prompt_md, cursorForRef, extentChars, {
                  pin: revision.revision_id,
                  ref: resolution.raw,
                  layer: `part:${p.part_id}:prompt`,
                });
                takeCursor(ext.next_cursor);
                return {
                  part_id: p.part_id,
                  ...(p.question_no != null ? { question_no: p.question_no } : {}),
                  prompt_md: ext.text,
                  material_ids: p.material_ids ?? [],
                  ...(extentChars != null || cursorForRef?.layer === `part:${p.part_id}:prompt`
                    ? {
                        extent: {
                          complete: ext.complete,
                          remaining: ext.remaining,
                          next_cursor: ext.next_cursor,
                        },
                      }
                    : {}),
                };
              }),
              slots: (revision.response_spec?.slots ?? []).map((s) =>
                projectSlot(s as unknown as SlotLike),
              ),
            },
          }
        : {}),
      ...(materialsProjection != null ? { materials: materialsProjection } : {}),
      ...(include.has('answers')
        ? {
            answers: {
              units: (revision.scoring_basis?.units ?? []).map((u) => ({
                scoring_unit_id: u.scoring_unit_id,
                slot_refs: u.slot_refs ?? [],
                material_refs: u.material_refs ?? [],
                points: u.points ?? null,
                ...(u.level_points != null ? { level_points: u.level_points } : {}),
                criterion: u.criterion as unknown as Record<string, unknown>,
              })),
            },
          }
        : {}),
      ...(include.has('rubric')
        ? {
            rubric: {
              rule_units: (revision.scoring_basis?.units ?? [])
                .filter(
                  (u) =>
                    u.criterion.kind === 'rule_reference' || u.criterion.kind === 'holistic_level',
                )
                .map((u) => ({
                  scoring_unit_id: u.scoring_unit_id,
                  criterion: u.criterion as unknown as Record<string, unknown>,
                })),
              aggregation: (revision.scoring_basis?.aggregation ?? {}) as Record<string, unknown>,
              blank_scores_zero: revision.scoring_basis?.blank_scores_zero === true,
            },
          }
        : {}),
      ...(include.has('source')
        ? (() => {
            const root = rootById.get(revision.group_id);
            const { tier, name } = deriveSourceTier({
              source: root?.source ?? '',
              metadata: root?.metadata ?? null,
            });
            return {
              source: {
                source: root?.source ?? '',
                source_ref: root?.source_ref ?? null,
                source_tier: { tier, name },
                created_by: (root?.created_by as unknown) ?? null,
                question_id: revision.group_id,
              },
            };
          })()
        : {}),
      ...(include.has('relations')
        ? {
            relations: {
              group_part_question_ids: partsByGroup.get(revision.group_id) ?? [],
              supersedes_chain: (chainByGroup.get(revision.group_id) ?? []).sort(
                (a, b) => a.revision_ordinal - b.revision_ordinal,
              ),
            },
          }
        : {}),
      ...(include.has('execution')
        ? {
            execution: {
              plan_version: revision.execution_plan?.plan_version ?? 0,
              assignments: (revision.execution_plan?.assignments ?? []).map((a) => ({
                scoring_unit_ids: a.scoring_unit_ids,
                executor: a.executor as unknown as Record<string, unknown>,
              })),
              escalation: (revision.execution_plan?.escalation ?? {}) as Record<string, unknown>,
            },
          }
        : {}),
      ...(include.has('scoring')
        ? {
            scoring: {
              units: (revision.scoring_basis?.units ?? []).map((u) => {
                const assignment = (revision.execution_plan?.assignments ?? []).find((a) =>
                  a.scoring_unit_ids.includes(u.scoring_unit_id),
                );
                return {
                  scoring_unit_id: u.scoring_unit_id,
                  slot_refs: u.slot_refs ?? [],
                  material_refs: u.material_refs ?? [],
                  points: u.points ?? null,
                  ...(u.level_points != null ? { level_points: u.level_points } : {}),
                  criterion: u.criterion as unknown as Record<string, unknown>,
                  rule: (u.rule ?? null) as unknown as Record<string, unknown> | null,
                  executor: (assignment?.executor as unknown as Record<string, unknown>) ?? null,
                };
              }),
              aggregation: (revision.scoring_basis?.aggregation ?? {}) as Record<string, unknown>,
              blank_scores_zero: revision.scoring_basis?.blank_scores_zero === true,
              escalation: (revision.execution_plan?.escalation ?? {}) as Record<string, unknown>,
            },
          }
        : {}),
      ...(focused.length > 0 ? { focused } : {}),
      ...(deniedLayers.length > 0 ? { denied_layers: deniedLayers } : {}),
      ...(include.has('metadata')
        ? {
            metadata: {
              note: 'mutable working-copy projection — NOT part of the versioned revision',
              working_copy_metadata: (rootById.get(revision.group_id)?.metadata as unknown) ?? null,
            },
          }
        : {}),
      coverage: {
        extent:
          nextCursor != null || cursorForRef != null
            ? ('chunked' as const)
            : ('full_requested_fields' as const),
        complete: unavailable.length === 0 && nextCursor == null,
        remaining: [],
        ...(nextCursor != null ? { next_cursor: nextCursor } : {}),
        unavailable,
      },
    };
    items.push(item);
  }

  return ReadBankOutputSchema.parse({ items });
}

async function executeReadBank(ctx: ToolContext, rawInput: ReadBankInput): Promise<ReadBankOutput> {
  return runReadBank(ctx.db, rawInput, {
    role: roleForActor(ctx.callerActor),
    callerRef: ctx.callerActor?.ref ?? null,
  });
}

export const readBankTool: DomainTool<ReadBankInput, ReadBankOutput> = {
  name: 'read_bank',
  description:
    'Fetch versioned question/group content by bank ref (qrev1:<revision_id>:<digest12> — the `ref` strings search_bank returns). Batch up to 20 refs; each resolves independently (partial success is normal). A ref that cannot be resolved, whose digest no longer matches, or whose group was withdrawn returns an explicit error for that ref — NEVER a silent fallback to latest. Default response is an overview (nav map of part/unit/material/slot stable ids — usable directly as edit_question targets); expand via include layers: content (parts + answer slots) / materials / answers (typed keys) / rubric / scoring (merged answers+rubric+execution) / source / relations / execution / metadata. focus narrows a read to part/unit/material/item/slot subtrees; extent.chars + next_cursor continue long text pinned to the read revision. A withdrawn revision is readable with a bound submission_id (old attempts read their exact frozen revision, marked historical + new_issuance_allowed=false) or a private role. answers/metadata/rubric/scoring/execution and private-visibility materials are role-gated by the server — include can never upgrade a role; denied layers are reported in denied_layers.',
  effect: 'read',
  inputSchema: ReadBankInputSchema,
  outputSchema: ReadBankOutputSchema,
  costClass: 'local',
  execute: executeReadBank,
  summarize(_input, output) {
    const ok = output.items.filter((i) => i.status === 'ok').length;
    return `read_bank · ${ok}/${output.items.length} ok`;
  },
  mirrorEvent: 'never',
};
