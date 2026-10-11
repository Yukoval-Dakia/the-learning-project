// ADR-0072 D1 — read_bank DomainTool：按版本化 ref 批量取内容。
//
// 每个引用是 `question_revision` 的一次不可变内容版本（bank-ref.ts）。解析失
// 败 / digest 不符 / 已撤回 → 该 ref 显式错误，绝不静默回退 latest（硬边界 3）。
// 内容分层（提案 §7）：原文/作答契约（structure + response_spec）｜答案与评分
// 依据（scoring_basis）｜执行计划（execution_plan）｜来源/工作副本元数据（可
// 变投影，如实标注）。缺图/缺材料在 coverage.unavailable 如实上报，不被「读
// 到题面」掩盖。每个 ref 独立成败（部分成功合法）。
//
// v1（LIGHT）：单次返回全部请求层，无分片续读（ReadCursor 不实现；题库单条
// 内容量级为 KB 级）；media 以版本化资产引用返回（asset_id + digest），不做图
// 像解码。工具只读，不碰 learner state。

import { and, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { question, question_revision, source_asset } from '@/db/schema';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  bankAssetDigestMatches,
  bankRefObjectKind,
  encodeBankRef,
  resolveBankRefs,
} from './bank-ref';

export const READ_BANK_INCLUDE_VALUES = [
  'content',
  'materials',
  'answers',
  'rubric',
  'source',
  'relations',
  'execution',
  'metadata',
] as const;

export type ReadBankInclude = (typeof READ_BANK_INCLUDE_VALUES)[number];

export const ReadBankInputSchema = z
  .object({
    refs: z.array(z.string().min(1)).min(1).max(20),
    include: z
      .array(z.enum(READ_BANK_INCLUDE_VALUES))
      .default(['content', 'materials', 'relations']),
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

const ReadBankOkItemSchema = z.object({
  ref: z.string(),
  status: z.literal('ok'),
  kind: z.enum(['question', 'group']),
  group_id: z.string(),
  revision_ordinal: z.number().int(),
  published_at: z.string(),
  supersedes_revision_id: z.string().nullable(),
  current: z.boolean(),
  lifecycle: z.object({
    availability: z.enum(['general_pool', 'container_only']).nullable(),
    admission_state: z.enum(['admitted', 'withheld']).nullable(),
    withheld_reason: z.string().nullable(),
    suspended: z.boolean(),
    suspension_reason: z.string().nullable(),
    current_revision_ref: z.string().nullable(),
  }),
  content: z
    .object({
      parts: z.array(
        z.object({
          part_id: z.string(),
          question_no: z.string().optional(),
          prompt_md: z.string(),
          material_ids: z.array(z.string()),
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
  metadata: z
    .object({
      note: z.literal('mutable working-copy projection — NOT part of the versioned revision'),
      working_copy_metadata: z.unknown().nullable(),
    })
    .optional(),
  coverage: z.object({
    extent: z.literal('full_requested_fields'),
    complete: z.boolean(),
    remaining: z.array(z.string()),
    unavailable: z.array(z.string()),
  }),
});

const ReadBankErrorItemSchema = z.object({
  ref: z.string(),
  status: z.enum(['unresolvable', 'digest_mismatch', 'withdrawn']),
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

export async function runReadBank(db: Db, rawInput: ReadBankInputParam): Promise<ReadBankOutput> {
  const input = ReadBankInputSchema.parse(rawInput);
  const include = new Set(input.include);
  const resolutions = await resolveBankRefs(db, input.refs);

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

  // 材料资产在场/摘要核验（仅 include.materials 时；coverage 只对请求过的层诚实）。
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
  const assetRows =
    wantMaterials && binaryAssetIds.length
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
    const structure = revision.structure;
    const unavailable: string[] = [];

    const materialsProjection = wantMaterials
      ? (structure?.materials ?? []).map((m) => {
          const hasInlineContent = m.content_md != null;
          const assetRow = assetById.get(m.asset.asset_id);
          const present = hasInlineContent || assetRow != null;
          const digestVerified = hasInlineContent
            ? null
            : assetRow != null
              ? bankAssetDigestMatches(assetRow.sha256, m.asset.digest)
              : null;
          if (!present) {
            unavailable.push(
              `material '${m.material_id}': asset '${m.asset.asset_id}' missing from the asset store`,
            );
          } else if (digestVerified === false) {
            unavailable.push(
              `material '${m.material_id}': stored asset sha256 '${assetRow?.sha256}' != revision digest '${m.asset.digest}'`,
            );
          }
          return {
            material_id: m.material_id,
            kind: m.kind,
            ...(m.caption != null ? { caption: m.caption } : {}),
            ...(m.alt_text != null ? { alt_text: m.alt_text } : {}),
            ...(m.content_md != null ? { content_md: m.content_md } : {}),
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

    const item: ReadBankOkItem = {
      ref: resolution.raw,
      status: 'ok',
      kind: bankRefObjectKind(revision),
      group_id: revision.group_id,
      revision_ordinal: revision.revision_ordinal,
      published_at: revision.published_at.toISOString(),
      supersedes_revision_id: revision.supersedes_revision_id ?? null,
      current: lifecycle?.current_revision_id === revision.revision_id,
      lifecycle: {
        availability: lifecycle?.availability ?? null,
        admission_state: lifecycle?.scoring_admission_state ?? null,
        withheld_reason: lifecycle?.scoring_admission_withheld_reason ?? null,
        suspended: lifecycle?.suspended === true,
        suspension_reason: lifecycle?.suspension_reason ?? null,
        current_revision_ref:
          lifecycle?.current_revision_id != null
            ? encodeBankRef(
                lifecycle.current_revision_id,
                currentDigestById.get(lifecycle.current_revision_id) ?? '',
              )
            : null,
      },
      ...(include.has('content')
        ? {
            content: {
              parts: (structure?.parts ?? []).map((p) => ({
                part_id: p.part_id,
                ...(p.question_no != null ? { question_no: p.question_no } : {}),
                prompt_md: p.prompt_md,
                material_ids: p.material_ids ?? [],
              })),
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
      ...(include.has('metadata')
        ? {
            metadata: {
              note: 'mutable working-copy projection — NOT part of the versioned revision',
              working_copy_metadata: (rootById.get(revision.group_id)?.metadata as unknown) ?? null,
            },
          }
        : {}),
      coverage: {
        extent: 'full_requested_fields',
        complete: unavailable.length === 0,
        remaining: [],
        unavailable,
      },
    };
    items.push(item);
  }

  return ReadBankOutputSchema.parse({ items });
}

async function executeReadBank(ctx: ToolContext, rawInput: ReadBankInput): Promise<ReadBankOutput> {
  return runReadBank(ctx.db, rawInput);
}

export const readBankTool: DomainTool<ReadBankInput, ReadBankOutput> = {
  name: 'read_bank',
  description:
    'Fetch versioned question/group content by bank ref (the `ref` strings search_bank returns, format qrev1:<revision_id>:<digest12>). Batch up to 20 refs; each resolves independently (partial success is normal). A ref that cannot be resolved, whose digest no longer matches, or whose group was withdrawn returns an explicit error for that ref — NEVER a silent fallback to latest. include layers: content (parts + answer slots) / materials (shared figures & passages with asset presence + digest honesty) / answers (typed answer keys) / rubric (rule/holistic scoring basis) / source / relations (group parts + full revision chain) / execution (grading executors) / metadata (mutable working-copy projection, labeled as unversioned). Missing figures/materials are reported in coverage.unavailable — a readable stem never hides them. v1 returns full content in one response (no chunked continuation).',
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
