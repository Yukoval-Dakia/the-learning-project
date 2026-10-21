// 作答卷 PDF 导出的 wire 契约。
//
// 三个契约面：
//   1. 创建导出：一组题 → 经既有 issueAssessment 逐题发放（只放可判题），
//      冻结 parts/材料 digest/option_order；幂等键重放不重发。
//   2. 区域图存档：界面线渲染器与 PDF 同一渲染 pass 量出的区域图 POST 回后端，
//      后端对冻结发放校验后按页 write-once 存档。
//   3. 读面：token + 页 → issuance id、该页区域图与冻结 part/slot
//      坐标，无私有答案。
//
// 本文件只放 zod 形状（db-light，manifest eager import 安全）；对冻结发放的
// 交叉校验逻辑在 server/worksheet/。

import { z } from 'zod';

import { AssessmentIssuance, PracticeIssuanceDto } from '@/core/schema/assessment';
import { SERVING_UNAVAILABLE_REASONS } from '@/core/schema/assessment/serving-admission';

// ---------- 区域图形状（界面线渲染器产出；坐标唯一规范 = 页面毫米） ----------

/** 页面毫米矩形（原点 = 页面左上角）。 */
export const WorksheetMmRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
});
export type WorksheetMmRectT = z.infer<typeof WorksheetMmRect>;

/** 作答区底纹：点阵 / 5mm 方格 / 横线（draft 与 writing 区域用）。 */
export const WorksheetRegionMark = z.enum(['dots', 'squares', 'ruled']);
export type WorksheetRegionMarkT = z.infer<typeof WorksheetRegionMark>;

/** 四角定位标记：TL/TR/BL 实心，BR 空心（描边 mm）。 */
export const WorksheetAnchor = z.object({
  cx: z.number().finite(),
  cy: z.number().finite(),
  size: z.number().finite(),
  fill: z.enum(['solid', 'hollow']),
  stroke_mm: z.number().finite().nullable(),
});
export type WorksheetAnchorT = z.infer<typeof WorksheetAnchor>;

/** choice 区域的一个选项圈：option_id 是稳定选项 id（ADR-0073），回收按它判。 */
export const WorksheetRegionOption = z.object({
  option_id: z.string().min(1),
  /** 冻结 option_order 内的位置（0-based）。 */
  order: z.number().int().min(0),
  /** 印出的字母，只给人看；回收不依赖。 */
  label: z.string().min(1),
  mm: WorksheetMmRect,
});
export type WorksheetRegionOptionT = z.infer<typeof WorksheetRegionOption>;

/**
 * 一个区域。writing/choice 绑一个计分单元的一个槽（跨页续写时各页各一个
 * 同 unit_id 区域，segment_index 从 1 递增）；draft 不判分、回收忽略。
 */
export const WorksheetRegion = z
  .object({
    region_id: z.string().min(1),
    kind: z.enum(['writing', 'choice', 'draft']),
    issuance_id: z.string().min(1).nullable(),
    slot_id: z.string().min(1).nullable(),
    unit_id: z.string().min(1).nullable(),
    mark: WorksheetRegionMark.nullable(),
    mm: WorksheetMmRect,
    segment_index: z.number().int().min(1).optional(),
    options: z.array(WorksheetRegionOption).optional(),
  })
  .superRefine((region, ctx) => {
    if (region.kind === 'draft') {
      if (region.issuance_id != null || region.slot_id != null || region.unit_id != null) {
        ctx.addIssue({
          code: 'custom',
          message: 'draft region must not reference an issuance, slot or unit',
        });
      }
      if (region.mark == null) {
        ctx.addIssue({ code: 'custom', message: 'draft region requires a mark' });
      }
      return;
    }
    if (region.issuance_id == null || region.slot_id == null || region.unit_id == null) {
      ctx.addIssue({
        code: 'custom',
        message: `${region.kind} region must reference an issuance, slot and unit`,
      });
    }
    if (region.segment_index == null) {
      ctx.addIssue({
        code: 'custom',
        message: `${region.kind} region requires segment_index (1-based)`,
      });
    }
    if (region.kind === 'choice') {
      if (region.options == null || region.options.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'choice region requires options[]' });
      }
      if (region.mark != null) {
        ctx.addIssue({ code: 'custom', message: 'choice region must not carry a mark' });
      }
    }
    if (region.kind === 'writing' && region.options != null) {
      ctx.addIssue({ code: 'custom', message: 'writing region must not carry options[]' });
    }
  });
export type WorksheetRegionT = z.infer<typeof WorksheetRegion>;

/** 单页区域图（顶层切片；`of` 是总页数，同一次导出各页一致）。 */
export const WorksheetPageMap = z.object({
  page: z.number().int().min(1),
  of: z.number().int().min(1),
  orientation: z.enum(['portrait', 'landscape']),
  size_mm: z.object({ w: z.number().finite(), h: z.number().finite() }),
  qr: z.object({ payload: z.string().min(1), mm: WorksheetMmRect }),
  anchors: z.object({
    tl: WorksheetAnchor,
    tr: WorksheetAnchor,
    bl: WorksheetAnchor,
    br: WorksheetAnchor,
  }),
  regions: z.array(WorksheetRegion),
});
export type WorksheetPageMapT = z.infer<typeof WorksheetPageMap>;

/** 存档 POST 体：整份区域图（全部页一次提交，与渲染 pass 同源）。
 *
 * 顶层 strict：多题导出每区域各自携带 issuance_id，顶层不再有
 * 单一 issuance_id 字段 —— 遗留顶层字段直接拒收，不静默丢弃。 */
export const WorksheetRegionMapArchiveBody = z.strictObject({
  schema_version: z.literal(1),
  short_code: z.string().min(1),
  /** 同一渲染 pass 产出的 PDF digest（随存档冻结，进 write-once 比对）。 */
  pdf_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** 在网页作答（不印作答区）的计分单元 id 清单；导出行 write-once 冻结。 */
  web_only_units: z.array(z.string().min(1)),
  pages: z.array(WorksheetPageMap).min(1),
});
export type WorksheetRegionMapArchiveBodyT = z.infer<typeof WorksheetRegionMapArchiveBody>;

// ---------- 创建导出 ----------

export const WorksheetExportItemSchema = z.object({
  /** 组根 question id（单题 = 自身；复合题 = 父 id）。 */
  group_id: z.string().min(1),
  /** 显式目标 revision（缺省 = current_revision_id；必须属于该组）。 */
  revision_id: z.string().min(1).optional(),
  /** 目标 part 子集（缺省 = 全部）。 */
  part_ids: z.array(z.string().min(1)).min(1).optional(),
  /** 选择槽呈现顺序覆盖（缺省 = 声明顺序，不 shuffle）。 */
  option_order_overrides: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(),
});

export const WorksheetExportCreateBodySchema = z.object({
  /** 调用方幂等锚：同 key 同请求 ⇒ 重放（不重发不改冻结）；异请求 ⇒ 409。 */
  idempotency_key: z.string().min(1),
  /** 卷面来源标题（页头「来源」；空缺省）。 */
  title: z.string().max(200).optional(),
  /** 有序题目清单（卷面顺序）。 */
  items: z.array(WorksheetExportItemSchema).min(1),
});

/** 导出内单题的公开计分单元坐标（真实 unit id 进渲染输入）。 */
export const WorksheetUnitProjectionSchema = z.object({
  scoring_unit_id: z.string().min(1),
  slot_refs: z.array(z.string().min(1)),
});

/** 被服务门拒绝、未导出的题（typed 原因，随响应与重放返回）。 */
export const WorksheetRefusedItemSchema = z.object({
  group_id: z.string().min(1),
  status: z.string().min(1),
  serving_reason: z.enum(SERVING_UNAVAILABLE_REASONS).nullable(),
  issues: z.array(z.string().min(1)),
});

/** 已导出（已发放冻结）的一题：发放坐标 + 公开渲染输入 + 计分单元 id。 */
export const WorksheetIssuedItemSchema = z.object({
  position: z.number().int().min(0),
  group_id: z.string().min(1),
  issuance_id: z.string().min(1),
  /** 冻结发放坐标（revision/parts/材料 digest/option_order）。 */
  issuance: AssessmentIssuance,
  /** 作答期公开 DTO（无答案键、私有 rubric、执行计划）。 */
  practice_dto: PracticeIssuanceDto,
  /** 发出范围内的计分单元（id + slot_refs；不含判据与分值）。 */
  units: z.array(WorksheetUnitProjectionSchema),
});

// ---------- 导出状态（创建响应与读面同形：重放可能已存档） ----------

export const WorksheetExportStateSchema = z.object({
  status: z.enum(['created', 'replayed']),
  export_id: z.string().min(1),
  export_token: z.string().min(1),
  short_code: z.string().min(1),
  title: z.string(),
  /** 区域图存档后非空；存档前 null。 */
  page_count: z.number().int().min(1).nullable(),
  /** 与区域图同一渲染 pass 产出的 PDF digest（存档后非空）。 */
  pdf_digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
  archived_at: z.string().datetime().nullable(),
  issued: z.array(WorksheetIssuedItemSchema),
  refused: z.array(WorksheetRefusedItemSchema),
  /** 已存档页（page + digest；未存档 = 空数组）。 */
  pages: z.array(
    z.object({
      page: z.number().int().min(1),
      page_count: z.number().int().min(1),
      map_digest: z.string().min(1),
      archived_at: z.string().datetime(),
    }),
  ),
  web_only_units: z.array(z.string().min(1)).nullable(),
});
export type WorksheetExportStateT = z.infer<typeof WorksheetExportStateSchema>;

// ---------- 区域图存档 ----------

export const WorksheetRegionMapArchivedSchema = z.object({
  status: z.enum(['archived', 'existing']),
  export_id: z.string().min(1),
  export_token: z.string().min(1),
  page_count: z.number().int().min(1),
  pdf_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  web_only_units: z.array(z.string().min(1)),
  pages: z.array(z.object({ page: z.number().int().min(1), map_digest: z.string().min(1) })),
});
export type WorksheetRegionMapArchivedT = z.infer<typeof WorksheetRegionMapArchivedSchema>;

// ---------- 回收读面（token + 页） ----------

/** 冻结槽坐标（kind 供回收侧区分 choice/writing 解释）。 */
export const WorksheetFrozenSlotSchema = z.object({
  slot_id: z.string().min(1),
  part_id: z.string().min(1),
  kind: z.string().min(1),
});

export const WorksheetFrozenIssuanceSchema = z.object({
  issuance_id: z.string().min(1),
  group_id: z.string().min(1),
  part_ids: z.array(z.string().min(1)),
  option_order: z.array(
    z.object({ slot_id: z.string().min(1), option_ids: z.array(z.string().min(1)).min(1) }),
  ),
  slots: z.array(WorksheetFrozenSlotSchema),
  units: z.array(WorksheetUnitProjectionSchema),
});

export const WorksheetPageResponseSchema = z.object({
  export_id: z.string().min(1),
  export_token: z.string().min(1),
  short_code: z.string().min(1),
  page: z.number().int().min(1),
  page_count: z.number().int().min(1),
  /** 该页冻结的区域图（write-once 存档原样）。 */
  region_map: WorksheetPageMap,
  /** 该页区域引用到的发放（冻结坐标，无私有答案）。 */
  issuances: z.array(WorksheetFrozenIssuanceSchema),
});
export type WorksheetPageResponseT = z.infer<typeof WorksheetPageResponseSchema>;

// ---------- params ----------

export const WorksheetTokenParamsSchema = z.object({ token: z.string().min(1) });

export const WorksheetPageParamsSchema = z.object({
  token: z.string().min(1),
  page: z.string().min(1),
});
